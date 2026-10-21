import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedPilot } from '../scripts/seed-pilot.mjs';
import { buildArtifact } from '../fixtures/deployment/artifacts.mjs';
import { LocalAuctionSandbox } from '../fixtures/deployment/sandbox.mjs';
import { GithubConnector,GitlabConnector } from '../src/sre/connectors.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { createSreRuntime } from '../src/sre/server.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { seedDemo } from '../src/sre/demo.mjs';
import { Rollbacks } from '../src/sre/rollback.mjs';
import { hash } from '../src/sre/security.mjs';
import { WorkflowApprovalError } from '../src/sre/workflow-contract.mjs';

async function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'workflow-approval-')),pilot=seedPilot();
  const baseline=await buildArtifact(join(directory,'artifacts'),pilot.baseline),fault=await buildArtifact(join(directory,'artifacts'),pilot.releases['credit-timeout'].sha);
  const sandbox=new LocalAuctionSandbox(directory,[baseline,fault]);
  await sandbox.deployFixture(baseline);const list=(await sandbox.json('/api/lots')).data;
  assert.equal((await sandbox.json('/api/lots/'+list[0].id+'/bids',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'baseline'},body:JSON.stringify({amountCents:list[0].currentBidCents+10000,dealer:'Synthetic approval tester'})})).status,201);
  await sandbox.markHealthyTarget();const current=await sandbox.deployFixture(fault);
  return {directory,sandbox,baseline,current,close:async()=>{await sandbox.close();rmSync(directory,{recursive:true,force:true});}};
}
const request=(f,approval)=>({requestId:'approval-expiry',environment:f.sandbox.environment,expected:{sha:f.current.sha,artifact:f.current.artifact,deploymentId:f.current.deploymentId,deploymentAt:f.current.at},target:{sha:f.baseline.sha,artifact:f.baseline.artifact},approval});

