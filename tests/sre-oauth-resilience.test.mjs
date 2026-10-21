import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenProvider } from '../src/sre/http-client.mjs';
import { JiraConnector, GithubConnector } from '../src/sre/connectors.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const oauth={tokenUrl:'https://identity-fixture.invalid/token',clientIdEnv:'ID',clientSecretEnv:'SECRET'};
const response=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
const grant=(token='synthetic-token',extra={})=>({access_token:token,token_type:'Bearer',expires_in:300,...extra});

test('concurrent token acquisition shares one request and one result',async()=>{
  let calls=0,unblock,entered;
  const gate=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve);
  const get=tokenProvider({oauth},{ID:'synthetic',SECRET:'synthetic-secret'},async()=>{calls++;entered();await gate;return response(grant());});
  const wave=Promise.all(Array.from({length:12},()=>get()));
  await started;unblock();assert.deepEqual(await wave,Array(12).fill('synthetic-token'));assert.equal(calls,1,'Concurrent readers caused an OAuth request burst');
});

test('credential rotation cannot reuse the previous credential token',async()=>{
  const env={ID:'synthetic',SECRET:'old-secret'};let calls=0;
  const get=tokenProvider({oauth},env,async(url,options)=>{calls++;return response(grant(new URLSearchParams(options.body).get('client_secret')==='old-secret'?'old-token':'new-token'));});
  assert.equal(await get(),'old-token');env.SECRET='new-secret';assert.equal(await get(),'new-token');assert.equal(calls,2);
});

test('removed OAuth credentials cannot keep authorizing with a cached token',async()=>{
  const env={ID:'synthetic',SECRET:'synthetic-secret'};
  const get=tokenProvider({oauth},env,async()=>response(grant()));await get();delete env.SECRET;
  await assert.rejects(()=>get(),/credential|configuration|configured/i);
});

test('token endpoint Retry-After prevents another acquisition attempt until its deadline',async()=>{
  let now=Date.now(),calls=0;const env={ID:'synthetic',SECRET:'synthetic-secret'};
  const get=tokenProvider({oauth},env,async()=>{calls++;return response({error:'synthetic-quota'},429,{'retry-after':'60'});},{clock:()=>now});
  await assert.rejects(()=>get(),error=>error.status===429&&error.retryAfterMs===60000);
  env.SECRET='rotated-synthetic-secret';
  await assert.rejects(()=>get(),error=>error.retryAfterMs>0);assert.equal(calls,1);
  now+=60001;await assert.rejects(()=>get(),error=>error.status===429);assert.equal(calls,2);
});

for(const variant of ['empty-token','unsupported-type','negative-expiry','oversized-response','invalid-utf8'])test(variant+': invalid OAuth data cannot become authorization',async()=>{
  const get=tokenProvider({oauth},{ID:'synthetic',SECRET:'synthetic-secret'},async()=>{
    if(variant==='empty-token')return response(grant(''));
    if(variant==='unsupported-type')return response(grant('synthetic',{token_type:'MAC'}));
    if(variant==='negative-expiry')return response(grant('synthetic',{expires_in:-1}));
    if(variant==='oversized-response')return response(grant('synthetic',{unrelated:'x'.repeat(70000)}));
    return new Response(Buffer.concat([Buffer.from('{"access_token":"synthetic'),Buffer.from([0xff]),Buffer.from('","token_type":"Bearer","expires_in":300}')]),{status:200,headers:{'content-type':'application/json'}});
  });
  await assert.rejects(()=>get(),/OAuth|token|credential/i);
});

test('Jira bearer reads retain the same token provider between calls',async()=>{
  let acquisitions=0,reads=0;
  const jira=new JiraConnector({base:'https://jira-fixture.invalid',auth:'bearer',oauth,projects:['SA']},{env:{ID:'synthetic',SECRET:'synthetic-secret'},fetcher:async url=>{
    if(url.startsWith(oauth.tokenUrl)){acquisitions++;return response(grant());}
    reads++;return response({key:'SA-1'});
  }});
  await jira.issue('SA-1');await jira.issue('SA-2');assert.equal(reads,2);assert.equal(acquisitions,1,'Every Jira request created a new token cache');
});

test('a late response from old credentials cannot replace a rotated token or clear its acquisition',async()=>{
  const env={ID:'synthetic',SECRET:'old-secret'};let calls=0,entered,unblock,oldSignal;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>unblock=resolve);
  const get=tokenProvider({oauth},env,async(url,options)=>{
    calls++;
    if(new URLSearchParams(options.body).get('client_secret')==='old-secret'){oldSignal=options.signal;entered();await gate;return response(grant('old-token'));}
    return response(grant('new-token'));
  });
  const old=get().then(value=>({value}),error=>({error}));await started;
  env.SECRET='new-secret';assert.equal(await get(),'new-token');assert.equal(oldSignal.aborted,true);unblock();
  assert.ok((await old).error);assert.equal(await get(),'new-token');assert.equal(calls,2);
});

test('failed concurrent acquisition shares one failure and a later request can recover',async()=>{
  let calls=0,unblock,entered,fail=true;
  const gate=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve);
  const get=tokenProvider({oauth},{ID:'synthetic',SECRET:'synthetic-secret'},async()=>{calls++;if(fail){entered();await gate;throw new Error('private-synthetic-identity-detail');}return response(grant());});
  const wave=Promise.allSettled(Array.from({length:8},()=>get()));await started;unblock();
  const failures=await wave;assert.ok(failures.every(item=>item.status==='rejected'&&!item.reason.message.includes('private-synthetic-identity-detail')));assert.equal(calls,1);
  fail=false;assert.equal(await get(),'synthetic-token');assert.equal(calls,2);
});

