import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { seedDemo } from '../src/sre/demo.mjs';
import { Rollbacks,assessRollback } from '../src/sre/rollback.mjs';
import { postgresSql,StorageError } from '../src/sre/database.mjs';
import { hash } from '../src/sre/security.mjs';
import { proposalWorkflowRequest } from '../src/sre/workflow-contract.mjs';

async function fixture(dialect='sqlite') {
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});config.mode='connected';config.apiToken='fixture-api';config.capabilitySecret='fixture-reconciliation-capability-32';
  const service=config.services[0];service.verification={webhookSecretEnv:'VERIFY'};config.env={VERIFY:'independent-local-verifier'};
  let db;
  if(dialect==='postgres') {
    const pg=new PGlite();db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
  }
  const runtime=await createSreRuntime({config,db,autoStart:false,connectors:new Map()});
  const {incidentId}=await seedDemo(runtime.store,service);await runtime.worker.runOnce();let dispatches=0;
  const executor=new Rollbacks({store:runtime.store,services:[service],mode:'connected',connectors:new Map([[service.key,{github:{deployments:async()=>({items:(await runtime.store.context(incidentId)).deployments,complete:true})},rollback:{dispatch:async()=>({provider:'github',workflowRunId:77+dispatches++,requestId:'fixture'})}}]])});
  const principal={verified:true,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0],userId:'local-operator'};
  const proposal=await executor.propose(incidentId,principal);assert.equal(proposal.eligible,true,proposal.text);
  await executor.approve(proposal.id,proposal.text.split(' ').at(-1),principal);await executor.executeNext();
  const [row]=await runtime.store.db.query('SELECT * FROM sre_rollbacks WHERE id=?',[proposal.id]);assert.equal(row.status,'dispatched');
  const saved=JSON.parse(row.proposal),current=assessRollback(await runtime.store.context(incidentId),service).current;
  const proof={id:'verified-no-change',kind:'rollback_no_change',incidentId,rollbackRequestId:row.id,requestHash:'sha256:'+hash(proposalWorkflowRequest(saved,{approvedAt:Number(row.approved_at),expiresAt:Number(row.expires_at)})),provider:'github',runId:'77',terminal:true,deploymentStarted:false,outcome:'blocked',reason:'Guard rejected the job before deployment',environment:service.environment,sha:current.sha,artifact:current.artifact,deploymentId:current.deploymentId??current.id??'',deploymentAt:current.at,observedAt:Date.now(),evidenceUrl:'https://independent-verifier.invalid/no-change'};
  const event=payload=>({id:payload.id,source:'verification',serviceKey:service.key,kind:'rollback_result',incidentId,at:payload.observedAt,payload});
  return {config,service,runtime,executor,principal,row,proof,event,incidentId,dispatches:()=>dispatches};
}
for(const dialect of ['sqlite','postgres'])test(dialect+': signed-result storage is atomic, idempotent and permits only a newly approved action',async()=>{
  const f=await fixture(dialect),store=f.runtime.store;
  try {
    const before=(await store.snapshot()).outbox.length;
    const accepted=await store.ingest(f.event(f.proof));assert.equal(accepted.duplicate,false);
    assert.equal((await store.context(f.incidentId)).incident.status,'open');
    const [row]=await store.db.query('SELECT * FROM sre_rollbacks WHERE id=?',[f.row.id]);assert.equal(row.status,'not_executed');assert.equal(JSON.parse(row.external_ref).noChangeVerified,true);
    assert.equal((await store.snapshot()).outbox.length,before+1);
    assert.equal((await store.ingest(f.event(f.proof))).duplicate,true);assert.equal((await store.snapshot()).outbox.length,before+1);
    await assert.rejects(()=>store.ingest(f.event({...f.proof,reason:'Changed replay'})),/reused with different content/);
    assert.equal(await f.executor.executeNext(),false);assert.equal(f.dispatches(),1);
    const waiting=await f.executor.propose(f.incidentId,f.principal);assert.equal(waiting.eligible,false);assert.match(waiting.text,/current.*assessment/i);
    for(let i=0;i<20&&await f.runtime.worker.runOnce();i++);
    assert.equal((await store.context(f.incidentId)).assessmentStatus.state,'current');assert.equal(f.dispatches(),1);
    const next=await f.executor.propose(f.incidentId,f.principal);assert.equal(next.eligible,true);assert.notEqual(next.id,f.row.id);
    await f.executor.approve(next.id,next.text.split(' ').at(-1),f.principal);await f.executor.executeNext();assert.equal(f.dispatches(),2);
    assert.equal((await store.db.query('SELECT status FROM sre_rollbacks WHERE id=?',[f.row.id]))[0].status,'not_executed');
  } finally{await f.runtime.close();}
});
for(const dialect of ['sqlite','postgres'])test(dialect+': storage failure after a no-change state write rolls back inbox, status and notification together',async()=>{
  const f=await fixture(dialect),store=f.runtime.store,transaction=store.db.transaction.bind(store.db);
  try {
    const before=await store.snapshot();
    store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{
      const rows=await q(sql,args);if(sql.startsWith("UPDATE sre_rollbacks SET status='not_executed'"))throw new StorageError(new Error('Injected result-store outage'));return rows;
    }));
    await assert.rejects(()=>store.ingest(f.event(f.proof)),StorageError);
    store.db.transaction=transaction;
    assert.equal((await store.db.query('SELECT status FROM sre_rollbacks WHERE id=?',[f.row.id]))[0].status,'dispatched');
    assert.equal((await store.snapshot()).outbox.length,before.outbox.length);
    assert.equal(Number((await store.db.query("SELECT COUNT(*) AS count FROM sre_events WHERE external_id=?",[f.proof.id]))[0].count),0);
    await store.ingest(f.event(f.proof));assert.equal((await store.db.query('SELECT status FROM sre_rollbacks WHERE id=?',[f.row.id]))[0].status,'not_executed');
  } finally{store.db.transaction=transaction;await f.runtime.close();}
});
test('invalid no-change outcomes leave the submitted action unresolved and retain no partial event',async()=>{
  const f=await fixture(),store=f.runtime.store;
  try {
    const before=(await store.snapshot()).outbox.length;
    const changes=[
      proof=>{proof.deploymentStarted=true;},proof=>{proof.terminal=false;},proof=>{proof.outcome='failed';},
      proof=>{proof.requestHash='sha256:'+'0'.repeat(64);},proof=>{proof.runId='78';},
      proof=>{proof.environment='other';},proof=>{proof.provider='gitlab';},
      proof=>{proof.rollbackRequestId='rb-unrelated';},proof=>{proof.sha='0'.repeat(40);},
      proof=>{proof.artifact='sha256:'+'0'.repeat(64);},proof=>{proof.deploymentAt++;},
      proof=>{proof.observedAt=Date.now()+1;},proof=>{proof.observedAt=Date.now()-181000;},
      proof=>{proof.evidenceUrl='http://insecure.invalid';},proof=>{proof.evidenceUrl='https://user:password@unsafe.invalid';},
      proof=>{proof.reason='';},proof=>{proof.kind='recovery';},
    ];
    for(let i=0;i<changes.length;i++){
      const proof=structuredClone(f.proof);proof.id='invalid-'+i;changes[i](proof);
      // Fix the clock so the future-dated test cannot race a millisecond tick.
      const clock=store.clock;store.clock=()=>f.proof.observedAt;
      try{await assert.rejects(()=>store.ingest(f.event(proof)));}
      finally{store.clock=clock;}
      assert.equal(Number((await store.db.query('SELECT COUNT(*) AS count FROM sre_events WHERE external_id=?',[proof.id]))[0].count),0);
      assert.equal((await store.db.query('SELECT status FROM sre_rollbacks WHERE id=?',[f.row.id]))[0].status,'dispatched');
    }
    assert.equal((await store.snapshot()).outbox.length,before);assert.equal((await store.context(f.incidentId)).incident.status,'open');
    await assert.rejects(()=>store.ingest({...f.event(f.proof),source:'teams'}),/independent/);
    await assert.rejects(()=>store.ingest({...f.event(f.proof),incidentId:undefined}),/explicit incident/);
  } finally{await f.runtime.close();}
});
test('repository changes and pending action records cannot be reconciled by an old no-change proof',async()=>{
  const f=await fixture(),store=f.runtime.store;
  try {
    const repository=f.service.github.repository;f.service.github.repository='other/auction';
    await assert.rejects(()=>store.ingest(f.event(f.proof)),/mapping changed/);f.service.github.repository=repository;
    await store.db.query("UPDATE sre_rollbacks SET status='pending' WHERE id=?",[f.row.id]);
    await assert.rejects(()=>store.ingest(f.event(f.proof)),/submitted or uncertain/);
  } finally{await f.runtime.close();}
});
test('an uncertain submission without a run receipt requires a bound independent outcome instead of another dispatch',async()=>{
  const f=await fixture(),store=f.runtime.store;
  try {
    await store.db.query("UPDATE sre_rollbacks SET status='unknown',external_ref=NULL WHERE id=?",[f.row.id]);
    assert.equal(await f.executor.executeNext(),false);assert.equal(f.dispatches(),1);
    await store.ingest(f.event(f.proof));const [row]=await store.db.query('SELECT status,external_ref FROM sre_rollbacks WHERE id=?',[f.row.id]);
    assert.equal(row.status,'not_executed');assert.equal(JSON.parse(row.external_ref).workflowRunId,'77');assert.equal(f.dispatches(),1);
    assert.equal((await store.context(f.incidentId)).incident.status,'open');
  } finally{await f.runtime.close();}
});
test('HTTP no-change callback requires the independent HMAC and cannot turn a chat statement into authorization',async()=>{
  const f=await fixture(),server=f.runtime.server;
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const body=JSON.stringify(f.proof),timestamp=String(Date.now()),url='http://127.0.0.1:'+server.address().port+'/webhooks/verification/'+f.service.key;
    const send=secret=>fetch(url,{method:'POST',headers:{'x-sre-timestamp':timestamp,'x-sre-signature':'sha256='+createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex')},body});
    assert.equal((await send('untrusted-chat-author')).status,401);
    assert.equal((await f.runtime.store.snapshot()).rollbacks[0].status,'dispatched');
    assert.equal((await send(f.config.env.VERIFY)).status,202);
    assert.equal((await send(f.config.env.VERIFY)).status,202);
    assert.equal((await f.runtime.store.snapshot()).rollbacks[0].status,'not_executed');assert.equal((await f.runtime.store.context(f.incidentId)).incident.status,'open');
  } finally{await f.runtime.close();}
});
