import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runRecoveryDrill } from '../fixtures/recovery-drill.mjs';

const rounds=Number(process.argv[2]||21);
if(!Number.isInteger(rounds)||rounds<1||rounds>1000)throw new Error('Choose 1–1000 bounded exercise rounds');
const directory=resolve('.local/recovery-drills','exercise-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
mkdirSync(directory,{recursive:true});
const cases=[['bid-race','recovery-verified',1],['healthy-release','healthy-no-runtime-incident',0],['dependency-outage','rollback-blocked',0],['credit-timeout','recovery-verified',1],['schema-break','rollback-blocked',0],['late-bid','needs-transaction-reconciliation',1],['catalog-latency','recovery-verified',1]];
const summary={mode:'offline-contract-exercise',startedAt:new Date().toISOString(),rounds,completed:[],failures:[],limitations:'Bounded local repetitions with fresh databases and a mid-drill restart. This is not a multi-hour uptime or real-vendor test.'};
for(let index=0;index<rounds;index++) {
  const [scenario,outcome,dispatches]=cases[index%cases.length],path=join(directory,String(index+1).padStart(4,'0')+'-'+scenario);
  const started=performance.now();
  try {
    const report=await runRecoveryDrill({scenario,directory:path});
    writeFileSync(join(path,'report.json'),JSON.stringify(report,null,2)+'\n');
    assert.equal(report.outcome,outcome);assert.equal(report.dispatchCount,dispatches);
    summary.completed.push({round:index+1,scenario,outcome,dispatches,durationMs:Math.round(performance.now()-started),report:join(path,'report.json')});
  } catch(error) {
    summary.failures.push({round:index+1,scenario,error:error.message,stack:error.stack});process.exitCode=1;break;
  } finally {writeFileSync(join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n');}
}
summary.finishedAt=new Date().toISOString();
writeFileSync(join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({completed:summary.completed.length,failures:summary.failures.length,summary:join(directory,'summary.json')},null,2));
