import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {normalize} from '../src/sre/normalize.mjs';
import {hash} from '../src/sre/security.mjs';
import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';

for(const dialect of ['sqlite','postgres'])test(dialect+': explicitly correlated read-only ServiceNow tickets reuse a detected log incident and retain independent lifecycles',async()=>{
  const config=validateConfig(rehearsalProfile(),{}),service=config.services[0],at=Date.now()-10000;
  service.servicenow.correlateLogMonitors=true;
  const pg=dialect==='postgres'?new PGlite():null;
  const db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:sqliteDatabase(':memory:');
  const store=await new SreStore(db,{services:config.services}).initialize();
  const issueKey='log-monitor:rehearsal-bid-order:'+hash({environment:service.environment,region:'eu-west-1',version:'a'.repeat(40)});
  const ticket=(id,state,when)=>normalize('servicenow',{sys_id:id.repeat(32),number:'INC-FIXTURE',cmdb_ci:service.servicenow.cmdbCi,correlation_id:issueKey,state,sys_created_on:new Date(at-1000).toISOString(),sys_updated_on:new Date(when).toISOString()},service);
  try{
    const result=await store.ingest({id:'detected',source:'log-monitor',serviceKey:service.key,kind:'problem',issueKey,status:'OPEN',at,startedAt:at,payload:{}});
    const original=(await store.context(result.incidentId)).session.agent_id;
    assert.equal((await store.ingest(ticket('a','2',at+1000))).incidentId,result.incidentId);
    assert.equal((await store.ingest(ticket('b','2',at+2000))).incidentId,result.incidentId);
    await store.ingest(ticket('a','6',at+3000));
    let c=await store.context(result.incidentId),states=JSON.parse(c.incident.source_states);
    assert.equal((await store.snapshot()).incidents.length,1);assert.equal(c.session.agent_id,original);assert.equal(c.incident.status,'open');
    assert.equal(states['servicenow:'+'a'.repeat(32)].status,'CLOSED');assert.equal(states['servicenow:'+'b'.repeat(32)].status,'OPEN');
    const reopened=await new SreStore(db,{services:config.services}).initialize();await reopened.ingest(ticket('b','6',at+4000));c=await reopened.context(result.incidentId);
    assert.equal(c.incident.status,'open','Closing tickets must not close the observed log source');assert.equal(c.session.agent_id,original);
    assert.equal((await reopened.ingest(ticket('b','2',at+3500))).stale,true);
  }finally{await db.close();}
});

test('log correlation requires an explicit configured monitor and exact key; a CI mismatch is rejected',()=>{
  const config=validateConfig(rehearsalProfile(),{}),service=config.services[0],at=new Date().toISOString(),key='log-monitor:rehearsal-bid-order:'+'a'.repeat(64);
  const payload={sys_id:'b'.repeat(32),cmdb_ci:service.servicenow.cmdbCi,correlation_id:key,state:'2',sys_created_on:at,sys_updated_on:at};
  service.servicenow.correlateLogMonitors=false;assert.equal(normalize('servicenow',payload,service).issueKey,'servicenow:'+payload.sys_id);
  service.servicenow.correlateLogMonitors=true;assert.equal(normalize('servicenow',payload,service).issueKey,key);
  for(const correlation_id of ['log-monitor:unknown:'+'a'.repeat(64),key+'suffix','log-monitor:rehearsal-bid-order:'+('a'.repeat(63)),key.replace(/a{64}$/,'A'.repeat(64))])assert.equal(normalize('servicenow',{...payload,correlation_id},service).issueKey,'servicenow:'+payload.sys_id);
  assert.throws(()=>normalize('servicenow',{...payload,cmdb_ci:'c'.repeat(32)},service),/outside/);
  assert.throws(()=>validateConfig({...rehearsalProfile(),services:[{...service,servicenow:{...service.servicenow,correlateLogMonitors:'true'}}]},{}),/correlateLogMonitors/);
});
