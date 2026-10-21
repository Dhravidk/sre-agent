import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {loadConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {postgresSql,StorageError} from '../src/sre/database.mjs';
import {exportDatabase,importDatabase,transferTables} from '../src/sre/database-transfer.mjs';
import {hash} from '../src/sre/security.mjs';
import {fictionalDirectory} from '../fixtures/ownership-directory.mjs';
import {normalize} from '../src/sre/normalize.mjs';

const actor={kind:'local-operator',id:'fixture database operator'};
async function runtime(dialect='sqlite',path=':memory:'){
  const config=loadConfig({SRE_SQLITE_PATH:path});let db,calls=0;
  if(dialect==='postgres'){const pg=new PGlite();db={dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const r=await createSreRuntime({config,db,autoStart:false,qaAdapter:{localOnly:true,execute:async({markdown})=>{calls++;return {status:'passed',branch:'codex/transfer-fixture',commit:'a'.repeat(40),patch:'Fixture patch',markdown,mergeRequestDraft:'Fixture MR draft',summary:'Contract fixture result'};}}});return {r,calls:()=>calls};
}
async function populated(dialect='sqlite',path=':memory:'){
  const f=await runtime(dialect,path),r=f.r,s=r.config.services[0],id=(await seedDemo(r.store,s)).incidentId;
  const sample=devActivity('join '+id,s);await r.router.accept(sample.activity,sample.reference);await r.router.processOnce();for(let i=0;i<10&&await r.worker.runOnce();i++);
  await r.casework.importDirectory(s.key,fictionalDirectory(await r.store.coordinationNow()));
  const plan=await r.casework.createPlan(id),principal={verified:true,simulation:true,tenant:s.teams.tenantId,conversationId:s.teams.conversations[0],userId:'local-operator'},key=conversationKey(principal.tenant,principal.conversationId);
  const done=await r.casework.proposeFix(id,plan.id,principal,key,'done');await r.casework.approveFix(done.id,done.nonce,principal,key);await r.casework.runOnce();
  const pending=await r.casework.proposeFix(id,plan.id,principal,key,'pending');await r.casework.approveFix(pending.id,pending.nonce,principal,key);
  const now=await r.store.coordinationNow();await r.store.deferProviderRetry('b'.repeat(64),now+180000,429);
  await r.store.ingest(normalize('gitlab',{object_kind:'merge_request',project:{id:17},object_attributes:{iid:78,state:'opened',last_commit:{id:'c'.repeat(40)},updated_at:new Date(now).toISOString(),title:'Fictional transfer MR'}},s,{deliveryId:'transfer-mr'}));
  s.logMonitors=[{id:'transfer-logs',codes:['WINNING_BID_REGRESSED'],minCount:2,windowSeconds:60}];
  await r.logDetector.observe(s,'fixture',{complete:true,records:[1,2].map(i=>({timestamp:now-10+i,level:'ERROR',environment:s.environment,region:'eu',code:'WINNING_BID_REGRESSED',message:'Fictional transfer log '+i}))});
  const command=devActivity('incidents',s);await r.router.accept(command.activity,command.reference);
  return {...f,id,plan,done,pending};
}
const options=exported=>({snapshot:exported.snapshot,expectedSha256:exported.sha256,restoreId:'transfer-v1',reason:'Move the stopped application to a reviewed empty database',offline:true,actor});
async function counts(store){const rows=await Promise.all(transferTables.map(async name=>{const [row]=await store.db.query('SELECT COUNT(*) AS count FROM '+name);return [name,Number(row.count)];}));return Object.fromEntries(rows);}

for(const [from,to]of [['sqlite','postgres'],['postgres','sqlite']])test(from+' → '+to+': full tracking graph transfers atomically with old actions held and completed QA preserved',async()=>{
  const source=await populated(from),target=await runtime(to);try{
    const link=await source.r.casework.trackChange(source.id,'gitlab',78,actor),withdrawal=await source.r.casework.withdrawChange(source.id,'gitlab',78,actor,{expectedEvidenceId:link.evidenceId,reason:'The transfer fixture keeps this MR outside the operational case'});
    const originalCounts=await counts(source.r.store),exported=await exportDatabase(source.r.store,{offline:true,actor});
    assert.deepEqual(await counts(source.r.store),originalCounts);assert.equal(exported.tables,transferTables.length);
    const result=await importDatabase(target.r.store,options(exported));assert.equal(result.held,true);assert.equal(result.counts.qaRequests,1);assert.equal(result.counts.logSamples,2);
    const original=await source.r.store.context(source.id),copied=await target.r.store.context(source.id);assert.equal(copied.session.agent_id,original.session.agent_id);assert.equal(copied.incident.revision,original.incident.revision+1);assert.equal(copied.incident.analysis,null);
    const correction=copied.changeAssociations.controls.find(c=>c.number==='78');assert.equal(correction.state,'withdrawn');assert.equal(correction.evidenceId,withdrawal.evidenceId);assert.equal(correction.historicalAfterRestore,true);assert.equal((await target.r.casework.linkChange(source.id,'gitlab',78,link.evidenceId)).suppressed,true);assert.ok(!(await target.r.casework.timeline(source.id)).links.some(l=>l.change_number==='78'));
    assert.equal((await target.r.casework.getPlan(source.plan.id,source.id)).markdown,source.plan.markdown);
    const completed=(await target.r.store.db.query('SELECT status,result FROM sre_fix_requests WHERE id=?',[source.done.id]))[0];assert.equal(completed.status,'passed');assert.equal(JSON.parse(completed.result).patch,'Fixture patch');
    assert.equal((await target.r.store.db.query('SELECT status FROM sre_fix_requests WHERE id=?',[source.pending.id]))[0].status,'unknown');assert.ok((await target.r.casework.timeline(source.id)).items.length);assert.equal((await target.r.casework.contacts(source.id)).contacts.length,0);
    assert.ok(await target.r.store.providerRetry('b'.repeat(64)));assert.equal(await target.r.casework.runOnce(),false);assert.equal(await target.r.outbox.runOnce(),false);assert.equal(await target.r.router.processOnce(),false);assert.equal(target.calls(),0);
    assert.deepEqual(await counts(source.r.store),originalCounts,'The source remains intact after cutover import');
    const beforeRetry=await counts(target.r.store);assert.equal((await importDatabase(target.r.store,options(exported))).duplicate,true);assert.deepEqual(await counts(target.r.store),beforeRetry);
    await assert.rejects(importDatabase(target.r.store,{...options(exported),reason:'Changed cutover reason'}),/reused/);
  }finally{await source.r.close();await target.r.close();}
});

for(const dialect of ['sqlite','postgres'])test(dialect+': an interrupted import rolls back copied rows and the quarantine as one transaction',async()=>{
  const source=await populated(),target=await runtime(dialect);const transaction=target.r.store.db.transaction.bind(target.r.store.db);let armed=true;
  try{
    const exported=await exportDatabase(source.r.store,{offline:true,actor});
    target.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const result=await q(sql,args);if(armed&&sql.startsWith('UPDATE sre_fix_requests'))throw new StorageError(new Error('Injected import failure during quarantine'));return result;}));
    await assert.rejects(importDatabase(target.r.store,options(exported)),e=>e instanceof StorageError);assert.ok(Object.values(await counts(target.r.store)).every(n=>n===0));assert.equal(await target.r.store.restoreFence(),null);
    armed=false;assert.equal((await importDatabase(target.r.store,options(exported))).held,true);
  }finally{await source.r.close();await target.r.close();}
});

