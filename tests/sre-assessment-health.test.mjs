import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';import {createSreRuntime} from '../src/sre/server.mjs';import {validateConfig} from '../src/sre/config.mjs';import {postgresSql} from '../src/sre/database.mjs';import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';import {seedDemo,devActivity} from '../src/sre/demo.mjs';import {OperationalMonitor} from '../src/sre/operations.mjs';

async function fixture(dialect){
 const config=validateConfig(rehearsalProfile(),{SRE_SQLITE_PATH:':memory:',SRE_CLAUDE_BIN:'/nonexistent-assessment-health-cli'});assert.equal(config.sqlitePath,':memory:');
 const pg=dialect==='postgres'?new PGlite():null,db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
 const r=await createSreRuntime({config,db,connectors:new Map([[config.services[0].key,{}]]),autoStart:false}),service=config.services[0];let now=Date.now(),sequence=0;r.store.clock=()=>now;r.store.coordinationNow=async()=>now;
 const f={r,service,advance:ms=>now+=ms};f.settle=async()=>{for(let i=0;i<100;i++){const [row]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.count))return;await r.worker.runOnce();}throw Error('Health fixture did not settle');};
 f.id=(await seedDemo(r.store,service)).incidentId;await f.settle();await r.store.db.query('DELETE FROM sre_outbox');
 const sample=devActivity('help',service,{conversationType:'groupChat'});await r.store.rememberConversation({tenant:'synthetic',serviceKey:service.key,reference:sample.reference});
 f.monitor=new OperationalMonitor({store:r.store,config:{...config,mode:'connected',teamsMode:'live',operations:{...config.operations,notify:true},services:config.services.map(s=>({...s,teams:{...s.teams,operationsConversationId:s.teams.conversations[0]}}))},schedulerEnabled:false});
 f.question=async(text='Review the current accepted-bid evidence.')=>r.store.ingest({id:'health-question-'+ ++sequence,source:'operator-api',serviceKey:service.key,kind:'question',incidentId:f.id,at:now,payload:{text}});
 f.orphan=async()=>{f.advance(10);await f.question('Fictional interrupted admission; the old worker left no queued review.');await r.store.db.query("UPDATE sre_jobs SET status='superseded' WHERE incident_id=? AND status='pending'",[f.id]);};
 f.notices=()=>r.store.db.query("SELECT id,text,conversation_key FROM sre_outbox WHERE text LIKE 'Shared service checks%' ORDER BY created_at,id");
 return f;
}
const orphan=report=>report.conditions.find(c=>c.code==='assessment_orphaned');
const waiting=report=>report.pendingSources.find(c=>c.source==='incident assessment');

