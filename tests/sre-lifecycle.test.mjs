import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createSreRuntime } from '../src/sre/server.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { RulesReasoner } from '../src/sre/reasoner.mjs';
import { devActivity } from '../src/sre/demo.mjs';
import {StorageError} from '../src/sre/database.mjs';

test('shutdown cleanup closes provider clients and storage even when releasing its worker lease fails',async()=>{
 const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),failure=new StorageError(Error('Controlled unavailable lease storage'));let clientsClosed=0,storageClosed=0;
 const client={close:async()=>{clientsClosed++;}},runtime=await createSreRuntime({config,autoStart:false,connectors:new Map([[config.services[0].key,{github:client,gitlab:client}]])}),closeDb=runtime.store.db.close.bind(runtime.store.db);runtime.store.release=async()=>{throw failure;};runtime.store.db.close=async()=>{storageClosed++;await closeDb();};
 try{const closing=runtime.close();assert.equal(runtime.close(),closing);await assert.rejects(closing,error=>error===failure);assert.equal(clientsClosed,1);assert.equal(storageClosed,1);assert.equal(await runtime.actions(),false);}finally{if(!storageClosed)await closeDb();}
});
test('shutdown cleanup retains multiple failures while still closing every remaining resource once',async()=>{
 const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),lease=new StorageError(Error('Controlled lease failure')),provider=Error('Controlled provider close failure');let first=0,second=0,storage=0;
 const runtime=await createSreRuntime({config,autoStart:false,connectors:new Map([[config.services[0].key,{github:{close:async()=>{first++;throw provider;}},gitlab:{close:async()=>{second++;}}}]])}),closeDb=runtime.store.db.close.bind(runtime.store.db);runtime.store.release=async()=>{throw lease;};runtime.store.db.close=async()=>{storage++;await closeDb();};
 try{await assert.rejects(runtime.close(),error=>error instanceof AggregateError&&error.errors.includes(lease)&&error.errors.includes(provider));assert.equal(first,1);assert.equal(second,1);assert.equal(storage,1);}finally{if(!storage)await closeDb();}
});
test('shutdown cleanup drains a live investigation despite another close failure before closing storage',async()=>{
 let entered,release,storageClosed=false;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve),rules=new RulesReasoner(),failure=Error('Controlled transport close failure');const runtime=await createSreRuntime({config:loadConfig({SRE_SQLITE_PATH:':memory:'}),autoStart:false,reasoner:{investigate:async(...args)=>{entered();await held;return rules.investigate(...args);}}}),closeDb=runtime.store.db.close.bind(runtime.store.db);runtime.store.db.close=async()=>{storageClosed=true;await closeDb();};
 try{await runtime.store.ingest({id:'cleanup-drain-incident',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'cleanup-drain',status:'OPEN',at:Date.now(),payload:{}});const reading=runtime.investigate();await started;runtime.outbox.close=async()=>{throw failure;};const closing=runtime.close(),observed=closing.then(()=>null,error=>error);await setImmediate();assert.equal(storageClosed,false);assert.equal(runtime.casework.qaExecution.closed,true);release();await reading;assert.equal(await observed,failure);assert.equal(storageClosed,true);}finally{release();if(!storageClosed){await runtime.close().catch(()=>{});if(!storageClosed)await closeDb();}}
});

test('shutdown waits for the original investigation despite repeated scheduler ticks',async()=>{
  let unblock,entered,closed=false;
  const waiting=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve);
  const rules=new RulesReasoner();
  const runtime=await createSreRuntime({config:loadConfig({SRE_SQLITE_PATH:':memory:'}),autoStart:false,reasoner:{investigate:async(...args)=>{entered();await waiting;return rules.investigate(...args);}}});
  await runtime.store.ingest({id:'shutdown-test',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'shutdown',status:'OPEN',at:Date.now(),payload:{}});
  const running=runtime.tick();await started;
  assert.equal(runtime.tick(),running);
  const closing=runtime.close();assert.equal(runtime.close(),closing);
  closing.then(()=>closed=true);
  await setImmediate();assert.equal(closed,false);
  unblock();await running;await closing;assert.equal(closed,true);
});