test('snapshot tampering, configuration mismatch and SQL-shaped columns are refused before retaining any imported rows',async()=>{
  const source=await populated(),target=await runtime();try{
    const exported=await exportDatabase(source.r.store,{offline:true,actor});
    await assert.rejects(importDatabase(target.r.store,{...options(exported),expectedSha256:'f'.repeat(64)}),/digest/);
    const bad=structuredClone(exported.snapshot);bad.tables.sre_incidents.columns[0]='id); DROP TABLE sre_incidents';
    await assert.rejects(importDatabase(target.r.store,{...options(exported),snapshot:bad,expectedSha256:hash(bad)}),/identifier/);
    target.r.config.services[0].teams.tenantId='different-tenant';await assert.rejects(importDatabase(target.r.store,options(exported)),/mapping/);assert.ok(Object.values(await counts(target.r.store)).every(n=>n===0));
    await assert.rejects(exportDatabase(source.r.store,{offline:false,actor}),/offline/);await assert.rejects(importDatabase(target.r.store,{...options(exported),actor:{kind:'teams',id:'responder'}}),/operator/);
  }finally{await source.r.close();await target.r.close();}
});

test('non-empty and unrelated destination databases are preserved',async()=>{
  const source=await populated(),target=await runtime();try{
    const exported=await exportDatabase(source.r.store,{offline:true,actor});await target.r.store.checkpoint('existing',{keep:'this value'});await assert.rejects(importDatabase(target.r.store,options(exported)),/not empty/);assert.deepEqual(await target.r.store.checkpoint('existing'),{keep:'this value'});
    await target.r.store.db.query('CREATE TABLE unrelated (value TEXT)');await target.r.store.db.query("INSERT INTO unrelated(value) VALUES('retained')");await assert.rejects(importDatabase(target.r.store,options(exported)),/unrelated tables/);assert.equal((await target.r.store.db.query('SELECT value FROM unrelated'))[0].value,'retained');
  }finally{await source.r.close();await target.r.close();}
});

