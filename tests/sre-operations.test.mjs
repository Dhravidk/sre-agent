import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { OperationalMonitor } from '../src/sre/operations.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { sqliteDatabase, postgresSql } from '../src/sre/database.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { RulesReasoner } from '../src/sre/reasoner.mjs';
import { pollScopeHash } from '../src/sre/poll-scope.mjs';

async function fixture(db=sqliteDatabase(':memory:')) {
  let now=Date.now();
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});config.mode='connected';config.teamsMode='live';
  const service=config.services[0];service.github.enabled=true;
  const store=await new SreStore(db,{clock:()=>now,services:config.services}).initialize();
  const checkpoint=store.checkpoint.bind(store);
  store.checkpoint=(id,value)=>checkpoint(id,value===undefined?undefined:{scopeHash:pollScopeHash(service,'github'),...value});
  const monitor=new OperationalMonitor({store,config,schedulerEnabled:false});
  const conversation=await store.rememberConversation({tenant:service.teams.tenantId,serviceKey:service.key,reference:{conversation:{id:service.teams.conversations[0],conversationType:'groupChat'},serviceUrl:'https://teams.invalid'}});
  return {store,config,service,monitor,conversation,now,setNow:value=>now=value};
}

test('operational checks distinguish startup, missing/error/stale polling, and recovery',async()=>{
  const f=await fixture(),key='github:'+f.service.key;
  try {
    assert.equal((await f.monitor.snapshot()).state,'starting');
    f.setNow(f.now+181000);
    assert.ok((await f.monitor.snapshot()).conditions.some(x=>x.code==='poll_scope'));
    await f.store.checkpoint(key,{error:'Connector returned HTTP 401',failedAt:f.store.clock()});
    assert.ok((await f.monitor.snapshot()).conditions.some(x=>x.code==='poll_error'&&x.message.includes('401')));
    await f.store.checkpoint(key,{successAt:f.store.clock(),complete:true});
    assert.equal((await f.monitor.snapshot()).state,'healthy');
    f.setNow(f.now+400000);
    assert.ok((await f.monitor.snapshot()).conditions.some(x=>x.code==='poll_stale'));
  } finally {await f.store.db.close();}
});

test('operational checks show exhausted work, uncertain delivery, and unknown rollback separately',async()=>{
  const f=await fixture();
  try {
    const {incidentId}=await f.store.ingest({id:'p1',source:'dynatrace',serviceKey:f.service.key,kind:'problem',issueKey:'p1',status:'OPEN',at:f.now,payload:{}});
    for(let attempt=0;attempt<3;attempt++) {
      const job=await f.store.claim('test-worker');assert.ok(job);await f.store.fail(job,new Error('investigator failed'));
      const [saved]=await f.store.db.query('SELECT next_at FROM sre_jobs WHERE id=?',[job.id]);f.setNow(Number(saved.next_at));
    }
    await f.store.queueMessage(incidentId,'Uncertain report',null,'report-1');
    await f.store.db.query("UPDATE sre_outbox SET status='unknown' WHERE id='report-1'");
    await f.store.db.query("INSERT INTO sre_rollbacks(id,incident_id,proposal,nonce_hash,expires_at,status,created_at) VALUES(?,?,?,'fixture',?,'unknown',?)",['rb-test',incidentId,'{}',f.now+600000,f.now]);
    const conditions=(await f.monitor.snapshot()).conditions.map(x=>x.code);
    for(const code of ['investigation_dead','notification_unknown','rollback_unknown'])assert.ok(conditions.includes(code),code);
  } finally {await f.store.db.close();}
});

test('operational notices stay quiet while unchanged and queue one recovery notice',async()=>{
  const f=await fixture(),key='github:'+f.service.key;
  try {
    await f.store.checkpoint(key,{error:'Connector returned HTTP 401',failedAt:f.now});
    await f.monitor.observe();await f.monitor.observe();f.setNow(f.now+60000);await f.monitor.observe();
    assert.equal((await f.store.snapshot()).outbox.length,1);
    await f.store.checkpoint(key,{successAt:f.store.clock(),complete:true});
    await f.monitor.observe();await f.monitor.observe();
    const outbox=(await f.store.snapshot()).outbox;
    assert.equal(outbox.length,2);assert.equal(outbox.filter(x=>x.text.includes('checks recovered')).length,1);
    assert.ok(outbox.every(x=>x.conversation_key===f.conversation));
  } finally {await f.store.db.close();}
});

