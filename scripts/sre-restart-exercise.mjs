import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

// Reproduce the old supervisor's missed recovery: crash the worker, restart it,
// then suspend BOTH observer and replacement beyond the old 30-second window.
if(process.platform==='win32')throw Error('This owned-process suspension exercise requires POSIX signals');
const directory=resolve('.local/restart-runs',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));await mkdir(directory,{recursive:true});
const report={mode:'owned-SIGKILL-restart-and-observer-suspension',startedAt:new Date().toISOString(),pauseMs:32000,status:'running',liveProviderCalls:0,modelCalls:0,limitations:'Controlled local process pause; proves resumed work and observation classification, not uninterrupted host availability.'};
const supervisor=spawn(process.execPath,['scripts/sre-soak.mjs','1','1'],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH||'',LANG:'en_US.UTF-8',TZ:'UTC'}});
let buffer='',output='',errors='',paused=false,resumed=false,pauseTimer,activePid,soakPath;
const resume=()=>{if(paused){try{process.kill(activePid,'SIGCONT');}catch{}try{supervisor.kill('SIGCONT');}catch{}paused=false;resumed=true;}};
supervisor.stdout.on('data',chunk=>{
  output+=chunk;buffer+=chunk;
  for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let event;try{event=JSON.parse(line);}catch{continue;}
    if(event.stage==='soak-started')soakPath=event.report;
    if(event.stage==='deliberate-process-crash')report.crashedJobId=event.jobId;
    if(event.stage==='observation-started'&&event.label==='reclaimed question after restart'&&report.crashedJobId&&!resumed&&!paused){activePid=event.pid;report.replacementPid=activePid;process.kill(activePid,'SIGSTOP');supervisor.kill('SIGSTOP');paused=true;report.pausedAt=new Date().toISOString();pauseTimer=setTimeout(resume,report.pauseMs);}
  }
});
supervisor.stderr.on('data',chunk=>{errors+=chunk;});
const timeout=setTimeout(()=>{report.error='Exercise exceeded its 180-second budget';resume();supervisor.kill('SIGTERM');},180000);
try {
  const exit=await new Promise((done,fail)=>{supervisor.once('error',fail);supervisor.once('exit',(code,signal)=>done({code,signal}));});report.supervisorExit=exit;assert.equal(exit.code,0);
  const soak=JSON.parse(await readFile(soakPath));report.soakReport=soakPath;report.soakStatus=soak.status;
  assert.equal(soak.status,'interrupted');assert.ok(soak.observationGaps.some(gap=>gap.label==='reclaimed question after restart'&&gap.gapMs>30000));
  assert.ok(soak.observations.some(x=>x.stage==='session-and-work-recovered'&&x.jobId===report.crashedJobId));assert.ok(soak.cycles.length>=1);
  const db=new DatabaseSync(resolve(soak.directory,'sre.sqlite'),{readOnly:true});try{
    const job=db.prepare('SELECT status,attempts,incident_id FROM sre_jobs WHERE id=?').get(report.crashedJobId);assert.equal(job.status,'done');assert.equal(job.attempts,2);
    const session=db.prepare('SELECT agent_id FROM sre_sessions WHERE incident_id=?').get(job.incident_id);assert.equal(session.agent_id,soak.cycles.find(c=>c.incidentId===job.incident_id).session);report.recoveredJob={...job,sameAgentIdentity:true};
  }finally{db.close();}
  assert.ok(soak.processes.every(p=>p.exit));report.processes=soak.processes;report.observationGaps=soak.observationGaps;report.status='passed-resumed-work-and-honest-interruption-classification';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{clearTimeout(timeout);clearTimeout(pauseTimer);resume();report.finishedAt=new Date().toISOString();await writeFile(directory+'/supervisor.log',output);await writeFile(directory+'/supervisor.stderr',errors);await writeFile(directory+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,report:directory+'/report.json',recoveredJob:report.recoveredJob,error:report.error}));}