test('shutdown drains the original poll while duplicate poll launches share its promise',async()=>{
  let unblock,entered,closed=false,calls=0;
  const waiting=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve);
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});
  const connectors=new Map([[config.services[0].key,{dynatrace:{problems:async()=>{calls++;entered();await waiting;return {items:[],complete:true};}}}]]);
  const runtime=await createSreRuntime({config,connectors,autoStart:false});
  const polling=runtime.poll();await started;assert.equal(runtime.poll(),polling);
  const closing=runtime.close().then(()=>closed=true);
  await setImmediate();assert.equal(closed,false);assert.equal(calls,1);
  unblock();await polling;await closing;assert.equal(closed,true);
});

test('commands acknowledge a linked incident while the original model turn is still running',async()=>{
  let unblock,entered;
  const waiting=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve),rules=new RulesReasoner();
  const runtime=await createSreRuntime({config:loadConfig({SRE_SQLITE_PATH:':memory:'}),autoStart:false,reasoner:{investigate:async(...args)=>{entered();await waiting;return rules.investigate(...args);}}});
  try {
    const event=await runtime.store.ingest({id:'command-during-model',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'slow-model',status:'OPEN',at:Date.now(),payload:{}});
    const running=runtime.tick();await started;
    const sample=devActivity('join '+event.incidentId,runtime.config.services[0]);
    await runtime.router.accept(sample.activity,sample.reference);
    const commands=runtime.commands();assert.equal(runtime.commands(),commands);await commands;
    assert.equal(runtime.worker.running,true);
    assert.ok((await runtime.store.snapshot()).outbox.some(message=>message.text.includes('This conversation is now linked to '+event.incidentId)));
    unblock();await running;
  } finally {unblock();await runtime.close();}
});

test('worker and poller share deployment inbox identity and incident revision fencing',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=config.services[0];
  const deployment={id:'1',deploymentId:'1',provider:'github',environment:service.environment,sha:'a'.repeat(40),status:'success',at:Date.now()-10000};
  const connectors=new Map([[service.key,{github:{deployments:async()=>({items:[deployment],complete:true}),linkedChanges:async()=>({items:[],complete:true})}}]]);
  const runtime=await createSreRuntime({config,connectors,autoStart:false});
  try {
    const {incidentId}=await runtime.store.ingest({id:'p1',source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'deployment-watch',status:'OPEN',at:Date.now(),payload:{}});
    const before=await runtime.store.context(incidentId);
    await runtime.worker.collect(before,AbortSignal.timeout(5000));
    const collected=await runtime.store.context(incidentId);
    assert.equal(collected.incident.revision,before.incident.revision+1);
    await runtime.poll();
    const polled=await runtime.store.context(incidentId);
    assert.equal(polled.incident.revision,collected.incident.revision);
    assert.equal(polled.deployments.length,1);
    assert.equal((await runtime.store.snapshot()).counts.find(x=>x.source==='github').count,1);
  } finally {await runtime.close();}
});

test('a database failure in one polling lane cannot let shutdown overtake another live lane',async()=>{
  let unblock,entered,closed=false;
  const waiting=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve);
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=config.services[0];
  const clients={dynatrace:{problems:async()=>{entered();await waiting;return {items:[],complete:true};}},github:{deployments:async()=>({items:[],complete:true})}};
  const runtime=await createSreRuntime({config,connectors:new Map([[service.key,clients]]),autoStart:false});
  const recordPollResult=runtime.store.recordPollResult.bind(runtime.store);
  runtime.store.recordPollResult=async(id,value)=>{if(id==='github:'+service.key)throw new Error('injected checkpoint storage outage');return recordPollResult(id,value);};
  const result=runtime.poll().then(()=>null,error=>error);
  await started;await setImmediate();assert.equal(runtime.poller.running,true);
  const closing=runtime.close().then(()=>closed=true);
  try {
    await setImmediate();assert.equal(closed,false);
    unblock();assert.match((await result).message,/injected checkpoint storage outage/);
    await closing;assert.equal(closed,true);
  } finally {unblock();await runtime.close();}
});