test('short-lived tokens use a proportional refresh margin and missing expiry is never invented',async()=>{
  let now=Date.now(),calls=0,expiry=10;
  const get=tokenProvider({oauth},{ID:'synthetic',SECRET:'synthetic-secret'},async()=>{calls++;const value=grant('token-'+calls);if(expiry===null)delete value.expires_in;else value.expires_in=expiry;return response(value);},{clock:async()=>now});
  assert.equal(await get(),'token-1');now+=8000;assert.equal(await get(),'token-1');assert.equal(calls,1);
  now+=2000;assert.equal(await get(),'token-2');expiry=null;now+=10000;
  assert.equal(await get(),'token-3');assert.equal(await get(),'token-4');
});

test('a resource HTTP 401 refreshes only on the next read without replaying the first request',async()=>{
  let tokens=0,reads=0;
  const github=new GithubConnector({repository:'team/auction',oauth},{env:{ID:'synthetic',SECRET:'synthetic-secret'},fetcher:async url=>{
    if(url===oauth.tokenUrl)return response(grant('token-'+(++tokens)));
    reads++;return response([],reads===1?401:200);
  }});
  await assert.rejects(()=>github.deployments('staging'),error=>error.status===401);assert.equal(tokens,1);assert.equal(reads,1);
  assert.equal((await github.deployments('staging')).complete,true);assert.equal(tokens,2);assert.equal(reads,2);
});

test('a late 401 for an older token cannot invalidate a newer cached token',async()=>{
  let calls=0;
  const get=tokenProvider({oauth},{ID:'synthetic',SECRET:'synthetic-secret'},async()=>response(grant('token-'+(++calls))));
  assert.equal(await get(),'token-1');get.invalidate('token-1');assert.equal(await get(),'token-2');get.invalidate('token-1');
  assert.equal(await get(),'token-2');assert.equal(calls,2);
});

test('static-token override does not resurrect a previously cached OAuth grant when removed',async()=>{
  const env={ID:'synthetic',SECRET:'synthetic-secret'};let calls=0;
  const get=tokenProvider({tokenEnv:'TOKEN',oauth},env,async()=>response(grant('token-'+(++calls))));
  assert.equal(await get(),'token-1');env.TOKEN='static-synthetic';assert.equal(await get(),'static-synthetic');delete env.TOKEN;
  assert.equal(await get(),'token-2');assert.equal(calls,2);
});

for(const variant of ['missing-type','fractional-expiry','non-numeric-expiry','control-character','non-json-type','stream-budget'])test(variant+': OAuth parsing fails without returning provider text',async()=>{
  let cancelled=false;
  const get=tokenProvider({oauth},{ID:'synthetic',SECRET:'synthetic-secret'},async()=>{
    if(variant==='stream-budget')return new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(32768));},cancel(){cancelled=true;}}),{status:200,headers:{'content-type':'application/json'}});
    const value=grant('private-synthetic-token-detail');
    if(variant==='missing-type')delete value.token_type;
    if(variant==='fractional-expiry')value.expires_in=1.5;
    if(variant==='non-numeric-expiry')value.expires_in='unknown';
    if(variant==='control-character')value.access_token+='\r\n';
    return response(value,200,variant==='non-json-type'?{'content-type':'text/html'}:{});
  });
  await assert.rejects(()=>get(),error=>!error.message.includes('private-synthetic-token-detail'));
  if(variant==='stream-budget')assert.equal(cancelled,true,'The oversized credential stream was left active');
});

test('concurrent Jira reads and token-endpoint throttling use actual loopback HTTP without a refresh storm',async()=>{
  let now=Date.now(),tokens=0,reads=0,denyResource=false,limitToken=false;
  const server=createServer(async(request,reply)=>{
    if(request.url==='/token') {
      tokens++;await delay(20);
      reply.writeHead(limitToken?429:200,{'content-type':'application/json',...(limitToken?{'retry-after':'60'}:{})});reply.end(JSON.stringify(limitToken?{error:'synthetic-quota'}:grant('token-'+tokens)));return;
    }
    reads++;reply.writeHead(denyResource?401:200,{'content-type':'application/json'});reply.end(JSON.stringify({key:'SA-1'}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  const jira=new JiraConnector({base,auth:'bearer',oauth,projects:['SA']},{local:true,env:{ID:'synthetic',SECRET:'synthetic-secret'},clock:async()=>now,fetcher:(url,options)=>fetch(url===oauth.tokenUrl?base+'/token':url,options)});
  try {
    await Promise.all(Array.from({length:10},()=>jira.issue('SA-1')));assert.equal(tokens,1);assert.equal(reads,10);
    denyResource=true;await assert.rejects(()=>jira.issue('SA-1'),error=>error.status===401);assert.equal(tokens,1);denyResource=false;limitToken=true;
    const failed=await Promise.allSettled(Array.from({length:8},()=>jira.issue('SA-1')));assert.ok(failed.every(item=>item.status==='rejected'&&item.reason.status===429));assert.equal(tokens,2);assert.equal(reads,11);
    await assert.rejects(()=>jira.issue('SA-1'),error=>error.retryAfterMs>0);assert.equal(tokens,2);
    now+=60001;limitToken=false;await Promise.all(Array.from({length:8},()=>jira.issue('SA-1')));assert.equal(tokens,3);assert.equal(reads,19);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
