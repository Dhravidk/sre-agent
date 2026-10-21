import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {teamsTrialConfig,teamsTrialGateway,trialForwardingAllowed,gateTrialDeliveries,trialNoticeSender} from '../src/sre/teams-trial.mjs';
import {teamsManifest} from '../scripts/package-teams.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {devActivity} from '../src/sre/demo.mjs';

const settings={tenantId:'11111111-1111-4111-8111-111111111111',botId:'22222222-2222-4222-8222-222222222222',database:':memory:',rooms:[{id:'19:bidding@thread.tacv2',name:'Bidding trial'},{id:'19:platform@thread.tacv2',name:'Platform trial'}]};
const credentials={TENANT_ID:settings.tenantId,CLIENT_ID:settings.botId,CLIENT_SECRET:'fixture-secret',SRE_TEAMS_TRIAL_API_TOKEN:'fixture-api-token',SRE_TEAMS_TRIAL_CAPABILITY_SECRET:'fixture-capability-secret-'.repeat(3)};
test('the native trial notice preserves cancellation options, sender binding, receipt and exact message body',async()=>{
 const controller=new AbortController(),options={signal:controller.signal},reference={conversation:{id:'owned-fixture'}},receipt={id:'receipt'},calls=[],sender={send(ref,text,passed){calls.push({self:this,ref,text,passed});return receipt;}};
 const wrapped=trialNoticeSender(sender);assert.equal(await wrapped.send(reference,'Fictional 🧪 incident',options),receipt);assert.equal(calls[0].self,sender);assert.equal(calls[0].ref,reference);assert.equal(calls[0].passed,options);assert.equal(calls[0].text,'[Fictional SRE Teams trial · Claude off · deployments disabled]\nFictional 🧪 incident');
 const failure=Error('Owned fixture failure');sender.send=()=>{throw failure;};assert.throws(()=>wrapped.send(reference,'Fictional',options),error=>error===failure);
});
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

test('mention-only trial package identifies the app and bot separately and offers coordination commands without history permissions',()=>{
  const env={CLIENT_ID:settings.botId,TEAMS_APP_ID:'33333333-3333-4333-8333-333333333333',TEAMS_APP_VERSION:'1.0.0',TEAMS_APP_SHORT_NAME:'SRE Agent Trial',TEAMS_APP_SCOPES:'team,groupChat',TEAMS_APP_MESSAGE_ACCESS:'mentions',TEAMS_APP_WEBSITE_URL:'https://trial.example/trial',TEAMS_APP_PRIVACY_URL:'https://trial.example/trial/privacy',TEAMS_APP_TERMS_URL:'https://trial.example/trial/terms'};
  const manifest=teamsManifest(env);assert.equal(manifest.id,env.TEAMS_APP_ID);assert.equal(manifest.bots[0].botId,settings.botId);assert.equal(manifest.name.short,'SRE Agent Trial');assert.equal(manifest.version,'1.0.0');
  assert.equal(manifest.authorization,undefined);assert.equal(manifest.webApplicationInfo,undefined);assert.deepEqual(manifest.bots[0].scopes,['team','groupChat']);
  const commands=manifest.bots[0].commandLists[0].commands;assert.equal(commands.length,10);assert.ok(['work','theory','sync','ack','rollback','approve'].every(name=>commands.some(command=>command.title===name)));
  assert.throws(()=>teamsManifest({...env,TEAMS_APP_SHORT_NAME:'x'.repeat(31)}),/30 characters/);assert.throws(()=>teamsManifest({...env,TEAMS_APP_VERSION:'latest'}),/semantic version/);
});

test('real-Teams trial fixes rules mode, exact channels and disabled deployment/providers despite inherited overrides',()=>{
  const c=teamsTrialConfig(settings,{...credentials,SRE_AGENT_MODE:'claude',SRE_TEAMS_MODE:'playground',DATABASE_URL:'postgres://wrong',SRE_HOST:'0.0.0.0'});
  assert.equal(c.agentMode,'rules');assert.equal(c.mode,'connected');assert.equal(c.teamsMode,'live');assert.equal(c.host,'127.0.0.1');assert.equal(c.databaseUrl,undefined);
  assert.equal(c.services[0].rollback.enabled,false);assert.equal(c.services[0].teams.captureResponderUpdates,false);
  assert.deepEqual(c.services[0].teams.conversations,settings.rooms.map(room=>room.id));
  assert.ok(['github','gitlab','servicenow','dynatrace','dynatraceLogs','jira','releases','logs','verification'].every(source=>c.services[0][source].enabled===false));
  assert.throws(()=>teamsTrialConfig({...settings,tenantId:'other'},credentials),/identities/);
  assert.throws(()=>teamsTrialConfig({...settings,rooms:[settings.rooms[0],settings.rooms[0]]},credentials),/distinct/);
});

