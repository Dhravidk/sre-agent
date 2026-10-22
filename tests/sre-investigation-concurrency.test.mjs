import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {InvestigationPool} from '../src/sre/investigation-pool.mjs';
import {RulesReasoner} from '../src/sre/reasoner.mjs';
import {ModelQuotaError} from '../src/sre/model-quota.mjs';
import {loadConfig,validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {prepareRestore} from '../src/sre/restore-recovery.mjs';

async function database(dialect){
  if(dialect==='sqlite')return sqliteDatabase(':memory:');
  const pg=new PGlite();
  return {dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
}
const analysis={mode:'claude',summary:'Queue fixture only',text:'Queue fixture only',teamsMessages:[]};
async function seed(store,n=8){
  const ids=[];
  for(let i=0;i<n;i++)ids.push((await store.ingest({id:'incident-'+i,source:'evaluation',serviceKey:'service',kind:'problem',issueKey:'incident-'+i,status:'OPEN',at:await store.coordinationNow(),payload:{}})).incidentId);
  return ids;
}
async function finish(store,job){return store.finish(job,analysis,null,Number((await store.context(job.incident_id)).incident.revision));}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': database slots bound concurrent owners and keep each incident exclusive across restart',async()=>{
    const services=[{key:'service',environment:'evaluation',teams:{tenantId:'evaluation',conversations:['hot']}}],options={questionBatchLimit:8,investigationConcurrency:4,services},db=await database(dialect),store=await new SreStore(db,options).initialize();
    try{
      const ids=await seed(store);
      const hot=await store.rememberConversation({tenant:'evaluation',serviceKey:'service',reference:{serviceUrl:'https://delivery.invalid',conversation:{id:'hot'}}});await store.bindConversation(hot,ids[0]);
      for(let n=0;n<20;n++)await store.ingest({id:'hot-'+n,source:'operator-api',serviceKey:'service',incidentId:ids[0],kind:'question',at:await store.coordinationNow(),payload:{text:'Noisy room question '+n},conversationKey:hot});
      const jobs=(await Promise.all(Array.from({length:5},(_,n)=>store.claim('owner-'+n)))).filter(Boolean);
      assert.equal(jobs.length,4);assert.equal(new Set(jobs.map(j=>j.incident_id)).size,4);
      assert.equal(new Set(jobs.map(j=>j.lease_name)).size,4);
      assert.equal(await store.claim(jobs[0].lease_owner),null,'an owner cannot occupy multiple slots');
      const reopened=await new SreStore(db,options).initialize();
      assert.equal(await reopened.claim('peer'),null);
      await assert.rejects(()=>new SreStore(db).initialize(),/Stop active investigators/);
      await reopened.heartbeat(jobs[2].lease_owner,jobs[2].id,60000,jobs[2].lease_name);
      await reopened.setRemoteState(jobs[2].incident_id,{provider:'fixture',phase:'started'},jobs[2]);
      await Promise.all(jobs.map(j=>finish(reopened,j)));
      const next=(await Promise.all(Array.from({length:5},(_,n)=>reopened.claim('next-'+n)))).filter(Boolean);
      assert.equal(next.length,4);assert.ok(next.every(j=>!jobs.some(old=>old.incident_id===j.incident_id)),'unserved incidents precede the hot incident');
      assert.equal((await store.snapshot()).workerConcurrency,4);
    }finally{await db.close();}
  });

  test(dialect+': expired slot owners cannot heartbeat, checkpoint, publish or install a quota hold',async()=>{
    const db=await database(dialect),store=await new SreStore(db,{investigationConcurrency:2}).initialize();let now=await store.coordinationNow();store.coordinationNow=async()=>now;
    try{
      await seed(store,1);const old=await store.claim('old',1000);now+=1001;
      const replacement=await store.claim('replacement',1000);assert.equal(replacement.id,old.id);
      await assert.rejects(()=>store.heartbeat('old',old.id,1000,old.lease_name),/lease lost/);
      await assert.rejects(()=>store.setRemoteState(old.incident_id,{bad:true},old),/lease lost/);
      await assert.rejects(()=>finish(store,old),/lease lost/);
      await store.fail(old,new ModelQuotaError('claude-cli'));
      assert.equal(await store.modelQuota(),null);
      const [job]=await db.query('SELECT status,lease_owner FROM sre_jobs WHERE id=?',[old.id]);assert.equal(job.lease_owner,'replacement');assert.equal(job.status,'running');
      await finish(store,replacement);
    }finally{await db.close();}
  });

  test(dialect+': simultaneous quota failures preserve one exact account hold and original attempts',async()=>{
    const db=await database(dialect),store=await new SreStore(db,{investigationConcurrency:4}).initialize();
    try{
      await seed(store);const jobs=await Promise.all(Array.from({length:4},(_,n)=>store.claim('owner-'+n)));
      await store.fail(jobs[0],new ModelQuotaError('claude-cli',{resetLabel:'7pm America/Detroit'}));const first=await store.modelQuota();
      await Promise.all(jobs.slice(1).map(j=>store.fail(j,new ModelQuotaError('claude-cli'))));
      assert.deepEqual(await store.modelQuota(),first,'later in-flight caps must not invalidate the reviewed hold ID');
      const policy=await store.checkpoint('agent-scheduler-policy');
      await prepareRestore(store,{restoreId:'quota-scheduler-restore',backupSha256:'a'.repeat(64),backupAt:Date.now()-1000,reason:'Synthetic restore contract',actor:{kind:'local-operator',id:'fixture'},offline:true});
      assert.deepEqual(await store.modelQuota(),first);assert.deepEqual(await store.checkpoint('agent-scheduler-policy'),policy);
      const reopened=await new SreStore(db,{investigationConcurrency:4}).initialize();assert.equal(await reopened.claim('peer'),null);
      for(const job of jobs){const [row]=await db.query('SELECT status,attempts FROM sre_jobs WHERE id=?',[job.id]);assert.equal(row.status,'pending');assert.equal(Number(row.attempts),0);}
      await reopened.resumeModelQuota({holdId:first.id,reason:'Fixture provider reset verified',actor:{kind:'local-operator',id:'fixture'}});
      assert.ok(await reopened.claim('resumed'));
    }finally{await db.close();}
  });

  test(dialect+': idle capacity changes fence an older differently configured process',async()=>{
    const db=await database(dialect),old=await new SreStore(db,{investigationConcurrency:2}).initialize();
    try{
      await seed(old);await finish(old,await old.claim('initial'));
      const current=await new SreStore(db,{investigationConcurrency:4}).initialize();
      await assert.rejects(()=>old.claim('outdated'),/concurrency changed/);
      assert.equal((await Promise.all(Array.from({length:5},(_,n)=>current.claim('current-'+n)))).filter(Boolean).length,4);
    }finally{await db.close();}
  });

  test(dialect+': expiry in the final slot-release statement rolls back publication and quota holds',async()=>{
    const db=await database(dialect),store=await new SreStore(db,{investigationConcurrency:2}).initialize();let now=await store.coordinationNow();store.coordinationNow=async()=>now;
    const transaction=db.transaction.bind(db);let expire=false;
    db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const result=await q(sql,args);if(expire&&sql.startsWith('DELETE FROM sre_locks WHERE name='))now+=1001;return result;}));
    try{
      await seed(store,1);const job=await store.claim('owner',1000);expire=true;
      await assert.rejects(()=>finish(store,job),/lease expired/);assert.equal((await store.context(job.incident_id)).incident.analysis,null);
      const [row]=await db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]);assert.equal(row.status,'running');
      expire=false;const replacement=await store.claim('new-owner',1000);expire=true;
      await assert.rejects(()=>store.fail(replacement,new ModelQuotaError('claude-cli')),/lease expired/);assert.equal(await store.modelQuota(),null);
    }finally{await db.close();}
  });
}

