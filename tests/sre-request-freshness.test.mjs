import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {ModelQuotaError} from '../src/sre/model-quota.mjs';
import {prepareRestore} from '../src/sre/restore-recovery.mjs';
import {requestFreshnessLimits} from '../src/sre/request-freshness.mjs';

async function fixture(dialect){
  let db;if(dialect==='sqlite')db=sqliteDatabase(':memory:');
  else {const pg=new PGlite();db={dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const options={questionBatchLimit:32,investigationConcurrency:2},store=await new SreStore(db,options).initialize();let now=await store.coordinationNow(),n=0;
  const clock=()=>now;store.coordinationNow=async()=>now;
  const ingest=(incidentId,kind='responder_update',extra={})=>store.ingest({id:'event-'+n++,source:'evaluation',serviceKey:'service',incidentId,kind,at:now-100000,payload:{text:kind==='question'?'Explain source and safe recovery.':'Unverified input',...extra}});
  const incident=async name=>(await store.ingest({id:name,source:'evaluation',serviceKey:'service',kind:'problem',issueKey:name,status:'OPEN',at:now,payload:{}})).incidentId;
  const finish=async(job,revision)=>store.finish(job,{mode:'claude',summary:'Fixture assessment',text:'Full fixture assessment',teamsMessages:[]},null,revision??Number((await store.context(job.incident_id)).incident.revision));
  return {db,store,options,clock,advance:ms=>{now+=ms;},ingest,incident,finish,reopen:async()=>{const reopened=await new SreStore(db,options).initialize();reopened.coordinationNow=async()=>now;return reopened;}};
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': a stale request waits for the burst, survives reopen, then recovers its earlier fair position once',async()=>{
    const f=await fixture(dialect);let store=f.store;
    try{
      const hot=await f.incident('hot');
      const first=await store.claim('one');assert.equal(first.incident_id,hot);await f.finish(first);f.advance(10);
      const quiet=await f.incident('quiet');await f.finish(await store.claim('one'));f.advance(10);
      await f.ingest(hot,'question');await f.ingest(hot,'question');const job=await store.claim('one'),revision=Number((await store.context(hot)).incident.revision),requests=job.payload.requests;
      assert.equal(requests.length,2);f.advance(100);await f.ingest(hot);assert.equal(await f.finish(job,revision),null);
      assert.equal((await store.context(hot)).assessmentStatus.state,'outdated');
      const before=(await f.db.query('SELECT payload FROM sre_jobs WHERE id=?',[job.id]))[0].payload;
      assert.deepEqual(JSON.parse(before).requests,requests);assert.equal(await store.claim('one'),null,'fresh update jobs cannot bypass the settling request');
      store=await f.reopen();assert.equal((await f.db.query('SELECT payload FROM sre_jobs WHERE id=?',[job.id]))[0].payload,before);
      // A genuinely new incident keeps its first-pass precedence.
      const late=await f.incident('late'),lateJob=await store.claim('late');assert.equal(lateJob.incident_id,late);await f.finish(lateJob);
      f.advance(4000);const update={id:'last-update',source:'evaluation',serviceKey:'service',incidentId:hot,kind:'responder_update',at:0,payload:{text:'Old source timestamp, newly received.'}};
      await store.ingest(update);f.advance(4999);await store.ingest(update); // duplicate does not move readiness
      await f.ingest(quiet,'question');const quietJob=await store.claim('quiet');assert.equal(quietJob.incident_id,quiet);await f.finish(quietJob);
      f.advance(1);const retry=await store.claim('one');assert.equal(retry.id,job.id);assert.deepEqual(retry.payload,job.payload);assert.equal(retry.scheduling.recovered,true);
      assert.equal(await store.checkpoint('agent-freshness-ready:'+hot),null);
      const beforeSecond=Number((await store.context(hot)).incident.revision);f.advance(10);await f.ingest(hot);await f.finish(retry,beforeSecond);
      const [scheduled]=await f.db.query('SELECT updated_at FROM sre_checkpoints WHERE id=?',['agent-scheduled:'+hot]);assert.equal(Number(scheduled.updated_at),retry.scheduling.scheduledAt,'a second stale result cannot roll back fairness again');
      await f.ingest(quiet,'question');f.advance(5000);const nextQuiet=await store.claim('quiet-again');assert.equal(nextQuiet.incident_id,quiet,'a changing hot request cannot repeatedly jump ahead of the quieter incident');await f.finish(nextQuiet);
    }finally{await f.db.close();}
  });

  test(dialect+': continuous fresh arrivals cannot extend one settling turn beyond two minutes',async()=>{
    const f=await fixture(dialect);
    try{
      const id=await f.incident('hot');await f.finish(await f.store.claim('owner'));f.advance(10);await f.ingest(id,'question');const job=await f.store.claim('owner'),revision=Number((await f.store.context(id)).incident.revision);
      await f.ingest(id);await f.finish(job,revision);const staleAt=f.clock();
      for(let n=0;n<requestFreshnessLimits.maxWaitMs/4000-1;n++){f.advance(4000);await f.ingest(id);assert.equal(await f.store.claim('owner'),null);}
      f.advance(3999);await f.ingest(id);assert.equal(await f.store.claim('owner'),null);f.advance(1);
      const retry=await f.store.claim('owner');assert.equal(f.clock()-staleAt,120000);assert.equal(retry.id,job.id);
      await f.store.fail(retry,Error('Transport retry'));const [deferred]=await f.db.query('SELECT next_at,payload FROM sre_jobs WHERE id=?',[retry.id]);
      await f.ingest(id);assert.equal((await f.db.query('SELECT next_at FROM sre_jobs WHERE id=?',[retry.id]))[0].next_at,deferred.next_at,'input cannot shorten an ordinary transport deadline');
      const other=await f.store.claim('other');assert.notEqual(other?.id,retry.id,'a deferred question cannot be reclaimed or batched early');
    }finally{await f.db.close();}
  });

  test(dialect+': a ninety-six-second flood settles once while quiet requests remain eligible',async()=>{
    const f=await fixture(dialect);
    try{
      const hot=await f.incident('long-hot');await f.finish(await f.store.claim('owner'));
      const quiet=await f.incident('long-quiet');await f.finish(await f.store.claim('owner'));
      await f.ingest(hot,'question');await f.ingest(hot,'question');const job=await f.store.claim('owner'),requests=job.payload.requests,revision=Number((await f.store.context(hot)).incident.revision);
      await f.ingest(hot);assert.equal(await f.finish(job,revision),null);const staleAt=f.clock();
      for(let n=0;n<24;n++){
        f.advance(4000);await f.ingest(hot);
        if(n===15){await f.ingest(quiet,'question');const other=await f.store.claim('quiet');assert.equal(other.incident_id,quiet);await f.finish(other);}
        assert.equal(await f.store.claim('owner'),null,'do not spend another model turn in the continuing burst');
      }
      f.advance(4999);assert.equal(await f.store.claim('owner'),null);f.advance(1);
      const retry=await f.store.claim('owner');assert.equal(retry.id,job.id);assert.deepEqual(retry.payload.requests,requests);assert.equal(f.clock()-staleAt,101000);
      assert.ok(await f.finish(retry));assert.equal(await f.store.checkpoint('agent-freshness-ready:'+hot),null);
    }finally{await f.db.close();}
  });

  test(dialect+': stale owners cannot install gates or roll back scheduling, and input cannot forge host retry metadata',async()=>{
    const f=await fixture(dialect);
    try{
      const id=await f.incident('hot');await f.finish(await f.store.claim('owner'));f.advance(10);await f.ingest(id,'question',{freshnessRetry:{version:1,previousAt:0,recovered:false,scheduledAt:0}});
      const [pending]=await f.db.query("SELECT payload FROM sre_jobs WHERE status='pending'");assert.equal(JSON.parse(pending.payload).freshnessRetry,undefined);
      const job=await f.store.claim('owner',1000),revision=Number((await f.store.context(id)).incident.revision);await f.ingest(id);f.advance(1001);const replacement=await f.store.claim('replacement',1000);
      await assert.rejects(()=>f.finish(job,revision),/lease lost/);assert.equal(await f.store.checkpoint('agent-freshness-ready:'+id),null);await f.finish(replacement);
    }finally{await f.db.close();}
  });

  test(dialect+': account and restore holds survive settling and retain the exact request and priority',async()=>{
    const f=await fixture(dialect);
    try{
      const id=await f.incident('hot');await f.finish(await f.store.claim('owner'));f.advance(10);await f.ingest(id,'question');const job=await f.store.claim('owner'),revision=Number((await f.store.context(id)).incident.revision);await f.ingest(id);await f.finish(job,revision);
      const gate=await f.store.checkpoint('agent-freshness-ready:'+id),scheduling=await f.store.checkpoint('agent-request-schedule:'+job.id),[before]=await f.db.query('SELECT payload FROM sre_jobs WHERE id=?',[job.id]);
      const peer=await f.incident('peer'),running=await f.store.claim('peer');assert.equal(running.incident_id,peer);await f.store.fail(running,new ModelQuotaError('codex-cli'));f.advance(60000);assert.equal(await f.store.claim('blocked'),null);
      await prepareRestore(f.store,{restoreId:'freshness-restore',backupSha256:'b'.repeat(64),backupAt:f.clock()-1000,reason:'Fixture gate persistence',actor:{kind:'local-operator',id:'fixture'},offline:true});
      assert.deepEqual(await f.store.checkpoint('agent-freshness-ready:'+id),gate);assert.deepEqual(await f.store.checkpoint('agent-request-schedule:'+job.id),scheduling);assert.equal((await f.db.query('SELECT payload FROM sre_jobs WHERE id=?',[job.id]))[0].payload,before.payload);assert.equal((await f.store.modelQuota()).state,'held');
    }finally{await f.db.close();}
  });

  test(dialect+': readiness extended after candidate selection is rechecked before batching or consuming priority',async()=>{
    const f=await fixture(dialect);
    try{
      const id=await f.incident('hot');await f.finish(await f.store.claim('owner'));f.advance(10);await f.ingest(id,'question');const job=await f.store.claim('owner'),revision=Number((await f.store.context(id)).incident.revision);await f.ingest(id);await f.finish(job,revision);f.advance(5000);
      const before=await f.db.query('SELECT id,status,payload,attempts,next_at FROM sre_jobs ORDER BY id'),position=await f.db.query('SELECT value,updated_at FROM sre_checkpoints WHERE id=?',['agent-scheduled:'+id]),transaction=f.db.transaction.bind(f.db);let extend=true;
      f.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{
        const result=await q(sql,args);
        if(extend&&sql.startsWith('SELECT j.*,f.updated_at')&&result[0]?.incident_id===id){extend=false;await q('UPDATE sre_checkpoints SET updated_at=? WHERE id=?',[f.clock()+5000,'agent-freshness-ready:'+id]);}
        return result;
      }));
      assert.equal(await f.store.claim('racing'),null);assert.equal(extend,false);assert.deepEqual(await f.db.query('SELECT id,status,payload,attempts,next_at FROM sre_jobs ORDER BY id'),before);assert.deepEqual(await f.db.query('SELECT value,updated_at FROM sre_checkpoints WHERE id=?',['agent-scheduled:'+id]),position);
      f.advance(5000);const retry=await f.store.claim('ready');assert.equal(retry.id,job.id);assert.deepEqual(retry.payload,job.payload);
    }finally{await f.db.close();}
  });
}
