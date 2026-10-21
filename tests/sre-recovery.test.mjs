import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubConnector, GitlabConnector } from '../src/sre/connectors.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { seedDemo } from '../src/sre/demo.mjs';
import { Rollbacks, assessRollback, releases } from '../src/sre/rollback.mjs';
import { normalize } from '../src/sre/normalize.mjs';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';

const sha='a'.repeat(40),otherSha='b'.repeat(40);
const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const options=fetcher=>({fetcher,env:{TOKEN:'fixture'},sleep:async()=>{}});
const principal=service=>({verified:true,simulation:false,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0],userId:'local-operator'});

async function ready() {
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});
  const runtime=await createSreRuntime({config,autoStart:false});
  const service=config.services[0];
  const {incidentId}=await seedDemo(runtime.store,service);
  await runtime.worker.runOnce();
  return {runtime,service,incidentId,current:assessRollback(await runtime.store.context(incidentId),service).current};
}

async function approved(runtime,service,incidentId,read,dispatch) {
  const executor=new Rollbacks({store:runtime.store,services:[service],mode:'connected',connectors:new Map([[service.key,{github:{deployments:read},rollback:{dispatch}}]])});
  const p=principal(service),proposal=await executor.propose(incidentId,p);
  assert.equal(proposal.eligible,true,proposal.text);
  await executor.approve(proposal.id,proposal.text.split(' ').at(-1),p);
  return {executor,proposal};
}

test('GitHub polling retains failure, queued, unknown and historical inactive deployment states',async()=>{
  const now=Date.now(),states=['success','failure','in_progress','queued',undefined,'inactive'];
  const deployments=states.map((state,index)=>({id:index+1,sha,environment:'staging',created_at:new Date(now-10000).toISOString(),payload:{sre:{artifact:'sha256:'+'c'.repeat(64)}}}));
  const client=new GithubConnector({repository:'test/auction',tokenEnv:'TOKEN'},options(async url=>{
    if(url.includes('/deployments?'))return json(deployments);
    const index=Number(url.match(/deployments\/(\d+)/)[1])-1,state=states[index];
    return json(state?[{state,created_at:new Date(now).toISOString()},...(state==='inactive'?[{state:'success',created_at:new Date(now-5000).toISOString()}]:[])]:[]);
  }));
  const result=await client.deployments('staging');
  assert.equal(result.complete,true);
  assert.deepEqual(result.items.map(x=>x.status),['success','failed','pending','pending','unknown','inactive','success']);
  assert.equal(result.items.at(-1).at,now-5000);
});

test('GitHub rejects a deployment whose status moved it to another environment',async()=>{
  const client=new GithubConnector({repository:'test/auction',tokenEnv:'TOKEN'},options(async url=>json(url.includes('/statuses')?[{state:'success',environment:'production',created_at:new Date().toISOString()}]:[{id:1,sha,environment:'staging'}])));
  await assert.rejects(()=>client.deployments('staging'),/out-of-scope/);
});

test('GitLab reconciliation reads failed and running deployments instead of filtering to success',async()=>{
  const client=new GitlabConnector({base:'https://gitlab.invalid',project:'17',tokenEnv:'TOKEN'},options(async url=>{
    assert.equal(new URL(url).searchParams.has('status'),false);
    return json(['success','failed','running','canceled','created'].map((status,index)=>({id:index+1,sha,environment:{name:'staging'},status,updated_at:new Date().toISOString()})));
  }));
  assert.deepEqual((await client.deployments('staging')).items.map(x=>x.status),['success','failed','pending','failed','pending']);
});

test('deployment webhooks retain nonterminal status and honor status-level environment',()=>{
  const service=loadConfig({}).services[0];
  const github=normalize('github',{repository:{full_name:service.github.repository},deployment:{id:1,sha,environment:service.environment},deployment_status:{state:'in_progress',created_at:new Date().toISOString()}},service,{eventType:'deployment_status'});
  assert.equal(github.payload.status,'pending');
  assert.throws(()=>normalize('github',{repository:{full_name:service.github.repository},deployment:{id:1,sha,environment:service.environment},deployment_status:{state:'success',environment:'other',created_at:new Date().toISOString()}},service,{eventType:'deployment_status'}),/outside/);
  const gitlab=normalize('gitlab',{object_kind:'deployment',project:{id:17},deployment_id:1,sha,environment:service.environment,status:'running',status_changed_at:new Date().toISOString()},service);
  assert.equal(gitlab.payload.status,'pending');
});