test('the offline CLI writes a new private snapshot, refuses overwrite, imports held, and starts no connector or model',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sre-transfer-cli-')),sourcePath=join(dir,'source.sqlite'),targetPath=join(dir,'target.sqlite'),snapshotPath=join(dir,'snapshot.json'),source=await populated('sqlite',sourcePath);await source.r.close();
  const script=resolve('scripts/sre-database-transfer.mjs'),profile=resolve('config/sre.local.json'),env={PATH:process.env.PATH,SRE_CONFIG:profile,SRE_SQLITE_PATH:sourcePath},run=(args,extra={})=>spawnSync(process.execPath,[script,...args],{env:{...env,...extra},encoding:'utf8'});
  try{
    const exported=run(['export','--offline','--file',snapshotPath]);assert.equal(exported.status,0,exported.stderr);const receipt=JSON.parse(exported.stdout);assert.equal(receipt.modelCalls,0);assert.equal(receipt.providerCalls,0);assert.equal((await stat(snapshotPath)).mode&0o777,0o600);assert.equal(hash(JSON.parse(await readFile(snapshotPath,'utf8'))),receipt.sha256);
    assert.notEqual(run(['export','--offline','--file',snapshotPath]).status,0);
    const imported=run(['import','--offline','--file',snapshotPath,'--sha256',receipt.sha256,'--restore-id','cli-transfer','--reason','Reviewed fixture cutover'],{SRE_SQLITE_PATH:targetPath});assert.equal(imported.status,0,imported.stderr);assert.equal(JSON.parse(imported.stdout).held,true);
    assert.notEqual(run(['export','--file',join(dir,'no-flag.json')]).status,0);assert.notEqual(run(['export','--offline','--file',join(dir,'ambiguous-db.json')],{DATABASE_URL:'postgres://do-not-connect.invalid/sre'}).status,0);
    const target=await runtime('sqlite',targetPath);try{assert.equal((await target.r.store.restoreFence()).active,true);assert.equal((await target.r.store.db.query('SELECT status FROM sre_fix_requests WHERE id=?',[source.pending.id]))[0].status,'unknown');}finally{await target.r.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});
