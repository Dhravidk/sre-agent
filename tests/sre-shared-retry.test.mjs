import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient,tokenProvider } from '../src/sre/http-client.mjs';
import { createConnectors } from '../src/sre/connectors.mjs';
import { RequestNotSubmittedError } from '../src/sre/submission.mjs';
import { loadConfig,validateConfig } from '../src/sre/config.mjs';

const response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
function sharedGate() {
  let now=Date.now();const record={until:0,status:429};
  const gate={read:async()=>record.until>now?{...record,retryAfterMs:record.until-now}:null,defer:async value=>{if(value.until>record.until)Object.assign(record,value);}};
  return {record,gate,now:()=>now,advance:ms=>now+=ms};
}

test('received provider delay is committed to the configured shared gate before returning',async()=>{
  const f=sharedGate();
  const api=new ApiClient({base:'https://retry-fixture.invalid',clock:f.now,retryGate:f.gate,fetcher:async()=>response({},429,{'retry-after':'60'})});
  await assert.rejects(()=>api.request('/read'),error=>error.status===429);assert.equal(f.record.until,f.now()+60000);
});

test('a new client honors an already committed shared wait before authentication or transport',async()=>{
  const f=sharedGate();f.record.until=f.now()+60000;let auth=0,calls=0;
  const api=new ApiClient({base:'https://retry-fixture.invalid',clock:f.now,retryGate:f.gate,auth:async()=>{auth++;return {};},fetcher:async()=>{calls++;return response([]);}});
  await assert.rejects(()=>api.request('/read'),error=>error.status===429&&error.retryAfterMs>0);assert.equal(auth,0);assert.equal(calls,0);
  f.advance(60001);await api.request('/read');assert.equal(auth,1);assert.equal(calls,1);
});

test('a fresh OAuth provider honors the shared issuer wait before acquiring a token',async()=>{
  const f=sharedGate();f.record.until=f.now()+60000;let tokens=0;
  const get=tokenProvider({oauth:{tokenUrl:'https://issuer-retry.invalid/token',clientIdEnv:'ID',clientSecretEnv:'SECRET'}},{ID:'synthetic',SECRET:'synthetic-secret'},async()=>{tokens++;return response({access_token:'synthetic-token',token_type:'Bearer',expires_in:300});},{clock:f.now,retryGate:f.gate});
  await assert.rejects(()=>get(),error=>error.status===429&&error.retryAfterMs>0);assert.equal(tokens,0);
  f.advance(60001);assert.equal(await get(),'synthetic-token');assert.equal(tokens,1);
});

test('shared retry storage failure prevents an uncoordinated provider request',async()=>{
  let calls=0;
  const api=new ApiClient({base:'https://retry-fixture.invalid',retryGate:{read:async()=>{throw new Error('private-synthetic-storage-detail');}},fetcher:async()=>{calls++;return response([]);}});
  await assert.rejects(()=>api.request('/read'));assert.equal(calls,0);
});

for(const provider of ['github','gitlab'])test(provider+': missing write credentials cannot fall back to the reader OAuth identity',async()=>{
  const now=Date.now();let tokens=0,writes=0;
  const service={key:'identity-test',tenant:'test-tenant',environment:'staging',[provider]:{enabled:true,base:'https://provider-retry.invalid',repository:'fixture/auction',project:'17',tokenEnv:'READ',oauth:{tokenUrl:'https://reader-issuer.invalid/token',clientIdEnv:'READ_ID',clientSecretEnv:'READ_SECRET'}},rollback:{enabled:true,provider,tokenEnv:'WRITE',workflow:'rollback.yml',ref:'main'}};
  const clients=createConnectors(service,{env:{READ_ID:'synthetic-reader',READ_SECRET:'synthetic-reader-secret'},fetcher:async url=>{
    if(url.startsWith('https://reader-issuer.invalid/')){tokens++;return response({access_token:'synthetic-reader-grant',token_type:'Bearer',expires_in:300});}
    writes++;return provider==='github'?new Response(null,{status:204}):response({id:9},201);
  }});
  await assert.rejects(()=>clients.rollback.dispatch({id:'rb-synthetic',environment:'staging',approval:{approvedAt:now-1000,expiresAt:now+600000},current:{sha:'b'.repeat(40),artifact:'sha256:'+'c'.repeat(64),deploymentId:'17',at:now-10000},target:{sha:'a'.repeat(40),artifact:'sha256:'+'d'.repeat(64)}}),error=>error instanceof RequestNotSubmittedError);
  assert.equal(tokens,0);assert.equal(writes,0);
});

for(const failure of ['active-hold','unavailable-storage'])test(failure+': a deployment blocked by shared coordination has no transport invocation',async()=>{
  const f=sharedGate();f.record.until=f.now()+60000;let calls=0,auth=0;
  const gate=failure==='active-hold'?f.gate:{read:async()=>{throw new Error('private-storage-detail');}};
  const api=new ApiClient({base:'https://retry-fixture.invalid',clock:f.now,retryGate:gate,auth:async()=>{auth++;return {};},fetcher:async()=>{calls++;return response({});}});
  await assert.rejects(()=>api.request('/write',{method:'POST',mutating:true,body:{}}),error=>error instanceof RequestNotSubmittedError&&!error.message.includes('private-storage'));
  assert.equal(calls,0);assert.equal(auth,0);
});
for(const failure of ['received-429','failed-persistence'])test(failure+': a submitted deployment remains uncertain and is never replayed',async()=>{
  const f=sharedGate();let calls=0;
  const gate=failure==='received-429'?f.gate:{read:async()=>null,defer:async()=>{throw new Error('private-storage-detail');}};
  const api=new ApiClient({base:'https://retry-fixture.invalid',clock:f.now,retryGate:gate,fetcher:async()=>{calls++;return response({},429,{'retry-after':'60'});}});
  await assert.rejects(()=>api.request('/write',{method:'POST',mutating:true,body:{}}),error=>error.uncertain===true&&!(error instanceof RequestNotSubmittedError)&&!error.message.includes('private-storage'));
  assert.equal(calls,1);assert.equal(api.cooldown.until,f.now()+60000);
  if(failure==='received-429')assert.equal(f.record.until,f.now()+60000);
});

