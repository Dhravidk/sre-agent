import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedPilot } from '../scripts/seed-pilot.mjs';
import { buildArtifact } from '../fixtures/deployment/artifacts.mjs';
import { LocalAuctionSandbox } from '../fixtures/deployment/sandbox.mjs';

async function fixture(scenario='credit-timeout') {
  const directory=mkdtempSync(join(tmpdir(),'local-auction-deploy-')),pilot=seedPilot();
  const baseline=await buildArtifact(join(directory,'artifacts'),pilot.baseline),fault=await buildArtifact(join(directory,'artifacts'),pilot.releases[scenario].sha);
  const sandbox=new LocalAuctionSandbox(directory,[baseline,fault]);
  return {directory,baseline,fault,sandbox,close:async()=>{await sandbox.close();rmSync(directory,{recursive:true,force:true});}};
}
async function lots(sandbox) {return (await sandbox.json('/api/lots')).data;}
async function bid(sandbox,lot,amount,{id=randomUUID(),processingMs=15,dealer='Synthetic dealer'}={}) {return sandbox.json('/api/lots/'+lot.id+'/bids',{method:'POST',headers:{'content-type':'application/json','idempotency-key':id},body:JSON.stringify({amountCents:amount,dealer,processingMs})});}
async function healthy(f) {await f.sandbox.deployFixture(f.baseline);const list=await lots(f.sandbox);const result=await bid(f.sandbox,list[0],list[0].currentBidCents+10000);assert.equal(result.status,201);return f.sandbox.markHealthyTarget();}
const rollback=(f,current,id='rollback-fixture')=>({requestId:id,environment:f.sandbox.environment,expected:{sha:current.sha,artifact:current.artifact,deploymentId:current.deploymentId,deploymentAt:current.deploymentAt},target:{sha:f.baseline.sha,artifact:f.baseline.artifact},approval:{approvedAt:Date.now(),expiresAt:Date.now()+600000}});

test('accepted bid and idempotency receipt survive a lost response, SIGKILL, and actual artifact rollback',async()=>{
  const f=await fixture();
  try {
    await healthy(f);const list=await lots(f.sandbox),request={id:'lost-ack',dealer:'Response-lost dealer'},amount=list[0].currentBidCents+10000;
    await f.sandbox.control('drop-next-response');await assert.rejects(()=>bid(f.sandbox,list[0],amount,request));
    const committed=(await lots(f.sandbox))[0];assert.equal(committed.bids.length,2);
    const oldPid=(await f.sandbox.identity()).pid;await f.sandbox.restartCurrent();assert.notEqual((await f.sandbox.identity()).pid,oldPid);
    const repeated=await bid(f.sandbox,list[0],amount,request);assert.equal(repeated.status,201);assert.equal((await lots(f.sandbox))[0].bids.length,2);
    assert.equal((await bid(f.sandbox,list[0],amount+10000,request)).status,409);
    const current=await f.sandbox.deployFixture(f.fault);
    const broken=await bid(f.sandbox,committed,committed.currentBidCents+10000);assert.equal(broken.status,504);
    const result=await f.sandbox.rollback(rollback(f,current));assert.equal(result.deployment.sha,f.baseline.sha);
    assert.equal((await lots(f.sandbox))[0].bids.length,2);assert.equal((await lots(f.sandbox))[0].currentBidCents,amount);
    assert.equal((await bid(f.sandbox,list[0],amount,request)).status,201);assert.equal((await lots(f.sandbox))[0].bids.length,2);
  } finally {await f.close();}
});

test('local rollout drains an in-flight accepted bid before replacing its process',async()=>{
  const f=await fixture();
  try {
    await healthy(f);const list=await lots(f.sandbox),id='in-flight-replacement';
    const entered=new Promise(resolve=>{const onMessage=message=>{if(message.type==='bid-started'&&message.requestId===id){f.sandbox.child.off('message',onMessage);resolve();}};f.sandbox.child.on('message',onMessage);});
    const bidding=bid(f.sandbox,list[0],list[0].currentBidCents+10000,{id,processingMs:150});await entered;
    const replacing=f.sandbox.deployFixture(f.fault);
    const result=await bidding;assert.equal(result.status,201);await replacing;
    const after=(await lots(f.sandbox))[0];assert.equal(after.bids.length,2);assert.equal(after.currentBidCents,result.data.lot.currentBidCents);
    assert.equal(f.sandbox.processes[0].exit.code,0);
  } finally {await f.close();}
});

