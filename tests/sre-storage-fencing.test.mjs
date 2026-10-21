import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { sqliteDatabase,postgresSql } from '../src/sre/database.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { loadConfig } from '../src/sre/config.mjs';

async function fixture(dialect) {
  let now=Date.now(),db;
  if(dialect==='sqlite')db=sqliteDatabase(':memory:');
  else {
    const pg=new PGlite();
    db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
  }
  const store=await new SreStore(db,{clock:()=>now}).initialize();
  // Simulated statement-time expiry; native TCP cases exercise the real clock.
  store.coordinationNow=async()=>now;
  const opened=await store.ingest({id:'fence',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'P-FENCE',status:'OPEN',at:now,payload:{}});
  return {db,store,incidentId:opened.incidentId,expire:()=>{now+=1001;}};
}
for(const dialect of ['sqlite','postgres']) {
  test(dialect+': expiry during the final notification statement rolls back result, job, session and audit',async()=>{
    const f=await fixture(dialect),job=await f.store.claim('original',1000),agentId=(await f.store.context(f.incidentId)).session.agent_id;
    const transaction=f.db.transaction.bind(f.db);
    f.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{
      const rows=await q(sql,args);if(sql.startsWith('INSERT INTO sre_outbox'))f.expire();return rows;
    }));
    try {
      await assert.rejects(()=>f.store.finish(job,{summary:'expired',text:'must not publish'},{sessionId:'expired-model-session'}),/lease expired/);
      const context=await f.store.context(f.incidentId);assert.equal(context.incident.analysis,null);assert.equal(context.jobs[0].status,'running');
      assert.deepEqual(context.session.remote_state,{});assert.equal(context.session.agent_id,agentId);assert.equal(context.assessmentHistory.length,0);
      assert.equal(Number((await f.db.query('SELECT COUNT(*) AS count FROM sre_outbox'))[0].count),0);
      const reclaimed=await f.store.claim('replacement',1000);assert.equal(reclaimed.id,job.id);assert.equal(reclaimed.attempts,2);
    } finally {await f.db.close();}
  });
  test(dialect+': a late failure report cannot exhaust or reschedule an expired job lease',async()=>{
    const f=await fixture(dialect),job=await f.store.claim('original',1000);
    try {
      f.expire();await f.store.fail({...job,attempts:3},new Error('late investigation failure'));
      const [pending]=await f.db.query('SELECT status,error,attempts FROM sre_jobs WHERE id=?',[job.id]);
      assert.equal(pending.status,'running');assert.equal(pending.error,null);assert.equal(Number(pending.attempts),1);
      assert.equal((await f.store.claim('replacement',1000)).id,job.id);
    } finally {await f.db.close();}
  });
  test(dialect+': reclaimed ownership fences remote checkpoints and rejects cross-incident persistence',async()=>{
    const f=await fixture(dialect),original=await f.store.claim('original',1000);
    try {
      await f.store.setRemoteState(f.incidentId,{sessionId:'preserved',streamIndex:1},original);
      f.expire();const replacement=await f.store.claim('replacement',1000);
      await f.store.setRemoteState(f.incidentId,{sessionId:'preserved',streamIndex:2},replacement);
      await assert.rejects(()=>f.store.setRemoteState(f.incidentId,{sessionId:'stale'},original),/lease lost/);
      await assert.rejects(()=>f.store.setRemoteState('some-other-incident',{sessionId:'wrong-scope'},replacement),/outside the job incident/);
      assert.deepEqual((await f.store.context(f.incidentId)).session.remote_state,{sessionId:'preserved',streamIndex:2});
    } finally {await f.db.close();}
  });
  test(dialect+': session checkpoint expiry during its database write rolls back the opaque state',async()=>{
    const f=await fixture(dialect),job=await f.store.claim('original',1000),transaction=f.db.transaction.bind(f.db);
    f.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{
      const rows=await q(sql,args);if(sql.startsWith('UPDATE sre_sessions SET remote_state='))f.expire();return rows;
    }));
    try {
      await assert.rejects(()=>f.store.setRemoteState(f.incidentId,{sessionId:'late-state'},job),/lease expired/);
      assert.deepEqual((await f.store.context(f.incidentId)).session.remote_state,{});
    } finally {await f.db.close();}
  });
}
test('worker binds the remote checkpoint callback to its actual job after another owner reclaims it',async()=>{
  let now=Date.now(),replacement,runtime;
  runtime=await createSreRuntime({config:loadConfig({SRE_SQLITE_PATH:':memory:'}),autoStart:false,reasoner:{investigate:async(context,options)=>{
    now+=1001;replacement=await runtime.store.claim('replacement',1000);
    await options.persistRemote({sessionId:'stale-callback'});
    throw new Error('A stale callback should have been rejected');
  }}});
  runtime.store.clock=()=>now;runtime.worker.leaseMs=1000;
  try {
    const {incidentId}=await runtime.store.ingest({id:'callback',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'P-CALLBACK',status:'OPEN',at:now,payload:{}});
    assert.equal(await runtime.worker.runOnce(),false);assert.ok(replacement);
    const context=await runtime.store.context(incidentId);assert.deepEqual(context.session.remote_state,{});assert.equal(context.incident.analysis,null);
    const [job]=await runtime.store.db.query('SELECT status,lease_owner,error FROM sre_jobs WHERE id=?',[replacement.id]);assert.equal(job.status,'running');assert.equal(job.lease_owner,'replacement');assert.equal(job.error,null);
  } finally {await runtime.close();}
});
