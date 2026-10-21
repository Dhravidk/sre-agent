import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, openSync, closeSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { seedPilot, loadRelease, pilotDiff, pilotPolicySource } from './seed-pilot.mjs';
import { Auction } from '../src/auction/service.mjs';
import { releases } from '../src/sre/rollback.mjs';
import { hash } from '../src/sre/security.mjs';
import { waitForObservation } from './soak-wait.mjs';

const minutes=Number(process.argv[2]||360),crashEvery=Number(process.argv[3]||6);
if(!Number.isFinite(minutes)||minutes<1||minutes>1440||!Number.isInteger(crashEvery)||crashEvery<1||crashEvery>1000)throw new Error('Use sre-soak.mjs <minutes 1–1440> <crash frequency 1–1000 cycles>');
const root=fileURLToPath(new URL('..',import.meta.url)),run=randomUUID().slice(0,8);
const directory=resolve('.local/soak-runs',new Date().toISOString().replaceAll(':','-')+'-'+run);mkdirSync(directory,{recursive:true});
const statePath=join(directory,'state.json'),reportPath=join(directory,'report.json'),databasePath=join(directory,'sre.sqlite');
const frozenRoot=join(directory,'runtime');mkdirSync(join(frozenRoot,'scripts'),{recursive:true});mkdirSync(join(frozenRoot,'fixtures'),{recursive:true});
for(const name of ['src','config','package.json','pnpm-lock.yaml'])cpSync(join(root,name),join(frozenRoot,name),{recursive:true});
for(const name of ['scripts/seed-pilot.mjs','scripts/sre-soak.mjs','scripts/soak-wait.mjs','fixtures/soak-runtime.mjs'])cpSync(join(root,name),join(frozenRoot,name));
const sourceFiles={};
function fingerprint(folder,prefix='') {for(const entry of readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const name=prefix+entry.name;if(entry.isDirectory())fingerprint(join(folder,entry.name),name+'/');else if(entry.isFile())sourceFiles[name]=hash(readFileSync(join(folder,entry.name)).toString('base64'));}}
fingerprint(frozenRoot);writeFileSync(join(directory,'source-fingerprints.json'),JSON.stringify(sourceFiles,null,2)+'\n');
const manifest=seedPilot(),fault=manifest.releases['credit-timeout'];
const baselineRules=await loadRelease(manifest.baseline),faultRules=await loadRelease(fault.sha);
const digest=sha=>'sha256:'+hash(['server.mjs','src/auction/service.mjs','src/auction/rules.mjs'].map(path=>[path,execFileSync('git',['-C',manifest.repository,'show',sha+':'+path],{encoding:'utf8'})]));
const artifacts={[manifest.baseline]:digest(manifest.baseline),[fault.sha]:digest(fault.sha)};
const state={apiToken:randomBytes(24).toString('hex'),capabilitySecret:randomBytes(32).toString('hex'),releaseSecret:randomBytes(32).toString('hex'),healthSecret:randomBytes(32).toString('hex'),baselineSha:manifest.baseline,faultSha:fault.sha,policySources:{[manifest.baseline]:pilotPolicySource(manifest.baseline),[fault.sha]:pilotPolicySource(fault.sha)},diff:pilotDiff(fault.sha),deployments:[],problems:[],incidents:[],failDynatrace:false,reasonerDelayMs:0};
const report={mode:'offline-real-clock-process-soak',run,directory,pid:process.pid,status:'running',requestedMinutes:minutes,crashEveryCycles:crashEvery,startedAt:new Date().toISOString(),sourceFingerprint:hash(sourceFiles),frozenRuntime:frozenRoot,cycles:[],crashes:[],processes:[],observations:[],failures:[],maxChildRssBytes:0,limitations:['Provider methods and identities are synthetic; the service, HTTP API, SQLite, scheduler and OS process lifecycle are real.','Known auction fixture and deterministic rules; no live vendor/model or production recovery validation.','The fixture uses a five-second worker lease, ten-second polls, thirty-second active reconciliation, disabled rollback execution, and a retained provider deployment window of twenty records.','Runtime source/configuration is frozen for this run. Installed dependencies remain shared at the pinned lockfile versions.']};
let child,base,childExit,logFd,stopping=false,sequence=0;
const save=()=>{report.lastObservedAt=new Date().toISOString();report.elapsedSeconds=Math.round((Date.now()-Date.parse(report.startedAt))/1000);writeFileSync(reportPath+'.tmp',JSON.stringify(report,null,2)+'\n');renameSync(reportPath+'.tmp',reportPath);};
const snapshot=()=>{writeFileSync(statePath+'.tmp',JSON.stringify(state)+'\n');renameSync(statePath+'.tmp',statePath);save();};
const note=(stage,extra={})=>{const item={at:new Date().toISOString(),stage,pid:child?.pid,...extra};report.observations.push(item);if(report.observations.length>500)report.observations.shift();save();console.log(JSON.stringify(item));};
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});

