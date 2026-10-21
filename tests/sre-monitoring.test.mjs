import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ConnectorPoller } from '../src/sre/poller.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { sqliteDatabase } from '../src/sre/database.mjs';

async function fixture() {
  let now=Date.now(),sample={timestamps:[now-120000,now-60000,now],values:[300,400,500]};
  const store=await new SreStore(sqliteDatabase(':memory:'),{clock:()=>now}).initialize();
  const monitor={id:'latency',name:'Auction latency',selector:'fixture:latency',threshold:250,operator:'gt',consecutive:3,unit:'ms'};
  const service={key:'auction-test',monitors:[monitor]};
  const client={metrics:async()=>({result:[{data:[sample]}]})};
  const poller=new ConnectorPoller({store,services:[service],connectors:new Map([[service.key,{dynatrace:client}]])});
  return {store,monitor,service,poller,now,setSample:value=>sample=value,setNow:value=>now=value};
}

for(const variant of ['duplicate','out-of-order','future','large-gap','outside-window','unpaired','string-time','missing-value','zero-count'])test('invalid '+variant+' metric samples cannot close an incident',async()=>{
  const f=await fixture();
  try {
    await f.poller.runOnce();assert.equal((await f.store.snapshot()).incidents[0].status,'open');
    const previous=await f.store.checkpoint('metric:'+f.service.key+':latency');
    const sample={timestamps:[f.now-120000,f.now-60000,f.now],values:[100,110,120]};
    if(variant==='duplicate')sample.timestamps=[f.now,f.now,f.now];
    if(variant==='out-of-order')sample.timestamps=[f.now-60000,f.now-120000,f.now];
    if(variant==='future')sample.timestamps=[f.now-120000,f.now-60000,f.now+1000];
    if(variant==='large-gap')sample.timestamps=[f.now-600000,f.now-60000,f.now];
    if(variant==='outside-window')sample.timestamps=[f.now-86400000,f.now-60000,f.now];
    if(variant==='unpaired')sample.values.unshift(50);
    if(variant==='string-time')sample.timestamps=sample.timestamps.map(String);
    if(variant==='missing-value')sample.values[1]=null;
    if(variant==='zero-count')f.monitor.consecutive=0;
    f.setSample(sample);await f.poller.runOnce();
    assert.equal((await f.store.snapshot()).incidents[0].status,'open');
    const checkpoint=await f.store.checkpoint('metric:'+f.service.key+':latency');
    assert.ok(checkpoint.error);
    if(variant==='zero-count')assert.equal(checkpoint.successAt,undefined,'A changed definition cannot inherit the old definition\'s success');
    else assert.equal(checkpoint.successAt,previous.successAt,'Keep the last successful observation when a later poll fails in the same scope');
  } finally {await f.store.db.close();}
});

test('a changed metric threshold reuses the issue without reusing a different event body',async()=>{
  const f=await fixture();
  try {
    await f.poller.runOnce();f.monitor.threshold=600;
    await f.poller.runOnce();
    const checkpoint=await f.store.checkpoint('metric:'+f.service.key+':latency');
    assert.equal(checkpoint.error,undefined);
    assert.equal((await f.store.snapshot()).incidents.length,1);
    assert.equal((await f.store.snapshot()).incidents[0].status,'verifying');
  } finally {await f.store.db.close();}
});

test('a slow connector cannot block another independent source and concurrency is bounded',async()=>{
  let unblock,entered,snowRead=false,inFlight=0,peak=0;
  const waiting=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve);
  const store=await new SreStore(sqliteDatabase(':memory:')).initialize();
  const service={key:'auction-test',monitors:[]};
  const clients={dynatrace:{problems:async()=>{inFlight++;peak=Math.max(peak,inFlight);entered();await waiting;inFlight--;return {items:[],complete:true};}},servicenow:{incidents:async()=>{inFlight++;peak=Math.max(peak,inFlight);snowRead=true;await setImmediate();inFlight--;return {items:[],complete:true};}}};
  const poller=new ConnectorPoller({store,services:[service],connectors:new Map([[service.key,clients]]),concurrency:2});
  const polling=poller.runOnce();
  try {
    await started;await setImmediate();
    assert.equal(snowRead,true);assert.equal(peak,2);
  } finally {unblock();await polling;await store.db.close();}
});