test('redeploying a SHA cannot inherit compatibility or health from an earlier deployment',()=>{
  const prior={provider:'github',id:'1',environment:'staging',sha,at:100,status:'success',artifact:'sha256:'+'c'.repeat(64),rollbackCompatible:true,dataRollbackSafe:true,healthy:true};
  const next={provider:'github',id:'2',environment:'staging',sha,at:200,status:'success'};
  const history=releases([prior,next]);
  assert.equal(history.length,2);
  assert.equal(history[0].rollbackCompatible,undefined);
  assert.equal(history[0].artifact,undefined);
  assert.equal(history[0].healthy,undefined);
  assert.equal(releases([prior,{...prior,at:200,rollbackCompatible:null}])[0].rollbackCompatible,null);
  assert.equal(releases([prior,{...prior,artifact:'sha256:'+'d'.repeat(64),at:200}])[0].identityConflict,true);
});

for(const status of ['failed','pending','unknown'])test('fresh rollback check blocks a newer '+status+' deployment even with the same SHA',async()=>{
  const {runtime,service,incidentId,current}=await ready();let writes=0;
  try {
    const {executor,proposal}=await approved(runtime,service,incidentId,async()=>({complete:true,items:[current,{...current,id:'new-attempt',at:current.at+1000,status}]}),async()=>{writes++;return {};});
    await executor.executeNext();
    assert.equal(writes,0);
    assert.equal((await runtime.store.snapshot()).rollbacks.find(x=>x.id===proposal.id).status,'blocked');
  } finally {await runtime.close();}
});

test('a different deployment of the same SHA invalidates an approved rollback',async()=>{
  const {runtime,service,incidentId,current}=await ready();let writes=0;
  try {
    const {executor}=await approved(runtime,service,incidentId,async()=>({complete:true,items:[{...current,id:'replacement',at:current.at+1000}]}),async()=>{writes++;return {};});
    await executor.executeNext();
    assert.equal(writes,0);
    assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'blocked');
  } finally {await runtime.close();}
});

test('an execution lease expiring during remote revalidation cannot dispatch',async()=>{
  const {runtime,service,incidentId,current}=await ready();let writes=0,now=runtime.store.clock();runtime.store.clock=()=>now;
  try {
    const {executor}=await approved(runtime,service,incidentId,async()=>{now+=180001;return {complete:true,items:[current]};},async()=>{writes++;return {};});
    await executor.executeNext();
    assert.equal(writes,0);
    assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'blocked');
  } finally {await runtime.close();}
});

test('concurrent approved proposals for a service cannot both dispatch',async()=>{
  const {runtime,service,incidentId,current}=await ready();let writes=0,unblock,entered;
  const waiting=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve);
  const read=async()=>{entered();await waiting;return {complete:true,items:[current]};};
  try {
    const first=await approved(runtime,service,incidentId,read,async()=>{writes++;return {};});
    const second=await approved(runtime,service,incidentId,async()=>({complete:true,items:[current]}),async()=>{writes++;return {};});
    const running=first.executor.executeNext();
    await started;
    await second.executor.executeNext();
    unblock();await running;
    assert.equal(writes,1);
  } finally {unblock();await runtime.close();}
});

test('a reclaimed execution fences the original delayed worker without overwriting its receipt',async()=>{
  const {runtime,service,incidentId,current}=await ready();let writes=0,unblock,entered,now=runtime.store.clock();runtime.store.clock=()=>now;
  const waiting=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve);
  try {
    const first=await approved(runtime,service,incidentId,async()=>{entered();await waiting;return {complete:true,items:[current]};},async()=>{writes++;return {id:'first'};});
    const original=first.executor.executeNext();await started;now+=180001;
    await first.executor.recoverInterrupted();
    const second=new Rollbacks({store:runtime.store,services:[service],mode:'connected',connectors:new Map([[service.key,{github:{deployments:async()=>({complete:true,items:[current]})},rollback:{dispatch:async()=>{writes++;return {id:'replacement'};}}}]])});
    await second.executeNext();unblock();await original;
    const saved=(await runtime.store.snapshot()).rollbacks[0];
    assert.equal(writes,1);assert.equal(saved.status,'dispatched');
    assert.equal(JSON.parse(saved.external_ref).id,'replacement');
    assert.equal((await runtime.store.snapshot()).outbox.filter(x=>x.id==='rollback:'+saved.id+':dispatched').length,1);
  } finally {unblock();await runtime.close();}
});

