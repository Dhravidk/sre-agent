import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {postgresSql} from '../src/sre/database.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {normalize} from '../src/sre/normalize.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {prepareRestore,releaseRestore} from '../src/sre/restore-recovery.mjs';
import {StorageError} from '../src/sre/database.mjs';

const a='a'.repeat(40),b='b'.repeat(40),operator={kind:'local-operator',id:'fictional incident lead'};
async function fixture(dialect){
  let db;if(dialect==='postgres'){const pg=new PGlite();db={dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=config.services[0];service.gitlab={...service.gitlab,base:'https://git-fixture.invalid',project:'17',enabled:false};
  const rooms=['bidding','platform','provider'];service.teams={...service.teams,conversations:rooms,captureResponderUpdates:true,collaborationGroups:[{key:'test',name:'Fictional timeline response',conversations:rooms.map(id=>({id,name:id}))}]};
  const r=await createSreRuntime({config,db,connectors:new Map([[service.key,{}]]),autoStart:false});let sequence=0,time=Date.now()-60000;
  const issue=async key=>(await r.store.ingest({id:key,source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:key,status:'OPEN',at:time,title:key==='bidding'?'Fictional accepted-bid race':'Fictional provider outage on healthy code',payload:{problemId:key,metrics:{codes:[key==='bidding'?'WINNING_BID_REGRESSED':'CREDIT_PROVIDER_UNAVAILABLE']}}})).incidentId;
  const id=await issue('bidding'),other=await issue('provider');
  const send=async(room,text,user='local-operator')=>{const m=devActivity(text,service,{id:'timeline-chat-'+ ++sequence,userId:user,displayName:user,conversationId:room,conversationType:'groupChat'});await r.router.accept(m.activity,m.reference);await r.router.processOnce();};
  await send(rooms[0],'join '+id);await send(rooms[1],'join '+id);await send(rooms[2],'join '+other);
  await r.store.addEvidence(id,'gitlab','code_review',{headSha:a,coverage:'Fixture source identity only; no general code diagnosis.'});await r.store.addEvidence(other,'gitlab','code_review',{headSha:a,coverage:'Same source commit does not establish the same incident.'});
  const mr=(n=72,head=a)=>r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'merge_request',object_attributes:{iid:n,state:'opened',last_commit:{id:head},updated_at:new Date(++time).toISOString(),title:'Fictional accepted-bid version guard fix'}},service,{deliveryId:'timeline-mr-'+ ++sequence}));
  const ci=(status,at,{pipeline=301,head=a}={})=>r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{id:pipeline,project_id:17,sha:head,status,updated_at:new Date(at).toISOString()}},service,{deliveryId:'timeline-ci-'+ ++sequence}));
  await mr();await r.casework.trackChange(id,'gitlab',72,operator);
  const settle=async()=>{for(let i=0;i<80;i++){const [n]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(n.count))return;await r.worker.runOnce();}throw Error('Timeline fixture did not settle');};
  return {r,service,id,other,rooms,send,mr,ci,settle,at:()=>time+=1000};
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': the incident history groups repeated CI deliveries, keeps their status versions and leaves every source fact unchanged',async()=>{
    const f=await fixture(dialect);try{
      const t=f.at();await f.ci('running',t);await f.ci('success',t+100);for(let i=0;i<5;i++)await f.ci('success',t+100);await f.ci('failed',t+200);await f.ci('success',t+100);const before=await f.r.store.db.query('SELECT id,payload,body_hash FROM sre_events ORDER BY id');
      const view=await f.r.casework.timeline(f.id),group=view.groups.find(g=>g.stage==='ci-update'&&g.run.id==='301');assert.equal(group.factCount,9);assert.equal(group.observationCount,3);assert.equal(group.latest.status,'failed');assert.equal(group.latest.at,t+200);assert.equal(group.relevance.kind,'linked-commit');assert.equal(group.sources.length,9);assert.equal(view.items.filter(r=>r.stage==='ci-update').length,9);assert.deepEqual(await f.r.store.db.query('SELECT id,payload,body_hash FROM sre_events ORDER BY id'),before);assert.equal((await f.r.store.context(f.id)).incident.status,'open');
      await f.settle();const plan=await f.r.casework.createPlan(f.id);assert.match(plan.markdown,/9 source facts.*3 status\/time observations/);assert.match(plan.markdown,/latest update version: failed/);assert.match(plan.markdown,/not current CI or recovery proof/);
    }finally{await f.r.close();}
  });
  test(dialect+': CI received after withdrawal is shared-commit history and never appears as a current incident relationship',async()=>{
    const f=await fixture(dialect);try{
      const first=await f.ci('running',f.at()),link=(await f.r.casework.timeline(f.id)).links.find(l=>l.change_number==='72');await f.r.casework.withdrawChange(f.id,'gitlab',72,operator,{expectedEvidenceId:link.evidence_id,reason:'The provider team owns this different investigation; retain source history only.'});const revision=(await f.r.store.context(f.id)).incident.revision,other=(await f.r.store.context(f.other)).incident.revision,later=await f.ci('failed',f.at());
      const view=await f.r.casework.timeline(f.id);assert.equal(view.items.find(r=>r.id===first.eventId).relevance.kind,'retained-evidence');assert.equal(view.items.find(r=>r.id===later.eventId).relevance.kind,'shared-commit');assert.equal(view.links.some(l=>l.change_number==='72'),false);assert.ok(view.groups.some(g=>g.relevance.kind==='shared-commit'&&g.sources.some(s=>s.eventId===later.eventId)));assert.equal((await f.r.store.context(f.id)).incident.revision,revision);assert.equal((await f.r.store.context(f.other)).incident.revision,other);
      const unrelated=await f.r.casework.timeline(f.other);assert.equal(unrelated.items.find(r=>r.id===later.eventId).relevance.kind,'shared-commit');await f.send(f.rooms[0],'changes','avery');assert.match((await f.r.store.snapshot()).outbox.find(m=>m.text.startsWith('Tracked change history')).text,/Shared commit history; no active incident link/);
    }finally{await f.r.close();}
  });
  test(dialect+': a CI delivery flood cannot remove the linked MR head from the bounded incident timeline',async()=>{
    const f=await fixture(dialect);try{
      await f.mr(72,b);const t=f.at();for(let i=0;i<520;i++)await f.ci('running',t+i);const view=await f.r.casework.timeline(f.id);assert.ok(view.items.some(r=>r.provider==='gitlab'&&r.change_number==='72'&&r.head_sha===b),'Reserve linked MR facts before bounding the noisy source window');assert.ok(view.groups.some(g=>g.changeNumber==='72'&&g.headSha===b));assert.equal(view.limited,true);assert.equal(view.coverage.providerWindowLimited,true);assert.ok(view.groups.find(g=>g.stage==='ci-update').sourcesLimited);assert.equal(Number((await f.r.store.db.query("SELECT COUNT(*) AS count FROM sre_change_events WHERE stage='ci-update'"))[0].count),520);
    }finally{await f.r.close();}
  });
  test(dialect+': separate pipeline identities and tied conflicting statuses are preserved in compact history',async()=>{
    const f=await fixture(dialect);try{
      const t=f.at();await f.ci('success',t);await f.ci('failed',t);await f.ci('success',t+100,{pipeline:302});
      for(const state of ['success','failed'])await f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{sha:a,status:state,updated_at:new Date(t+200).toISOString()}},f.service,{deliveryId:'unidentified-'+state}));
      const view=await f.r.casework.timeline(f.id),first=view.groups.find(g=>g.run?.id==='301'),second=view.groups.find(g=>g.run?.id==='302'),unidentified=view.groups.find(g=>g.run&&!g.run.known);assert.equal(first.latest.state,'conflicting');assert.equal(first.latest.status,null);assert.deepEqual(first.latest.statuses,['failed','success']);assert.equal(second.latest.status,'success');assert.equal(unidentified.latest.state,'identity-unknown');assert.equal(unidentified.latest.status,null);assert.equal(unidentified.factCount,2);
    }finally{await f.r.close();}
  });
  test(dialect+': finish-time reports are displayed separately from comparable update versions',async()=>{
    const f=await fixture(dialect);try{
      const t=f.at();await f.ci('running',t);await f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{id:301,sha:a,status:'failed',finished_at:new Date(t+100).toISOString()}},f.service,{deliveryId:'finished-without-update-version'}));
      const group=(await f.r.casework.timeline(f.id)).groups.find(g=>g.run?.id==='301');assert.equal(group.latest.status,'running');assert.equal(group.latest.at,t);assert.equal(group.unversionedCount,1);assert.ok(group.sources.some(r=>r.status==='failed'&&r.timeKind==='finished'));assert.match(group.note,/not current CI or recovery proof/);
    }finally{await f.r.close();}
  });
  test(dialect+': restoration labels historical relationships without erasing withdrawals or treating old CI as recovery',async()=>{
    const f=await fixture(dialect);try{
      await f.mr(73);const link=await f.r.casework.trackChange(f.id,'gitlab',73,operator);await f.r.casework.withdrawChange(f.id,'gitlab',73,operator,{expectedEvidenceId:link.evidenceId,reason:'Separate workstream'});const first=await f.ci('success',f.at());await new Promise(resolve=>setTimeout(resolve,2));
      const fence=await prepareRestore(f.r.store,{restoreId:'timeline-history',backupSha256:'a'.repeat(64),backupAt:Date.now()-60000,reason:'Owned timeline restore rehearsal',actor:operator,offline:true});await releaseRestore(f.r.store,{restoreId:fence.restoreId,requestId:'timeline-release',reason:'Only fictional external effects exist',actor:operator,observedAt:await f.r.store.coordinationNow(),evidenceUrls:['https://fixture.invalid/restore']});const later=await f.ci('failed',f.at()),view=await f.r.casework.timeline(f.id);
      assert.equal(view.items.find(r=>r.id===first.eventId).recordedBeforeRestore,true);assert.equal(view.items.find(r=>r.id===later.eventId).recordedBeforeRestore,false);assert.equal(view.groups.find(g=>g.changeNumber==='72').relevance.kind,'historical-change');assert.equal(view.groups.find(g=>g.changeNumber==='73').relevance.kind,'withdrawn-change');assert.ok(view.groups.filter(g=>g.stage==='ci-update').every(g=>g.relevance.references.every(r=>r.state==='historical')));assert.equal((await f.r.store.context(f.id)).incident.status,'open');
    }finally{await f.r.close();}
  });
  test(dialect+': a changed source projection cannot silently become a different history status',async()=>{
    const f=await fixture(dialect);try{
      const event=await f.ci('success',f.at()),[row]=await f.r.store.db.query('SELECT payload FROM sre_change_events WHERE id=?',[event.eventId]),body=JSON.parse(row.payload);body.pipeline.status='failed';await f.r.store.db.query('UPDATE sre_change_events SET payload=? WHERE id=?',[JSON.stringify(body),event.eventId]);await assert.rejects(f.r.casework.timeline(f.id),e=>e instanceof StorageError);
    }finally{await f.r.close();}
  });
}