test('a failed operations outbox transaction does not suppress the next notice',async()=>{
  const f=await fixture();
  try {
    await f.store.checkpoint('github:'+f.service.key,{error:'HTTP 401',failedAt:f.now});
    const queue=f.store.queueMessage.bind(f.store);let fail=true;
    f.store.queueMessage=async(...args)=>{if(fail){fail=false;throw new Error('injected storage outage');}return queue(...args);};
    await assert.rejects(()=>f.monitor.observe(),/injected storage outage/);
    assert.equal((await f.store.snapshot()).outbox.length,0);
    assert.ok((await f.monitor.snapshot()).conditions.some(x=>x.code==='observer_error'));
    await f.monitor.observe();await f.monitor.observe();
    assert.equal((await f.store.snapshot()).outbox.length,1);
    assert.equal((await f.monitor.snapshot()).conditions.some(x=>x.code==='observer_error'),false);
  } finally {await f.store.db.close();}
});

test('operational notifications never choose an unallowlisted or foreign-tenant conversation',async()=>{
  const f=await fixture();
  try {
    await f.store.db.query('UPDATE sre_conversations SET tenant_id=? WHERE id=?',['foreign',f.conversation]);
    await f.store.checkpoint('github:'+f.service.key,{error:'HTTP 401',failedAt:f.now});
    await f.monitor.observe();
    assert.equal((await f.store.snapshot()).outbox.length,0);
    assert.equal((await f.monitor.snapshot()).state,'needs-attention');
  } finally {await f.store.db.close();}
});

test('an uncertain operational notice remains visible without recursively flooding the outbox',async()=>{
  const f=await fixture();
  try {
    await f.store.checkpoint('github:'+f.service.key,{error:'HTTP 401',failedAt:f.now});
    await f.monitor.observe();
    await f.store.db.query("UPDATE sre_outbox SET status='unknown'");
    await f.monitor.observe();
    await f.store.db.query("UPDATE sre_outbox SET status='unknown'");
    for(let i=0;i<5;i++)await f.monitor.observe();
    assert.equal((await f.store.snapshot()).outbox.length,2);
    assert.ok((await f.monitor.snapshot()).conditions.some(x=>x.code==='notification_unknown'));
  } finally {await f.store.db.close();}
});

test('operator health API is authenticated while ingress liveness remains available during a polling fault',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});config.mode='connected';config.apiToken='fixture-api';config.services[0].github.enabled=true;
  const runtime=await createSreRuntime({config,connectors:new Map(),autoStart:false});
  runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');
  const base='http://127.0.0.1:'+runtime.server.address().port;
  try {
    await runtime.store.checkpoint('github:'+config.services[0].key,{scopeHash:pollScopeHash(config.services[0],'github'),error:'HTTP 401',failedAt:Date.now()});
    assert.equal((await fetch(base+'/api/operations')).status,401);
    const report=await (await fetch(base+'/api/operations',{headers:{authorization:'Bearer fixture-api'}})).json();
    assert.equal(report.state,'needs-attention');assert.ok(report.conditions.some(x=>x.code==='poll_error'));
    assert.equal((await fetch(base+'/health')).status,200);
    const status=await (await fetch(base+'/api/status',{headers:{authorization:'Bearer fixture-api'}})).json();
    assert.equal(status.operations.state,'needs-attention');
  } finally {await runtime.close();}
});

test('runtime exposes a stalled investigator and clears it when that same invocation completes',async()=>{
  let now=Date.now(),entered,unblock;
  const waiting=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve),rules=new RulesReasoner();
  const runtime=await createSreRuntime({config:loadConfig({SRE_SQLITE_PATH:':memory:'}),autoStart:false,reasoner:{investigate:async(...args)=>{entered();await waiting;return rules.investigate(...args);}}});
  runtime.store.clock=()=>now;
  try {
    await runtime.store.ingest({id:'p1',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'p1',status:'OPEN',at:now,payload:{}});
    const running=runtime.tick();await started;now+=180001;
    assert.ok((await runtime.operations.snapshot()).conditions.some(x=>x.code==='loop_stalled'));
    // The investigator's separate lease is now expired, so it must fail safely.
    unblock();await running;
    assert.equal((await runtime.operations.snapshot()).conditions.some(x=>x.code==='loop_stalled'),false);
  } finally {unblock();await runtime.close();}
});

test('PostgreSQL operational aggregation and transactional notices execute in PGlite',async()=>{
  const pg=new PGlite();
  const db={dialect:'postgres',query:async(sql,args=[]) =>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[]) =>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
  const f=await fixture(db);
  try {
    await f.store.checkpoint('github:'+f.service.key,{error:'HTTP 401',failedAt:f.now});
    await f.monitor.observe();await f.monitor.observe();
    assert.equal((await f.monitor.snapshot()).state,'needs-attention');
    assert.equal((await f.store.snapshot()).outbox.length,1);
  } finally {await f.store.db.close();}
});

