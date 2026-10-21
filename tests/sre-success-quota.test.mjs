import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { GithubConnector } from '../src/sre/connectors.mjs';
import { ApiClient,ConnectorError } from '../src/sre/http-client.mjs';
import { RequestNotSubmittedError } from '../src/sre/submission.mjs';
import { sqliteDatabase } from '../src/sre/database.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { providerRetryGate } from '../src/sre/provider-retry.mjs';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function provider(handler) {
  const calls=[];const server=createServer((req,res)=>{
    calls.push({path:req.url,method:req.method});const result=handler(new URL(req.url,'http://127.0.0.1'),req);
    res.writeHead(result.status||200,{'content-type':'application/json',...result.headers});res.end(result.status===204?undefined:JSON.stringify(result.body??[]));
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  return {base:'http://127.0.0.1:'+server.address().port,calls,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
const quota=now=>({'x-ratelimit-remaining':'0','x-ratelimit-reset':String(now/1000+60)});
const github=(base,options={})=>new GithubConnector({base,repository:'fixture/auction',tokenEnv:'TOKEN',workflow:'rollback.yml',ref:'main'},{local:true,env:{TOKEN:'synthetic'},...options});
function gateFixture(now) {
  const record={until:0,status:429};return {record,gate:{read:async()=>record.until>now()?{...record,retryAfterMs:record.until-now()}:null,defer:async hold=>{if(hold.until>record.until)Object.assign(record,hold);}}};
}
const proposal=now=>({id:'rb-success-quota',environment:'staging',approval:{approvedAt:now-1000,expiresAt:now+600000},current:{sha:'b'.repeat(40),artifact:'sha256:'+'c'.repeat(64),deploymentId:'17',at:now-5000},target:{sha:'a'.repeat(40),artifact:'sha256:'+'d'.repeat(64)}});

test('GitHub returns the successful response then defers the next request until the observed reset',async()=>{
  let now=Math.floor(Date.now()/1000)*1000,exhausted=true;
  const f=await provider(()=>({body:{id:17},headers:exhausted?quota(now):{}})),client=github(f.base,{clock:async()=>now});
  try {
    assert.deepEqual(await client.request(client.repo),{id:17});
    await assert.rejects(()=>client.request(client.repo),error=>error.status===429&&error.providerStatus===200&&error.retryAfterMs===60000);assert.equal(f.calls.length,1);
    now+=60001;exhausted=false;assert.deepEqual(await client.request(client.repo),{id:17});assert.equal(f.calls.length,2);
  } finally {await f.close();}
});

test('a successful exhausted page cannot continue or certify a complete paginated read',async()=>{
  const now=Math.floor(Date.now()/1000)*1000;
  const f=await provider(url=>({body:[],headers:url.searchParams.get('page')==='1'?{...quota(now),link:'<'+f.base+'/repos/fixture/auction/items?per_page=100&page=2>; rel="next"'}:{}})),client=github(f.base,{clock:()=>now});
  try {await assert.rejects(()=>client.pages(client.repo+'/items'),error=>error.status===429&&error.providerStatus===200);assert.equal(f.calls.length,1);}
  finally {await f.close();}
});

test('an accepted GitHub dispatch remains successful and its quota hold blocks a later write before submission',async()=>{
  const now=Math.floor(Date.now()/1000)*1000,f=await provider(()=>({status:204,headers:quota(now)})),client=github(f.base,{clock:()=>now});
  try {
    const receipt=await client.dispatch(proposal(now));assert.equal(receipt.status,'dispatched');
    await assert.rejects(()=>client.dispatch({...proposal(now),id:'rb-next-request'}),RequestNotSubmittedError);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'POST');
  } finally {await f.close();}
});

test('a successful exhausted response commits a shared deadline before another client can request',async()=>{
  const now=Math.floor(Date.now()/1000)*1000,f=await provider(()=>({body:{id:17},headers:quota(now)})),shared=gateFixture(()=>now);
  const first=github(f.base,{clock:()=>now,retryGate:shared.gate}),second=github(f.base,{clock:()=>now,retryGate:shared.gate});
  try {
    assert.equal((await first.request(first.repo)).id,17);assert.equal(shared.record.until,now+60000);assert.equal(shared.record.status,200);
    await assert.rejects(()=>second.request(second.repo),error=>error.status===429&&error.providerStatus===200);assert.equal(f.calls.length,1);
  } finally {await f.close();}
});

test('pending successful quota feedback blocks another request while storage is unavailable and resumes without losing the original deadline',async()=>{
  const now=Math.floor(Date.now()/1000)*1000,shared=gateFixture(()=>now);let unavailable=true,calls=0;
  const gate={read:shared.gate.read,defer:async hold=>{if(unavailable)throw Error('private-synthetic-storage-detail');return shared.gate.defer(hold);}};
  const client=github('https://quota-fixture.invalid',{clock:()=>now,retryGate:gate,fetcher:async()=>{calls++;return new Response('{"ok":true}',{headers:{'content-type':'application/json',...quota(now)}});}});
  await assert.rejects(()=>client.request(client.repo),error=>!error.message.includes('private-synthetic')&&error.uncertain===false);assert.equal(calls,1);
  await assert.rejects(()=>client.request(client.repo));assert.equal(calls,1);assert.equal(shared.record.until,0);
  unavailable=false;await assert.rejects(()=>client.request(client.repo),error=>error.status===429);assert.equal(calls,1);assert.equal(shared.record.until,now+60000);
});

test('an accepted write followed by quota-persistence failure remains uncertain and is never automatically repeated',async()=>{
  const now=Math.floor(Date.now()/1000)*1000;let calls=0;
  const client=github('https://quota-fixture.invalid',{clock:()=>now,retryGate:{read:async()=>null,defer:async()=>{throw Error('private-synthetic-storage-detail');}},fetcher:async()=>{calls++;return new Response(null,{status:204,headers:quota(now)});}});
  await assert.rejects(()=>client.dispatch(proposal(now)),error=>error.uncertain===true&&!(error instanceof RequestNotSubmittedError)&&!error.message.includes('private-synthetic'));
  await assert.rejects(()=>client.dispatch({...proposal(now),id:'rb-next'}),RequestNotSubmittedError);assert.equal(calls,1);
});

test('a failed response clock retains the observation and prevents another uncoordinated read',async()=>{
  let now=Math.floor(Date.now()/1000)*1000,unavailable=true,calls=0,empty=true;const until=now+60000;
  const client=github('https://quota-fixture.invalid',{clock:async()=>{if(unavailable)throw Error('private-synthetic-clock-detail');return now;},fetcher:async()=>{calls++;return new Response('[]',{headers:empty?quota(until-60000):{}});}});
  await assert.rejects(()=>client.request(client.repo),error=>!error.message.includes('private-synthetic'));assert.equal(calls,1);
  await assert.rejects(()=>client.request(client.repo));assert.equal(calls,1);
  unavailable=false;now+=50000;await assert.rejects(()=>client.request(client.repo),error=>error.status===429&&error.retryAfterMs===10000);assert.equal(calls,1);
  now=until+1;empty=false;assert.deepEqual(await client.request(client.repo),[]);assert.equal(calls,2);
});

test('a clock failure after an accepted write cannot become a local non-submission',async()=>{
  const now=Math.floor(Date.now()/1000)*1000;let calls=0;
  const client=new ApiClient({base:'https://quota-fixture.invalid',successQuotaReset:'epoch-seconds',clock:async()=>{throw Error('private-synthetic-clock-detail');},fetcher:async()=>{calls++;return new Response(null,{status:204,headers:quota(now)});}});
  await assert.rejects(()=>client.request('/write',{method:'POST',mutating:true,body:{}}),error=>error.uncertain===true&&!(error instanceof RequestNotSubmittedError)&&!error.message.includes('private-synthetic'));assert.equal(calls,1);
  await assert.rejects(()=>client.request('/write',{method:'POST',mutating:true,body:{}}),RequestNotSubmittedError);assert.equal(calls,1);
});

test('a later held read with an unavailable clock keeps the wait and excludes the database diagnostic',async()=>{
  const now=Math.floor(Date.now()/1000)*1000;let calls=0,unavailable=false;
  const client=github('https://quota-fixture.invalid',{clock:async()=>{if(unavailable)throw Error('private-synthetic-database-detail');return now;},fetcher:async()=>{calls++;return new Response('[]',{headers:quota(now)});}});
  await client.request(client.repo);unavailable=true;
  await assert.rejects(()=>client.request(client.repo),error=>error instanceof ConnectorError&&error.message==='Connector retry clock is unavailable');
  assert.equal(calls,1);unavailable=false;await assert.rejects(()=>client.request(client.repo),error=>error.status===429);assert.equal(calls,1);
});

test('concurrent in-flight successes preserve the longest observed reset when their metadata completes out of order',async()=>{
  const now=Math.floor(Date.now()/1000)*1000,shared=gateFixture(()=>now);let calls=0,clockCalls=0,releaseClock,firstResponse,secondResponse,firstEntered,secondEntered;
  const heldClock=new Promise(resolve=>releaseClock=resolve),entered1=new Promise(resolve=>firstEntered=resolve),entered2=new Promise(resolve=>secondEntered=resolve);
  const one=new Promise(resolve=>firstResponse=resolve),two=new Promise(resolve=>secondResponse=resolve);
  const client=github('https://quota-fixture.invalid',{clock:async()=>++clockCalls===1?heldClock:now,retryGate:shared.gate,fetcher:async()=>{calls++;if(calls===1){firstEntered();return one;}secondEntered();return two;}});
  const first=client.request('/first'),second=client.request('/second');await Promise.all([entered1,entered2]);
  firstResponse(new Response('{"id":1}',{headers:quota(now+60000)}));await new Promise(resolve=>setImmediate(resolve));
  secondResponse(new Response('{"id":2}',{headers:quota(now)}));assert.deepEqual(await second,{id:2});releaseClock(now);assert.deepEqual(await first,{id:1});
  assert.equal(shared.record.until,now+120000);await assert.rejects(()=>client.request('/third'),error=>error.status===429);assert.equal(calls,2);
});

test('a positive late remaining count cannot erase an already observed exhausted window',async()=>{
  const now=Math.floor(Date.now()/1000)*1000;let calls=0,firstResponse,secondResponse,firstEntered,secondEntered;
  const one=new Promise(resolve=>firstResponse=resolve),two=new Promise(resolve=>secondResponse=resolve),entered1=new Promise(resolve=>firstEntered=resolve),entered2=new Promise(resolve=>secondEntered=resolve);
  const client=github('https://quota-fixture.invalid',{clock:()=>now,fetcher:async()=>{calls++;if(calls===1){firstEntered();return one;}secondEntered();return two;}});
  const first=client.request('/first'),second=client.request('/second');await Promise.all([entered1,entered2]);
  firstResponse(new Response('[]',{headers:quota(now)}));await first;secondResponse(new Response('[]',{headers:{'x-ratelimit-remaining':'5'}}));await second;
  await assert.rejects(()=>client.request('/third'),error=>error.status===429);assert.equal(calls,2);
});

test('unsupported success-header contracts are opt-in and do not reinterpret another provider default',async()=>{
  const now=Math.floor(Date.now()/1000)*1000;let calls=0;
  const client=new ApiClient({base:'https://unknown-provider.invalid',clock:()=>now,fetcher:async()=>{calls++;return new Response('[]',{headers:quota(now)});}});
  await client.request('/read');await client.request('/read');assert.equal(calls,2);assert.equal(client.cooldown,null);
  assert.throws(()=>new ApiClient({base:'https://unknown-provider.invalid',successQuotaReset:'unknown'}),/contract/);
});

for(const headers of [
  {'x-ratelimit-remaining':'0'},
  {'x-ratelimit-remaining':'0','x-ratelimit-reset':'malformed'},
  {'x-ratelimit-remaining':'0','retry-after':'60'},
  {'x-ratelimit-remaining':'0','retry-after':'-1'},
  {'x-ratelimit-remaining':'0','retry-after':'0.5'},
])test('an exhausted successful response with '+Object.keys(headers).join('/')+' retains a conservative bounded fallback',async()=>{
  const now=Date.now();let calls=0;
  const client=github('https://quota-fixture.invalid',{clock:()=>now,fetcher:async()=>{calls++;return new Response('[]',{headers});}});
  await client.request(client.repo);await assert.rejects(()=>client.request(client.repo),error=>error.status===429&&error.retryAfterMs>0&&error.retryAfterMs<=60000);assert.equal(calls,1);
});

test('a successful exhausted response honors the longer HTTP-date Retry-After and retains it across later reads',async()=>{
  const now=Math.floor(Date.now()/1000)*1000;let calls=0;
  const client=github('https://quota-fixture.invalid',{clock:()=>now,fetcher:async()=>{calls++;return new Response('[]',{headers:{...quota(now),'retry-after':new Date(now+120000).toUTCString()}});}});
  await client.request(client.repo);await assert.rejects(()=>client.request(client.repo),error=>error.status===429&&error.retryAfterMs===120000);assert.equal(calls,1);
});

test('successful GitHub pacing survives an actual SQLite close/reopen through a new client',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'sre-success-quota-')),path=join(directory,'state.sqlite');let db,now=Math.floor(Date.now()/1000)*1000,calls=0,empty=true;
  const descriptor={tenant:'synthetic',provider:'github',endpoint:'https://quota-fixture.invalid',scope:'reader-account'};
  try {
    db=sqliteDatabase(path);let store=await new SreStore(db,{clock:()=>now}).initialize();
    const options=()=>({clock:()=>store.coordinationNow(),retryGate:providerRetryGate(store,descriptor),fetcher:async()=>{calls++;return new Response('[]',{headers:empty?quota(now):{}});}});
    await github(descriptor.endpoint,options()).request('/read');assert.equal((await store.providerRetry(providerRetryGate(store,descriptor).scopeHash)).status,200);await db.close();db=undefined;
    db=sqliteDatabase(path);store=await new SreStore(db,{clock:()=>now}).initialize();const replacement=github(descriptor.endpoint,options());
    await assert.rejects(()=>replacement.request('/read'),error=>error.status===429&&error.providerStatus===200);assert.equal(calls,1);now+=60001;empty=false;await replacement.request('/read');assert.equal(calls,2);
  } finally {await db?.close();rmSync(directory,{recursive:true,force:true});}
});

