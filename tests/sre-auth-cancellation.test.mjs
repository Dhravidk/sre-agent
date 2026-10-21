import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate,setTimeout as delay } from 'node:timers/promises';
import { GithubConnector } from '../src/sre/connectors.mjs';
import { ApiClient } from '../src/sre/http-client.mjs';
import { RequestNotSubmittedError } from '../src/sre/submission.mjs';

const oauth={tokenUrl:'https://identity-cancellation.invalid/token',clientIdEnv:'ID',clientSecretEnv:'SECRET'};
const grant=()=>new Response(JSON.stringify({access_token:'synthetic-token',token_type:'Bearer',expires_in:300}),{status:200,headers:{'content-type':'application/json'}});
const client=fetcher=>new GithubConnector({repository:'team/auction',oauth},{env:{ID:'synthetic-client',SECRET:'synthetic-secret'},fetcher});

test('an already-cancelled read never starts token acquisition or a provider request',async()=>{
  let tokens=0,reads=0;const controller=new AbortController();controller.abort(new Error('private-synthetic-abort-reason'));
  const github=client(async url=>{if(url===oauth.tokenUrl){tokens++;return grant();}reads++;return new Response('[]');});
  const error=await github.deployments('staging',{signal:controller.signal}).then(()=>null,error=>error);
  assert.ok(error);assert.ok(!error.message.includes('private-synthetic-abort-reason'));assert.equal(tokens,0);assert.equal(reads,0);
});

test('one cancelled reader detaches promptly without cancelling another reader shared acquisition',async()=>{
  let entered,unblock,settled=false,tokens=0,reads=0;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>unblock=resolve),controller=new AbortController();
  const github=client(async(url,options)=>{if(url===oauth.tokenUrl){tokens++;entered();await gate;assert.equal(options.signal.aborted,false);return grant();}reads++;return new Response('[]');});
  const first=github.deployments('staging',{signal:controller.signal}).then(value=>({value}),error=>{settled=true;return {error};});
  const second=github.deployments('staging');await started;controller.abort();await setImmediate();
  const promptly=settled;unblock();const [cancelled,completed]=await Promise.all([first,second]);
  assert.equal(promptly,true);assert.ok(cancelled.error);assert.equal(completed.complete,true);assert.equal(tokens,1);assert.equal(reads,1);
});

test('when every reader cancels the abandoned acquisition is aborted and cannot poison a later read',async()=>{
  let entered,unblock,tokenSignal,tokens=0,reads=0;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>unblock=resolve),a=new AbortController(),b=new AbortController();
  const github=client(async(url,options)=>{if(url===oauth.tokenUrl){tokens++;if(tokens===1){tokenSignal=options.signal;entered();await gate;}return grant();}reads++;return new Response('[]');});
  const one=github.deployments('staging',{signal:a.signal}),two=github.deployments('staging',{signal:b.signal});
  const results=Promise.allSettled([one,two]);await started;a.abort();b.abort();await setImmediate();const aborted=tokenSignal.aborted;
  const cancelled=await results;
  assert.equal(aborted,true);assert.ok(cancelled.every(item=>item.status==='rejected'));assert.equal(reads,0);
  try {
    assert.equal((await github.deployments('staging')).complete,true);assert.equal(tokens,2);assert.equal(reads,1);
  } finally {unblock();}
  await setImmediate();assert.equal((await github.deployments('staging')).complete,true);assert.equal(tokens,2);assert.equal(reads,2);
});

test('cancellation during final preflight cannot reach the deployment transport',async()=>{
  let writes=0;const controller=new AbortController();
  const api=new ApiClient({base:'https://deployment-cancellation.invalid',fetcher:async()=>{writes++;return new Response(null,{status:204});}});
  await assert.rejects(()=>api.request('/deploy',{method:'POST',mutating:true,signal:controller.signal,beforeSend:async()=>controller.abort(new Error('private-synthetic-abort-reason'))}),error=>error instanceof RequestNotSubmittedError&&!error.message.includes('private-synthetic-abort-reason'));
  assert.equal(writes,0);
});

test('a generic authentication callback receives cancellation and late rejection is observed safely',async()=>{
  let entered,unblock,authSignal,settled=false,reads=0;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>unblock=resolve),controller=new AbortController();
  const api=new ApiClient({base:'https://generic-auth-cancellation.invalid',auth:async({signal})=>{authSignal=signal;entered();await gate;throw new Error('private-synthetic-late-auth-error');},fetcher:async()=>{reads++;return new Response('[]');}});
  const waiting=api.request('/read',{signal:controller.signal}).then(value=>({value}),error=>{settled=true;return {error};});await started;controller.abort();await setImmediate();const promptly=settled;
  unblock();const result=await waiting;await setImmediate();assert.equal(promptly,true);assert.equal(authSignal.aborted,true);assert.equal(result.error.name,'AbortError');assert.ok(!result.error.message.includes('private-synthetic'));assert.equal(reads,0);
});

test('cancellation after submission remains uncertain and never automatically repeats a deployment',async()=>{
  let writes=0;const controller=new AbortController();
  const api=new ApiClient({base:'https://submitted-cancellation.invalid',fetcher:async()=>{writes++;controller.abort();throw new RequestNotSubmittedError('private-synthetic-transport-detail');}});
  await assert.rejects(()=>api.request('/deploy',{method:'POST',mutating:true,signal:controller.signal}),error=>error.uncertain===true&&!(error instanceof RequestNotSubmittedError)&&!error.message.includes('private-synthetic'));
  assert.equal(writes,1);
});

test('cancellation interrupts read backoff and cannot start the next retry',async()=>{
  let entered,reads=0;const started=new Promise(resolve=>entered=resolve),controller=new AbortController();
  const api=new ApiClient({base:'https://backoff-cancellation.invalid',fetcher:async()=>{reads++;return new Response('{}',{status:500});},sleep:async(ms,value,options)=>{entered();await delay(10000,value,options);}});
  const request=api.request('/read',{signal:controller.signal}).then(value=>({value}),error=>({error}));await started;controller.abort(new Error('private-synthetic-abort-detail'));
  const result=await request;assert.ok(result.error);assert.ok(!result.error.message.includes('private-synthetic'));assert.equal(reads,1);
});
