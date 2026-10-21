import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const config=JSON.parse(process.env.LOCAL_AUCTION_CONFIG||'{}');
const manifest=JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));
const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const artifact=digest(JSON.stringify({format:manifest.format,sha:manifest.sha,policy:manifest.policy,files:manifest.files}));
if(config.artifact!==artifact||config.sha!==manifest.sha||!config.storePath||config.environment!=='local-process-test')throw new Error('Invalid owned local auction runtime configuration');
for(const [name,expected] of Object.entries(manifest.files))if(digest(readFileSync(new URL(name,import.meta.url)))!==expected)throw new Error('Retained local artifact bytes changed');
const { Auction }=await import('./src/auction/service.mjs');
const auction=new Auction(),db=new DatabaseSync(config.storePath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS auction_state(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS auction_requests(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS auction_operator_audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL);');
const saved=db.prepare('SELECT payload FROM auction_state WHERE id=1').get();
if(saved) {
  const state=JSON.parse(saved.payload);
  const validBid=bid=>bid&&Number.isSafeInteger(bid.amountCents)&&bid.amountCents>0&&typeof bid.dealer==='string'&&bid.dealer.length>0&&Number.isFinite(bid.at)&&bid.at>=0;
  const validLot=lot=>lot&&/^LOT-\d+$/.test(lot.id)&&Array.isArray(lot.bids)&&lot.bids.every(validBid)&&Number.isSafeInteger(lot.currentBidCents)&&lot.currentBidCents>=0&&Number.isSafeInteger(lot.version)&&lot.version>=0&&Number.isFinite(lot.endsAt);
  if(state.format!==1||!Array.isArray(state.lots)||state.lots.length!==3||state.dataSchemaVersion!==1||typeof state.creditDown!=='boolean'||state.lots.some(lot=>!validLot(lot))||new Set(state.lots.map(lot=>lot.id)).size!==3)throw new Error('Invalid retained auction state; refuse a silent reset');
  auction.lots=state.lots;auction.dataSchemaVersion=state.dataSchemaVersion;auction.creditDown=Boolean(state.creditDown);
} else if(config.initialDurationMs!==undefined) {
  if(!Number.isInteger(config.initialDurationMs)||config.initialDurationMs<500||config.initialDurationMs>1200000)throw new Error('Invalid fixture auction duration');
  for(const lot of auction.lots)lot.endsAt=Date.now()+config.initialDurationMs;
}
const snapshot=()=>JSON.stringify({format:1,lots:auction.lots,dataSchemaVersion:auction.dataSchemaVersion,creditDown:auction.creditDown});
function persist(request) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO auction_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(snapshot());
    if(request)db.prepare('INSERT INTO auction_requests(id,fingerprint,result) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(request.id,request.fingerprint,JSON.stringify(request.result));
    db.exec('COMMIT');
  } catch(error){db.exec('ROLLBACK');throw error;}
}
persist();
let dropNextResponse=false,stopping=false,fatal=false;
const identity={sha:manifest.sha,artifact,deploymentId:config.deploymentId,deploymentAt:config.deploymentAt,rollbackRequestId:config.rollbackRequestId||null,environment:config.environment,pid:process.pid,artifactType:manifest.format};
async function body(req) {const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>10000)throw new Error('Request too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
const server=createServer(async(req,res)=>{
  const send=(status,data)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(data));};
  try {
    if(fatal)return send(503,{error:'Fixture storage unavailable'});
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='GET'&&url.pathname==='/identity')return send(200,identity);
    if(req.method==='GET'&&url.pathname==='/health')return send(200,{status:'ok',synthetic:true,...identity});
    if(req.method==='GET'&&url.pathname==='/api/lots')return send(200,await auction.catalog());
    if(req.method==='GET'&&url.pathname==='/metrics')return send(200,{...auction.telemetry(),...identity});
    if(req.method==='POST'&&/^\/api\/lots\/[A-Za-z0-9_-]+\/bids$/.test(url.pathname)) {
      const input=await body(req),lotId=url.pathname.split('/')[3],requestId=req.headers['idempotency-key'];
      if(typeof requestId!=='string'||!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)||typeof input.dealer!=='string'||!input.dealer.trim()||input.dealer.length>200)return send(400,{error:'Synthetic bid requires a dealer and stable idempotency key'});
      const id=lotId+':'+requestId,fingerprint=JSON.stringify([lotId,input.amountCents,input.dealer]);
      const prior=db.prepare('SELECT * FROM auction_requests WHERE id=?').get(id);
      if(prior){if(prior.fingerprint!==fingerprint)return send(409,{code:'IDEMPOTENCY_CONFLICT'});const result=JSON.parse(prior.result);return send(result.status,result);}
      const timing=input.processingMs??15;
      if(!Number.isInteger(timing)||timing<0||timing>2000)return send(400,{error:'Invalid synthetic bid timing'});
      process.send?.({type:'bid-started',requestId});
      const result=await auction.bid(lotId,input.amountCents,input.dealer,requestId,timing);
      if(fatal)return send(503,{error:'Fixture storage unavailable'});
      try {persist({id,fingerprint,result});}catch(error){fatal=true;send(503,{error:'Fixture storage unavailable'});void stop(1);return;}
      // Only the parent fixture can request a lost acknowledgement. The durable
      // transaction has already committed; a later retry must reuse its result.
      if(dropNextResponse){dropNextResponse=false;req.socket.destroy();return;}
      return send(result.status,result);
    }
    return send(404,{error:'Unknown local fixture endpoint'});
  } catch {if(!res.headersSent)send(400,{error:'Invalid local fixture request'});else res.destroy();}
});
async function stop(code=0) {
  if(stopping)return;stopping=true;
  await new Promise(resolve=>server.close(resolve));db.close();process.exit(code);
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void stop());
process.on('message',message=>{
  try {
    if(message.type==='drop-next-response')dropNextResponse=true;
    else if(message.type==='dependency-state'){auction.creditDown=message.down===true;persist();}
    else if(message.type==='reconcile-winners') {
      const changed=[];
      for(const lot of auction.lots){const amount=Math.max(lot.currentBidCents,...lot.bids.map(bid=>bid.amountCents));if(amount!==lot.currentBidCents){changed.push({lotId:lot.id,before:lot.currentBidCents,after:amount,bidCount:lot.bids.length});lot.currentBidCents=amount;lot.version++;}}
      db.exec('BEGIN IMMEDIATE');
      try {db.prepare('UPDATE auction_state SET payload=? WHERE id=1').run(snapshot());db.prepare('INSERT INTO auction_operator_audit(at,action,details) VALUES(?,?,?)').run(Date.now(),'synthetic-operator-winner-reconciliation',JSON.stringify(changed));db.exec('COMMIT');}
      catch(error){db.exec('ROLLBACK');throw error;}
      process.send?.({type:'control-receipt',id:message.id,changed});return;
    } else throw new Error('Unknown parent fixture control');
    process.send?.({type:'control-receipt',id:message.id});
  } catch(error){process.send?.({type:'control-receipt',id:message.id,error:error.message});}
});
server.listen(0,'127.0.0.1',()=>process.send?.({type:'ready',port:server.address().port,...identity}));
