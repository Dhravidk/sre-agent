import { createServer } from 'node:http';
import { Auction } from './src/auction/service.mjs';
const auction = new Auction();
const server = createServer(async(req,res)=>{
  try {
    const url = new URL(req.url,'http://localhost');
    let data;
    if (req.method==='GET' && url.pathname==='/health') data={status:'ok',synthetic:true};
    else if(req.method==='GET' && url.pathname==='/api/lots') data=await auction.catalog();
    else if(req.method==='POST' && /^\/api\/lots\/[^/]+\/bids$/.test(url.pathname)) {
      let body=''; for await(const chunk of req) { body+=chunk; if(body.length>10000) throw new Error('Body too large'); }
      const input=JSON.parse(body); data=await auction.bid(url.pathname.split('/')[3],input.amountCents,input.dealer,req.headers['idempotency-key']);
      res.statusCode=data.status;
    } else if(req.method==='GET' && url.pathname==='/metrics') data=auction.telemetry();
    else { res.statusCode=404; data={error:'Use /api/lots, /api/lots/:id/bids, or /metrics'}; }
    res.setHeader('content-type','application/json'); res.end(JSON.stringify(data));
  } catch { res.statusCode=400; res.end(JSON.stringify({error:'Invalid request'})); }
});
server.listen(Number(process.env.PORT||3100),'127.0.0.1',()=>console.log('Synthetic auction API: http://127.0.0.1:'+(process.env.PORT||3100)));