test('a healthy peer cannot clear another runtime local fault or repeatedly toggle its notice',async()=>{
  const f=await fixture(),peer=new OperationalMonitor({store:f.store,config:f.config,schedulerEnabled:false});
  try {
    await f.store.checkpoint('github:'+f.service.key,{successAt:f.now,complete:true});
    f.monitor.end('tick',new Error('Synthetic stalled investigator'));
    await f.monitor.observe();await peer.observe();await f.monitor.observe();await peer.observe();
    const outbox=(await f.store.snapshot()).outbox;
    assert.equal(outbox.length,1,'A healthy peer cleared/reopened an unresolved local fault');
    assert.ok(!outbox[0].text.includes('recovered'));assert.ok(outbox[0].text.includes(f.monitor.runtimeId.slice(0,8)));
  } finally {await f.store.db.close();}
});

test('each peer can recover only its own local notice while another peer remains faulty',async()=>{
  const f=await fixture(),peer=new OperationalMonitor({store:f.store,config:f.config,schedulerEnabled:false});
  try {
    await f.store.checkpoint('github:'+f.service.key,{successAt:f.now,complete:true});
    f.monitor.end('tick',new Error('First runtime failure'));peer.end('poll',new Error('Second runtime failure'));
    await f.monitor.observe();await peer.observe();
    f.monitor.end('tick');await f.monitor.observe();await peer.observe();
    let outbox=(await f.store.snapshot()).outbox;assert.equal(outbox.length,3);
    const recoveries=outbox.filter(item=>item.text.includes('recovered'));assert.equal(recoveries.length,1);assert.ok(recoveries[0].text.includes(f.monitor.runtimeId.slice(0,8)));assert.ok(!recoveries[0].text.includes(peer.runtimeId.slice(0,8)));
    peer.end('poll');await peer.observe();outbox=(await f.store.snapshot()).outbox;assert.equal(outbox.length,4);
  } finally {await f.store.db.close();}
});

test('shared failures deduplicate across peers independently of instance faults',async()=>{
  const f=await fixture(),peer=new OperationalMonitor({store:f.store,config:f.config,schedulerEnabled:false});
  try {
    await f.store.checkpoint('github:'+f.service.key,{error:'Synthetic provider read failure',failedAt:f.now});
    f.monitor.end('tick',new Error('An independent local failure'));
    await f.monitor.observe();await peer.observe();await f.monitor.observe();
    assert.equal((await f.store.snapshot()).outbox.length,2,'Shared and instance faults must have independent notification state');
    await f.store.checkpoint('github:'+f.service.key,{successAt:f.now,complete:true});
    await peer.observe();await f.monitor.observe();
    const outbox=(await f.store.snapshot()).outbox;assert.equal(outbox.length,3);
    assert.equal(outbox.filter(item=>item.text.includes('Shared service checks recovered')).length,1);
    assert.equal(outbox.filter(item=>item.text.includes('Instance checks recovered')).length,0);
  } finally {await f.store.db.close();}
});

test('a newly starting peer with pending source inventory cannot announce shared recovery',async()=>{
  const f=await fixture(),peer=new OperationalMonitor({store:f.store,config:f.config,schedulerEnabled:false});
  try {
    f.monitor.startedAt=f.now-181000;
    await f.monitor.observe();assert.equal((await f.store.snapshot()).outbox.length,1);
    assert.equal((await peer.snapshot()).state,'starting');await peer.observe();
    assert.equal((await f.store.snapshot()).outbox.length,1,'Startup uncertainty cleared an established missing-source alert');
    await f.store.checkpoint('github:'+f.service.key,{successAt:f.now,complete:true});
    await peer.observe();await f.monitor.observe();assert.equal((await f.store.snapshot()).outbox.length,2);
  } finally {await f.store.db.close();}
});

test('instance labels are validated and each condition states its reporting scope',async()=>{
  assert.equal(loadConfig({SRE_INSTANCE_ID:'worker-a'}).instanceId,'worker-a');
  for(const instanceId of ['', 'worker a','worker\nsecond','x'.repeat(129)])assert.throws(()=>loadConfig({SRE_INSTANCE_ID:instanceId}),/instance label/);
  const f=await fixture();
  try {
    f.monitor.end('tick',new Error('Synthetic local failure'));
    await f.store.checkpoint('github:'+f.service.key,{error:'Synthetic shared failure',failedAt:f.now});
    const report=await f.monitor.snapshot();assert.equal(report.instanceId,f.config.instanceId);
    assert.equal(report.conditions.find(item=>item.code==='loop_error').scope,'instance');assert.equal(report.conditions.find(item=>item.code==='poll_error').scope,'shared');
  } finally {await f.store.db.close();}
});