test('a slow incident does not prevent an idle slot serving a newly arrived quiet incident',async()=>{
  const db=sqliteDatabase(':memory:'),store=await new SreStore(db,{investigationConcurrency:2}).initialize();
  const slow=Promise.withResolvers(),started=Promise.withResolvers(),quiet=Promise.withResolvers();let slowId,quietId;
  const rules=new RulesReasoner(),reasoner={mode:'claude',investigate:async(context,{signal})=>{
    if(context.incident.id===slowId){started.resolve();await Promise.race([slow.promise,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);}
    const result=await rules.investigate(context);result.analysis.mode='claude';result.analysis.teamsMessages=[];
    if(context.incident.id===quietId)quiet.resolve();return result;
  }};
  const pool=new InvestigationPool({store,services:[{key:'service',rollback:{enabled:false}}],connectors:new Map(),reasoner});
  try{
    [slowId]=await seed(store,2);pool.wake();await started.promise;
    for(let n=0;n<100;n++){if((await store.snapshot()).jobs.some(j=>j.status==='done'))break;await delay(5);}
    quietId=(await store.ingest({id:'late-quiet',source:'evaluation',serviceKey:'service',kind:'problem',issueKey:'late-quiet',status:'OPEN',at:Date.now(),payload:{}})).incidentId;
    pool.wake();await Promise.race([quiet.promise,delay(2000).then(()=>{throw Error('Quiet incident blocked behind slow incident');})]);
    for(let n=0;n<100&&!((await store.context(quietId)).incident.analysis);n++)await delay(5);
    assert.ok((await store.context(quietId)).incident.analysis);
    assert.equal((await store.context(slowId)).incident.analysis,null);slow.resolve();await pool.idle();
  }finally{slow.resolve();await pool.close();await db.close();}
});

test('concurrency config rejects invalid/unbounded values and offline rules parallelism',()=>{
  const base=loadConfig({});for(const value of [0,5,1.5,'4',NaN])assert.throws(()=>validateConfig({...base,investigationConcurrency:value},{}),/concurrency/);
  assert.throws(()=>validateConfig({...base,investigationConcurrency:2},{}),/Claude mode/);
});

test('runtime ticks refill idle capacity while an earlier incident remains in the model',async()=>{
  const base=loadConfig({}),config=validateConfig({...base,mode:'trial',agentMode:'claude',investigationConcurrency:2},{SRE_CLAUDE_BIN:'/nonexistent-concurrency-fixture'});
  const blocked=Promise.withResolvers(),started=Promise.withResolvers(),late=Promise.withResolvers(),rules=new RulesReasoner();let slowId,lateId;
  const reasoner={mode:'claude',investigate:async(context,{signal})=>{
    if(context.incident.id===slowId){started.resolve();await Promise.race([blocked.promise,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);}
    const result=await rules.investigate(context);result.analysis.mode='claude';result.analysis.teamsMessages=[];if(context.incident.id===lateId)late.resolve();return result;
  }};
  const runtime=await createSreRuntime({config,db:sqliteDatabase(':memory:'),connectors:new Map(),reasoner,autoStart:false});
  try{
    const serviceKey=config.services[0].key,incident=async id=>(await runtime.store.ingest({id,source:'evaluation',serviceKey,kind:'problem',issueKey:id,status:'OPEN',at:Date.now(),payload:{}})).incidentId;
    slowId=await incident('slow');await incident('first-quiet');const original=runtime.tick();await started.promise;
    for(let n=0;n<100;n++){if((await runtime.store.snapshot()).jobs.some(j=>j.status==='done'))break;await delay(5);}
    lateId=await incident('late-quiet');assert.equal(runtime.tick(),original);
    await Promise.race([late.promise,delay(2000).then(()=>{throw Error('Original tick blocked the quiet incident');})]);
    blocked.resolve();await original;assert.ok((await runtime.store.context(lateId)).incident.analysis);
  }finally{blocked.resolve();await runtime.close();}
});

test('pool shutdown cancels every active model and admits no more queued work',async()=>{
  const store=await new SreStore(sqliteDatabase(':memory:'),{investigationConcurrency:2}).initialize();let calls=0,cancelled=0;const both=Promise.withResolvers();
  const reasoner={mode:'claude',investigate:async(_context,{signal})=>{calls++;if(calls===2)both.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{cancelled++;reject(signal.reason);},{once:true}));}};
  const pool=new InvestigationPool({store,services:[{key:'service',rollback:{enabled:false}}],connectors:new Map(),reasoner});
  try{
    await seed(store,5);pool.wake();await both.promise;await pool.close();assert.equal(calls,2);assert.equal(cancelled,2);assert.equal(pool.running,false);
    assert.equal((await store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status='running'"))[0].count,0);
  }finally{await pool.close();await store.db.close();}
});

test('repeated admission failures retain a bounded error buffer and start no model calls',async()=>{
  let calls=0;const store={investigationConcurrency:4,restoreFence:async()=>null,claim:async()=>{throw Error('Synthetic unavailable storage');},release:async()=>{}};
  const pool=new InvestigationPool({store,services:[],connectors:new Map(),reasoner:{mode:'claude',investigate:async()=>{calls++;}}});
  try{for(let i=0;i<20;i++){await assert.rejects(()=>pool.runOnce(),/unavailable storage/);assert.ok(pool.errors.length<=4,'admission errors must not accumulate faster than the scheduler surfaces them');}assert.equal(calls,0);}
  finally{await pool.close().catch(()=>{});}
});
