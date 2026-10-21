import { assertText } from '../src/sre/security.mjs';
const [command,arg,...rest]=process.argv.slice(2);
const base=process.env.SRE_SERVICE_URL||'http://127.0.0.1:3001';
const endpoint=command==='seed'?'/api/dev/seed':command==='teams'?'/api/dev/teams':command==='ask'?'/api/incidents/'+assertText(arg,'incident ID')+'/questions':'/api/status';
const payload=command==='seed'?{scenario:arg||'recent-regression'}:command==='teams'?{text:[arg,...rest].join(' ')}:command==='ask'?{text:rest.join(' ')}:undefined;
const response=await fetch(base+endpoint,{method:payload?'POST':'GET',headers:{'content-type':'application/json',...(process.env.SRE_API_TOKEN?{authorization:'Bearer '+process.env.SRE_API_TOKEN}:{})},body:payload?JSON.stringify(payload):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});
console.log(JSON.stringify(await response.json(),null,2));if(!response.ok)process.exitCode=1;
