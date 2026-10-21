import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lab } from './lab.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
export async function createLabServer({lab=new Lab()}={}) {
  await lab.initialize();
  const server=createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('cache-control','no-store');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    const reply=(status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(body));};
    try {
      const host=new URL('http://'+req.headers.host);
      if(!['127.0.0.1','localhost','[::1]'].includes(host.hostname)) return reply(403,{error:'Local lab host required'});
      if(req.headers.origin && req.headers.origin!==host.origin) return reply(403,{error:'Cross-origin requests are not accepted'});
      const url=new URL(req.url,host);
      let body={};
      if(req.method==='POST') {
        let raw=''; for await(const chunk of req) {raw+=chunk;if(raw.length>262144)return reply(413,{error:'Request too large'});}
        body=raw?JSON.parse(raw):{};
      }
      if(req.method==='GET' && url.pathname==='/health') return reply(200,{status:'ok',runtime:'local',externalCalls:false});
      if(req.method==='GET' && url.pathname==='/api/state') return reply(200,lab.snapshot());
      if(req.method==='GET' && url.pathname==='/api/lots') return reply(200,await lab.auction.catalog());
      if(req.method==='POST' && lab.busy && ['/api/traffic','/api/reset','/api/scenarios/run'].includes(url.pathname)) return reply(409,{error:'Wait for the scenario to finish'});
      if(req.method==='POST' && url.pathname==='/api/scenarios/run') return reply(200,await lab.run(body.id));
      if(req.method==='POST' && url.pathname==='/api/traffic') return reply(200,await lab.traffic());
      if(req.method==='POST' && url.pathname==='/api/monitor') return reply(200,lab.monitor());
      if(req.method==='POST' && url.pathname==='/api/reset') return reply(200,await lab.reset());
      if(req.method==='POST' && url.pathname==='/api/ask') return reply(200,lab.ask(body.text));
      if(req.method==='POST' && url.pathname==='/api/events') return reply(200,lab.store.event(body));
      if(req.method==='POST' && /^\/api\/lots\/[^/]+\/bids$/.test(url.pathname)) {
        if(lab.busy) return reply(409,{error:'Wait for the scenario to finish'});
        const result=await lab.auction.bid(url.pathname.split('/')[3],body.amountCents,body.dealer,req.headers['idempotency-key']||'');
        lab.monitor(); return reply(result.status,result);
      }
      const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
      if(req.method==='GET' && files[url.pathname]) {
        const name=files[url.pathname]; const mime=name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html';
        res.setHeader('content-type',mime+'; charset=utf-8');res.end(await readFile(resolve(root,'web',name)));return;
      }
      reply(404,{error:'Not found'});
    } catch(error) {reply(400,{error:error instanceof SyntaxError?'Invalid JSON':error.message});}
  });
  return {server,lab};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.env.RUNTIME && process.env.RUNTIME!=='local') throw new Error('This launcher is the local lab. Use a reviewed AWS entrypoint for cloud deployment.');
  const {server,lab}=await createLabServer();
  const port=Number(process.env.PORT||3000);
  server.listen(port,'127.0.0.1',()=>console.log('Auction SRE Lab: http://127.0.0.1:'+port+' — offline fixtures, no cloud or model calls'));
  const shutdown=()=>server.close(()=>{lab.store.close();process.exit(0);});
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