test('trial gateway serves only static notices and stays closed to webhook traffic by default',async()=>{
  const gateway=teamsTrialGateway({upstream:'http://127.0.0.1:1/api/messages'}),base=await listen(gateway);
  try {
    for(const path of ['/trial','/trial/privacy','/trial/terms'])assert.equal((await fetch(base+path)).status,200);
    for(const path of ['/','/api/status','/api/dev/teams','/internal/evidence','/api/messages?path=/api/status'])assert.equal((await fetch(base+path)).status,404);
    assert.equal((await fetch(base+'/api/messages',{method:'POST',body:'{}'})).status,503);
  } finally {await close(gateway);}
});

test('a trial can explicitly select GitLab code history while all provider readers, Claude and execution remain disabled',()=>{
  const c=teamsTrialConfig({...settings,repositoryProvider:'gitlab'},credentials);
  assert.equal(c.services[0].rollback.provider,'gitlab');assert.equal(c.services[0].rollback.enabled,false);assert.equal(c.agentMode,'rules');
  assert.equal(c.services[0].gitlab.enabled,false);assert.equal(c.services[0].github.enabled,false);
  assert.throws(()=>teamsTrialConfig({...settings,repositoryProvider:'unknown'},credentials),/repositoryProvider/);
});

test('opened gateway forwards only bounded JSON bot messages, preserves authentication and never reaches operator APIs',async()=>{
  const received=[];
  const upstream=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({path:req.url,authorization:req.headers.authorization,body});res.writeHead(401,{'content-type':'application/json'});res.end('{"error":"SDK rejected fake token"}');});
  const destination=await listen(upstream),gateway=teamsTrialGateway({upstream:destination+'/api/messages',enabled:()=>true,maxBodyBytes:64}),base=await listen(gateway);
  try {
    assert.equal((await fetch(base+'/api/messages',{method:'POST',body:'{}'})).status,401);
    assert.equal((await fetch(base+'/api/messages',{method:'POST',headers:{authorization:'Bearer fixture'},body:'{}'})).status,415);
    assert.equal((await fetch(base+'/api/messages',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:'x'.repeat(65)})).status,413);
    assert.equal(received.length,0);
    const response=await fetch(base+'/api/messages',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:'{"type":"message"}'});
    assert.equal(response.status,401);assert.deepEqual(received,[{path:'/api/messages',authorization:'Bearer fixture',body:'{"type":"message"}'}]);
    assert.equal((await fetch(base+'/api/status',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:'{}'})).status,404);
    assert.equal(received.length,1);
  } finally {await close(gateway);await close(upstream);}
});

test('gateway refuses non-loopback and alternate upstream routes',()=>{
  for(const url of ['http://example.com/api/messages','http://127.0.0.1/api/status','http://127.0.0.1/api/messages?path=/api/status','http://user:password@127.0.0.1/api/messages'])assert.throws(()=>teamsTrialGateway({upstream:url}),/only the loopback Teams webhook/);
});

test('forwarding requires an exact expiring tenant/bot/channel grant and closes on expiry or malformed state',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sre-trial-grant-')),path=join(dir,'forwarding.json'),now=Date.now();
  const grant={enabled:true,tenantId:settings.tenantId,botId:settings.botId,channelIds:settings.rooms.map(room=>room.id),expiresAt:now+3600000};
  try {
    assert.equal(trialForwardingAllowed(path,settings,now),false);
    await writeFile(path,JSON.stringify(grant));assert.equal(trialForwardingAllowed(path,settings,now),true);assert.equal(trialForwardingAllowed(path,settings,grant.expiresAt),false);
    for(const change of [{enabled:false},{tenantId:'wrong'},{botId:'wrong'},{channelIds:[settings.rooms[0].id]},{expiresAt:now+9*3600000}]){await writeFile(path,JSON.stringify({...grant,...change}));assert.equal(trialForwardingAllowed(path,settings,now),false);}
    await writeFile(path,'not-json');assert.equal(trialForwardingAllowed(path,settings,now),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('closed and expired trial grants pause real outbox processing without consuming attempts, including after database restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-trial-outbound-')),grantPath=join(directory,'forwarding.json'),dbPath=join(directory,'agent.sqlite');
  let now=Date.now(),r;const sent=[],grant={enabled:true,tenantId:settings.tenantId,botId:settings.botId,channelIds:settings.rooms.map(room=>room.id),expiresAt:now+1000};
  const open=async()=>{
    const c=loadConfig({SRE_SQLITE_PATH:dbPath,SRE_CLAUDE_BIN:'/nonexistent-trial-expiry-cli'});
    r=await createSreRuntime({config:c,autoStart:false,sender:{send:async(reference,text)=>{sent.push(text);return {id:'fixture-receipt-'+sent.length};}}});
    gateTrialDeliveries(r.outbox,()=>trialForwardingAllowed(grantPath,settings,now));
  };
  const queue=async id=>{const s=devActivity('incidents',r.config.services[0],{id});await r.router.accept(s.activity,s.reference);await r.router.processOnce();};
  try {
    await open();await queue('before-grant');assert.equal(await r.outbox.runOnce(),false);assert.equal(sent.length,0);
    assert.deepEqual((await r.store.db.query('SELECT status,attempts FROM sre_outbox')).map(row=>({...row})),[{status:'pending',attempts:0}]);
    await writeFile(grantPath,JSON.stringify(grant));assert.equal(await r.outbox.runOnce(),true);assert.equal(sent.length,1);
    await queue('after-expiry');now=grant.expiresAt;assert.equal(await r.outbox.runOnce(),false);assert.equal(sent.length,1);
    await r.close();await open();assert.equal(await r.outbox.runOnce(),false);assert.equal(sent.length,1);
    const [pending]=await r.store.db.query("SELECT status,attempts FROM sre_outbox WHERE status='pending'");assert.equal(pending.attempts,0);
    await writeFile(grantPath,JSON.stringify({...grant,expiresAt:now+1000}));assert.equal(await r.outbox.runOnce(),true);assert.equal(sent.length,2);
    assert.equal(await r.outbox.runOnce(),false);assert.equal(sent.length,2,'a renewed window must not duplicate completed deliveries');
  } finally {if(r)await r.close();await rm(directory,{recursive:true,force:true});}
});

