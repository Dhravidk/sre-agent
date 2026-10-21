import { randomUUID } from 'node:crypto';

const [incidentId,jobId,reason,...options]=process.argv.slice(2);
if(!/^inc_[a-f0-9]+$/.test(incidentId||'')||!/^[a-f0-9]{64}$/.test(jobId||'')||!reason?.trim()||reason.length>1000||(options.length&&!(options.length===2&&options[0]==='--request-id')))throw new Error('Use sre:retry <incident-id> <job-id> "<reason>" [--request-id <saved-id>]');
const requestId=options[1]||randomUUID(),base=(process.env.SRE_SERVICE_URL||'http://127.0.0.1:3001').replace(/\/$/,'');
if(!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId))throw new Error('Invalid retry request ID');
// Retain this ID if the server commits but the connection/response is lost.
console.error(JSON.stringify({requestId,retryInstruction:'Reuse this ID with --request-id after an uncertain response.'}));
const response=await fetch(base+'/api/incidents/'+incidentId+'/jobs/'+jobId+'/retry',{method:'POST',headers:{'content-type':'application/json',...(process.env.SRE_API_TOKEN?{authorization:'Bearer '+process.env.SRE_API_TOKEN}:{})},body:JSON.stringify({requestId,reason}),redirect:'error',signal:AbortSignal.timeout(15000)});
console.log(JSON.stringify(await response.json(),null,2));if(!response.ok)process.exitCode=1;
