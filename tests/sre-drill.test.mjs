import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRecoveryDrill } from '../fixtures/recovery-drill.mjs';

for(const [scenario,outcome,dispatches,findings] of [
  ['bid-race','recovery-verified',1,1],
  ['credit-timeout','recovery-verified',1,1],
  ['catalog-latency','recovery-verified',1,1],
  ['late-bid','needs-transaction-reconciliation',1,1],
  ['healthy-release','healthy-no-runtime-incident',0,0],
  ['schema-break','rollback-blocked',0,1],
  ['dependency-outage','rollback-blocked',0,0],
])test('measured GitHub contract recovery drill: '+scenario,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'sre-drill-test-'));
  try {
    const result=await runRecoveryDrill({scenario,directory});
    assert.equal(result.outcome,outcome);
    assert.equal(result.dispatchCount,dispatches);
    assert.equal(result.codeFindings.length,findings);
    assert.equal(result.stages[0].rollbackEligible,false);
    if(outcome==='recovery-verified') {
      assert.ok(result.stages.some(x=>x.name==='service-restarted'&&x.sessionPreserved));
      assert.equal(result.stages.at(-1).rollbackStatus,'verified');
      assert.equal(result.stages.at(-1).checks.businessInvariants,true);
    }
    if(scenario==='bid-race') {
      assert.deepEqual(result.before.violations,['WINNING_BID_REGRESSED']);
      assert.deepEqual(result.afterRollback.historicalViolations,['WINNING_BID_REGRESSED']);
      assert.equal(result.reconciliation.bidHistoryPreserved,true);
    }
    if(scenario==='dependency-outage')assert.equal(result.changeAssessment,'unlikely');
  } finally {rmSync(directory,{recursive:true,force:true});}
});
