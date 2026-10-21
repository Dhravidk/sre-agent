import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { mkdirSync,readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { runProcessRecoveryDrill } from '../fixtures/process-recovery-drill.mjs';

const directory=resolve('.local/deployment-drills','exercise-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));mkdirSync(directory,{recursive:true});
function fingerprint() {
  const files={};
  function walk(path) {for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const name=join(path,entry.name);if(entry.isDirectory())walk(name);else if(entry.isFile())files[name]=createHash('sha256').update(readFileSync(name)).digest('hex');}}
  for(const path of ['src','fixtures','scripts','config'])walk(path);
  for(const name of ['package.json','pnpm-lock.yaml'])files[name]=createHash('sha256').update(readFileSync(name)).digest('hex');
  return files;
}
const sources=fingerprint();writeFileSync(join(directory,'source-fingerprints.json'),JSON.stringify(sources,null,2)+'\n');
const summary={mode:'local-process-recovery-exercise',startedAt:new Date().toISOString(),sourceFingerprint:createHash('sha256').update(JSON.stringify(sources)).digest('hex'),completed:[],failures:[],limitations:'Actual local auction processes/artifact rollout and independent SQLite verification. Provider transports/identities and known-signature reasoning remain fixtures; not live CI/model or production recovery validation.'};
const cases=[
  {scenario:'bid-race',outcome:'recovery-verified',dispatches:1},
  {scenario:'credit-timeout',outcome:'recovery-verified',dispatches:1},
  {scenario:'catalog-latency',outcome:'recovery-verified',dispatches:1},
  {scenario:'late-bid',outcome:'needs-transaction-reconciliation',dispatches:1},
  {scenario:'healthy-release',outcome:'healthy-no-runtime-incident',dispatches:0},
  {scenario:'schema-break',outcome:'rollback-blocked',dispatches:0},
  {scenario:'dependency-outage',outcome:'rollback-blocked',dispatches:0},
  {scenario:'credit-timeout',lostDispatchResponse:true,outcome:'recovery-verified',dispatches:1},
  {scenario:'credit-timeout',sameShaRace:true,outcome:'deployment-race-blocked',dispatches:1},
  {scenario:'credit-timeout',expiredApproval:true,outcome:'recovery-verified',dispatches:2},
  {scenario:'credit-timeout',credentialRotation:true,outcome:'recovery-verified',dispatches:1},
];
for(let i=0;i<cases.length;i++) {
  const item=cases[i],name=item.scenario+(item.lostDispatchResponse?'-lost-response':item.sameShaRace?'-same-sha-race':item.expiredApproval?'-expired-approval':item.credentialRotation?'-credential-rotation':''),path=join(directory,String(i+1).padStart(2,'0')+'-'+name),started=performance.now();
  try {
    const result=await runProcessRecoveryDrill({...item,directory:path,serviceNowMcp:true});assert.equal(result.outcome,item.outcome);assert.equal(result.dispatchCount,item.dispatches);assert.ok(result.processes.every(process=>process.exit&&process.exit.code===0));
    assert.equal(result.serviceNowMcp.enabled,true);if(item.scenario!=='healthy-release')assert.ok(result.serviceNowMcp.calls.some(call=>call.name==='get_incident_details'));
    summary.completed.push({case:name,outcome:result.outcome,dispatches:result.dispatchCount,processes:result.processes.length,serviceNowMcpCalls:result.serviceNowMcp.calls.length,durationMs:Math.round(performance.now()-started),report:join(path,'report.json')});
  } catch(cause){summary.failures.push({case:name,error:cause.message,stack:cause.stack});process.exitCode=1;break;}
  finally {writeFileSync(join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n');}
}
if(JSON.stringify(fingerprint())!==JSON.stringify(sources)){summary.failures.push({error:'Source files changed during the exercise; do not treat the run as one source revision.'});process.exitCode=1;}
summary.finishedAt=new Date().toISOString();writeFileSync(join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({completed:summary.completed.length,failures:summary.failures.length,sourceFingerprint:summary.sourceFingerprint,summary:join(directory,'summary.json')},null,2));