test('native live SDK rejects unsigned and malformed tokens; the trial launcher preserves its incident across process restart',{timeout:20000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-live-trial-process-')),path=join(directory,'settings.json');let child,exited,output='',errors='';
  await writeFile(path,JSON.stringify({...settings,directory,database:join(directory,'agent.sqlite'),apiPort:0,botPort:0,gatewayPort:0}));
  const start=async()=>{
    output='';errors='';child=spawn(process.execPath,['scripts/sre-teams-trial.mjs'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,...credentials,SRE_TEAMS_TRIAL_SETTINGS:path,SRE_AGENT_MODE:'claude',SRE_CLAUDE_BIN:'/nonexistent-live-teams-test-cli'},stdio:['ignore','pipe','pipe']});
    exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
    for(let i=0;i<100;i++) {
      const line=output.split('\n').find(line=>line.startsWith('{"trial":'));if(line)return JSON.parse(line);
      if(child.exitCode!==null)throw Error('Trial launcher stopped: '+errors);await delay(40);
    }
    throw Error('Trial launcher startup deadline exceeded');
  };
  const stop=async()=>{child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);const result=await exited;clearTimeout(timer);assert.equal(result.code,0,errors);};
  const status=async run=>{const response=await fetch(run.console+'/api/status',{headers:{authorization:'Bearer '+credentials.SRE_TEAMS_TRIAL_API_TOKEN}});assert.equal(response.status,200);return response.json();};
  try {
    let run=await start();let before=await status(run);
    assert.equal(before.mode,'connected');assert.equal(before.agentMode,'rules');assert.equal(before.teamsMode,'live');assert.ok(before.connections.every(source=>source.enabled===false));
    assert.equal((await fetch(run.console+'/api/status')).status,401);
    for(const authorization of [undefined,'Bearer invalid-not-a-jwt']) {
      const response=await fetch(run.bot+'/api/messages',{method:'POST',headers:{'content-type':'application/json',...(authorization?{authorization}:{})},body:JSON.stringify({type:'message',id:'unsigned-input',text:'join '+run.incidentId,serviceUrl:'https://smba.trafficmanager.net/amer/',conversation:{id:settings.rooms[0].id,conversationType:'channel'},channelData:{tenant:{id:settings.tenantId}}})});
      assert.equal(response.status,401);
    }
    const after=await status(run);assert.deepEqual(after.counts,before.counts,'unauthenticated inputs must not become incident events');assert.equal(after.conversations.length,0);
    assert.equal((await fetch(run.gateway+'/api/messages',{method:'POST',headers:{authorization:'Bearer invalid','content-type':'application/json'},body:'{}'})).status,503);
    assert.equal((await fetch(run.gateway+'/api/status')).status,404);
    const identity=after.sessions.find(session=>session.incident_id===run.incidentId).agent_id,incidentId=run.incidentId;
    await stop();run=await start();before=await status(run);assert.equal(run.incidentId,incidentId);assert.equal(before.sessions.find(session=>session.incident_id===incidentId).agent_id,identity);assert.equal(before.incidents.length,1);
  } finally {if(child&&child.exitCode===null&&child.signalCode===null)await stop();await rm(directory,{recursive:true,force:true});}
});
