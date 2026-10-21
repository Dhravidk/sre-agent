import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {webhookLoadFixture,webhookLoadHead as head} from '../fixtures/sre-webhook-load.mjs';
import {changeObservationNotices} from '../src/sre/change-observation-notices.mjs';
import {StorageError} from '../src/sre/database.mjs';
import {boundedContext} from '../src/sre/reasoner.mjs';
import {exportDatabase,importDatabase} from '../src/sre/database-transfer.mjs';

const seedFailures=async f=>{for(const id of [401,402,403,404])await f.ci(id,'failed');await f.settle();};
const specificPeers=async(f,since,needle)=>{const notes=await f.notices(since);assert.equal(notes.length,2,'One notice for each joined group');for(const room of f.rooms.slice(0,2)){const[key]=await f.r.store.db.query('SELECT id FROM sre_conversations WHERE conversation_id=?',[room]);assert.ok(notes.some(note=>note.conversation_key===key.id&&note.text.includes(needle)),room+' must see the specific material update');}return notes;};
for(const dialect of ['sqlite','postgres']){
  test(dialect+': a fifth failing run cannot disappear behind the three-run briefing budget',async()=>{
    const f=await webhookLoadFixture(dialect);try{
      await seedFailures(f);const before=await f.checkpoint(),other=(await f.r.store.context(f.other)).incident.revision;
      await f.ci(405,'failed');await f.settle();const notes=await specificPeers(f,before,'Pipeline 405 failed'),a=await f.analysis(),change=a.observedChanges.find(row=>row.number==='72');
      assert.equal(change.ci[0].id,'405');assert.equal(change.ciAttention.adverse,5);assert.equal(change.ciOmitted.adverse,2);assert.ok(notes.every(row=>row.text.includes('2 additional failure/cancellation reports')&&Buffer.byteLength(row.text)<=11000));
      assert.equal((await f.r.store.context(f.other)).incident.revision,other);assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    }finally{await f.close();}
  });
  test(dialect+': new routine passing runs do not displace existing failures or create peer chatter',async()=>{
    const f=await webhookLoadFixture(dialect);try{
      await seedFailures(f);const before=await f.checkpoint();for(let n=0;n<12;n++){await f.ci(500+n,'success');await f.settle();}
      assert.equal((await f.notices(before)).length,0);assert.ok((await f.analysis()).observedChanges.find(row=>row.number==='72').ci.every(run=>run.status==='failed'));
    }finally{await f.close();}
  });
  test(dialect+': repeated versions and questions preserve material priority without a follow-up broadcast',async()=>{
    const f=await webhookLoadFixture(dialect);try{
      await seedFailures(f);await f.ci(405,'failed');await f.settle();const before=await f.checkpoint(),registry=(await f.analysis()).observedChangeRegistry;
      for(let n=0;n<3;n++){await f.ci(401,'failed');await f.question();await f.settle();}
      assert.equal((await f.notices(before)).length,0);assert.equal((await f.analysis()).observedChanges.find(row=>row.number==='72').ci[0].id,'405');assert.deepEqual((await f.analysis()).observedChangeRegistry,registry);
    }finally{await f.close();}
  });
  test(dialect+': a new failure on the fourth MR is in the actual peer brief rather than only the stored history',async()=>{
    const f=await webhookLoadFixture(dialect);try{
      const heads=[head,'b'.repeat(40),'c'.repeat(40),'d'.repeat(40)];
      for(let n=0;n<4;n++){const number=72+n;if(n){await f.mr(heads[n],{number});await f.r.casework.trackChange(f.id,'gitlab',number,{kind:'local-operator',id:'Fictional lead'});}await f.ci(1000+number,n===3?'running':'failed',{head:heads[n]});}
      await f.settle();const before=await f.checkpoint();await f.ci(1075,'failed',{head:heads[3]});await f.settle();const notes=await specificPeers(f,before,'Pipeline 1075 failed');assert.ok(notes.every(row=>row.text.includes('gitlab #75')&&row.text.includes(heads[3])&&row.text.includes('3/4 shown')));
    }finally{await f.close();}
  });
  test(dialect+': a later success for an omitted failing run is reported without declaring recovery',async()=>{
    const f=await webhookLoadFixture(dialect);try{
      await seedFailures(f);const shown=(await f.analysis()).observedChanges.find(row=>row.number==='72').ci.map(run=>run.id),omitted=[401,402,403,404].find(id=>!shown.includes(String(id)));assert.ok(omitted);const before=await f.checkpoint();await f.ci(omitted,'success');await f.settle();const notes=await specificPeers(f,before,'Pipeline '+omitted+' success'),change=(await f.analysis()).observedChanges.find(row=>row.number==='72');assert.equal(change.ciAttention.adverse,3);assert.ok(notes.every(row=>row.text.includes('Incident state: open')&&row.text.includes('do not verify recovery')));assert.equal((await f.r.store.context(f.id)).incident.status,'open');
    }finally{await f.close();}
  });
  test(dialect+': old-head noise cannot restore a previous head’s priority or mutate another incident',async()=>{
    const f=await webhookLoadFixture(dialect);try{
      await seedFailures(f);const current='b'.repeat(40);await f.mr(current);await f.settle();const before=await f.checkpoint(),other=(await f.r.store.context(f.other)).incident.revision;await f.ci(406,'failed');await f.settle();assert.equal((await f.notices(before)).length,0);assert.equal((await f.analysis()).observedChanges.find(row=>row.number==='72').headSha,current);await f.ci(407,'failed',{head:current});await f.settle();await specificPeers(f,before,'Pipeline 407 failed');assert.equal((await f.r.store.context(f.other)).incident.revision,other);
    }finally{await f.close();}
  });
  test(dialect+': overlapping change references share one bounded registry rather than multiplying run state',async()=>{
    const f=await webhookLoadFixture(dialect);try{
      for(const number of [73,74,75]){await f.mr(head,{number});await f.r.casework.trackChange(f.id,'gitlab',number,{kind:'local-operator',id:'Fictional lead'});}
      for(let n=0;n<64;n++)await f.ci(800+n,'success');await f.settle();const analysis=await f.analysis(),registry=analysis.observedChangeRegistry;assert.equal(registry.runs.length,64);assert.equal(registry.changes.length,4);assert.ok(Buffer.byteLength(JSON.stringify(registry))<36000);assert.ok(analysis.observedChanges.every(change=>change.ci.length===3&&change.ciOmitted.other===61));
      const snapshot=boundedContext(await f.r.store.context(f.id));assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<=160000);assert.ok(!Object.hasOwn(snapshot.incident.analysis,'observedChangeRegistry'));assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    }finally{await f.close();}
  });
  test(dialect+': malformed or future saved notification metadata fails closed without publishing',async()=>{
    const f=await webhookLoadFixture(dialect);try{
      await seedFailures(f);const context=await f.r.store.context(f.id),before=await f.checkpoint(),saved=context.incident.analysis.observedChangeRegistry;
      for(const change of [registry=>registry.version=999,registry=>registry.runs[0].changedRevision=Number(context.incident.revision)+1,registry=>registry.runs.push({...registry.runs[0]}),registry=>registry.runs=Array(101).fill(registry.runs[0])]){const registry=structuredClone(saved);change(registry);await assert.rejects(()=>changeObservationNotices(f.r.store,{...context,incident:{...context.incident,analysis:{...context.incident.analysis,observedChangeRegistry:registry}}},f.service,f.r.casework),error=>error instanceof StorageError);}
      assert.equal((await f.notices(before)).length,0);assert.deepEqual((await f.analysis()).observedChangeRegistry,saved);
    }finally{await f.close();}
  });
  test(dialect+': model-returned priority and pipeline claims cannot replace host-derived observations',async()=>{
    const f=await webhookLoadFixture(dialect);try{
      await seedFailures(f);const investigate=f.r.worker.reasoner.investigate.bind(f.r.worker.reasoner);f.r.worker.reasoner={investigate:async(...args)=>{const result=await investigate(...args);result.analysis.observedChangeRegistry={version:999,runs:[],changes:[]};result.analysis.observedChanges=[{provider:'gitlab',number:'72',headSha:'f'.repeat(40),materialRevision:Number.MAX_SAFE_INTEGER,ci:[{id:'99999',status:'success'}]}];return result;}};
      const before=await f.checkpoint();await f.ci(405,'failed');await f.settle();const notes=await specificPeers(f,before,'Pipeline 405 failed'),analysis=await f.analysis();assert.equal(analysis.observedChangeRegistry.version,1);assert.equal(analysis.observedChanges.find(row=>row.number==='72').headSha,head);assert.ok(notes.every(note=>!note.text.includes('Pipeline 99999')));assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    }finally{await f.close();}
  });
}
test('file reopen retains run priority and exact old delivery/source identities without replay',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-ci-attention-')),f=await webhookLoadFixture('sqlite',{path:join(directory,'agent.sqlite')});try{
    await seedFailures(f);await f.ci(405,'failed');await f.settle();const before=await f.checkpoint(),registry=(await f.analysis()).observedChangeRegistry,events=await f.r.store.db.query('SELECT * FROM sre_events ORDER BY id'),outbox=await f.r.store.db.query('SELECT * FROM sre_outbox ORDER BY id');await f.restart();
    assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_events ORDER BY id'),events);assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_outbox ORDER BY id'),outbox);assert.deepEqual((await f.analysis()).observedChangeRegistry,registry);await f.ci(401,'failed');await f.question();await f.settle();assert.equal((await f.notices(before)).length,0);assert.equal((await f.analysis()).observedChanges.find(row=>row.number==='72').ci[0].id,'405');
  }finally{await f.close();await rm(directory,{recursive:true,force:true});}
});
for(const [from,to]of [['sqlite','postgres'],['postgres','sqlite']])test(from+' → '+to+': notification priority remains historical through offline storage cutover and cannot send under the restore hold',async()=>{
  const source=await webhookLoadFixture(from),target=await webhookLoadFixture(to,{initialize:false}),actor={kind:'local-operator',id:'Fictional cutover reviewer'};try{
    await seedFailures(source);await source.ci(405,'failed');await source.settle();const history=await source.r.store.db.query('SELECT id,body FROM sre_assessments WHERE incident_id=? ORDER BY id',[source.id]),archive=await exportDatabase(source.r.store,{offline:true,actor});
    await importDatabase(target.r.store,{snapshot:archive.snapshot,expectedSha256:archive.sha256,restoreId:'ci-notification-priority-cutover',reason:'Fictional notification-state adapter cutover',offline:true,actor});
    assert.deepEqual((await target.r.store.db.query('SELECT id,body FROM sre_assessments WHERE incident_id=? ORDER BY id',[source.id])).map(row=>({...row})),history.map(row=>({...row})));const context=await target.r.store.context(source.id);assert.equal(context.incident.analysis,null);assert.equal(context.recoveryFence.active,true);assert.equal(await target.r.outbox.runOnce(),false);assert.equal(target.sent.length,0);
    const observed=await changeObservationNotices(target.r.store,context,target.service,target.r.casework);assert.equal(observed.changes.length,0);assert.equal(observed.registry.runs.length,0);assert.equal((await target.r.store.snapshot()).rollbacks.length,0);
  }finally{await source.close();await target.close();}
});
