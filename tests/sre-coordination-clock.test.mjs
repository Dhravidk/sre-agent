import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { SreStore } from '../src/sre/store.mjs';
import { sqliteDatabase,postgresSql,StorageError } from '../src/sre/database.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { OperationalMonitor } from '../src/sre/operations.mjs';
import { GithubConnector,GitlabConnector } from '../src/sre/connectors.mjs';
import { RequestNotSubmittedError } from '../src/sre/submission.mjs';
import { devActivity } from '../src/sre/demo.mjs';
import { ConnectorPoller } from '../src/sre/poller.mjs';
import { pollScopeHash } from '../src/sre/poll-scope.mjs';
import { hash } from '../src/sre/security.mjs';

test('PostgreSQL coordination time advances inside a transaction and ignores the application clock',async()=>{
  const pg=new PGlite(),db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
  let offset=120000;
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),store=await new SreStore(db,{clock:()=>Date.now()+offset}).initialize();
  try {
    await db.transaction(async q=>{
      const start=await store.coordinationNow(q);
      await delay(35);
      const later=await store.coordinationNow(q);
      assert.ok(later-start>=25,'A transaction-start timestamp was reused for a live deadline check');
      assert.ok(Math.abs(later-Date.now())<1000);assert.ok(store.clock()-later>119000);
    });
    const monitor=new OperationalMonitor({store,config,schedulerEnabled:false});
    for(const value of [-120000,120000]) {
      offset=value;const snapshot=await monitor.snapshot(),condition=snapshot.conditions.find(item=>item.code==='clock_skew');
      assert.ok(condition);assert.ok(Math.abs(condition.offsetMs-value)<1000);
    }
    offset=0;assert.ok(!(await monitor.snapshot()).conditions.some(item=>item.code==='clock_skew'));
  } finally {await db.close();}
});

test('an invalid database clock fails closed without falling back to the application clock',async()=>{
  let fallbackCalls=0;
  for(const rows of [[],[{now:'invalid'}],[{now:'9007199254740992'}],[{now:-1}]]) {
    const store=new SreStore({dialect:'postgres',query:async()=>rows},{clock:()=>{fallbackCalls++;return Date.now();}});
    await assert.rejects(()=>store.coordinationNow(),error=>error instanceof StorageError);
  }
  assert.equal(fallbackCalls,0);
});

test('SQLite keeps its explicit local test clock',async()=>{
  const db=sqliteDatabase(':memory:');let now=1234;
  const store=new SreStore(db,{clock:()=>now});
  try {assert.equal(await store.coordinationNow(),1234);now+=500;assert.equal(await store.coordinationNow(),1734);}
  finally {await db.close();}
});

test('upgrading the clock policy discards a future legacy cursor and inventories historical open issues',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=config.services[0],now=Date.now();service.dynatrace.enabled=true;
  const store=await new SreStore(sqliteDatabase(':memory:'),{clock:()=>now,services:[service]}).initialize();
  let activeReads=0;
  const legacyHash=hash({serviceKey:service.key,tenant:service.tenant,environment:service.environment,source:'dynatrace',scope:{entityId:service.dynatrace.entityId}});
  const poller=new ConnectorPoller({store,services:[service],connectors:new Map([[service.key,{dynatrace:{
    problems:async()=>({items:[],complete:true}),
    openProblems:async()=>{activeReads++;return {items:[{ProblemID:'P-LEGACY-CLOCK',State:'OPEN',EntityIds:[service.dynatrace.entityId],StartedAt:now-3600000,ObservedAt:now}],complete:true};},
  }}]])});
  try {
    await store.checkpoint('dynatrace:'+service.key,{scopeHash:legacyHash,until:now+120000,activeReconciledAt:now+120000,successAt:now+120000,complete:true});
    await poller.runOnce();assert.equal(activeReads,1);
    const saved=await store.checkpoint('dynatrace:'+service.key);assert.equal(saved.scopeHash,pollScopeHash(service,'dynatrace'));assert.equal(saved.until,now);assert.equal(saved.activeReconciledAt,now);
    const snapshot=await store.snapshot();assert.equal(snapshot.incidents.length,1);assert.equal(Number(snapshot.incidents[0].started_at),now-3600000);
  } finally {await store.db.close();}
});

