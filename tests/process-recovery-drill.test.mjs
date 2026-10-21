import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcessRecoveryDrill } from '../fixtures/process-recovery-drill.mjs';

for(const [scenario,outcome,dispatches] of [
  ['bid-race','recovery-verified',1],
  ['credit-timeout','recovery-verified',1],
  ['catalog-latency','recovery-verified',1],
  ['late-bid','needs-transaction-reconciliation',1],
  ['healthy-release','healthy-no-runtime-incident',0],
  ['schema-break','rollback-blocked',0],
  ['dependency-outage','rollback-blocked',0],
])test('real local process deployment/recovery through the agent: '+scenario,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'process-recovery-'));
  try {
    const result=await runProcessRecoveryDrill({scenario,directory});
    assert.equal(result.outcome,outcome);assert.equal(result.dispatchCount,dispatches);
    assert.equal(result.codeFindings.length,['dependency-outage','healthy-release'].includes(scenario)?0:1);
    assert.ok(result.processes.every(item=>item.exit&&item.exit.code===0),'Every owned service process must exit cleanly');
    if(outcome==='recovery-verified') {
      assert.equal(result.processes.length,3);assert.equal(new Set(result.processes.map(item=>item.pid)).size,3);
      assert.equal(result.processes[0].sha,result.processes.at(-1).sha);assert.notEqual(result.processes[0].sha,result.processes[1].sha);
      assert.equal(result.stages.at(-1).rollbackStatus,'verified');assert.ok(result.retainedBids.length>=1);
      assert.equal(result.workflowRequests.length,1);assert.equal(result.workflowRequests[0].status,'complete');
      assert.ok(result.stages.some(item=>item.name==='agent-restarted'&&item.sessionPreserved));
    }
    if(scenario==='bid-race') {
      assert.deepEqual(result.historicalViolations,['WINNING_BID_REGRESSED']);assert.equal(result.retainedBids.length,3);
      assert.equal(result.reconciliation.bidHistoryPreserved,true);assert.ok(result.stages.some(item=>item.name==='business-recovery-withheld'));
      assert.deepEqual(result.after.violations,[]);
    }
    if(scenario==='late-bid'){assert.deepEqual(result.historicalViolations,['BID_ACCEPTED_AFTER_CLOSE']);assert.ok(result.stages.some(item=>item.name==='business-recovery-withheld'));}
    if(scenario==='dependency-outage'){assert.equal(result.changeAssessment,'unlikely');assert.equal(result.processes.length,1);}
  } finally {rmSync(directory,{recursive:true,force:true});}
});

for(const variant of ['lost-response','same-sha-race'])test('actual local workflow handles '+variant+' without a second deployment dispatch',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'process-dispatch-fault-'));
  try {
    const result=await runProcessRecoveryDrill({directory,lostDispatchResponse:variant==='lost-response',sameShaRace:variant==='same-sha-race'});
    assert.equal(result.dispatchCount,1);assert.equal(result.workflowRequests.length,1);
    assert.ok(result.processes.every(item=>item.exit));
    if(variant==='lost-response') {
      assert.equal(result.dispatchStatus,'unknown');assert.equal(result.outcome,'recovery-verified');assert.equal(result.stages.at(-1).rollbackStatus,'verified');
      assert.equal(result.workflowRequests[0].status,'complete');assert.equal(result.processes.length,3);
    } else {
      assert.equal(result.outcome,'deployment-race-blocked');assert.equal(result.pipelineResult.status,'blocked');assert.equal(result.workflowRequests[0].status,'blocked');
      assert.equal(result.processes.length,3);assert.equal(result.processes.at(-1).sha,result.changeSha);
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});
test('queued approval expiry makes no deployment, reconciles independently and requires a new approved request',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'process-expired-approval-'));
  try {
    const result=await runProcessRecoveryDrill({directory,expiredApproval:true});
    assert.equal(result.outcome,'recovery-verified');assert.equal(result.dispatchCount,2);assert.equal(result.processes.length,3);
    assert.deepEqual(result.workflowRequests.map(item=>item.status),['blocked','complete']);assert.notEqual(result.workflowRequests[0].id,result.workflowRequests[1].id);
    assert.ok(result.stages.some(item=>item.name==='queued-approval-expired'&&item.deployments===2));
    assert.ok(result.stages.some(item=>item.name==='no-change-independently-reconciled'&&item.incidentStillOpen));
    assert.ok(result.stages.some(item=>item.name==='fresh-approval-dispatched'));assert.equal(result.stages.at(-1).rollbackStatus,'verified');
    assert.ok(result.processes.every(item=>item.exit?.code===0));
  } finally{rmSync(directory,{recursive:true,force:true});}
});
test('restoring credentials after restart leaves the blocked request unchanged and needs a fresh approval before process replacement',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'process-credential-rotation-'));
  try {
    const result=await runProcessRecoveryDrill({directory,credentialRotation:true});
    assert.equal(result.outcome,'recovery-verified');assert.equal(result.dispatchStatus,'blocked');
    assert.equal(result.dispatchCount,1);assert.equal(result.processes.length,3);
    assert.equal(result.workflowRequests.length,1);assert.equal(result.workflowRequests[0].status,'complete');
    assert.notEqual(result.credentialRecovery.blockedRequestId,result.credentialRecovery.freshRequestId);
    assert.ok(result.stages.some(item=>item.name==='credentials-blocked-before-submission'&&item.dispatches===0&&item.deployments===2));
    assert.ok(result.stages.some(item=>item.name==='credentials-restored-without-replay'&&item.dispatches===0&&item.sessionPreserved));
    assert.ok(result.stages.some(item=>item.name==='fresh-approval-after-credential-restoration'&&item.dispatches===1));
    assert.equal(result.stages.at(-1).rollbackStatus,'verified');assert.ok(result.processes.every(item=>item.exit?.code===0));
  } finally {rmSync(directory,{recursive:true,force:true});}
});
