const [command,...args]=process.argv.slice(2);
const base=process.env.SRE_LAB_URL||'http://127.0.0.1:3000';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw new Error('CLI targets a loopback lab only');
const routes={scenario:['/api/scenarios/run',{id:args[0]||'bid-race'}],ask:['/api/ask',{text:args.join(' ')||'Investigate auction-api'}],reset:['/api/reset',{}],traffic:['/api/traffic',{}]};
const route=routes[command];if(!route)throw new Error('Use scenario <id>, ask <text>, reset, or traffic');
try {
  const response=await fetch(base+route[0],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(route[1])});
  const result=await response.json();console.log(JSON.stringify(result,null,2));if(!response.ok)process.exitCode=1;
} catch(error) { console.error('Cannot reach the local lab. Start pnpm dev first. '+error.message);process.exitCode=1; }
