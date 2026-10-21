import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { sqliteDatabase,postgresSql } from '../src/sre/database.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { normalize } from '../src/sre/normalize.mjs';

async function fixture(dialect='sqlite') {
  const service=loadConfig({}).services[0],now=Date.now(),startedAt=now-20000;
  let db;
  if(dialect==='sqlite')db=sqliteDatabase(':memory:');
  else {
    const pg=new PGlite();
    db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
  }
  const options={services:[service],clock:()=>now},store=await new SreStore(db,options).initialize();
  const dt=(id,status,at)=>({id,source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'dynatrace:P-CORRELATED',startedAt,status,at,payload:{}});
  const snow=(id,ticket,status,at)=>normalize('servicenow',{sys_id:ticket.repeat(32),cmdb_ci:service.servicenow.cmdbCi,correlation_id:'dynatrace:P-CORRELATED',state:status==='OPEN'?'2':'6',sys_created_on:new Date(startedAt).toISOString(),sys_updated_on:new Date(at).toISOString()},service,{deliveryId:id});
  return {db,store,service,options,now,startedAt,dt,snow};
}

for(const dialect of ['sqlite','postgres'])test(dialect+': correlated ServiceNow records close independently and gate recovery',async()=>{
  const f=await fixture(dialect),{store,service,startedAt:t,now,snow,dt}=f;
  try {
    const {incidentId}=await store.ingest(dt('problem','OPEN',t));
    await store.ingest(snow('b-open','b','OPEN',t+500));
    await store.ingest(snow('b-closed','b','CLOSED',t+3000));
    // This ticket arrives later, with a timestamp older than the other ticket's close.
    await store.ingest(snow('a-open','a','OPEN',t+1000));
    await store.ingest(dt('problem-closed','CLOSED',t+4000));
    let context=await store.context(incidentId),states=JSON.parse(context.incident.source_states);
    assert.equal(context.incident.status,'open');
    assert.equal(states['servicenow:'+('a'.repeat(32))].status,'OPEN');
    assert.equal(states['servicenow:'+('b'.repeat(32))].status,'CLOSED');
    assert.equal(states.servicenow,undefined);
    const deployment={provider:'github',environment:service.environment,status:'success',sha:'a'.repeat(40),artifact:'sha256:'+'b'.repeat(64)};
    await store.ingest({id:'deployment',source:'releases',serviceKey:service.key,kind:'deployment',at:t-1000,payload:deployment});
    const proof={id:'proof',source:'verification',serviceKey:service.key,kind:'verification',incidentId,at:now,payload:{...deployment,incidentId,deploymentAt:t-1000,observedAt:now,healthy:true,checks:{technical:true,businessInvariants:true},evidenceUrl:'https://verifier.invalid/correlated'}};
    await assert.rejects(()=>store.ingest(proof),/all incident sources/);
    const session=context.session.agent_id;
    const reopened=await new SreStore(f.db,f.options).initialize();
    assert.equal((await reopened.context(incidentId)).session.agent_id,session);
    await reopened.ingest(snow('a-closed','a','CLOSED',t+5000));
    const delayed=snow('a-delayed-open','a','OPEN',t+4500);
    assert.equal((await reopened.ingest(delayed)).stale,true);
    assert.equal((await reopened.ingest(delayed)).incidentId,incidentId,'Duplicate stale deliveries retain their incident identity');
    assert.equal((await reopened.context(incidentId)).incident.status,'verifying');
    await reopened.ingest(proof);
    assert.equal((await reopened.context(incidentId)).incident.status,'resolved');
    const before=(await store.snapshot()).counts;
    await assert.rejects(()=>store.ingest({...snow('missing-native-id','a','OPEN',now),payload:{}}),/native sys_id/);
    assert.deepEqual((await store.snapshot()).counts,before,'Malformed identity must roll back the entire ingress transaction');
  } finally {await f.db.close();}
});

for(const dialect of ['sqlite','postgres'])test(dialect+': startup restores legacy ticket states from accepted and delayed audit events',async()=>{
  const f=await fixture(dialect),{store,startedAt:t,snow,dt}=f;
  try {
    const {incidentId}=await store.ingest(dt('problem','OPEN',t));
    await store.ingest(snow('b-open','b','OPEN',t+2000));
    await store.ingest(snow('b-closed','b','CLOSED',t+3000));
    const hidden=snow('a-delayed','a','OPEN',t+1000);hidden.startedAt=t-86400000;hidden.payload.sys_created_on=new Date(hidden.startedAt).toISOString();
    const delayed=await store.ingest(hidden);
    await store.ingest(dt('problem-closed','CLOSED',t+4000));
    const original=await store.context(incidentId);
    const legacy={dynatrace:{at:t+4000,status:'CLOSED'},servicenow:{at:t+3000,status:'CLOSED'}};
    // Older versions left stale deliveries unlinked and could consider this closed.
    await f.db.query('UPDATE sre_events SET incident_id=NULL WHERE id=?',[delayed.eventId]);
    await f.db.query("UPDATE sre_incidents SET source_states=?,started_at=?,status='resolved',analysis=? WHERE id=?",[JSON.stringify(legacy),t,JSON.stringify({summary:'Old aggregate said recovered'}),incidentId]);
    const restarted=await new SreStore(f.db,f.options).initialize();
    const context=await restarted.context(incidentId),states=JSON.parse(context.incident.source_states);
    assert.equal(context.incident.status,'open');assert.equal(context.incident.analysis,null);
    assert.equal(context.incident.started_at,hidden.startedAt,'Recovered source age must not imply a recent regression');
    assert.equal(context.session.agent_id,original.session.agent_id);
    assert.equal(states['servicenow:'+('a'.repeat(32))].status,'OPEN');
    assert.equal(states['servicenow:'+('b'.repeat(32))].status,'CLOSED');
    assert.equal(context.evidence.filter(item=>item.kind==='source_identity_upgrade').length,1);
    const jobs=(await restarted.snapshot()).jobs.length,revision=context.incident.revision;
    await restarted.initialize();
    assert.equal((await restarted.snapshot()).jobs.length,jobs);
    assert.equal((await restarted.context(incidentId)).incident.revision,revision);
    await restarted.ingest(snow('a-final-close','a','CLOSED',t+5000));
    assert.equal((await restarted.context(incidentId)).incident.status,'verifying');
  } finally {await f.db.close();}
});

for(const variant of ['missing','unnamed'])test('legacy source upgrade refuses '+variant+' audit without dropping its state',async()=>{
  const f=await fixture(),{store,startedAt:t,dt}=f;
  try {
    const {incidentId}=await store.ingest(dt('problem','OPEN',t));
    const legacy={dynatrace:{at:t,status:'OPEN'},servicenow:{at:t+1,status:'CLOSED'}};
    await f.db.query('UPDATE sre_incidents SET source_states=? WHERE id=?',[JSON.stringify(legacy),incidentId]);
    if(variant==='unnamed') {
      const event={...dt('old-snow','CLOSED',t+1),source:'servicenow'};
      await f.db.query('INSERT INTO sre_events(id,source,service_key,external_id,kind,occurred_at,received_at,body_hash,incident_id,payload) VALUES(?,?,?,?,?,?,?,?,?,?)',['old-snow','servicenow',f.service.key,'old-snow','problem',t+1,t+1,'legacy',incidentId,JSON.stringify(event)]);
    }
    await assert.rejects(()=>store.initialize(),variant==='missing'?/durable source audit/:/native sys_id/);
    assert.deepEqual(JSON.parse((await store.context(incidentId)).incident.source_states),legacy);
  } finally {await f.db.close();}
});
