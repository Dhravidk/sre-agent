import { safeUrl } from '../src/sre/security.mjs';

const base=safeUrl(process.env.SRE_SERVICE_URL||'http://127.0.0.1:3001',true);
const response=await fetch(base+'/api/operations',{redirect:'error',signal:AbortSignal.timeout(15000),headers:process.env.SRE_API_TOKEN?{authorization:'Bearer '+process.env.SRE_API_TOKEN}:{}});
if(!response.ok)throw new Error('Agent health request returned HTTP '+response.status);
const report=await response.json();
console.log(JSON.stringify(report,null,2));
if(process.argv.includes('--strict')&&report.state!=='healthy')process.exitCode=1;
