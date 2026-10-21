import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { sqliteDatabase,postgresSql,StorageError } from '../src/sre/database.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { seedDemo,devActivity } from '../src/sre/demo.mjs';
import { prepareRestore,releaseRestore } from '../src/sre/restore-recovery.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';

async function fixture(dialect='sqlite') {
  let db;
  if(dialect==='sqlite')db=sqliteDatabase(':memory:');
  else {const pg=new PGlite();db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});config.mode='connected';config.apiToken='synthetic';config.env={};
  let runtime,writes=0;const delivered=[];
  // Return stable provider records, excluding this store's projection metadata.
  // Feeding recordId back as provider data would invent a new event every read.
  const clients={github:{deployments:async()=>({items:(await runtime.store.context(incidentId)).deployments.map(({recordId,source,...record})=>record),complete:true})},rollback:{dispatch:async proposal=>{writes++;return {requestId:proposal.id};}}};
  runtime=await createSreRuntime({config,db,autoStart:false,connectors:new Map([[config.services[0].key,clients]]),sender:{send:async(reference,text)=>{delivered.push(text);return {id:'synthetic'};}}});
  const service=config.services[0],{incidentId}=await seedDemo(runtime.store,service);
  for(let i=0;i<8&&await runtime.worker.runOnce();i++);
  const principal={verified:true,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0],userId:'local-operator'};
  const proposal=await runtime.rollbacks.propose(incidentId,principal);assert.equal(proposal.eligible,true);await runtime.rollbacks.approve(proposal.id,proposal.text.split(' ').at(-1),principal);
  await db.query('DELETE FROM sre_outbox');
  const message=devActivity('incidents',service,{serviceUrl:'https://teams-fixture.invalid'});await runtime.router.accept(message.activity,message.reference);
  await runtime.store.queueMessage(incidentId,'A notice that may already have been delivered',null,'snapshot-notice');
  await runtime.store.ingest({id:'question',source:'operator-api',serviceKey:service.key,kind:'question',incidentId,at:Date.now(),payload:{text:'Retain this investigation across a restore.'}});
  await runtime.store.release(runtime.worker.owner);
  const job=await runtime.store.claim('before-backup');assert.ok(job);
  await runtime.store.setRemoteState(incidentId,{sessionId:'stale-remote-cursor',streamIndex:1},job);
  const input={restoreId:'restore-1',backupSha256:'a'.repeat(64),backupAt:Date.now()-1000,reason:'Restore a consistent snapshot and reconcile its lost interval',actor:{kind:'local-operator',id:'synthetic recovery operator'},offline:true};
  return {runtime,db,store:runtime.store,service,incidentId,proposal,principal,job,input,delivered,writes:()=>writes,close:()=>runtime.close()};
}