test('new incident evidence during deployment revalidation blocks dispatch',async()=>{
  const {runtime,service,incidentId,current}=await ready();let writes=0;
  try {
    const {executor}=await approved(runtime,service,incidentId,async()=>{
      await runtime.store.ingest({id:'new-evidence',source:'operator-api',serviceKey:service.key,kind:'question',incidentId,at:runtime.store.clock(),payload:{text:'New observations contradict the earlier assessment'}});
      return {complete:true,items:[current]};
    },async()=>{writes++;return {};});
    await executor.executeNext();assert.equal(writes,0);
    assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'blocked');
  } finally {await runtime.close();}
});

test('changing the repository after approval invalidates the action even if the same SHA exists there',async()=>{
  const {runtime,service,incidentId,current}=await ready();let writes=0;
  try {
    const {executor}=await approved(runtime,service,incidentId,async()=>({complete:true,items:[current]}),async()=>{writes++;return {};});
    service.github.repository='other/auction';
    await executor.executeNext();assert.equal(writes,0);
    assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'blocked');
  } finally {await runtime.close();}
});

test('GitHub PR collection refuses a stale webhook SHA and a head moving during diff reads',async()=>{
  const client=new GithubConnector({repository:'test/auction',tokenEnv:'TOKEN'},options(async url=>json(url.includes('/files')?[]:{head:{sha},changed_files:0})));
  await assert.rejects(()=>client.pull(42,{expectedSha:otherSha}),/head changed/);
  let reads=0;
  const moving=new GithubConnector({repository:'test/auction',tokenEnv:'TOKEN'},options(async url=>json(url.includes('/files')?[]:{head:{sha:++reads===1?sha:otherSha},changed_files:0})));
  await assert.rejects(()=>moving.pull(42,{expectedSha:sha}),/head changed/);
});

function failNextRollbackNotice(store) {
  const original=store.queueMessage.bind(store);let remaining=1;
  store.queueMessage=async(...args)=>{
    if(remaining&&String(args[3]).startsWith('rollback:')){remaining--;throw new Error('injected outbox storage failure');}
    return original(...args);
  };
}

test('uncertain dispatch and its notification commit together after a storage failure',async()=>{
  const {runtime,service,incidentId,current}=await ready();let writes=0,now=runtime.store.clock();runtime.store.clock=()=>now;
  try {
    const {executor}=await approved(runtime,service,incidentId,async()=>({complete:true,items:[current]}),async()=>{writes++;throw new Error('transport outcome unknown');});
    failNextRollbackNotice(runtime.store);
    await assert.rejects(()=>executor.executeNext(),/injected outbox storage failure/);
    assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'dispatching','An unsaved notice must not leave a terminal state without its outbox intent');
    now+=180001;await executor.recoverInterrupted();
    const snapshot=await runtime.store.snapshot();
    assert.equal(snapshot.rollbacks[0].status,'unknown');
    assert.ok(snapshot.outbox.some(x=>x.text.includes('outcome is unknown')));
    await executor.executeNext();assert.equal(writes,1);
  } finally {await runtime.close();}
});

test('blocked dispatch and its notification roll back together when storage fails',async()=>{
  const {runtime,service,incidentId,current}=await ready();let writes=0,now=runtime.store.clock();runtime.store.clock=()=>now;
  try {
    const {executor}=await approved(runtime,service,incidentId,async()=>({complete:false,items:[current]}),async()=>{writes++;return {};});
    failNextRollbackNotice(runtime.store);
    await assert.rejects(()=>executor.executeNext(),/injected outbox storage failure/);
    assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'checking');
    now+=180001;await executor.recoverInterrupted();await executor.executeNext();
    const snapshot=await runtime.store.snapshot();
    assert.equal(snapshot.rollbacks[0].status,'blocked');
    assert.ok(snapshot.outbox.some(x=>x.text.includes('was blocked')));assert.equal(writes,0);
  } finally {await runtime.close();}
});

test('recovery of an interrupted dispatch durably queues one uncertainty notice',async()=>{
  const {runtime,service,incidentId,current}=await ready();
  try {
    const {executor,proposal}=await approved(runtime,service,incidentId,async()=>({complete:true,items:[current]}),async()=>({}));
    await runtime.store.db.query("UPDATE sre_rollbacks SET status='dispatching',lease_until=? WHERE id=?",[runtime.store.clock()-1,proposal.id]);
    failNextRollbackNotice(runtime.store);
    await assert.rejects(()=>executor.recoverInterrupted(),/injected outbox storage failure/);
    assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'dispatching');
    await executor.recoverInterrupted();await executor.recoverInterrupted();
    const snapshot=await runtime.store.snapshot();
    assert.equal(snapshot.rollbacks[0].status,'unknown');
    assert.equal(snapshot.outbox.filter(x=>x.text.includes('outcome is unknown')).length,1);
  } finally {await runtime.close();}
});

