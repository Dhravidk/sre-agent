import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { GithubConnector,GitlabConnector } from '../src/sre/connectors.mjs';
import { ApiClient } from '../src/sre/http-client.mjs';
import { RequestNotSubmittedError } from '../src/sre/submission.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { loadConfig } from '../src/sre/config.mjs';

const sha='a'.repeat(40);
async function provider(handler) {
  const calls=[];
  const server=createServer((request,response)=>{
    calls.push({path:request.url,method:request.method});
    const reply=handler(new URL(request.url,'http://127.0.0.1'),request)||{};
    response.writeHead(reply.status||200,{'content-type':'application/json',...reply.headers});response.end(JSON.stringify(reply.body??[]));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {base:'http://127.0.0.1:'+server.address().port,calls,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

test('GitHub follows a next-page indication after an empty page without changing repository scope',async()=>{
  const fixture=await provider(url=>{
    if(url.pathname.endsWith('/statuses'))return {body:[{state:'success',environment:'staging',created_at:new Date().toISOString()}]};
    if(url.searchParams.get('page')==='1')return {body:[],headers:{link:'<'+fixture.base+'/repositories/123/deployments?environment=staging&per_page=30&page=2>; rel="next"'}};
    return {body:[{id:2,sha,environment:'staging',created_at:new Date().toISOString()}]};
  });
  const github=new GithubConnector({base:fixture.base,repository:'team/auction',tokenEnv:'TOKEN'},{local:true,env:{TOKEN:'synthetic'}});
  try {
    const result=await github.deployments('staging');assert.equal(result.complete,true);assert.equal(result.items[0]?.deploymentId,'2');
    assert.equal(fixture.calls.filter(call=>call.path.startsWith('/repos/team/auction/deployments?')).length,2);
    assert.ok(fixture.calls.every(call=>call.path.startsWith('/repos/team/auction/')),'Pagination changed the configured repository');
  } finally {await fixture.close();}
});

test('GitLab next-page metadata prevents an empty page from hiding a deployment',async()=>{
  const fixture=await provider(url=>url.searchParams.get('page')==='1'?{body:[],headers:{'x-next-page':'2'}}:{body:[{id:17,sha,environment:{name:'staging'},status:'success',updated_at:new Date().toISOString()}]});
  const gitlab=new GitlabConnector({base:fixture.base,project:'17',tokenEnv:'TOKEN'},{local:true,env:{TOKEN:'synthetic'}});
  try {const result=await gitlab.deployments('staging');assert.equal(result.complete,true);assert.equal(result.items[0]?.deploymentId,'17');assert.equal(fixture.calls.length,2);}
  finally {await fixture.close();}
});

test('sparse pages cannot bypass the configured page budget and claim complete history',async()=>{
  const fixture=await provider(url=>({body:[],headers:{link:'<'+fixture.base+'/items?page='+(Number(url.searchParams.get('page'))+1)+'>; rel="next"'}}));
  const client=new ApiClient({base:fixture.base,local:true});
  try {const result=await client.pages('/items',{maxPages:2});assert.equal(result.complete,false);assert.equal(fixture.calls.length,2);}
  finally {await fixture.close();}
});

test('an unsupported continuation cannot certify complete pagination or cause a credentialed foreign request',async()=>{
  const fixture=await provider(()=>({body:[],headers:{link:'<https://foreign-fixture.invalid/items?after=opaque>; rel="next"'}}));
  const client=new ApiClient({base:fixture.base,local:true,headers:{authorization:'Bearer synthetic'}});
  try {await assert.rejects(()=>client.pages('/items'),/pagination continuation/i);assert.equal(fixture.calls.length,1);}
  finally {await fixture.close();}
});

test('a long Retry-After survives the next polling attempt without another provider request',async()=>{
  let now=Date.now(),limited=true;
  const fixture=await provider(()=>limited?{status:429,headers:{'retry-after':'60'},body:{message:'Synthetic quota'}}:{body:{ok:true}});
  const client=new ApiClient({base:fixture.base,local:true,clock:()=>now});
  try {
    await assert.rejects(()=>client.request('/read'),error=>error.retryAfterMs===60000);
    await assert.rejects(()=>client.request('/read'),error=>error.retryAfterMs>0);assert.equal(fixture.calls.length,1,'The next poll ignored the provider delay');
    now+=60001;limited=false;assert.deepEqual(await client.request('/read'),{ok:true});assert.equal(fixture.calls.length,2);
  } finally {await fixture.close();}
});

test('GitHub primary rate-limit reset prevents repeated forbidden polling until the reset',async()=>{
  let now=Math.floor(Date.now()/1000)*1000,limited=true;
  const fixture=await provider(()=>limited?{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(now/1000+3600)},body:{message:'Synthetic quota'}}:{body:[]});
  const github=new GithubConnector({base:fixture.base,repository:'team/auction',tokenEnv:'TOKEN'},{local:true,env:{TOKEN:'synthetic'},clock:()=>now});
  try {
    await assert.rejects(()=>github.deployments('staging'),error=>error.status===403&&error.retryAfterMs===3600000);
    await assert.rejects(()=>github.deployments('staging'),error=>error.retryAfterMs>0);assert.equal(fixture.calls.length,1);
    now+=3600001;limited=false;assert.equal((await github.deployments('staging')).complete,true);assert.equal(fixture.calls.length,2);
  } finally {await fixture.close();}
});

test('a delay on the final retry is retained and a deferred deployment request never reaches transport',async()=>{
  let now=Date.now();
  const fixture=await provider(()=>fixture.calls.length<3?{status:500,headers:{'retry-after':'0'}}:{status:429,headers:{'retry-after':'120'}});
  const client=new ApiClient({base:fixture.base,local:true,clock:async()=>now,sleep:async()=>{}});
  try {
    await assert.rejects(()=>client.request('/read'),error=>error.status===429&&error.retryAfterMs===120000);assert.equal(fixture.calls.length,3);
    await assert.rejects(()=>client.request('/deploy',{method:'POST',mutating:true,body:{action:'synthetic'}}),error=>error instanceof RequestNotSubmittedError);
    assert.equal(fixture.calls.length,3);assert.ok(fixture.calls.every(call=>call.method==='GET'));
  } finally {await fixture.close();}
});

test('a provider date delay uses the configured asynchronous clock and defaults remain bounded',async()=>{
  let now=Math.floor(Date.now()/1000)*1000,dated=true;
  const fixture=await provider(()=>({status:429,headers:dated?{'retry-after':new Date(now+90000).toUTCString()}:undefined}));
  const client=new ApiClient({base:fixture.base,local:true,clock:async()=>now});
  try {
    await assert.rejects(()=>client.request('/read'),error=>error.retryAfterMs===90000);assert.equal(fixture.calls.length,1);
    now+=90001;dated=false;
    await assert.rejects(()=>client.request('/read'),error=>error.retryAfterMs===60000);assert.equal(fixture.calls.length,2);
    await assert.rejects(()=>client.request('/read'),error=>error.retryAfterMs===60000);assert.equal(fixture.calls.length,2);
  } finally {await fixture.close();}
});

test('rate-limited and incomplete polling retain the cursor until a complete own read recovers',async()=>{
  let now=Date.now(),mode='healthy';
  const fixture=await provider(url=>{
    if(mode==='limited')return {status:429,headers:{'retry-after':'60'}};
    if(mode==='partial')return {body:[],headers:{link:'<'+fixture.base+'/repositories/123/deployments?page='+(Number(url.searchParams.get('page'))+1)+'>; rel="next"'}};
    if(url.pathname.endsWith('/statuses'))return {body:[{state:'success',environment:'staging',created_at:new Date(now-1000).toISOString()}]};
    return {body:[{id:1,sha,environment:'staging',created_at:new Date(now-1000).toISOString()}]};
  });
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=config.services[0];Object.assign(config,{mode:'connected',teamsMode:'off',operations:{notify:false}});service.github.enabled=true;service.environment='staging';
  const github=new GithubConnector({base:fixture.base,repository:service.github.repository,tokenEnv:'TOKEN'},{local:true,env:{TOKEN:'synthetic'},clock:()=>now});
  const runtime=await createSreRuntime({config,autoStart:false,connectors:new Map([[service.key,{github}]])});runtime.store.clock=()=>now;
  try {
    const key='github:'+service.key;await runtime.poll();const original=await runtime.store.checkpoint(key);assert.equal((await runtime.operations.snapshot()).state,'healthy');
    now+=10000;mode='limited';await runtime.poll();const limitedCalls=fixture.calls.length;
    now+=10000;await runtime.poll();assert.equal(fixture.calls.length,limitedCalls);assert.equal((await runtime.store.checkpoint(key)).until,original.until);
    assert.ok((await runtime.operations.snapshot()).conditions.some(item=>item.code==='instance_poll_error'));
    now+=60000;mode='partial';await runtime.poll();assert.equal(fixture.calls.length,limitedCalls+2);assert.equal((await runtime.store.checkpoint(key)).until,original.until);
    assert.equal((await runtime.operations.snapshot()).state,'needs-attention');
    now+=1000;mode='healthy';await runtime.poll();const complete=await runtime.store.checkpoint(key);
    assert.equal(complete.until,now);assert.equal(complete.error,undefined);assert.equal((await runtime.operations.snapshot()).state,'healthy');
    assert.equal((await runtime.store.snapshot()).incidents.length,0);
  } finally {await runtime.close();await fixture.close();}
});

for(const variant of ['out-of-order','ambiguous-next','mixed-cursor','invalid-budget'])test(variant+': invalid paging cannot produce a complete result',async()=>{
  const fixture=await provider(()=>({body:[],headers:{link:variant==='out-of-order'?'<'+fixture.base+'/items?page=9>; rel="next"':variant==='mixed-cursor'?'<'+fixture.base+'/items?page=2&after=opaque>; rel="next"':'<'+fixture.base+'/items?page=2>; rel="next", <'+fixture.base+'/items?page=3>; rel="next"'}}));
  const client=new ApiClient({base:fixture.base,local:true});
  try {await assert.rejects(()=>client.pages('/items',variant==='invalid-budget'?{maxPages:NaN}:{}),/pagination/i);assert.equal(fixture.calls.length,variant==='invalid-budget'?0:1);}
  finally {await fixture.close();}
});