for(const dialect of ['sqlite','postgres'])test(dialect+': restored uncertainty survives restart/attestation and only fresh instructions can produce new work',async()=>{
  const f=await fixture(dialect);
  try {
    const before=await f.store.context(f.incidentId),prepared=await prepareRestore(f.store,f.input);
    assert.equal(prepared.active,true);assert.deepEqual(prepared.counts,{deliveries:1,rollbacks:1,commands:1,runningInvestigations:1});
    assert.equal((await prepareRestore(f.store,f.input)).duplicate,true);
    await assert.rejects(()=>prepareRestore(f.store,{...f.input,reason:'different content'}),/reused/);
    assert.equal((await f.db.query('SELECT status FROM sre_rollbacks WHERE id=?',[f.proposal.id]))[0].status,'unknown');
    assert.equal((await f.db.query("SELECT status FROM sre_outbox WHERE id='snapshot-notice'"))[0].status,'unknown');
    assert.equal((await f.db.query('SELECT status FROM sre_commands'))[0].status,'discarded');
    assert.equal((await f.db.query('SELECT status FROM sre_jobs WHERE id=?',[f.job.id]))[0].status,'pending');
    const context=await f.store.context(f.incidentId);assert.equal(context.session.agent_id,before.session.agent_id);assert.deepEqual(context.session.remote_state,{});assert.equal(context.incident.analysis,null);
    assert.equal(await f.runtime.rollbacks.executeNext(),false);assert.equal(await f.runtime.outbox.runOnce(),false);assert.equal(await f.runtime.router.processOnce(),false);
    await assert.rejects(()=>f.runtime.rollbacks.approve(f.proposal.id,f.proposal.text.split(' ').at(-1),f.principal),/holding approvals/);
    assert.equal((await f.runtime.rollbacks.propose(f.incidentId,f.principal)).eligible,false);
    assert.ok((await f.runtime.operations.snapshot()).conditions.some(item=>item.code==='database_restore_hold'));
    // Restored questions and reconciliation reads share the fair ready queue.
    // Drain all read-only work while its outbound intents remain held.
    for(let i=0;i<20&&await f.runtime.worker.runOnce();i++);
    assert.equal((await f.db.query('SELECT status FROM sre_jobs WHERE id=?',[f.job.id]))[0].status,'done');
    assert.equal((await f.db.query("SELECT id FROM sre_jobs WHERE status IN ('pending','running')")).length,0);
    assert.ok((await f.db.query("SELECT id FROM sre_outbox WHERE status='held_restore'")).length>0);
    assert.equal(f.writes(),0);assert.equal(f.delivered.length,0);
    const attestation={restoreId:f.input.restoreId,requestId:'release-1',reason:'External records reviewed; lost facts remain explicit',actor:f.input.actor,observedAt:Date.now(),evidenceUrls:['https://synthetic-verifier.invalid/recovery/1']};
    const released=await releaseRestore(f.store,attestation);assert.equal(released.active,false);assert.equal(released.release.healthVerified,false);assert.equal((await releaseRestore(f.store,attestation)).duplicate,true);
    assert.equal((await prepareRestore(f.store,f.input)).active,false,'Receipt replay must not reapply a completed preparation');
    assert.equal(await f.runtime.rollbacks.executeNext(),false);assert.equal(await f.runtime.outbox.runOnce(),false);assert.equal(f.writes(),0);assert.equal(f.delivered.length,0);
    const fresh=devActivity('incidents',f.service,{serviceUrl:'https://teams-fixture.invalid'});await f.runtime.router.accept(fresh.activity,fresh.reference);assert.equal(await f.runtime.router.processOnce(),true);
    assert.equal(await f.runtime.outbox.runOnce(),true);assert.equal(f.delivered.length,1);assert.ok(!f.delivered[0].includes('may already have been delivered'));
    assert.equal((await f.db.query('SELECT status FROM sre_rollbacks WHERE id=?',[f.proposal.id]))[0].status,'unknown');
    assert.equal((await f.store.context(f.incidentId)).incident.status,'open');
  } finally {await f.close();}
});

for(const dialect of ['sqlite','postgres'])test(dialect+': failed restore preparation rolls back every quarantine and can be redelivered',async()=>{
  const f=await fixture(dialect),transaction=f.db.transaction.bind(f.db);let armed=true;
  f.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const result=await q(sql,args);if(armed&&sql.startsWith('UPDATE sre_rollbacks'))throw new StorageError(new Error('Synthetic interrupted recovery transaction'));return result;}));
  try {
    await assert.rejects(()=>prepareRestore(f.store,f.input),error=>error instanceof StorageError);
    assert.equal(await f.store.restoreFence(),null);
    assert.equal((await f.db.query('SELECT status FROM sre_rollbacks WHERE id=?',[f.proposal.id]))[0].status,'approved');
    assert.equal((await f.db.query("SELECT status FROM sre_outbox WHERE id='snapshot-notice'"))[0].status,'pending');
    assert.equal((await f.db.query('SELECT status FROM sre_jobs WHERE id=?',[f.job.id]))[0].status,'running');
    assert.equal((await f.store.context(f.incidentId)).session.remote_state.sessionId,'stale-remote-cursor');
    armed=false;assert.equal((await prepareRestore(f.store,f.input)).active,true);
  } finally {await f.close();}
});