test('an approval that expires before the workflow starts cannot replace the running process',async()=>{
  const f=await fixture();
  try {
    const before=await f.sandbox.identity(),result=await f.sandbox.rollback(request(f,{approvedAt:Date.now()-2000,expiresAt:Date.now()-1})).then(value=>({value}),error=>({error}));
    assert.ok(result.error,'Expired approval executed: '+JSON.stringify({beforePid:before.pid,afterPid:(await f.sandbox.identity()).pid,deployments:f.sandbox.history().length}));
    assert.match(result.error.message,/approval.*expired/i);assert.equal((await f.sandbox.identity()).pid,before.pid);assert.equal(f.sandbox.history().length,2);
    assert.equal(f.sandbox.requests()[0].status,'blocked');
  } finally{await f.close();}
});
for(const provider of ['github','gitlab'])test(provider+' rejects missing approval timestamps before obtaining credentials or writing',async()=>{
  let calls=0;
  const configuration={base:'https://provider.invalid',repository:'synthetic/auction',project:'17',tokenEnv:'TOKEN',workflow:'rollback.yml',ref:'main'};
  const client=new (provider==='github'?GithubConnector:GitlabConnector)(configuration,{env:{TOKEN:'synthetic'},fetcher:async()=>{calls++;return new Response(provider==='github'?null:JSON.stringify({id:1}),{status:provider==='github'?204:201,headers:{'content-type':'application/json'}});}});
  const proposal={id:'rb-missing-approval',environment:'local',current:{sha:'a'.repeat(40),artifact:'sha256:'+'c'.repeat(64),at:1234,deploymentId:'1'},target:{sha:'b'.repeat(40),artifact:'sha256:'+'d'.repeat(64)}};
  await assert.rejects(()=>client.dispatch(proposal),/approval/i);assert.equal(calls,0);
});
for(const provider of ['github','gitlab'])test(provider+' refuses expired, future, reversed, fractional and nonnumeric approval windows without a write',async()=>{
  let calls=0;const now=Date.now();
  const client=new (provider==='github'?GithubConnector:GitlabConnector)({base:'https://provider.invalid',repository:'synthetic/auction',project:'17',tokenEnv:'TOKEN',workflow:'rollback.yml',ref:'main'},{env:{TOKEN:'synthetic'},clock:()=>now,fetcher:async()=>{calls++;throw new Error('No invalid approval may reach the network');}});
  const proposal={id:'rb-invalid-window',environment:'local',current:{sha:'a'.repeat(40),artifact:'sha256:'+'c'.repeat(64),at:1234,deploymentId:'1'},target:{sha:'b'.repeat(40),artifact:'sha256:'+'d'.repeat(64)}};
  for(const approval of [
    {approvedAt:now-2000,expiresAt:now-1},{approvedAt:now+1,expiresAt:now+1000},
    {approvedAt:now,expiresAt:now},{approvedAt:now,expiresAt:now-100},
    {approvedAt:now-.5,expiresAt:now+1000},{approvedAt:String(now),expiresAt:now+1000},
    {approvedAt:now,expiresAt:Infinity},{approvedAt:-1,expiresAt:now+1000},
  ])await assert.rejects(()=>client.dispatch({...proposal,approval}),/approval/i);
  assert.equal(calls,0);
});
test('approval expiry while queued is checked after acquiring the workflow serial lock',async()=>{
  const f=await fixture();
  try {
    const pid=(await f.sandbox.identity()).pid,now=Date.now();
    const queued=f.sandbox.serial(()=>delay(200));
    const rejected=f.sandbox.rollback(request(f,{approvedAt:now,expiresAt:now+100})).then(value=>({value}),error=>({error}));
    await queued;assert.match((await rejected).error?.message||'',/approval.*expired/i);
    assert.equal((await f.sandbox.identity()).pid,pid);assert.equal(f.sandbox.history().length,2);
  } finally {await f.close();}
});
test('approval expiry during preflight is rechecked before stopping the current process',async()=>{
  const f=await fixture();
  try {
    const identity=f.sandbox.identity.bind(f.sandbox),pid=(await identity()).pid;let entered=false;
    f.sandbox.identity=async()=>{const value=await identity();entered=true;await delay(200);return value;};
    const now=Date.now();await assert.rejects(()=>f.sandbox.rollback(request(f,{approvedAt:now,expiresAt:now+150})),/approval.*expired/i);
    assert.equal(entered,true);assert.equal((await identity()).pid,pid);assert.equal(f.sandbox.history().length,2);
  } finally {await f.close();}
});
test('an exact completed receipt remains readable after expiry and cannot be extended into a second action',async()=>{
  const f=await fixture();
  try {
    const now=Date.now(),approval={approvedAt:now,expiresAt:now+1000},input=request(f,approval),first=await f.sandbox.rollback(input);
    await delay(Math.max(0,approval.expiresAt-Date.now()+5));const pid=(await f.sandbox.identity()).pid;
    const repeated=await f.sandbox.rollback(input);assert.equal(repeated.duplicate,true);assert.equal(repeated.deployment.deploymentId,first.deployment.deploymentId);
    await assert.rejects(()=>f.sandbox.rollback({...input,approval:{...approval,expiresAt:Date.now()+60000}}),/reused with different content/);
    assert.equal((await f.sandbox.identity()).pid,pid);assert.equal(f.sandbox.history().length,3);assert.equal(f.sandbox.requests().length,1);
  } finally {await f.close();}
});
for(const version of [2,3])test('an approved version-'+version+' proposal without the coordination policy is invalidated before dispatch',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),runtime=await createSreRuntime({config,autoStart:false}),service=config.services[0];
  try {
    const {incidentId}=await seedDemo(runtime.store,service);await runtime.worker.runOnce();let writes=0;
    const executor=new Rollbacks({store:runtime.store,services:[service],mode:'connected',connectors:new Map([[service.key,{github:{deployments:async()=>({items:(await runtime.store.context(incidentId)).deployments,complete:true})},rollback:{dispatch:async()=>{writes++;return {};}}}]])});
    const principal={verified:true,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0],userId:'local-operator'};
    const proposed=await executor.propose(incidentId,principal);await executor.approve(proposed.id,proposed.text.split(' ').at(-1),principal);
    const [row]=await runtime.store.db.query('SELECT proposal FROM sre_rollbacks WHERE id=?',[proposed.id]),old=JSON.parse(row.proposal);
    old.policyHash=hash({dispatchContractVersion:version,policy:service.rollback,scope:old.scope,tenant:service.tenant});
    await runtime.store.db.query('UPDATE sre_rollbacks SET proposal=? WHERE id=?',[JSON.stringify(old),proposed.id]);
    await executor.executeNext();assert.equal(writes,0);assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'blocked');
  } finally{await runtime.close();}
});
for(const mode of ['expired-at-connector','missing-stored-time'])test(mode+': local preflight after dispatch intent is blocked with zero provider writes',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),runtime=await createSreRuntime({config,autoStart:false}),service=config.services[0];
  try {
    const {incidentId}=await seedDemo(runtime.store,service);await runtime.worker.runOnce();let writes=0,connectorNow;
    const connector=new GithubConnector({repository:service.github.repository,tokenEnv:'TOKEN',workflow:'rollback.yml',ref:'main'},{env:{TOKEN:'synthetic'},clock:()=>connectorNow,fetcher:async()=>{writes++;throw new Error('Expired approval cannot reach the provider');}});
    const executor=new Rollbacks({store:runtime.store,services:[service],mode:'connected',connectors:new Map([[service.key,{github:{deployments:async()=>({items:(await runtime.store.context(incidentId)).deployments,complete:true})},rollback:connector}]])});
    const principal={verified:true,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0],userId:'local-operator'},proposal=await executor.propose(incidentId,principal);
    await executor.approve(proposal.id,proposal.text.split(' ').at(-1),principal);connectorNow=proposal.expiresAt+1;
    if(mode==='missing-stored-time')await runtime.store.db.query('UPDATE sre_rollbacks SET approved_at=NULL WHERE id=?',[proposal.id]);
    await executor.executeNext();assert.equal(writes,0);const row=(await runtime.store.snapshot()).rollbacks[0];assert.equal(row.status,'blocked');assert.match(row.error,/approval/i);
  } finally{await runtime.close();}
});
test('an approval-shaped error after the HTTP write attempt remains uncertain and cannot trigger another dispatch',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),runtime=await createSreRuntime({config,autoStart:false}),service=config.services[0];
  try {
    const {incidentId}=await seedDemo(runtime.store,service);await runtime.worker.runOnce();let writes=0;
    const connector=new GithubConnector({repository:service.github.repository,tokenEnv:'TOKEN',workflow:'rollback.yml',ref:'main'},{env:{TOKEN:'synthetic'},fetcher:async()=>{writes++;throw new WorkflowApprovalError('Remote request outcome is unknown');}});
    const executor=new Rollbacks({store:runtime.store,services:[service],mode:'connected',connectors:new Map([[service.key,{github:{deployments:async()=>({items:(await runtime.store.context(incidentId)).deployments,complete:true})},rollback:connector}]])});
    const principal={verified:true,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0],userId:'local-operator'},proposal=await executor.propose(incidentId,principal);
    await executor.approve(proposal.id,proposal.text.split(' ').at(-1),principal);await executor.executeNext();
    assert.equal(writes,1);assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'unknown');
    assert.equal(await executor.executeNext(),false);assert.equal(writes,1);
  } finally{await runtime.close();}
});