test('same-SHA redeployment blocks an earlier request before stopping the newer process',async()=>{
  const f=await fixture();
  try {
    await healthy(f);const first=await f.sandbox.deployFixture(f.fault),request=rollback(f,first);
    const latest=await f.sandbox.deployFixture(f.fault),pid=(await f.sandbox.identity()).pid;
    assert.equal(first.sha,latest.sha);assert.notEqual(first.deploymentId,latest.deploymentId);
    await assert.rejects(()=>f.sandbox.rollback(request),/Actual deployment changed/);
    assert.equal((await f.sandbox.identity()).pid,pid);assert.equal(f.sandbox.history().length,3);assert.equal(f.sandbox.requests()[0].status,'blocked');
  } finally {await f.close();}
});

test('changed retained artifact bytes are rejected before the running process is stopped',async()=>{
  const f=await fixture();
  try {
    await healthy(f);const current=await f.sandbox.deployFixture(f.fault),pid=(await f.sandbox.identity()).pid;
    const path=join(f.baseline.path,'runtime.mjs');chmodSync(path,0o644);writeFileSync(path,readFileSync(path,'utf8')+'\n// tampered retained fixture\n');
    await assert.rejects(()=>f.sandbox.rollback(rollback(f,current)),/artifact bytes changed/);
    assert.equal((await f.sandbox.identity()).pid,pid);assert.equal(f.sandbox.history().length,2);
  } finally {await f.close();}
});

test('incompatible schema/data metadata blocks local rollback while preserving accepted transactions',async()=>{
  const f=await fixture('schema-break');
  try {
    await healthy(f);const current=await f.sandbox.deployFixture(f.fault),list=await lots(f.sandbox);
    assert.equal((await bid(f.sandbox,list[0],list[0].currentBidCents+10000)).data.code,'SCHEMA_MISMATCH');
    await assert.rejects(()=>f.sandbox.rollback(rollback(f,current)),/compatibility checks failed/);
    assert.equal((await lots(f.sandbox))[0].bids.length,1);assert.equal(f.sandbox.history().length,2);
  } finally {await f.close();}
});

test('concurrent duplicate workflow requests redeploy once and preserve a durable receipt',async()=>{
  const f=await fixture();
  try {
    await healthy(f);const current=await f.sandbox.deployFixture(f.fault),request=rollback(f,current);
    const results=await Promise.all([f.sandbox.rollback(request),f.sandbox.rollback(request),f.sandbox.rollback(request)]);
    assert.equal(results.filter(item=>!item.duplicate).length,1);assert.equal(new Set(results.map(item=>item.deployment.deploymentId)).size,1);
    assert.equal(f.sandbox.history().length,3);assert.equal(f.sandbox.requests().length,1);
    await assert.rejects(()=>f.sandbox.rollback({...request,target:{...request.target,sha:current.sha}}),/reused with different content/);
    assert.equal(f.sandbox.history().length,3);
  } finally {await f.close();}
});

test('corrupt retained state fails startup instead of resetting accepted auction data',async()=>{
  const f=await fixture();let second;
  try {
    await healthy(f);await f.sandbox.close();
    const path=join(f.directory,'auction.sqlite'),db=new DatabaseSync(path);
    const corrupted=JSON.stringify({format:1,lots:[],dataSchemaVersion:1});db.prepare('UPDATE auction_state SET payload=? WHERE id=1').run(corrupted);db.close();
    second=new LocalAuctionSandbox(f.directory,[f.baseline,f.fault]);
    await assert.rejects(()=>second.deployFixture(f.baseline),/before readiness/);
    const inspect=new DatabaseSync(path,{readOnly:true});assert.equal(inspect.prepare('SELECT payload FROM auction_state WHERE id=1').get().payload,corrupted);inspect.close();
    assert.ok(second.processes[0].exit);assert.equal(second.history().at(-1).status,'failed');
  } finally {await second?.close();await f.close();}
});

test('healthy target requires an accepted business probe and an independent matching bid ledger',async()=>{
  const f=await fixture();
  try {
    await f.sandbox.deployFixture(f.baseline);const list=await lots(f.sandbox);
    await assert.rejects(()=>f.sandbox.markHealthyTarget(),/do not establish a healthy target/);
    assert.equal((await bid(f.sandbox,list[0],list[0].currentBidCents)).status,409);
    await assert.rejects(()=>f.sandbox.markHealthyTarget(),/do not establish a healthy target/);
    assert.equal((await bid(f.sandbox,list[0],list[0].currentBidCents+10000)).status,201);await f.sandbox.markHealthyTarget();
    const db=new DatabaseSync(join(f.sandbox.directory,'auction.sqlite'));db.exec('DELETE FROM auction_requests');db.close();
    // Application memory/metrics still look healthy. The separate store reader must detect the lost receipts.
    assert.deepEqual((await f.sandbox.json('/metrics')).data.violations,[]);
    assert.deepEqual(f.sandbox.inspectStore().violations,['ACCEPTED_BID_LEDGER_MISMATCH']);
    await assert.rejects(()=>f.sandbox.markHealthyTarget(),/do not establish a healthy target/);
  } finally {await f.close();}
});