test('restore/release metadata cannot silently lift a hold or replace another recovery generation',async()=>{
  const f=await fixture();
  try {
    for(const changed of [{offline:false},{backupSha256:'invalid'},{backupAt:Date.now()+60000},{actor:{kind:'teams',id:'untrusted'}},{restoreId:'../invalid'}])await assert.rejects(()=>prepareRestore(f.store,{...f.input,...changed}));
    assert.equal(await f.store.restoreFence(),null);await prepareRestore(f.store,f.input);
    await assert.rejects(()=>prepareRestore(f.store,{...f.input,restoreId:'another-restore'}),/still held/);
    const release={restoreId:f.input.restoreId,requestId:'release-1',reason:'Reviewed',actor:f.input.actor,observedAt:Date.now(),evidenceUrls:['https://synthetic-verifier.invalid/review']};
    for(const changed of [{restoreId:'wrong'},{observedAt:Date.now()+60000},{observedAt:Date.now()-600001},{evidenceUrls:[]},{evidenceUrls:['http://insecure.invalid']},{evidenceUrls:['https://user:password@unsafe.invalid']},{actor:{kind:'teams',id:'untrusted'}}])await assert.rejects(()=>releaseRestore(f.store,{...release,...changed}));
    assert.equal((await f.store.restoreFence()).active,true);
    await releaseRestore(f.store,release);await assert.rejects(()=>releaseRestore(f.store,{...release,reason:'Changed attestation'}),/different release/);
  } finally {await f.close();}
});

test('restore hold blocks model work and health proofs; a malformed fence fails closed',async()=>{
  const f=await fixture();
  try {
    await prepareRestore(f.store,f.input);f.runtime.worker.restoreReadOnly=false;
    assert.equal(await f.runtime.worker.runOnce(),false);
    const now=Date.now();await assert.rejects(()=>f.store.ingest({id:'health-under-hold',source:'verification',kind:'verification',serviceKey:f.service.key,incidentId:f.incidentId,at:now,payload:{observedAt:now}}),/holding recovery verification/);
    assert.equal(Number((await f.db.query("SELECT COUNT(*) AS count FROM sre_events WHERE external_id='health-under-hold'"))[0].count),0);
    await f.db.query("UPDATE sre_checkpoints SET value='{}' WHERE id='recovery:database-restore'");
    await assert.rejects(()=>f.runtime.rollbacks.executeNext(),error=>error instanceof StorageError);
    await assert.rejects(()=>f.runtime.outbox.runOnce(),error=>error instanceof StorageError);
  } finally {await f.close();}
});

test('local restore CLI requires an explicit database, hashes the archive and records an operator attestation',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'restore-cli-')),database=join(directory,'restored.sqlite'),archive=join(directory,'archive.bin'),attestation=join(directory,'release.json');
  const script=resolve('scripts/sre-restore.mjs'),env={PATH:process.env.PATH,LANG:'C',SRE_CONFIG:resolve('config/sre.local.json')};
  const run=(args,extra={})=>spawnSync(process.execPath,[script,...args],{cwd:directory,env:{...env,...extra},encoding:'utf8'});
  try {
    assert.notEqual(run(['status']).status,0);
    writeFileSync(archive,'Synthetic CLI hashing input; the native exercise uses an actual PostgreSQL archive.');
    const prepared=run(['prepare','--offline-restored-database','--archive',archive,'--restore-id','cli-restore','--backup-at',new Date(Date.now()-1000).toISOString(),'--reason','Reviewed local fixture restoration'],{SRE_SQLITE_PATH:database});
    assert.equal(prepared.status,0,prepared.stderr);const record=JSON.parse(prepared.stdout);
    assert.equal(record.active,true);assert.equal(record.backupSha256,createHash('sha256').update('Synthetic CLI hashing input; the native exercise uses an actual PostgreSQL archive.').digest('hex'));
    writeFileSync(attestation,JSON.stringify({restoreId:'cli-restore',requestId:'cli-release',reason:'External fixture records reviewed',observedAt:Date.now(),evidenceUrls:['https://synthetic-verifier.invalid/cli']}));
    const released=run(['release','--attestation',attestation],{SRE_SQLITE_PATH:database});assert.equal(released.status,0,released.stderr);
    assert.equal(JSON.parse(released.stdout).release.authority,'local_operator_attestation');assert.equal(JSON.parse(released.stdout).release.healthVerified,false);
    assert.equal(JSON.parse(run(['status'],{SRE_SQLITE_PATH:database}).stdout).active,false);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