for(const dialect of ['sqlite','postgres']){
 test(dialect+': an active incident with outdated review and no queued work makes shared health actionable',async()=>{
  const f=await fixture(dialect);try{
   assert.equal((await f.monitor.snapshot()).state,'healthy');await f.orphan();const report=await f.monitor.snapshot(),condition=orphan(report);assert.equal(report.state,'needs-attention');assert.ok(condition);assert.equal(condition.scope,'shared');assert.equal(condition.serviceKey,f.service.key);assert.equal(condition.count,1);assert.equal(condition.incidentId,f.id);assert.match(condition.message,/current.*review|review.*current/i);assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
  }finally{await f.r.close();}
 });
 test(dialect+': queuing a replacement review stays waiting and does not announce recovery before completion',async()=>{
  const f=await fixture(dialect);try{
   await f.orphan();await f.monitor.observe();assert.equal((await f.notices()).length,1);f.advance(10);await f.question();const pending=await f.monitor.observe();assert.equal(pending.state,'starting');assert.ok(waiting(pending));assert.equal(orphan(pending),undefined);assert.equal((await f.notices()).length,1);
   await f.settle();assert.equal((await f.monitor.observe()).state,'healthy');await f.monitor.observe();const notes=await f.notices();assert.equal(notes.length,2);assert.equal(notes.filter(n=>n.text.includes('checks recovered')).length,1);assert.equal((await f.r.store.context(f.id)).assessmentStatus.state,'current');
  }finally{await f.r.close();}
 });
 test(dialect+': missing and unaudited saved assessments cannot be hidden by completed job rows',async()=>{
  const f=await fixture(dialect);try{
   await f.r.store.db.query('UPDATE sre_incidents SET analysis=NULL WHERE id=?',[f.id]);assert.ok(orphan(await f.monitor.snapshot()));
   await f.r.store.db.query('UPDATE sre_incidents SET analysis=? WHERE id=?',[JSON.stringify({summary:'Fictional imported assessment without its audit',text:'Unknown review provenance'}),f.id]);assert.equal((await f.r.store.context(f.id)).assessmentStatus.state,'unverified');assert.ok(orphan(await f.monitor.snapshot()));
   f.advance(10);await f.question();assert.equal((await f.monitor.snapshot()).state,'starting');await f.settle();assert.equal((await f.monitor.snapshot()).state,'healthy');
  }finally{await f.r.close();}
 });
 test(dialect+': exhausted investigation remains a manual retry condition and cannot become an automatic orphan retry',async()=>{
  const f=await fixture(dialect);try{
   f.advance(10);await f.question();const job=await f.r.store.claim(f.r.worker.owner);await f.r.store.fail({...job,attempts:3},Error('Fictional denied provider read'));const report=await f.monitor.snapshot();assert.equal(report.state,'needs-attention');assert.ok(report.conditions.some(c=>c.code==='investigation_dead'));assert.equal(orphan(report),undefined);
   const before=await f.r.store.db.query('SELECT * FROM sre_jobs ORDER BY id');await f.monitor.observe();assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_jobs ORDER BY id'),before,'Health observation must not retry exhausted work');
  }finally{await f.r.close();}
 });
 test(dialect+': a resolved historical case does not create an orphan warning',async()=>{
  const f=await fixture(dialect);try{
   await f.orphan();await f.r.store.db.query("UPDATE sre_incidents SET status='resolved' WHERE id=?",[f.id]);assert.equal((await f.monitor.snapshot()).state,'healthy');assert.equal(orphan(await f.monitor.snapshot()),undefined);
  }finally{await f.r.close();}
 });
 test(dialect+': orphan counts and notice destinations stay inside their configured logical service',async()=>{
  const f=await fixture(dialect);try{
   const second=structuredClone(f.service);second.key='another-auction';second.tenant='another-fixture';second.teams={...second.teams,tenantId:'other-fixture-tenant'};f.r.config.services.push(second);f.r.store.services=f.r.config.services;
   const sample=devActivity('help',second,{conversationType:'groupChat'}),secondRoom=await f.r.store.rememberConversation({tenant:second.teams.tenantId,serviceKey:second.key,reference:sample.reference});
   f.monitor.config.services.push({...second,teams:{...second.teams,operationsConversationId:second.teams.conversations[0]}});
   const other=await f.r.store.ingest({id:'second-service-health',source:'dynatrace',serviceKey:second.key,kind:'problem',issueKey:'other-service-provider',status:'OPEN',at:Date.now(),payload:{metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}}});await f.r.store.db.query("UPDATE sre_jobs SET status='superseded' WHERE incident_id=?",[other.incidentId]);
   const report=await f.monitor.observe(),condition=orphan(report);assert.equal(condition.serviceKey,second.key);assert.equal(condition.incidentId,other.incidentId);assert.equal(condition.count,1);const notes=await f.notices();assert.equal(notes.length,1);assert.equal(notes[0].conversation_key,secondRoom);assert.ok(!notes[0].text.includes(f.id));
  }finally{await f.r.close();}
 });
 test(dialect+': a notice enqueue failure rolls back its checkpoint and remains retryable without duplicate recovery',async()=>{
  const f=await fixture(dialect);try{
   await f.orphan();const queue=f.r.store.queueMessage.bind(f.r.store);let fail=true;f.r.store.queueMessage=async(...args)=>{if(fail){fail=false;throw Error('Injected orphan notice storage failure');}return queue(...args);};
   await assert.rejects(()=>f.monitor.observe(),/Injected orphan notice/);assert.equal((await f.notices()).length,0);await f.monitor.observe();await f.monitor.observe();assert.equal((await f.notices()).length,1);f.advance(10);await f.question();await f.monitor.observe();assert.equal((await f.notices()).length,1);await f.settle();await f.monitor.observe();assert.equal((await f.notices()).length,2);
  }finally{await f.r.close();}
 });
 test(dialect+': stale running leases and future retry waits do not turn missing current review into healthy status',async()=>{
  const f=await fixture(dialect);try{
   f.advance(10);await f.question();let job=await f.r.store.claim(f.r.worker.owner,1000);f.advance(1001);assert.equal((await f.monitor.snapshot()).state,'starting');f.advance(10001);assert.ok((await f.monitor.snapshot()).conditions.some(c=>c.code==='investigation_stuck'));
   job=await f.r.store.claim(f.r.worker.owner);await f.r.store.fail(job,Error('Fictional transient read'));const report=await f.monitor.snapshot();assert.equal(report.state,'starting');assert.ok(waiting(report));assert.equal(orphan(report),undefined);
  }finally{await f.r.close();}
 });
 test(dialect+': review freshness is independent of a bounded five-row history display and tied timestamps',async()=>{
  const f=await fixture(dialect);try{
   const c=await f.r.store.context(f.id),bodies=[];for(let i=1;i<=8;i++){const body=JSON.stringify({...c.incident.analysis,summary:'Fictional same-revision review '+i});bodies.push(body);await f.r.store.db.query('INSERT INTO sre_assessments(id,incident_id,revision,evaluated_at,body) VALUES(?,?,?,?,?)',[String(i).padStart(64,'0'),f.id,c.incident.revision,c.incident.updated_at+1000,body]);}
   await f.r.store.db.query('UPDATE sre_incidents SET analysis=? WHERE id=?',[bodies[0],f.id]);const current=await f.r.store.context(f.id);assert.equal(current.assessmentHistory.length,5);assert.equal(current.assessmentStatus.state,'current');assert.equal((await f.monitor.snapshot()).state,'healthy');
  }finally{await f.r.close();}
 });
}

test('the loopback health API exposes the affected incident and keeps liveness available',async()=>{
 const f=await fixture('sqlite');try{
  await f.orphan();f.r.server.listen(0,'127.0.0.1');await once(f.r.server,'listening');const base='http://127.0.0.1:'+f.r.server.address().port,response=await fetch(base+'/api/operations');assert.equal(response.status,200);const report=await response.json();assert.equal(report.state,'needs-attention');assert.equal(orphan(report).incidentId,f.id);assert.equal((await fetch(base+'/health')).status,200);assert.equal((await(await fetch(base+'/api/status')).json()).operations.state,'needs-attention');
 }finally{await f.r.close();}
});
