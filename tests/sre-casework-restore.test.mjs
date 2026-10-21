import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {loadConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {devActivity,seedDemo} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {postgresSql,StorageError} from '../src/sre/database.mjs';
import {prepareRestore,releaseRestore} from '../src/sre/restore-recovery.mjs';
import {fictionalDirectory} from '../fixtures/ownership-directory.mjs';

async function fixture(dialect){
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});let db,calls=0;
  if(dialect==='postgres'){const pg=new PGlite();db={dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const r=await createSreRuntime({config,db,autoStart:false,qaAdapter:{localOnly:true,execute:async()=>{calls++;return {status:'passed',branch:'codex/restore-fixture',commit:'a'.repeat(40),summary:'Fixture execution'};}}}),service=config.services[0];
  const id=(await seedDemo(r.store,service)).incidentId;
  const activity=devActivity('join '+id,service);await r.router.accept(activity.activity,activity.reference);await r.router.processOnce();
  for(let i=0;i<10&&await r.worker.runOnce();i++);
  const principal={verified:true,simulation:true,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0],userId:'local-operator'},key=conversationKey(principal.tenant,principal.conversationId);
  const plan=await r.casework.createPlan(id),a=await r.casework.proposeFix(id,plan.id,principal,key,'snapshot-approved'),b=await r.casework.proposeFix(id,plan.id,principal,key,'snapshot-running');
  await r.casework.approveFix(a.id,a.nonce,principal,key);await r.casework.approveFix(b.id,b.nonce,principal,key);
  const now=await r.store.coordinationNow();await r.store.db.query("UPDATE sre_fix_requests SET status='running',lease_owner='pre-backup-worker',lease_until=? WHERE id=?",[now+60000,b.id]);
  const directory=fictionalDirectory(now-1000);await r.casework.importDirectory(service.key,directory);
  service.logMonitors=[{id:'restore-logs',codes:['WINNING_BID_REGRESSED'],minCount:2,windowSeconds:60}];
  const record=n=>({timestamp:new Date(now-100+n).toISOString(),level:'ERROR',environment:service.environment,region:'eu',code:'WINNING_BID_REGRESSED',message:'Fictional saved log '+n});
  await r.logDetector.observe(service,'fixture',{records:[record(1),record(2)],complete:true});
  const input={restoreId:'casework-restore',backupSha256:'b'.repeat(64),backupAt:now-1,reason:'Test lost-interval casework reconciliation',actor:{kind:'local-operator',id:'fixture recovery operator'},offline:true};
  return {r,id,service,plan,a,b,directory,principal,key,input,calls:()=>calls,release:async()=>releaseRestore(r.store,{restoreId:input.restoreId,requestId:'release-casework',reason:'Reviewed fixture external records',actor:input.actor,observedAt:await r.store.coordinationNow(),evidenceUrls:['https://fixture.invalid/restore-evidence']})};
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': restoring casework quarantines approved/running QA immediately and preserves its audit',async()=>{
    const f=await fixture(dialect);try{
      const prepared=await prepareRestore(f.r.store,f.input);assert.equal(prepared.counts.qaRequests,2);
      const rows=await f.r.store.db.query('SELECT id,status,lease_owner,lease_until FROM sre_fix_requests ORDER BY id');assert.ok(rows.every(r=>r.status==='unknown'&&r.lease_owner===null&&r.lease_until===null));
      assert.equal((await f.r.casework.getPlan(f.plan.id,f.id)).markdown,f.plan.markdown);
      const view=await f.r.casework.snapshot(f.id);assert.equal(view.held,true);assert.ok(view.plans.every(p=>p.current===false));
      const events=await f.r.store.db.query("SELECT payload FROM sre_fix_events WHERE status='unknown'");assert.equal(events.length,2);assert.ok(events.every(e=>JSON.parse(e.payload).restoreId===f.input.restoreId));
      assert.equal(await f.r.casework.runOnce(),false);await f.release();assert.equal(await f.r.casework.runOnce(),false);assert.equal(f.calls(),0);
      assert.equal((await f.r.casework.approveFix(f.a.id,f.a.nonce,f.principal,f.key)).status,'unknown');
    }finally{await f.r.close();}
  });
  test(dialect+': restored directory history cannot name current contacts until a fresh import follows reconciliation',async()=>{
    const f=await fixture(dialect);try{
      assert.ok((await f.r.casework.contacts(f.id)).contacts.length);const prepared=await prepareRestore(f.r.store,f.input);
      let view=await f.r.casework.contacts(f.id);assert.equal(view.contacts.length,0);assert.match(view.unknowns.join(' '),/restor/i);
      await f.release();view=await f.r.casework.contacts(f.id);assert.equal(view.contacts.length,0);
      await f.r.casework.importDirectory(f.service.key,f.directory);assert.equal((await f.r.casework.contacts(f.id)).contacts.length,0,'Reimporting old observations cannot establish current ownership');
      const fresh=fictionalDirectory(Math.max(prepared.preparedAt,await f.r.store.coordinationNow()));await f.r.casework.importDirectory(f.service.key,fresh);view=await f.r.casework.contacts(f.id);assert.ok(view.contacts.some(c=>c.role==='on-call'));
      const rows=await f.r.store.db.query('SELECT payload FROM sre_directory_snapshots');assert.ok(rows.some(r=>JSON.parse(r.payload).restoreId===f.input.restoreId));
    }finally{await f.r.close();}
  });
  test(dialect+': restoration drops derived log counters while preserving evidence and requiring a new full threshold',async()=>{
    const f=await fixture(dialect);try{
      const before=Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_log_samples'))[0].count);assert.equal(before,2);
      const prepared=await prepareRestore(f.r.store,f.input);assert.equal(prepared.counts.logSamples,2);assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_log_samples'))[0].count),0);
      await f.release();const beforeEvents=Number((await f.r.store.db.query("SELECT COUNT(*) AS count FROM sre_events WHERE source='log-monitor'"))[0].count);await f.r.logDetector.runOnce();assert.equal(Number((await f.r.store.db.query("SELECT COUNT(*) AS count FROM sre_events WHERE source='log-monitor'"))[0].count),beforeEvents);
      const now=await f.r.store.coordinationNow(),record=n=>({timestamp:now,level:'ERROR',environment:f.service.environment,region:'eu',code:'WINNING_BID_REGRESSED',message:'Fresh post-restore observation '+n});
      assert.equal((await f.r.logDetector.observe(f.service,'fixture',{records:[record(1)],complete:true})).incidents.length,0);
      assert.equal((await f.r.logDetector.observe(f.service,'fixture',{records:[record(2)],complete:true})).incidents.length,1);
      const timeline=await f.r.casework.timeline(f.id);assert.match(timeline.interpretation,/restor/i);
    }finally{await f.r.close();}
  });
  test(dialect+': failed casework quarantine rolls back QA state, log counters and the restore fence together',async()=>{
    const f=await fixture(dialect),transaction=f.r.store.db.transaction.bind(f.r.store.db);let armed=true;
    f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const result=await q(sql,args);if(armed&&sql.startsWith('DELETE FROM sre_log_samples'))throw new StorageError(new Error('Injected interrupted casework restore'));return result;}));
    try{
      await assert.rejects(prepareRestore(f.r.store,f.input),e=>e instanceof StorageError);assert.equal(await f.r.store.restoreFence(),null);
      assert.equal((await f.r.store.db.query('SELECT status FROM sre_fix_requests WHERE id=?',[f.a.id]))[0].status,'approved');assert.equal((await f.r.store.db.query('SELECT status FROM sre_fix_requests WHERE id=?',[f.b.id]))[0].status,'running');assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_log_samples'))[0].count),2);
      armed=false;assert.equal((await prepareRestore(f.r.store,f.input)).active,true);
    }finally{await f.r.close();}
  });
}