test('valid cached OAuth token remains usable during a shared issuer hold; a failed gate cannot acquire a new token',async()=>{
  const f=sharedGate();let calls=0,unavailable=false;
  const gate={read:async()=>{if(unavailable)throw new Error('private-storage-detail');return f.gate.read();},defer:f.gate.defer};
  const get=tokenProvider({oauth:{tokenUrl:'https://issuer-retry.invalid/token',clientIdEnv:'ID',clientSecretEnv:'SECRET'}},{ID:'synthetic',SECRET:'synthetic-secret'},async()=>{calls++;return response({access_token:'synthetic-grant',token_type:'Bearer',expires_in:300});},{clock:f.now,retryGate:gate});
  assert.equal(await get(),'synthetic-grant');f.record.until=f.now()+60000;assert.equal(await get(),'synthetic-grant');assert.equal(calls,1);
  get.invalidate('synthetic-grant');unavailable=true;
  await assert.rejects(()=>get(),error=>error.status===undefined&&!error.message.includes('private-storage'));assert.equal(calls,1);
});

test('connector factory keeps reader, writer and issuer quota assignments explicit',()=>{
  const descriptors=[];
  const service={tenant:'synthetic',github:{enabled:true,repository:'fixture/auction',tokenEnv:'READ',retryScope:'read-account',oauth:{tokenUrl:'https://issuer-retry.invalid/token',retryScope:'read-issuer'}},rollback:{enabled:true,provider:'github',tokenEnv:'WRITE',workflow:'rollback.yml',ref:'main'}};
  const clients=createConnectors(service,{retryGateFactory:descriptor=>{descriptors.push(descriptor);return {descriptor};}});
  assert.equal(descriptors.length,2);assert.equal(clients.github.retryGate.descriptor.scope,'read-account');assert.equal(clients.rollback.retryGate,undefined);assert.equal(clients.rollback.config.oauth,undefined);
  service.rollback.retryScope='write-account';service.rollback.oauth={tokenUrl:'https://issuer-retry.invalid/write',clientIdEnv:'WRITE_ID',clientSecretEnv:'WRITE_SECRET',retryScope:'write-issuer'};
  const explicit=createConnectors(service,{retryGateFactory:descriptor=>({descriptor})});assert.equal(explicit.rollback.retryGate.descriptor.scope,'write-account');assert.equal(explicit.rollback.config.oauth,service.rollback.oauth);
});

test('Dynatrace API/logs at one endpoint can explicitly share a quota bucket',()=>{
  const descriptors=[],config={enabled:true,base:'https://dynatrace-retry.invalid',entityId:'SERVICE-SYNTHETIC',tokenEnv:'TOKEN',retryScope:'shared-account'};
  createConnectors({tenant:'synthetic',dynatrace:config,dynatraceLogs:{...config}},{retryGateFactory:descriptor=>{descriptors.push(descriptor);return {};}});
  assert.equal(descriptors.length,2);assert.deepEqual(descriptors[0],descriptors[1]);assert.equal(descriptors[0].provider,'dynatrace');
});

test('configuration rejects invalid quota labels and overlapping writer OAuth credential names',()=>{
  const config=loadConfig({});
  for(const value of ['',null,42,'contains spaces','a'.repeat(129)]) {
    const copy=structuredClone({...config,env:undefined});copy.services[0].github.retryScope=value;
    assert.throws(()=>validateConfig(copy,{}),/github.retryScope/);
  }
  config.mode='connected';config.agentMode='rules';const service=config.services[0];
  service.github.enabled=true;service.github.oauth={clientIdEnv:'READ_ID',clientSecretEnv:'READ_SECRET'};
  service.rollback={enabled:true,provider:'github',tokenEnv:'WRITE',workflow:'rollback.yml',ref:'main',oauth:{clientIdEnv:'READ_ID',clientSecretEnv:'WRITE_SECRET'}};
  const env={SRE_API_TOKEN:'synthetic',SRE_CAPABILITY_SECRET:'s'.repeat(32)};
  assert.throws(()=>validateConfig(config,env),/separate write credential/);
  service.rollback.oauth.clientIdEnv='WRITE_ID';assert.doesNotThrow(()=>validateConfig(config,env));
});

test('OAuth waiter cancellation during a shared-store lookup cannot submit a late token acquisition',async()=>{
  let entered,release,calls=0;const observed=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{release=resolve;}),controller=new AbortController();
  const get=tokenProvider({oauth:{tokenUrl:'https://issuer-retry.invalid/token',clientIdEnv:'ID',clientSecretEnv:'SECRET'}},{ID:'synthetic',SECRET:'synthetic-secret'},async()=>{calls++;return response({access_token:'synthetic',token_type:'Bearer'});},{retryGate:{read:async()=>{entered();await waiting;return null;}}});
  const result=get({signal:controller.signal});await observed;controller.abort();await assert.rejects(result,error=>error.name==='AbortError');
  release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
});