async function start() {
  logFd=openSync(join(directory,'child-'+(report.processes.length+1)+'.log'),'a');
  child=spawn(process.execPath,[join(frozenRoot,'fixtures/soak-runtime.mjs'),statePath,databasePath],{cwd:frozenRoot,env:{PATH:process.env.PATH||'',LANG:process.env.LANG||'en_US.UTF-8',TZ:'UTC',NODE_ENV:'test'},stdio:['ignore',logFd,logFd,'ipc']});
  const active=child;
  childExit=new Promise(resolveExit=>active.once('exit',(code,signal)=>resolveExit({code,signal,pid:active.pid})));
  const ready=await new Promise((accept,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Child startup did not report readiness')),15000);
    active.once('error',error=>{clearTimeout(timer);reject(error);});
    active.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error('Child exited before readiness: '+code+'/'+signal));});
    active.on('message',message=>{
      if(message.type==='ready'){clearTimeout(timer);accept(message);}
      if(message.type==='stats'){report.maxChildRssBytes=Math.max(report.maxChildRssBytes,message.rss);report.latestMemory={pid:message.pid,at:message.at,rss:message.rss,heapUsed:message.heapUsed};save();}
    });
  });
  base='http://127.0.0.1:'+ready.port;report.processes.push({pid:ready.pid,port:ready.port,startedAt:new Date().toISOString()});note('process-ready');
}
async function stop(signal='SIGTERM') {
  if(!child)return;
  const active=child;
  if(active.exitCode===null&&active.signalCode===null)active.kill(signal);
  let timer;
  const outcome=await Promise.race([childExit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned child did not stop')),10000);})]).finally(()=>clearTimeout(timer));
  report.processes.at(-1).exit=outcome;if(logFd!==undefined){closeSync(logFd);logFd=undefined;}child=null;save();return outcome;
}
async function api(path,body) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{authorization:'Bearer '+state.apiToken,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();assert.ok(response.ok,JSON.stringify({path,status:response.status,data}));return data;
}
async function waitFor(label,fn,timeout=30000) {
  return waitForObservation(label,fn,{timeout,alive:()=>Boolean(child&&child.exitCode===null&&child.signalCode===null),stopping:()=>stopping,onStart:()=>{if(label==='reclaimed question after restart')note('observation-started',{label});},onGap:gap=>{
    (report.observationGaps??=[]).push(gap);note('observation-interrupted',gap);
  }});
}
function deployment(sha,at,healthy=false) {
  const item={id:String(++sequence),deploymentId:String(sequence),provider:'github',repository:'synthetic/auction-soak',environment:'local',sha,artifact:artifacts[sha],at,status:'success',healthy,healthVerifiedAt:healthy?at+1:null,rollbackCompatible:true,dataRollbackSafe:true,schemaVersion:1,dependencyFingerprint:'fixture-deps',configurationFingerprint:'fixture-config',featureFlagsFingerprint:'fixture-flags'};
  state.deployments.push(item);state.deployments=state.deployments.slice(-20);return item;
}
async function signed(source,payload,secret) {
  const body=JSON.stringify(payload),timestamp=String(Date.now());
  const response=await fetch(base+'/webhooks/'+source+'/auction-soak',{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'x-sre-timestamp':timestamp,'x-sre-event-id':randomUUID(),'x-sre-signature':'sha256='+createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex')},body});
  const result=await response.json();assert.equal(response.status,202,JSON.stringify(result));return result;
}
async function measuredTraffic(auction) {
  const lot=auction.lots[0];for(let i=0;i<3;i++)await auction.bid(lot.id,lot.currentBidCents+10000,'Synthetic dealer',randomUUID());return auction.telemetry();
}

console.log(JSON.stringify({stage:'soak-started',pid:process.pid,minutes,report:reportPath}));snapshot();
try {
  const deadline=Date.now()+minutes*60000;
  while(!stopping&&(Date.now()<deadline||report.cycles.length===0)) {
    const cycle=report.cycles.length+1,started=Date.now(),historical=cycle===1?3600000:0;
    const auction=new Auction({rules:faultRules}),metrics=await measuredTraffic(auction);
    assert.deepEqual(metrics.codes,['CREDIT_TIMEOUT']);
    if(cycle===1)deployment(manifest.baseline,started-historical-120000,true);
    deployment(fault.sha,started-historical-1000);
    const problemId='P-SOAK-'+run+'-'+cycle,sysId=hash(problemId).slice(0,32);
    state.problems=[{ProblemID:problemId,State:'OPEN',Title:'Synthetic measured credit timeout',EntityIds:['SERVICE-AUCTION'],StartedAt:started-historical,ObservedAt:started-historical,metrics}];
    state.incidents=[{sys_id:sysId,number:'INC-SOAK-'+cycle,cmdb_ci:'1'.repeat(32),correlation_id:'dynatrace:'+problemId,state:'2',short_description:'Synthetic credit-check failures',sys_created_on:new Date(started-historical).toISOString(),sys_updated_on:new Date(started-historical).toISOString()}];
    state.failDynatrace=false;state.reasonerDelayMs=0;snapshot();
    if(!child)await start();
    const incident=await waitFor('incident investigation',async()=>{const data=await api('/api/status');return data.incidents.find(item=>item.issue_key==='dynatrace:'+problemId&&item.analysis?.changeAssessment==='likely');});
    assert.equal(incident.analysis.rollback.eligible,false,'The soak must keep rollback execution disabled');
    const context=await api('/api/incidents/'+incident.id),session=context.session.agent_id;
    note('incident-investigated',{cycle,incidentId:incident.id,session});
    if((cycle-1)%crashEvery===0) {
      state.reasonerDelayMs=2500;snapshot();
      const question=await api('/api/incidents/'+incident.id+'/questions',{text:'Recheck the measured credit timeout and preserve this session across a restart.'});
      const jobId=hash(['investigate',question.eventId,incident.id]);
      await waitFor('running question before deliberate crash',async()=>{const data=await api('/api/status');return data.jobs.find(item=>item.id===jobId&&item.status==='running');});
      const killed=await stop('SIGKILL');report.crashes.push({at:new Date().toISOString(),cycle,pid:killed.pid,signal:killed.signal,jobId});note('deliberate-process-crash',{cycle,jobId});
      await start();
      await waitFor('reclaimed question after restart',async()=>{const data=await api('/api/status');return data.jobs.find(item=>item.id===jobId&&item.status==='done');});
      assert.equal((await api('/api/incidents/'+incident.id)).session.agent_id,session);note('session-and-work-recovered',{cycle,jobId});
      state.reasonerDelayMs=0;snapshot();
    }
    const outageAt=Date.now();state.failDynatrace=true;state.incidents[0].sys_updated_on=new Date(outageAt).toISOString();snapshot();
    const sourceFault=await waitFor('telemetry access failure on the current instance',async()=>{
      const data=await api('/api/operations'),failure=data.conditions.find(item=>item.key==='reader:dynatrace:auction-soak'&&item.code==='instance_poll_error'&&item.scope==='instance');
      const local=data.localSources?.find(item=>item.id==='dynatrace:auction-soak');
      return failure&&local?.error?.includes('HTTP 401')&&local.failedAt>=outageAt?{runtimeId:data.runtimeId,condition:failure.code,scope:failure.scope,failedAt:local.failedAt}:null;
    });
    await waitFor('independent ServiceNow polling during Dynatrace failure',async()=>{const data=await api('/api/status'),item=data.connections.find(entry=>entry.source==='servicenow');return item?.checkpoint&&JSON.parse(item.checkpoint).successAt>=outageAt;});
    note('polling-fault-isolated',{cycle,...sourceFault});
    state.failDynatrace=false;auction.rules=baselineRules;auction.samples=[];
    const recoveredMetrics=await measuredTraffic(auction);assert.equal(recoveredMetrics.errors,0);assert.equal(recoveredMetrics.violations.length,0);
    const deployed=deployment(manifest.baseline,Date.now(),false),closedAt=Date.now();
    state.problems[0]={...state.problems[0],State:'CLOSED',ObservedAt:closedAt,metrics:recoveredMetrics};
    state.incidents[0]={...state.incidents[0],state:'6',sys_updated_on:new Date(closedAt).toISOString()};snapshot();
    await signed('releases',deployed,state.releaseSecret);
    await waitFor('all incident sources closed',async()=>{const item=(await api('/api/incidents/'+incident.id)).incident;return item.status==='verifying';});
    const latest=releases((await api('/api/incidents/'+incident.id)).deployments)[0];assert.equal(latest.sha,manifest.baseline);
    await signed('verification',{id:'soak-health-'+cycle,incidentId:incident.id,environment:'local',healthy:true,sha:latest.sha,artifact:latest.artifact,deploymentId:latest.deploymentId??latest.id,deploymentAt:latest.at,observedAt:Date.now(),checks:{technical:recoveredMetrics.requests>0&&recoveredMetrics.errors===0&&recoveredMetrics.p95Ms<=250,businessInvariants:recoveredMetrics.violations.length===0},evidenceUrl:'https://synthetic-verifier.invalid/soak/'+run+'/'+cycle},state.healthSecret);
    await waitFor('verified incident recovery and healthy agent checks',async()=>{const status=await api('/api/status');assert.equal(status.incidents.find(item=>item.id===incident.id).status,'resolved');assert.equal(status.rollbacks.length,0);return status.operations.state==='healthy';});
    report.cycles.push({cycle,incidentId:incident.id,session,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),elapsedSeconds:Math.round((Date.now()-started)/1000),outcome:'recovery-verified',originalIncidentAgeSeconds:historical/1000,measuredRecovery:{requests:recoveredMetrics.requests,errors:recoveredMetrics.errors,p95Ms:recoveredMetrics.p95Ms,violations:recoveredMetrics.violations}});note('cycle-complete',{cycle});
    if(report.observationGaps?.length){report.interruptionReason='Supervisor observation gap; resumed recovery checked, uninterrupted uptime not established';break;}
    if(report.maxChildRssBytes>1024*1024*1024)throw new Error('Owned child exceeded the one-GiB fixture RSS guard');
    for(let i=0;i<10&&!stopping&&Date.now()<deadline;i++)await delay(1000);
  }
  report.status=stopping||report.observationGaps?.length?'interrupted':'passed';
} catch(error) {
  report.status=error.interrupted?'interrupted':'failed';
  if(!error.interrupted){report.failures.push({at:new Date().toISOString(),error:error.message,stack:error.stack});process.exitCode=1;}
} finally {
  try{await stop();}catch(error){report.failures.push({at:new Date().toISOString(),error:error.message});report.status='failed';process.exitCode=1;}
  report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({stage:'soak-finished',status:report.status,cycles:report.cycles.length,crashes:report.crashes.length,elapsedSeconds:report.elapsedSeconds,report:reportPath}));
}