test('a known late dispatch receipt sends a new notice after an uncertainty notice',async()=>{
  const {runtime,service,incidentId,current}=await ready();let entered,unblock,now=runtime.store.clock();runtime.store.clock=()=>now;
  const waiting=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve);
  try {
    const {executor}=await approved(runtime,service,incidentId,async()=>({complete:true,items:[current]}),async()=>{entered();await waiting;return {id:'known-receipt'};});
    const running=executor.executeNext();await started;now+=180001;
    await executor.recoverInterrupted();unblock();await running;
    const snapshot=await runtime.store.snapshot();
    assert.equal(snapshot.rollbacks[0].status,'dispatched');
    assert.equal(snapshot.outbox.filter(x=>x.text.includes('outcome is unknown')).length,1);
    assert.equal(snapshot.outbox.filter(x=>x.text.includes('workflow dispatched')).length,1);
  } finally {unblock();await runtime.close();}
});

async function verificationFixture() {
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});
  config.mode='connected';config.apiToken='fixture-api';config.env={HEALTH_SECRET:'fixture-health'};
  const service=config.services[0];service.verification={webhookSecretEnv:'HEALTH_SECRET'};
  const runtime=await createSreRuntime({config,connectors:new Map(),autoStart:false});
  let now=Date.now();runtime.store.clock=()=>now;
  const {incidentId}=await seedDemo(runtime.store,service);
  const context=await runtime.store.context(incidentId),current=assessRollback(context,service).current;
  for(const [key,state] of Object.entries(JSON.parse(context.incident.source_states)))await runtime.store.ingest({id:'close:'+key,source:state.source||key,serviceKey:service.key,kind:'problem',issueKey:context.incident.issue_key,status:'CLOSED',at:now-1000,startedAt:context.incident.started_at,payload:state.sourceId?{sys_id:state.sourceId}:{}});
  runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');
  const url='http://127.0.0.1:'+runtime.server.address().port+'/webhooks/verification/'+service.key;
  const proof={id:'proof-1',incidentId,environment:service.environment,healthy:true,sha:current.sha,artifact:current.artifact,deploymentAt:current.at,observedAt:now,evidenceUrl:'https://verifier.invalid/auction/1',checks:{technical:true,businessInvariants:true}};
  return {runtime,service,incidentId,current,proof,setNow:value=>now=value,send:async(payload=proof)=>{
    const body=JSON.stringify(payload),timestamp=String(now),signature='sha256='+createHmac('sha256',config.env.HEALTH_SECRET).update(timestamp+'.'+body).digest('hex');
    return fetch(url,{method:'POST',headers:{'x-sre-timestamp':timestamp,'x-sre-signature':signature},body});
  }};
}

for(const variant of ['stale','artifact','unsettled','business-check','future','deployment-identity','rollback-request'])test('signed recovery proof rejects '+variant+' evidence and leaves the incident verifying',async()=>{
  const f=await verificationFixture();
  try {
    const proof={...f.proof};
    if(variant==='stale')f.setNow(proof.observedAt+600000);
    if(variant==='artifact')proof.artifact='sha256:'+'f'.repeat(64);
    if(variant==='future')proof.observedAt+=60000;
    if(variant==='business-check')proof.checks={technical:true,businessInvariants:false};
    if(variant==='deployment-identity')proof.deploymentAt-=1000;
    if(variant==='rollback-request')proof.rollbackRequestId='rb-not-a-dispatched-action';
    if(variant==='unsettled')await f.runtime.store.ingest({id:'pending',source:'github',serviceKey:f.service.key,kind:'deployment',at:proof.observedAt-500,payload:{...f.current,id:'new-attempt',status:'pending'}});
    const response=await f.send(proof);
    assert.equal(response.status,400,await response.text());
    assert.equal((await f.runtime.store.context(f.incidentId)).incident.status,'verifying');
  } finally {await f.runtime.close();}
});

test('a fresh scoped proof resolves once and identical signed redelivery is idempotent',async()=>{
  const f=await verificationFixture();
  try {
    assert.equal((await f.send()).status,202);
    assert.equal((await f.runtime.store.context(f.incidentId)).incident.status,'resolved');
    const duplicate=await f.send();
    assert.equal(duplicate.status,202);
    assert.equal((await duplicate.json()).duplicate,true);
  } finally {await f.runtime.close();}
});
