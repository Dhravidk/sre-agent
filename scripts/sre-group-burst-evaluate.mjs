import {resolve} from 'node:path';
import {CodexEvaluationReasoner} from './lib/codex-evaluation-reasoner.mjs';
import {runGroupBurstEvaluation} from './lib/group-burst-evaluation.mjs';
import {runConcurrentGroupEvaluation} from './lib/concurrent-group-evaluation.mjs';

if(!process.argv.includes('--live'))throw Error('Use --live to consume real model usage for sustained local group bursts. Vendor evidence is authored; no external delivery or deployment is performed.');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const provider=arg('--provider')||'claude';
if(!['claude','codex'].includes(provider))throw Error('Choose --provider claude or --provider codex');
const reasoner=provider==='codex'?new CodexEvaluationReasoner():undefined;
const directory=resolve(arg('--directory')||'.local/group-burst-development/evaluation-'+new Date().toISOString().replace(/[:.]/g,'-'));
const concurrency=Number(arg('--concurrency')||4),evaluate=process.argv.includes('--legacy')?runGroupBurstEvaluation:runConcurrentGroupEvaluation;
if(process.argv.includes('--legacy')&&process.argv.includes('--expanded'))throw Error('--expanded requires the concurrent evaluator');
console.log(JSON.stringify({status:'running',directory,model:'actual-'+provider,concurrency}));
const report=await evaluate({directory,reasoner,concurrency,expanded:process.argv.includes('--expanded')?true:undefined,seed:Number(arg('--seed')||91573),recordsPerService:Number(arg('--records')||30000),onEvent:e=>console.log(JSON.stringify(e))});
console.log(JSON.stringify({status:report.status,directory,checks:report.checks,metrics:report.metrics,cases:report.cases.map(c=>({case:c.case,status:c.status,remediation:c.remediation}))}));
if(report.status!=='passed')process.exitCode=1;
