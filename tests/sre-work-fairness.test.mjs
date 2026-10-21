import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import {createSreRuntime} from '../src/sre/server.mjs';import {postgresSql} from '../src/sre/database.mjs';import {validateConfig} from '../src/sre/config.mjs';import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';import {seedDemo} from '../src/sre/demo.mjs';
import {assessRollback,Rollbacks} from '../src/sre/rollback.mjs';

async function fixture(dialect,{path=':memory:',seed=true}={}){
  const config=validateConfig(rehearsalProfile(),{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-work-fairness-cli'});assert.equal(config.sqlitePath,path);const service=config.services[0];
  const pg=dialect==='postgres'?new PGlite():null,db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
  const r=await createSreRuntime({config,db,connectors:new Map([[service.key,{}]]),autoStart:false});let clock=Date.now(),sequence=0;r.store.clock=()=>clock;r.store.coordinationNow=async()=>clock;
  const f={r,service,advance:ms=>clock+=ms};
  f.question=async(id,text)=>r.store.ingest({id:'fair-question-'+ ++sequence,source:'operator-api',serviceKey:service.key,kind:'question',incidentId:id,at:clock,payload:{text}});
  f.other=async()=>r.store.ingest({id:'fair-provider-'+ ++sequence,source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'fairness-independent-credit',status:'OPEN',at:clock,payload:{problemId:'fairness-independent-credit',metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE'],requests:3}}});
  f.update=async()=>{const c=await r.store.context(f.id);return r.store.ingest({id:'fair-update-'+ ++sequence,source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:c.incident.issue_key,status:'OPEN',at:clock,startedAt:c.incident.started_at,payload:{problemId:c.incident.issue_key.replace(/^dynatrace:/,''),metrics:{violations:['WINNING_BID_REGRESSED'],requests:12}}});};
  f.complete=async(job)=>{const c=await r.store.context(job.incident_id);return r.store.finish(job,{...(c.incident.analysis||{summary:'Fictional provider review',hypotheses:[],unknowns:[],nextSteps:[]}),text:'Reviewed fixture request: '+(job.payload.question||job.incident_id)},null,c.incident.revision);};
  f.settle=async()=>{for(let i=0;i<100;i++){const [count]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(count.count))return;await r.worker.runOnce();}throw Error('Fairness fixture did not settle');};
  if(seed){f.id=(await seedDemo(r.store,service)).incidentId;await f.settle();await r.store.release(r.worker.owner);}
  return f;
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': a stale question yields to a waiting independent incident instead of retaining its original queue position',async()=>{
    const f=await fixture(dialect);try{
      f.advance(10);await f.question(f.id,'Recheck the accepted-bid failure.');const job=await f.r.store.claim('fair-owner'),old=await f.r.store.context(f.id);f.advance(10);const other=await f.other();f.advance(10);await f.update();
      assert.equal(await f.r.store.finish(job,old.incident.analysis,null,old.incident.revision),null);const next=await f.r.store.claim('fair-owner');assert.equal(next.incident_id,other.incidentId);await f.complete(next);const resumed=await f.r.store.claim('fair-owner');assert.equal(resumed.id,job.id);assert.equal(resumed.payload.question,job.payload.question);await f.complete(resumed);
    }finally{await f.r.close();}
  });
  test(dialect+': a stale first question yields to a later human question for the same incident without losing either request',async()=>{
    const f=await fixture(dialect);try{
      f.advance(10);await f.question(f.id,'Avery asks which source revision broke the ledger.');const first=await f.r.store.claim('fair-owner'),old=await f.r.store.context(f.id);f.advance(10);await f.question(f.id,'Sam asks why health probes stayed green.');f.advance(10);await f.update();
      await f.r.store.finish(first,old.incident.analysis,null,old.incident.revision);const second=await f.r.store.claim('fair-owner');assert.match(second.payload.question,/Sam/);await f.complete(second);const again=await f.r.store.claim('fair-owner');assert.equal(again.id,first.id);assert.match(again.payload.question,/Avery/);await f.complete(again);
      assert.equal((await f.r.store.context(f.id)).jobs.filter(j=>j.status==='done').length>=3,true);
    }finally{await f.r.close();}
  });
  test(dialect+': an expired running claim waits behind work that became ready before its lease expired',async()=>{
    const f=await fixture(dialect);try{
      f.advance(10);await f.question(f.id,'Abandoned fictional question.');const abandoned=await f.r.store.claim('crashed-owner',1000);f.advance(10);const other=await f.other();f.advance(1001);
      const next=await f.r.store.claim('replacement-owner',1000);assert.equal(next.incident_id,other.incidentId);await f.complete(next);const reclaimed=await f.r.store.claim('replacement-owner',1000);assert.equal(reclaimed.id,abandoned.id);await assert.rejects(()=>f.complete(abandoned),/lease lost/);await f.complete(reclaimed);
    }finally{await f.r.close();}
  });
  test(dialect+': retry eligibility respects backoff and does not leapfrog an already waiting incident once that backoff expires',async()=>{
    const f=await fixture(dialect);try{
      f.advance(10);await f.question(f.id,'Retry fixture provider read.');const failed=await f.r.store.claim('fair-owner');await f.r.store.fail(failed,Error('Fictional temporary failure'));const [retry]=await f.r.store.db.query('SELECT next_at FROM sre_jobs WHERE id=?',[failed.id]);assert.equal(await f.r.store.claim('fair-owner'),null);
      f.advance(100);const other=await f.other();f.advance(3000);const next=await f.r.store.claim('fair-owner');assert.equal(next.incident_id,other.incidentId);await f.complete(next);const resumed=await f.r.store.claim('fair-owner');assert.equal(resumed.id,failed.id);assert.ok(Number(retry.next_at)>Number(failed.created_at));await f.complete(resumed);
    }finally{await f.r.close();}
  });
  test(dialect+': a failed stale-result reschedule preserves the running job, original age and all pending work',async()=>{
    const f=await fixture(dialect);try{
      f.advance(10);await f.question(f.id,'Atomic stale-result reschedule.');const job=await f.r.store.claim('fair-owner'),old=await f.r.store.context(f.id);f.advance(10);await f.other();f.advance(10);await f.update();const before=await f.r.store.db.query('SELECT * FROM sre_jobs ORDER BY id'),transaction=f.r.store.db.transaction;
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith("UPDATE sre_jobs SET status='pending',next_at="))throw Error('Injected reschedule failure');return q(sql,args);}));
      await assert.rejects(()=>f.r.store.finish(job,old.incident.analysis,null,old.incident.revision),/Injected reschedule/);f.r.store.db.transaction=transaction;assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_jobs ORDER BY id'),before);assert.equal((await f.r.store.context(f.id)).incident.analysis.summary,old.incident.analysis.summary);
    }finally{await f.r.close();}
  });
  test(dialect+': the API reports stale assessment evidence even when no review job remains, and a fresh question restores current status',async()=>{
    const f=await fixture(dialect);try{
      const initial=await f.r.store.context(f.id);assert.equal(initial.assessmentStatus.state,'current');f.advance(10);await f.update();let c=await f.r.store.context(f.id);assert.equal(c.assessmentStatus.state,'outdated');assert.equal(c.assessmentStatus.revision,initial.incident.revision);
      await f.r.store.db.query("UPDATE sre_jobs SET status='superseded' WHERE status='pending'");f.r.server.listen(0,'127.0.0.1');await once(f.r.server,'listening');const response=await fetch('http://127.0.0.1:'+f.r.server.address().port+'/api/incidents/'+f.id);assert.equal(response.status,200);c=await response.json();assert.equal(c.assessmentStatus.state,'outdated');assert.ok(c.jobs.every(j=>!['pending','running'].includes(j.status)));await assert.rejects(()=>f.r.casework.createPlan(f.id),/stale/);
      f.advance(10);await f.question(f.id,'Please review the current evidence.');await f.settle();c=await f.r.store.context(f.id);assert.equal(c.assessmentStatus.state,'current');assert.equal(c.incident.analysis.rollback.eligible,true);
    }finally{await f.r.close();}
  });
  test(dialect+': missing and unaudited saved assessments remain unverified until a current investigation completes',async()=>{
    const f=await fixture(dialect,{seed:false});try{
      f.id=(await f.other()).incidentId;assert.equal((await f.r.store.context(f.id)).assessmentStatus.state,'missing');await f.r.store.db.query('UPDATE sre_incidents SET analysis=? WHERE id=?',[JSON.stringify({summary:'Fictional legacy assessment without an audit row',text:'Unverified import'}),f.id]);assert.equal((await f.r.store.context(f.id)).assessmentStatus.state,'unverified');await f.settle();assert.equal((await f.r.store.context(f.id)).assessmentStatus.state,'current');
    }finally{await f.r.close();}
  });
  test(dialect+': a review committed during a context read cannot make that older shown assessment appear current',async()=>{
    const f=await fixture(dialect);try{
      const before=await f.r.store.context(f.id),query=f.r.store.db.query;let held=false;
      f.r.store.db.query=async(sql,args=[])=>{const rows=await query(sql,args);if(!held&&sql.startsWith('SELECT * FROM sre_incidents WHERE id=')){held=true;f.advance(10);await f.update();await f.settle();}return rows;};
      const mixed=await f.r.store.context(f.id);f.r.store.db.query=query;assert.ok(held);assert.equal(mixed.incident.analysis.summary,before.incident.analysis.summary);assert.equal(mixed.assessmentStatus.state,'outdated');assert.equal(mixed.assessmentStatus.revision,before.incident.revision);assert.ok(mixed.assessmentStatus.latestRevision>mixed.incident.revision);assert.equal((await f.r.store.context(f.id)).assessmentStatus.state,'current');
    }finally{await f.r.close();}
  });
  test(dialect+': a rollback proposal cannot rely on an older likely-regression assessment while new evidence waits for review',async()=>{
    const f=await fixture(dialect);try{
      assert.equal(assessRollback(await f.r.store.context(f.id),f.service).eligible,true);f.advance(10);await f.update();const principal={verified:true,simulation:true,tenant:'synthetic',conversationId:f.service.teams.conversations[0],userId:'local-operator'};
      const proposal=await f.r.rollbacks.propose(f.id,principal);assert.equal(proposal.eligible,false);assert.match(proposal.text,/current.*assessment|assessment.*current/i);assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    }finally{await f.r.close();}
  });
  test(dialect+': an already approved rollback stops before provider reads or dispatch when its persisted assessment is outdated',async()=>{
    const f=await fixture(dialect);try{
      let reads=0,writes=0;const current=assessRollback(await f.r.store.context(f.id),f.service).current,provider=f.service.rollback.provider,executor=new Rollbacks({store:f.r.store,services:[f.service],mode:'connected',connectors:new Map([[f.service.key,{[provider]:{deployments:async()=>{reads++;return {complete:true,items:[current]};}},rollback:{dispatch:async()=>{writes++;return {status:'dispatched',fixture:true};}}}]])}),principal={verified:true,simulation:false,tenant:'synthetic',conversationId:f.service.teams.conversations[0],userId:'local-operator'};
      const proposal=await executor.propose(f.id,principal);assert.equal(proposal.eligible,true);await executor.approve(proposal.id,proposal.text.split(' ').at(-1),principal);f.advance(10);await f.update();await executor.executeNext();
      const row=(await f.r.store.snapshot()).rollbacks.find(item=>item.id===proposal.id);assert.equal(row.status,'blocked');assert.match(row.error,/current.*assessment|assessment.*current/i);assert.equal(reads,0);assert.equal(writes,0);
    }finally{await f.r.close();}
  });
}

test('file-backed restart preserves the yielded order without rewriting original creation times or session identities',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-work-fairness-')),path=join(directory,'agent.sqlite');let f=await fixture('sqlite',{path});try{
    const id=f.id,session=(await f.r.store.context(id)).session.agent_id;f.advance(10);await f.question(id,'Persistently yielded question.');const job=await f.r.store.claim('pre-restart'),old=await f.r.store.context(id);f.advance(10);const other=await f.other();f.advance(10);await f.update();await f.r.store.finish(job,old.incident.analysis,null,old.incident.revision);await f.r.store.release('pre-restart');const rows=await f.r.store.db.query('SELECT id,created_at,next_at FROM sre_jobs ORDER BY id');await f.r.close();
    f=await fixture('sqlite',{path,seed:false});f.id=id;f.advance(100);assert.deepEqual(await f.r.store.db.query('SELECT id,created_at,next_at FROM sre_jobs ORDER BY id'),rows);assert.equal((await f.r.store.context(id)).session.agent_id,session);assert.equal((await f.r.store.claim('post-restart')).incident_id,other.incidentId);
  }finally{await f.r.close();await rm(directory,{recursive:true,force:true});}
});
