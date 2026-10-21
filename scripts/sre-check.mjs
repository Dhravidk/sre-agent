import { loadConfig } from '../src/sre/config.mjs';
import { checkReadAccess } from '../src/sre/access-checks.mjs';

if(!process.argv.includes('--live'))throw new Error('Use --live to opt into read-only vendor API checks');
let result;
try {
  const config=loadConfig({...process.env,SRE_AGENT_MODE:'rules'});
  if(config.mode!=='connected')throw new Error('Connected configuration required');
  result=await checkReadAccess(config,{signal:AbortSignal.timeout(300000)});
  result.observedAt=Date.now();result.clockSource='host';
} catch {
  result={state:'failed',allRequiredReadsPassed:false,endToEndValidated:false,checks:[],error:'The access check could not complete. Inspect local configuration with sre:ready; no provider error text is included.'};
}
if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
else {
  for(const check of result.checks)console.log(check.service+' / '+check.source+' / '+check.operation+': '+check.status+'; '+check.summary+(check.httpStatus?' (HTTP '+check.httpStatus+')':''));
  console.log(result.error||result.note);
}
process.exitCode=result.state==='passed'?0:result.state==='failed'?1:2;