for(const provider of ['github','gitlab'])for(const outcome of ['success','clock-unavailable-initial','clock-unavailable-final','expired-final','invalid-clock'])test(provider+': asynchronous approval clock '+outcome+' preserves the submission boundary',async()=>{
  let clockReads=0,writes=0;const now=Date.now(),expiresAt=now+60000;
  const Connector=provider==='github'?GithubConnector:GitlabConnector;
  const client=new Connector({base:'https://provider.invalid',repository:'synthetic/auction',project:'17',workflow:'rollback.yml',ref:'main',tokenEnv:'TOKEN'}, {
    env:{TOKEN:'synthetic'},clock:async()=>{
      clockReads++;
      if((outcome==='clock-unavailable-initial'&&clockReads===1)||(outcome==='clock-unavailable-final'&&clockReads===2))throw new Error('Untrusted database diagnostic');
      if(outcome==='invalid-clock')return Infinity;
      return outcome==='expired-final'&&clockReads===2?expiresAt:now;
    },
    fetcher:async()=>{writes++;return new Response(JSON.stringify(provider==='github'?{workflow_run_id:77}:{id:77}),{status:provider==='github'?200:201});},
  });
  const proposal={id:'rb-clock',environment:'local',current:{sha:'a'.repeat(40),artifact:'sha256:'+'c'.repeat(64),deploymentId:'1',at:1234},target:{sha:'b'.repeat(40),artifact:'sha256:'+'d'.repeat(64)},approval:{approvedAt:now-1000,expiresAt}};
  if(outcome==='success') {assert.equal((await client.dispatch(proposal)).status,'dispatched');assert.equal(writes,1);assert.equal(clockReads,2);}
  else {
    await assert.rejects(()=>client.dispatch(proposal),error=>error instanceof RequestNotSubmittedError&&!error.message.includes('Untrusted database diagnostic'));
    assert.equal(writes,0);assert.equal(clockReads,['clock-unavailable-initial','invalid-clock'].includes(outcome)?1:2);
  }
});

async function commandFixture() {
  const runtime=await createSreRuntime({config:loadConfig({SRE_SQLITE_PATH:':memory:'}),autoStart:false});
  let now=Date.now();runtime.store.clock=()=>now;
  const sample=devActivity('incidents',runtime.config.services[0]);
  const accepted=await runtime.router.accept(sample.activity,sample.reference);
  return {runtime,accepted,expire:()=>{now+=30001;}};
}

test('command expiry while inserting its acknowledgment rolls back both acknowledgment and completion',async()=>{
  const f=await commandFixture(),db=f.runtime.store.db,transaction=db.transaction.bind(db);let armed=true;
  db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{
    const rows=await q(sql,args);
    if(armed&&sql.startsWith('INSERT INTO sre_outbox')&&String(args[0]).startsWith('command:'))f.expire();
    return rows;
  }));
  try {
    await assert.rejects(()=>f.runtime.router.processOnce(),/command lease expired/);
    assert.equal((await db.query('SELECT status FROM sre_commands WHERE id=?',[f.accepted.eventId]))[0].status,'running');
    assert.equal((await db.query('SELECT * FROM sre_outbox')).length,0);
    armed=false;assert.equal(await f.runtime.router.processOnce(),true);
    assert.equal((await db.query('SELECT status FROM sre_commands WHERE id=?',[f.accepted.eventId]))[0].status,'done');
    assert.equal((await db.query('SELECT * FROM sre_outbox')).length,1);
  } finally {await f.runtime.close();}
});

test('a delayed command result cannot acknowledge or complete a replacement command attempt',{timeout:10000},async()=>{
  const f=await commandFixture(),db=f.runtime.store.db,query=db.query.bind(db);
  let releaseFirst,releaseSecond,enteredFirst,enteredSecond,calls=0;
  const firstReady=new Promise(resolve=>enteredFirst=resolve),secondReady=new Promise(resolve=>enteredSecond=resolve);
  const firstGate=new Promise(resolve=>releaseFirst=resolve),secondGate=new Promise(resolve=>releaseSecond=resolve);
  db.query=async(sql,args)=>{
    const rows=await query(sql,args);
    if(sql.startsWith('SELECT id,title,status FROM sre_incidents')) {
      calls++;
      if(calls===1){enteredFirst();await firstGate;}
      else if(calls===2){enteredSecond();await secondGate;}
    }
    return rows;
  };
  let first,second;
  try {
    first=f.runtime.router.processOnce();await firstReady;f.expire();
    second=f.runtime.router.processOnce();await secondReady;
    releaseFirst();await first;
    assert.equal((await query('SELECT status FROM sre_commands WHERE id=?',[f.accepted.eventId]))[0].status,'running');
    assert.equal((await query('SELECT * FROM sre_outbox')).length,0);
    releaseSecond();await second;
    assert.equal((await query('SELECT status FROM sre_commands WHERE id=?',[f.accepted.eventId]))[0].status,'done');
    assert.equal((await query('SELECT * FROM sre_outbox')).length,1);
  } finally {releaseFirst();releaseSecond();await Promise.allSettled([first,second]);await f.runtime.close();}
});
