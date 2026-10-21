import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir,open,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

async function availablePort() {
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise((accept,reject)=>socket.close(error=>error?reject(error):accept()));return port;
}
export async function startPostgresCluster({directory,bin}) {
  if(!bin)throw new Error('Pass the PostgreSQL bin directory with --bin or SRE_TEST_PG_BIN');
  bin=resolve(bin);directory=resolve(directory);
  await mkdir(directory,{recursive:true,mode:0o700});
  const password=randomBytes(24).toString('hex'),passwordFile=join(directory,'password.txt'),data=join(directory,'data');
  await writeFile(passwordFile,password+'\n',{mode:0o600,flag:'wx'});
  const processes=[],log=await open(join(directory,'postgres.log'),'a',0o600);
  async function command(name,args) {
    const process=spawn(join(bin,name),args,{env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore',log.fd,log.fd]});
    const record={name,pid:process.pid,startedAt:new Date().toISOString()};processes.push(record);
    const [code,signal]=await once(process,'exit');record.exit={code,signal};
    if(code!==0)throw new Error(name+' failed; inspect retained postgres.log');
  }
  const port=await availablePort();
  const url=new URL('postgresql://sre_fixture@127.0.0.1:'+port+'/postgres');url.password=password;
  let stopped=false,server,exit,record;
  async function terminate(signal) {
    if(!server)return;
    if(server.exitCode===null&&server.signalCode===null){record.stopRequest={signal,at:new Date().toISOString()};server.kill(signal);}
    let timer;
    try{return await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned PostgreSQL server did not exit')),12000);})]);}
    finally{clearTimeout(timer);}
  }
  async function start() {
    if(stopped)throw new Error('Owned PostgreSQL cluster is closed');
    if(server&&server.exitCode===null&&server.signalCode===null)throw new Error('Owned PostgreSQL server is already running');
    // Unix sockets are disabled to avoid macOS path-length limits. SCRAM is
    // required on the sole loopback TCP listener. Durable defaults stay enabled.
    server=spawn(join(bin,'postgres'),['-D',data,'-h','127.0.0.1','-p',String(port),'-k','','-c','max_connections=35','-c','shared_buffers=16MB','-c','statement_timeout=10000','-c','lock_timeout=7000'],{env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore',log.fd,log.fd]});
    record={name:'postgres',pid:server.pid,port,generation:processes.filter(item=>item.name==='postgres').length+1,startedAt:new Date().toISOString()};processes.push(record);
    const current=record;exit=once(server,'exit').then(([code,signal])=>current.exit={code,signal});
    const deadline=Date.now()+15000;let last;
    while(Date.now()<deadline) {
      if(server.exitCode!==null||server.signalCode!==null)throw new Error('Owned PostgreSQL server exited during startup');
      const client=new Client({connectionString:url.href,connectionTimeoutMillis:500});
      try{
        await client.connect();
        const version=(await client.query('SELECT version() AS version')).rows[0].version;
        const settings=(await client.query("SELECT current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,current_setting('full_page_writes') AS full_page_writes,current_setting('listen_addresses') AS listen_addresses,current_setting('ssl') AS ssl")).rows[0];
        await client.end();record.readyAt=new Date().toISOString();record.settings=settings;return {pid:server.pid,version,settings};
      }
      catch(error){last=error;await client.end().catch(()=>{});await delay(100);}
    }
    throw new Error('PostgreSQL did not become ready: '+last?.code);
  }
  const stop=async()=>{
    if(stopped)return;stopped=true;
    try{await terminate('SIGTERM');}finally{await log.close();}
  };
  try {
    await command('initdb',['-D',data,'-U','sre_fixture','--auth-local=trust','--auth-host=scram-sha-256','--pwfile='+passwordFile,'--encoding=UTF8','--locale=C']);
    const initial=await start();
    return {url:url.href,port,password,processes,...initial,stop,immediateStop:()=>terminate('SIGQUIT'),restart:start};
  } catch(error){await stop();throw error;}
}
