import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { sqliteDatabase,postgresSql,StorageError } from '../src/sre/database.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { OperationalMonitor } from '../src/sre/operations.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { IncidentWorker } from '../src/sre/worker.mjs';
import { RulesReasoner } from '../src/sre/reasoner.mjs';
import { devActivity } from '../src/sre/demo.mjs';

async function exhaust(store) {
  const owner='fixture-exhaustion';let job;
  for(let i=0;i<3;i++) {
    job=await store.claim(owner);assert.ok(job);
    await store.fail(job,new Error('Fixture read access denied'));
    const [saved]=await store.db.query('SELECT next_at FROM sre_jobs WHERE id=?',[job.id]);
    const at=Number(saved.next_at);store.clock=()=>at;
  }
  await store.release(owner);return job;
}

async function fixture(dialect='sqlite',{question=true}={}) {
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=config.services[0];
  let db;
  if(dialect==='sqlite')db=sqliteDatabase(':memory:');
  else {const pg=new PGlite();db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const store=await new SreStore(db,{services:[service]}).initialize();
  // Advance retry schedules without real waits in this transaction unit test.
  store.coordinationNow=async()=>store.clock();
  const {incidentId}=await store.ingest({id:'problem',source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'retry-fixture',status:'OPEN',at:Date.now()-1000,payload:{}});
  if(question) {
    const initial=await store.claim('fixture-initial');await store.finish(initial,{summary:'Initial fixture analysis',text:'Initial fixture analysis'});await store.release('fixture-initial');
    await store.ingest({id:'question',source:'operator-api',serviceKey:service.key,incidentId,kind:'question',at:store.clock(),payload:{text:'Recheck the current evidence before recommending recovery.'}});
  }
  const job=await exhaust(store),request={serviceKey:service.key,incidentId,jobId:job.id,requestId:'stable-request',reason:'Read access has been restored; inspect fresh evidence.',actor:{kind:'local-operator',id:'fixture operator'}};
  return {store,db,config,service,incidentId,job,request};
}

for(const dialect of ['sqlite','postgres'])test(dialect+': operator retry is atomic, idempotent, auditable, and completes the original question',async()=>{
  const f=await fixture(dialect),{store,db,config,request,incidentId}=f;
  const worker=new IncidentWorker({store,services:config.services,connectors:new Map(),reasoner:new RulesReasoner()});
  try {
    const original=await store.context(incidentId);
    assert.equal((await new OperationalMonitor({store,config,schedulerEnabled:false}).snapshot()).conditions[0].code,'investigation_dead');
    // Other uncertain external actions must remain untouched by analysis retry.
    await store.queueMessage(incidentId,'Unknown delivery',null,'unknown-delivery');
    await db.query("UPDATE sre_outbox SET status='unknown' WHERE id='unknown-delivery'");
    await db.query("INSERT INTO sre_rollbacks(id,incident_id,proposal,nonce_hash,expires_at,status,created_at) VALUES(?,?,?,'fixture',?,'unknown',?)",['unknown-rollback',incidentId,'{}',store.clock()+60000,store.clock()]);
    const [a,b]=await Promise.all([store.retryInvestigation(request),store.retryInvestigation(request)]);
    assert.equal(a.replacementJobId,b.replacementJobId);assert.equal(Number(a.duplicate)+Number(b.duplicate),1);
    const [failed]=await db.query('SELECT * FROM sre_jobs WHERE id=?',[request.jobId]);
    assert.equal(failed.status,'retried');assert.equal(Number(failed.attempts),3);assert.match(failed.error,/access denied/);
    const [replacement]=await db.query('SELECT * FROM sre_jobs WHERE id=?',[a.replacementJobId]);
    assert.equal(Number(replacement.attempts),0);assert.equal(replacement.status,'pending');
    assert.equal(JSON.parse(replacement.payload).question,f.job.payload.question);
    assert.equal((await store.context(incidentId)).retries.length,1);
    assert.equal((await store.context(incidentId)).session.agent_id,original.session.agent_id);
    const conditions=(await new OperationalMonitor({store,config,schedulerEnabled:false}).snapshot()).conditions.map(item=>item.code);
    assert.ok(!conditions.includes('investigation_dead'));assert.ok(conditions.includes('notification_unknown'));assert.ok(conditions.includes('rollback_unknown'));
    await worker.runOnce();
    assert.equal((await db.query('SELECT status FROM sre_jobs WHERE id=?',[a.replacementJobId]))[0].status,'done');
    const context=await store.context(incidentId);
    assert.ok(context.evidence.some(item=>item.kind==='question'&&item.content.action==='retry_investigation'&&item.content.text.includes('Read access has been restored')));
    assert.match(context.incident.analysis.text,/Recheck the current evidence/);
    const reopened=await new SreStore(db,{services:config.services,clock:store.clock}).initialize();
    assert.equal((await reopened.retryInvestigation(request)).replacementJobId,a.replacementJobId);
    assert.equal((await db.query('SELECT * FROM sre_job_retries')).length,1);
    assert.equal((await db.query("SELECT status FROM sre_outbox WHERE id='unknown-delivery'"))[0].status,'unknown');
    assert.equal((await db.query("SELECT status FROM sre_rollbacks WHERE id='unknown-rollback'"))[0].status,'unknown');
  } finally {await worker.close();await db.close();}
});

test('retry rejects changed requests, foreign scopes and live/done attempts without resetting them',async()=>{
  const f=await fixture(),{store,request}=f;
  try {
    await assert.rejects(()=>store.retryInvestigation({...request,serviceKey:'other'}),error=>error.status===404);
    await assert.rejects(()=>store.retryInvestigation({...request,incidentId:'inc_other'}),error=>error.status===404);
    const accepted=await store.retryInvestigation(request);
    await assert.rejects(()=>store.retryInvestigation({...request,reason:'Changed reason'}),error=>error.status===409);
    await assert.rejects(()=>store.retryInvestigation({...request,requestId:'second-request'}),error=>error.status===409);
    const next={...request,requestId:'next-request',jobId:accepted.replacementJobId};
    await assert.rejects(()=>store.retryInvestigation(next),error=>error.status===409);
    const claimed=await store.claim('fixture-running');
    await assert.rejects(()=>store.retryInvestigation(next),error=>error.status===409);
    await store.finish(claimed,{summary:'Fixture complete',text:'Fixture complete'});
    await assert.rejects(()=>store.retryInvestigation(next),error=>error.status===409);
    assert.equal((await store.db.query('SELECT * FROM sre_job_retries')).length,1);
  } finally {await store.db.close();}
});

test('retry of telemetry work remains an explicit operator request and cannot be coalesced away',async()=>{
  const f=await fixture('sqlite',{question:false});
  try {
    const accepted=await f.store.retryInvestigation(f.request);
    await f.store.ingest({id:'later-telemetry',source:'logs',serviceKey:f.service.key,kind:'log',at:f.store.clock(),payload:{message:'New read-only evidence'}});
    const job=await f.store.claim('operator-retry');
    assert.equal(job.id,accepted.replacementJobId);assert.ok(job.payload.question);
    assert.equal((await f.store.db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'running');
  } finally {await f.db.close();}
});

test('a replacement that exhausts retries needs a separate operator request and retains the chain',async()=>{
  const f=await fixture();
  try {
    const first=await f.store.retryInvestigation(f.request);
    const failed=await exhaust(f.store);assert.equal(failed.id,first.replacementJobId);
    const next=await f.store.retryInvestigation({...f.request,jobId:failed.id,requestId:'new-operator-decision',reason:'A second independent access repair was verified.'});
    assert.notEqual(next.replacementJobId,first.replacementJobId);
    assert.equal((await f.store.context(f.incidentId)).retries.length,2);
    assert.equal((await f.db.query('SELECT attempts FROM sre_jobs WHERE id=?',[first.replacementJobId]))[0].attempts,3);
  } finally {await f.db.close();}
});

test('authenticated retry ingress rolls back every write on storage failure and safely accepts redelivery',async()=>{
  const f=await fixture(),{store,config,request,db}=f;
  config.mode='connected';config.apiToken='fixture-api';
  let fail=false;
  const database={...db,transaction:fn=>db.transaction(q=>fn(async(sql,args)=>{const result=await q(sql,args);if(fail&&sql.includes('INSERT INTO sre_evidence')){fail=false;await q('SELECT * FROM deliberately_missing_retry_storage');}return result;}))};
  const runtime=await createSreRuntime({config,db:database,connectors:new Map(),autoStart:false});runtime.store.clock=store.clock;
  runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');
  const url='http://127.0.0.1:'+runtime.server.address().port+'/api/incidents/'+f.incidentId+'/jobs/'+request.jobId+'/retry';
  const body=JSON.stringify({requestId:request.requestId,reason:request.reason});
  const post=(auth=true)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer fixture-api'}:{})},body});
  try {
    assert.equal((await post(false)).status,401);
    const before=await store.context(f.incidentId);fail=true;
    const rejected=await post();assert.equal(rejected.status,503);assert.equal(rejected.headers.get('retry-after'),'5');
    const unchanged=await store.context(f.incidentId);
    assert.equal(unchanged.incident.revision,before.incident.revision);assert.equal(unchanged.jobs.length,before.jobs.length);assert.equal(unchanged.retries.length,0);assert.equal(unchanged.jobs[0].status,'dead');
    const accepted=await post();assert.equal(accepted.status,202);const receipt=await accepted.json();
    const repeated=await post();assert.equal(repeated.status,202);assert.equal((await repeated.json()).replacementJobId,receipt.replacementJobId);
    await runtime.worker.runOnce();
    assert.equal((await store.db.query('SELECT status FROM sre_jobs WHERE id=?',[receipt.replacementJobId]))[0].status,'done');
  } finally {await runtime.close();}
});

test('Teams retry requires a direct scoped instruction and saves the authenticated responder identity',async()=>{
  const f=await fixture(),runtime=await createSreRuntime({config:f.config,db:f.db,autoStart:false});runtime.store.clock=f.store.clock;
  let activityId=1001;
  const send=async(text,options={})=>{
    const sample=devActivity(text,f.service,{conversationType:'channel',replyToId:'1000',id:String(activityId++),...options});
    await runtime.router.accept(sample.activity,sample.reference);await runtime.router.processOnce();
  };
  try {
    await send('join '+f.incidentId);
    const command='retry '+f.incidentId+' '+f.job.id+' Read access was restored.';
    await send(command,{mentioned:false,userId:'alex'});
    assert.equal((await f.db.query('SELECT * FROM sre_job_retries')).length,0);
    await send(command,{userId:'alex'});
    const [audit]=await f.db.query('SELECT requested_by FROM sre_job_retries');
    assert.equal(JSON.parse(audit.requested_by).id,'alex');assert.equal(JSON.parse(audit.requested_by).kind,'teams');
    assert.ok((await runtime.store.snapshot()).outbox.some(item=>item.text.includes('Fresh investigation queued')));
  } finally {await runtime.close();}
});

for(const failureAt of ['during-action','after-action'])test('Teams command survives storage failure '+failureAt+' and resumes the same retry once',async()=>{
  const f=await fixture();let fail=false;
  const database={...f.db,transaction:fn=>f.db.transaction(q=>fn(async(sql,args)=>{
    const result=await q(sql,args);
    const target=failureAt==='during-action'?sql.includes('INSERT INTO sre_job_retries'):sql.includes("UPDATE sre_commands SET status='done'");
    if(fail&&target){fail=false;await q('SELECT * FROM deliberately_missing_teams_retry_storage');}
    return result;
  }))};
  const runtime=await createSreRuntime({config:f.config,db:database,autoStart:false});runtime.store.clock=f.store.clock;
  let activityId=2001;
  const accept=async(text)=>{
    const sample=devActivity(text,f.service,{conversationType:'channel',replyToId:'2000',id:String(activityId++),userId:'lead'});
    return runtime.router.accept(sample.activity,sample.reference);
  };
  try {
    await accept('join '+f.incidentId);await runtime.router.processOnce();
    const inbound=await accept('retry '+f.incidentId+' '+f.job.id+' Read access restored after a verified repair.');
    fail=true;await assert.rejects(()=>runtime.router.processOnce(),StorageError);
    const [leased]=await f.db.query('SELECT * FROM sre_commands WHERE id=?',[inbound.eventId]);
    assert.equal(leased.status,'running');
    assert.equal((await f.db.query('SELECT * FROM sre_outbox WHERE id=?',['command:'+inbound.eventId])).length,0,'No false failure acknowledgement may consume the command');
    const auditsBefore=await f.db.query('SELECT * FROM sre_job_retries');
    assert.equal(auditsBefore.length,failureAt==='during-action'?0:1);
    runtime.store.clock=()=>Number(leased.lease_until)+1;
    await runtime.router.processOnce();
    const [complete]=await f.db.query('SELECT status FROM sre_commands WHERE id=?',[inbound.eventId]);assert.equal(complete.status,'done');
    const audits=await f.db.query('SELECT * FROM sre_job_retries');assert.equal(audits.length,1);
    const [replacement]=await f.db.query('SELECT * FROM sre_jobs WHERE id=?',[audits[0].replacement_job_id]);assert.equal(replacement.status,'pending');assert.equal(Number(replacement.attempts),0);
    const [ack]=await f.db.query('SELECT text FROM sre_outbox WHERE id=?',['command:'+inbound.eventId]);assert.match(ack.text,/Fresh investigation queued/);
    assert.equal(await runtime.router.processOnce(),false);
  } finally {await runtime.close();}
});