test('a malformed successful body still retains its observed quota deadline',async()=>{
  const now=Math.floor(Date.now()/1000)*1000;let calls=0;
  const client=github('https://quota-fixture.invalid',{clock:()=>now,fetcher:async()=>{calls++;return new Response('private-synthetic-invalid-json',{headers:quota(now)});}});
  await assert.rejects(()=>client.request(client.repo),error=>!error.message.includes('private-synthetic'));await assert.rejects(()=>client.request(client.repo),error=>error.status===429);assert.equal(calls,1);
});

test('an exhausted server-error response retains its reset even without an explicit Retry-After',async()=>{
  const now=Math.floor(Date.now()/1000)*1000;let calls=0;
  const client=new ApiClient({base:'https://quota-fixture.invalid',clock:()=>now,fetcher:async()=>{calls++;return new Response('[]',{status:503,headers:quota(now)});}});
  await assert.rejects(()=>client.request('/read'),error=>error.status===503&&error.retryAfterMs===60000);await assert.rejects(()=>client.request('/read'),error=>error.retryAfterMs===60000);assert.equal(calls,1);
});

test('an already expired reset does not invent a fresh wait and an enormous reset cannot overflow into an early retry',async()=>{
  const now=Math.floor(Date.now()/1000)*1000;let calls=0,huge=false;
  const client=github('https://quota-fixture.invalid',{clock:()=>now,fetcher:async()=>{calls++;return new Response('[]',{headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':huge?'9'.repeat(400):String(now/1000-1)}});}});
  await client.request(client.repo);await client.request(client.repo);assert.equal(calls,2);huge=true;await client.request(client.repo);assert.equal(client.cooldown.until,Number.MAX_SAFE_INTEGER);
  await assert.rejects(()=>client.request(client.repo),error=>error.status===429&&Number.isSafeInteger(error.retryAfterMs)&&error.retryAfterMs>0);assert.equal(calls,3);
});
