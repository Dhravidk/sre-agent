import {resolve} from 'node:path';
import {runMultiIncidentEvaluation} from './lib/multi-incident-evaluation.mjs';

if(!process.argv.includes('--live'))throw Error('Use --live to run actual Claude against concurrent authored incidents. This consumes model usage; it does not contact live Dynatrace or execute deployments.');
const arg=name=>{const n=process.argv.indexOf(name);return n<0?undefined:process.argv[n+1];};
const seed=Number(arg('--seed')||73421),recordsPerService=Number(arg('--records')||30000),caseId=arg('--case');
const directory=resolve(arg('--directory')||'.local/multi-incident-development/evaluation-'+new Date().toISOString().replace(/[:.]/g,'-'));
console.log(JSON.stringify({status:'running',directory,seed,recordsPerService,actualClaude:true,telemetry:'authored fixtures'}));
const report=await runMultiIncidentEvaluation({directory,seed,recordsPerService,...(caseId?{caseIds:[caseId],injectQuestions:false,restart:false}:{}),onEvent:e=>console.log(JSON.stringify(e))});
console.log(JSON.stringify({status:report.status,directory,cases:report.cases.map(c=>({case:c.case,status:c.status,remediation:c.remediation,checks:c.checks})),checks:report.checks}));
if(report.status!=='passed')process.exitCode=1;
