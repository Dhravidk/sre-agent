import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {assertRequestBatch,questionBatchLimits,requestBatchBytes} from '../src/sre/question-batch-budget.mjs';
import {IncidentWorker} from '../src/sre/worker.mjs';
import {RulesReasoner} from '../src/sre/reasoner.mjs';

test('question batch bounds distinguish count, individual characters and serialized UTF-8 bytes',()=>{
  const requests=Array.from({length:32},(_,n)=>({jobId:'job-'+n,question:'Explain this incident',conversationKey:'room-'+n}));
  assert.doesNotThrow(()=>assertRequestBatch(requests));assert.throws(()=>assertRequestBatch([...requests,requests[0]]),/bounded/);
  assert.throws(()=>assertRequestBatch([{jobId:'job',question:'x'.repeat(4001)}]),/bounded/);
  const multibyte=requests.slice(0,12).map(r=>({...r,question:'界'.repeat(1000)}));assert.ok(requestBatchBytes(multibyte)>32768);assert.throws(()=>assertRequestBatch(multibyte),/bounded/);
  assert.doesNotThrow(()=>assertRequestBatch(multibyte.slice(0,8)));assert.throws(()=>assertRequestBatch([null]),/bounded/);
  const legacy=requests.slice(0,8).map(r=>({...r,question:'\ud800'.repeat(4000)}));assert.throws(()=>assertRequestBatch(legacy),/bounded/);assert.doesNotThrow(()=>assertRequestBatch(legacy,1));assert.throws(()=>assertRequestBatch(requests.slice(0,9),1),/bounded/);assert.throws(()=>assertRequestBatch(requests,99),/bounded/);
  for(const value of [0,33,1.5,'32'])assert.throws(()=>new SreStore({}, {questionBatchLimit:value}),/batch limit/);
});
for(const dialect of ['sqlite','postgres'])test(dialect+': a persisted legacy eight-question batch survives upgrade without splitting its retry payload',async()=>{
  const db=await database(dialect),service={key:'legacy',environment:'test',teams:{tenantId:'test',conversations:[],collaborationGroups:[]},rollback:{enabled:false}},store=await new SreStore(db,{services:[service],questionBatchLimit:32}).initialize(),rules=new RulesReasoner();let observed;
  const worker=new IncidentWorker({store,services:[service],connectors:new Map(),reasoner:{mode:'claude',investigate:async(c,options)=>{observed=options;assert.equal(options.requestBatchVersion,1);assertRequestBatch(options.requests,options.requestBatchVersion);const result=await rules.investigate(c);result.analysis.mode='claude';result.analysis.teamsMessages=[];return result;}}});
  try{
    const {incidentId}=await store.ingest({id:'legacy',source:'evaluation',serviceKey:service.key,kind:'problem',issueKey:'legacy',status:'OPEN',at:Date.now(),payload:{}});
    for(let n=0;n<8;n++)await store.ingest({id:'q-'+n,source:'operator-api',serviceKey:service.key,incidentId,kind:'question',at:Date.now(),payload:{text:'界'.repeat(4000)}});
    const rows=await db.query("SELECT id,payload FROM sre_jobs WHERE incident_id=? AND payload LIKE ? ORDER BY id",[incidentId,'%界%']),requests=rows.map(r=>({jobId:r.id,question:JSON.parse(r.payload).question,conversationKey:null})),parent=rows[0];assert.equal(rows.length,8);assert.ok(requestBatchBytes(requests)>32768);
    await db.query('UPDATE sre_jobs SET payload=?,next_at=0 WHERE id=?',[JSON.stringify({...JSON.parse(parent.payload),requests}),parent.id]);for(const child of rows.slice(1))await db.query("UPDATE sre_jobs SET status='superseded' WHERE id=?",[child.id]);
    assert.equal(await worker.runOnce(),true,JSON.stringify(await db.query('SELECT status,error FROM sre_jobs WHERE id=?',[parent.id])));assert.deepEqual(observed.requests,requests);const saved=JSON.parse((await db.query('SELECT payload FROM sre_jobs WHERE id=?',[parent.id]))[0].payload);assert.deepEqual(saved.requests,requests);assert.equal(saved.requestBatchVersion,undefined);assert.equal((await store.context(incidentId)).assessmentStatus.state,'current');
  }finally{await worker.close();await db.close();}
});
async function database(dialect){if(dialect==='sqlite')return sqliteDatabase(':memory:');const pg=new PGlite();return{dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
for(const dialect of ['sqlite','postgres'])for(const long of [false,true])test(dialect+': '+(long?'large UTF-8 questions wait without loss, retaining their exact retry batch':'32 short room questions share one publication and each get a reply'),async()=>{
  const rooms=Array.from({length:32},(_,n)=>'room-'+n),service={key:'batch',environment:'test',teams:{tenantId:'test',maxIncidentConversations:32,conversations:rooms,collaborationGroups:[{key:'shared',name:'Synthetic group',conversations:rooms.map(id=>({id,name:id}))}]}},db=await database(dialect),options={services:[service],questionBatchLimit:32};let store=await new SreStore(db,options).initialize(),now=Date.now();store.coordinationNow=async()=>now;
  try{
    const {incidentId}=await store.ingest({id:'problem',source:'evaluation',serviceKey:'batch',kind:'problem',issueKey:'problem',status:'OPEN',at:now,payload:{}});
    const keys=[];for(const room of rooms){const key=await store.rememberConversation({tenant:'test',serviceKey:'batch',reference:{serviceUrl:'https://delivery.invalid',conversation:{id:room}}});await store.bindConversation(key,incidentId);keys.push(key);}
    for(const [n,conversationKey]of keys.entries()){now++;const event={id:'q-'+n,source:'operator-api',serviceKey:'batch',incidentId,kind:'question',at:now,conversationKey,payload:{text:long?'界'.repeat(4000):'Explain the supported code mechanism and recovery strategy '+n}};await store.ingest(event);assert.equal((await store.ingest(event)).duplicate,true);}
    let parents=0;const answered=new Set();
    for(;;){let job=await store.claim('batch');if(!job)break;const batch=job.payload.requests;
      assert.equal(job.payload.requestBatchVersion,2);assert.ok(batch.length<=(long?2:32));assert.ok(requestBatchBytes(batch)<=questionBatchLimits.bytes);assert.doesNotThrow(()=>assertRequestBatch(batch));
      if(long&&parents===0){await store.fail(job,Error('Transient fixture failure'));await db.query('UPDATE sre_jobs SET next_at=0 WHERE id=?',[job.id]);job=await store.claim('batch');assert.deepEqual(job.payload.requests,batch);}
      for(const request of batch){assert.ok(!answered.has(request.jobId));answered.add(request.jobId);}
      await store.finish(job,{mode:'claude',summary:'Synthetic batch test',text:'Recorded assessment reply',teamsMessages:[]},null,Number((await store.context(incidentId)).incident.revision));parents++;
    }
    assert.equal(answered.size,32);assert.equal(parents,long?16:1);const outbox=await db.query('SELECT id,conversation_key,text,status FROM sre_outbox ORDER BY id');assert.equal(outbox.length,32);assert.equal(new Set(outbox.map(o=>o.conversation_key)).size,32);
    store=await new SreStore(db,options).initialize();assert.equal(await store.claim('restart'),null);assert.deepEqual(await db.query('SELECT id,conversation_key,text,status FROM sre_outbox ORDER BY id'),outbox);
  }finally{await db.close();}
});
