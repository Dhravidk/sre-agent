import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {loadConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {postgresSql,StorageError} from '../src/sre/database.mjs';
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {normalize} from '../src/sre/normalize.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {createPilotQaAdapter} from '../fixtures/qa-sandbox.mjs';
import {prepareRestore,releaseRestore} from '../src/sre/restore-recovery.mjs';
import {boundedContext,modelContextLimits,RulesReasoner} from '../src/sre/reasoner.mjs';
import {seedPilot} from '../scripts/seed-pilot.mjs';

const result={status:'passed',branch:'codex/pinned-fixture',commit:'c'.repeat(40),patch:'fixture patch',mergeRequestDraft:'fixture MR draft',summary:'Checks pass on the pinned source only'};
function gate(){let open,enter;return {waiting:new Promise(resolve=>open=resolve),started:new Promise(resolve=>enter=resolve),open:()=>open(),enter:()=>enter()};}
async function fixture(dialect,qaAdapter,{path=':memory:'}={}){
  let db;
  if(dialect==='postgres'){const pg=new PGlite();db={dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const config=loadConfig({SRE_SQLITE_PATH:path}),service=config.services[0],rooms=['bidding-one','platform-one','bidding-two','platform-two'];
  service.teams={...service.teams,conversations:rooms,collaborationGroups:[{key:'response',name:'Fictional incident bridge',conversations:rooms.map(id=>({id,name:id}))}]};
  const r=await createSreRuntime({config,db,qaAdapter,autoStart:false});let sequence=0,now=Date.now();
  const send=async(room,text,user='local-operator')=>{const m=devActivity(text,service,{id:'tracking-'+ ++sequence,userId:user,displayName:user,conversationType:'groupChat',conversationId:room});await r.router.accept(m.activity,m.reference);await r.router.processOnce();};
  const id=(await seedDemo(r.store,service)).incidentId;
  // A second seedDemo would deliberately reuse its fictional MR !17. Keep
  // this independent provider incident unlinked to that same change identity.
  const other=(await r.store.ingest({id:'independent-provider-outage',source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'provider-outage',status:'OPEN',at:now,payload:{problemId:'provider-outage',title:'Credit provider unavailable on healthy code',metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}}})).incidentId;
  await send(rooms[0],'join '+id);await send(rooms[1],'join '+id);await send(rooms[2],'join '+other);await send(rooms[3],'join '+other);
  const mr=(head,{number=61,state='opened',at=++now,delivery='mr-'+sequence++}={})=>r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'merge_request',object_attributes:{iid:number,state,last_commit:{id:head},merge_commit_sha:state==='merged'?'d'.repeat(40):null,updated_at:new Date(at).toISOString(),title:'Fix the accepted winning bid'}},service,{deliveryId:delivery}));
  const initial=(await r.store.context(id)).deployments[0].sha;await mr(initial);
  const evidence=await r.store.addEvidence(id,'gitlab','code_review',{headSha:initial,comparison:{mergeRequest:{iid:61}}});await r.casework.linkChange(id,'gitlab',61,evidence);
  const settle=async()=>{for(let n=0;n<60;n++){const [row]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.count))return;await r.worker.runOnce();}throw Error('Tracking fixture did not settle');};await settle();
  const key=conversationKey('synthetic',rooms[0]),principal={verified:true,simulation:true,tenant:'synthetic',conversationId:rooms[0],userId:'local-operator'};
  const approve=async()=>{const plan=await r.casework.createPlan(id),request=await r.casework.proposeFix(id,plan.id,principal,key,'tracking-'+ ++sequence);await r.casework.approveFix(request.id,request.nonce,principal,key);return {plan,request};};
  return {r,service,id,other,rooms,key,principal,mr,initial,settle,approve,send};
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': two teams can withdraw a mistaken MR, suppress rediscovery and explicitly reconsider it without stale requests changing the new link',async()=>{
    const f=await fixture(dialect),actor={kind:'teams',principal:{...f.principal,userId:'alex'},displayName:'alex',conversationKey:f.key};try{
      await f.mr('b'.repeat(40),{number:72,delivery:'correctable'});const linked=await f.r.casework.trackChange(f.id,'gitlab',72,actor),original=await f.r.store.db.query('SELECT content FROM sre_evidence WHERE id=?',[linked.evidenceId]);
      await f.send(f.rooms[1],'untrack-change gitlab 72 '+linked.evidenceId+' Separate provider scope; this MR is not part of our incident.','noor');
      let context=await f.r.store.context(f.id),withdrawn=context.changeAssociations.controls.find(c=>c.number==='72');assert.equal(withdrawn.state,'withdrawn');assert.equal(withdrawn.actor.id,'noor');assert.equal((await f.r.casework.timeline(f.id)).links.some(l=>l.change_number==='72'),false);assert.deepEqual(await f.r.store.db.query('SELECT content FROM sre_evidence WHERE id=?',[linked.evidenceId]),original);
      const revision=context.incident.revision;await f.mr('c'.repeat(40),{number:72,delivery:'withdrawn-new-head',at:Date.now()+100});assert.equal((await f.r.store.context(f.id)).incident.revision,revision);
      const proof=await f.r.store.addEvidence(f.id,'gitlab','code_review',{headSha:'c'.repeat(40),comparison:{mergeRequest:{iid:72}}});assert.equal((await f.r.casework.linkChange(f.id,'gitlab',72,proof)).suppressed,true);await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',72,actor),e=>e.status===409);
      const options={reconsiderEvidenceId:withdrawn.evidenceId,reason:'New matched trace establishes that this reviewed MR belongs to the bidding scope.'},again=await f.r.casework.trackChange(f.id,'gitlab',72,actor,options);assert.notEqual(again.evidenceId,linked.evidenceId);assert.equal(again.status,'tracked');const after=(await f.r.store.context(f.id)).incident.revision;assert.equal((await f.r.casework.trackChange(f.id,'gitlab',72,actor,options)).duplicate,true);assert.equal((await f.r.store.context(f.id)).incident.revision,after);
      await assert.rejects(f.r.casework.withdrawChange(f.id,'gitlab',72,actor,{expectedEvidenceId:linked.evidenceId,reason:'Delayed old request'}),e=>e.status===409);await f.mr('d'.repeat(40),{number:72,delivery:'reconsidered-head',at:Date.now()+200});assert.ok(Number((await f.r.store.context(f.id)).incident.revision)>Number(after));await f.settle();const reconsideredPlan=await f.r.casework.createPlan(f.id);assert.ok(reconsideredPlan.markdown.includes(options.reason));assert.ok(reconsideredPlan.markdown.includes(withdrawn.evidenceId));
      const notices=(await f.r.store.snapshot()).outbox.filter(o=>o.text.startsWith('Change context')&&o.text.includes('withdrawn from'));assert.equal(notices.length,2);assert.ok(notices.every(o=>o.incident_id===f.id));
    }finally{await f.r.close();}
  });
  test(dialect+': withdrawal requires the current reference, a reason and the joined audience, and cannot detach a provider review from itself',async()=>{
    const f=await fixture(dialect),actor={kind:'teams',principal:f.principal,conversationKey:f.key},operator={kind:'local-operator',id:'fixture operator'};try{
      const native=await f.mr('b'.repeat(40),{number:72,delivery:'permissions-correction'}),linked=await f.r.casework.trackChange(f.id,'gitlab',72,actor),options={expectedEvidenceId:linked.evidenceId,reason:'Wrong case scope'};
      await assert.rejects(f.r.casework.withdrawChange(f.other,'gitlab',72,actor,options),/Join|conversation/);await assert.rejects(f.r.casework.withdrawChange(f.id,'gitlab',72,{...actor,principal:{...f.principal,verified:false}},options),/verified/);await assert.rejects(f.r.casework.withdrawChange(f.id,'gitlab',72,actor,{...options,reason:''}));await assert.rejects(f.r.casework.withdrawChange(f.id,'gitlab',72,actor,{...options,expectedEvidenceId:'f'.repeat(64)}),e=>e.status===409);
      const own=(await f.r.casework.timeline(native.incidentId)).links.find(l=>l.change_number==='72');await assert.rejects(f.r.casework.withdrawChange(native.incidentId,'gitlab',72,operator,{expectedEvidenceId:own.evidence_id,reason:'Cannot erase native identity'}),/own provider-review/);assert.ok((await f.r.casework.timeline(f.id)).links.some(l=>l.evidence_id===linked.evidenceId));
    }finally{await f.r.close();}
  });
  test(dialect+': an interrupted withdrawal rolls back its checkpoint, evidence, projection, revision and notices together',async()=>{
    const f=await fixture(dialect),actor={kind:'local-operator',id:'fixture operator'},transaction=f.r.store.db.transaction.bind(f.r.store.db);try{
      await f.mr('b'.repeat(40),{number:72,delivery:'atomic-correction'});const linked=await f.r.casework.trackChange(f.id,'gitlab',72,actor),before=await f.r.store.context(f.id),options={expectedEvidenceId:linked.evidenceId,reason:'Only the provider incident uses this MR'},count=Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_evidence'))[0].count);
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const rows=await q(sql,args);if(sql.startsWith('DELETE FROM sre_incident_change_links'))throw new StorageError(new Error('Injected interrupted withdrawal'));return rows;}));await assert.rejects(f.r.casework.withdrawChange(f.id,'gitlab',72,actor,options),e=>e instanceof StorageError);f.r.store.db.transaction=transaction;
      const after=await f.r.store.context(f.id);assert.equal(after.incident.revision,before.incident.revision);assert.deepEqual(after.changeAssociations,before.changeAssociations);assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_evidence'))[0].count),count);assert.ok((await f.r.casework.timeline(f.id)).links.some(l=>l.evidence_id===linked.evidenceId));
      const done=await f.r.casework.withdrawChange(f.id,'gitlab',72,actor,options),revision=(await f.r.store.context(f.id)).incident.revision;assert.equal(done.status,'withdrawn');assert.equal((await f.r.casework.withdrawChange(f.id,'gitlab',72,actor,options)).duplicate,true);assert.equal((await f.r.store.context(f.id)).incident.revision,revision);
    }finally{f.r.store.db.transaction=transaction;await f.r.close();}
  });
  test(dialect+': restored corrections survive reconciliation and one reaffirmed MR cannot authorize CI from another historical relationship',async()=>{
    const f=await fixture(dialect),actor={kind:'local-operator',id:'fixture operator'};try{
      await f.mr('b'.repeat(40),{number:72,delivery:'restored-withdrawn'});await f.mr('c'.repeat(40),{number:73,delivery:'restored-tracked'});const linked=await f.r.casework.trackChange(f.id,'gitlab',72,actor);await f.r.casework.trackChange(f.id,'gitlab',73,actor);const withdrawal=await f.r.casework.withdrawChange(f.id,'gitlab',72,actor,{expectedEvidenceId:linked.evidenceId,reason:'Wrong issue'});
      const fence=await prepareRestore(f.r.store,{restoreId:'correction-restore',backupSha256:'a'.repeat(64),backupAt:Date.now()-60000,reason:'Isolated correction restore',actor,offline:true});assert.equal((await f.r.store.context(f.id)).changeAssociations.controls.find(c=>c.number==='72').state,'withdrawn');await assert.rejects(f.r.casework.withdrawChange(f.id,'gitlab',73,actor,{expectedEvidenceId:'a'.repeat(64),reason:'Held'}),/held/);
      await releaseRestore(f.r.store,{restoreId:fence.restoreId,requestId:'correction-release',reason:'Reviewed isolated fixture',observedAt:await f.r.store.coordinationNow(),evidenceUrls:['https://fixture.invalid/correction'],actor});assert.equal((await f.r.casework.timeline(f.id)).links.find(l=>l.change_number==='73').historicalAfterRestore,true);
      await f.mr('e'.repeat(40),{number:61,delivery:'fresh-reaffirmation',at:(await f.r.store.coordinationNow())+1});await f.r.casework.trackChange(f.id,'gitlab',61,actor);assert.ok(!(await f.r.casework.timeline(f.id)).links.find(l=>l.change_number==='61').historicalAfterRestore);const revision=(await f.r.store.context(f.id)).incident.revision;
      await f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{sha:'c'.repeat(40),status:'success',updated_at:new Date().toISOString()}},f.service,{deliveryId:'historical-ci'}));assert.equal((await f.r.store.context(f.id)).incident.revision,revision);await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',72,actor),e=>e.status===409);
      await f.mr('f'.repeat(40),{number:72,delivery:'fresh-reconsideration',at:(await f.r.store.coordinationNow())+1});await f.r.casework.trackChange(f.id,'gitlab',72,actor,{reconsiderEvidenceId:withdrawal.evidenceId,reason:'Fresh scoped provider trace reviewed'});assert.equal((await f.r.store.context(f.id)).changeAssociations.controls.find(c=>c.number==='72').historicalAfterRestore,false);
    }finally{await f.r.close();}
  });
  test(dialect+': reader-only relationships can be corrected repeatedly and their decisions stay visible through log noise and new fix tickets',async()=>{
    const f=await fixture(dialect),actor={kind:'local-operator',id:'fixture operator'};try{
      const proof=await f.r.store.addEvidence(f.id,'gitlab','code_review',{headSha:'f'.repeat(40),comparison:{mergeRequest:{iid:73}}});await f.r.casework.linkChange(f.id,'gitlab',73,proof);let reference=proof;
      for(let n=0;n<2;n++){const withdrawn=await f.r.casework.withdrawChange(f.id,'gitlab',73,actor,{expectedEvidenceId:reference,reason:'Scope correction '+n}),tracked=await f.r.casework.trackChange(f.id,'gitlab',73,actor,{reconsiderEvidenceId:withdrawn.evidenceId,reason:'Reviewed exact reader evidence '+n});reference=tracked.evidenceId;}
      await f.r.casework.withdrawChange(f.id,'gitlab',73,actor,{expectedEvidenceId:reference,reason:'Final correction: keep this reader MR in the provider incident.'});
      for(let n=0;n<12;n++)await f.r.store.addEvidence(f.id,'dynatrace','logs',{records:Array.from({length:50},(_,i)=>({timestamp:new Date().toISOString(),level:'INFO',message:'Routine /health HTTP 200 '+n+'-'+i+' '+'.'.repeat(500)})),complete:true});
      const context=await f.r.store.context(f.id),model=boundedContext(context);assert.equal(model.changeAssociations.controls.find(c=>c.number==='73').state,'withdrawn');assert.ok(Buffer.byteLength(JSON.stringify(model))<=modelContextLimits.totalBytes);assert.ok(context.evidence.some(e=>e.id===proof));
      await f.settle();const plan=await f.r.casework.createPlan(f.id);assert.match(plan.markdown,/Context correction: gitlab #73 withdrawn/);assert.ok(plan.payload.findings.length,'Independent deployed-code findings remain retained');assert.match((await new RulesReasoner().investigate(await f.r.store.context(f.id),{})).analysis.text,/Final correction/);
    }finally{await f.r.close();}
  });
  test(dialect+': corrupt correction state fails closed instead of silently recreating a relationship',async()=>{
    const f=await fixture(dialect),actor={kind:'local-operator',id:'fixture operator'};try{
      await f.mr('b'.repeat(40),{number:72,delivery:'corruptible-control'});const linked=await f.r.casework.trackChange(f.id,'gitlab',72,actor);await f.r.store.db.query("UPDATE sre_checkpoints SET value='{}' WHERE id=?",['change-association:'+f.id+':gitlab:72']);await assert.rejects(f.r.store.context(f.id),e=>e instanceof StorageError);await assert.rejects(f.r.casework.linkChange(f.id,'gitlab',72,linked.evidenceId),e=>e instanceof StorageError);await assert.rejects(f.mr('c'.repeat(40),{number:72,delivery:'corrupt-event'}),e=>e instanceof StorageError);assert.equal(Number((await f.r.store.db.query("SELECT COUNT(*) AS count FROM sre_events WHERE external_id='corrupt-event'"))[0].count),0);
    }finally{await f.r.close();}
  });
  test(dialect+': a joined participant can track an observed forward-fix MR, retain attribution and follow later heads without approving QA',async()=>{
    const f=await fixture(dialect);try{
      await f.mr('b'.repeat(40),{number:72,delivery:'forward-fix'});const plan=await f.r.casework.createPlan(f.id),before=(await f.r.store.context(f.id)).incident.revision,other=(await f.r.store.context(f.other)).incident.revision;
      await f.send(f.rooms[0],'track-change gitlab 72','alex');const view=await f.r.casework.timeline(f.id),link=view.links.find(l=>l.change_number==='72');assert.ok(link);const [row]=await f.r.store.db.query('SELECT content FROM sre_evidence WHERE id=?',[link.evidence_id]);const content=JSON.parse(row.content);assert.equal(content.association.id,'alex');assert.equal(content.association.authority,'context_association');assert.equal(content.sha,'b'.repeat(40));assert.ok(content.providerObservation.eventId);assert.match((await f.r.store.snapshot()).outbox.find(o=>o.text.startsWith('Tracking gitlab #72')).text,/not cause/);
      assert.equal(Number((await f.r.store.context(f.id)).incident.revision),Number(before)+1);assert.equal((await f.r.casework.snapshot(f.id)).plans.find(p=>p.id===plan.id).current,false);
      const duplicate=await f.r.casework.trackChange(f.id,'gitlab',72,{kind:'local-operator',id:'console'});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.evidenceId,link.evidence_id);assert.equal(Number((await f.r.store.context(f.id)).incident.revision),Number(before)+1);
      await f.mr('c'.repeat(40),{number:72,delivery:'forward-fix-head',at:Date.now()+500});assert.ok((await f.r.store.context(f.id)).evidence.some(e=>e.kind==='change'&&e.content.number===72&&e.content.sha==='c'.repeat(40)));assert.equal((await f.r.store.context(f.other)).incident.revision,other);assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_fix_requests'))[0].count),0);assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_rollbacks'))[0].count),0);await f.settle();assert.match((await f.r.casework.createPlan(f.id)).markdown,/Context association: gitlab #72 linked by alex/);
    }finally{await f.r.close();}
  });
  test(dialect+': missing, conflicted, wrong-service and forged-scope change references cannot create an incident association',async()=>{
    const f=await fixture(dialect),operator={kind:'local-operator',id:'fixture operator'};try{
      for(const [provider,number]of [['gitlab',999],['jira',72],['gitlab','01'],['gitlab','1e3'],['gitlab','9007199254740992']])await assert.rejects(f.r.casework.trackChange(f.id,provider,number,operator));
      const at=Date.now()+100;await f.mr('b'.repeat(40),{number:72,at,delivery:'conflict-a'});await f.mr('c'.repeat(40),{number:72,at,delivery:'conflict-b'});await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',72,operator),/Conflicting/);
      await f.mr('b'.repeat(40),{number:73,delivery:'scope-known'});
      const actor={kind:'teams',principal:f.principal,conversationKey:f.key};await assert.rejects(f.r.casework.trackChange(f.other,'gitlab',73,actor),/Join|conversation/);await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',73,{...actor,principal:{...f.principal,verified:false}}),/verified/);await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',73,{...actor,principal:{...f.principal,tenant:'foreign'}}),/verified/);
      const foreign={...f.service,key:'other-service',teams:{...f.service.teams,tenantId:'other-tenant',conversations:['foreign-room']},gitlab:{...f.service.gitlab,project:'18'}};f.r.config.services.push(foreign);
      await f.r.store.ingest(normalize('gitlab',{project:{id:18},object_kind:'merge_request',object_attributes:{iid:74,state:'opened',last_commit:{id:'d'.repeat(40)},updated_at:new Date().toISOString()}},foreign,{deliveryId:'foreign-change'}));await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',74,operator),/No observed/);
      assert.equal((await f.r.casework.timeline(f.id)).links.filter(l=>['72','73','74'].includes(l.change_number)).length,0);
    }finally{await f.r.close();}
  });
  test(dialect+': GitHub PR associations retain their provider namespace and passive Teams text cannot attach a change',async()=>{
    const f=await fixture(dialect);try{
      await f.r.store.ingest(normalize('github',{repository:{full_name:f.service.github.repository},action:'opened',pull_request:{number:72,head:{sha:'b'.repeat(40)},base:{sha:'a'.repeat(40)},updated_at:new Date().toISOString(),title:'Forward bidding fix'}},f.service,{eventType:'pull_request',deliveryId:'github-observed'}));
      const m=devActivity('track-change github 72',f.service,{id:'passive-track',conversationId:f.rooms[0],conversationType:'groupChat',userId:'alex',mentioned:false});await f.r.router.accept(m.activity,m.reference);await f.r.router.processOnce();assert.ok(!(await f.r.casework.timeline(f.id)).links.some(l=>l.provider==='github'&&l.change_number==='72'));
      await f.send(f.rooms[0],'track-change github 72','alex');const link=(await f.r.casework.timeline(f.id)).links.find(l=>l.provider==='github'&&l.change_number==='72');assert.ok(link);assert.equal(link.association.label,'alex');await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',72,{kind:'local-operator',id:'console'}),/No observed/);
      const revision=(await f.r.store.context(f.id)).incident.revision;await f.r.store.ingest(normalize('github',{repository:{full_name:f.service.github.repository},check_suite:{head_sha:'b'.repeat(40),updated_at:new Date().toISOString(),conclusion:'success'}},f.service,{eventType:'check_suite',deliveryId:'github-ci'}));assert.ok(Number((await f.r.store.context(f.id)).incident.revision)>Number(revision));
    }finally{await f.r.close();}
  });
  test(dialect+': an existing connector-discovered MR can be acknowledged and receive exact-head CI without a duplicate MR webhook',async()=>{
    const f=await fixture(dialect);try{
      const head='f'.repeat(40),evidenceId=await f.r.store.addEvidence(f.id,'gitlab','code_review',{headSha:head,comparison:{mergeRequest:{iid:73}}});await f.r.casework.linkChange(f.id,'gitlab',73,evidenceId);const before=(await f.r.store.context(f.id)).incident.revision,other=(await f.r.store.context(f.other)).incident.revision;
      const acknowledged=await f.r.casework.trackChange(f.id,'gitlab',73,{kind:'teams',principal:{...f.principal,userId:'alex'},conversationKey:f.key});assert.equal(acknowledged.duplicate,true);assert.equal(acknowledged.headSha,head);assert.equal(acknowledged.evidenceId,evidenceId);assert.equal((await f.r.store.context(f.id)).incident.revision,before);
      await f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{sha:head,status:'success',updated_at:new Date().toISOString()}},f.service,{deliveryId:'reader-only-ci'}));assert.ok(Number((await f.r.store.context(f.id)).incident.revision)>Number(before));assert.equal((await f.r.store.context(f.other)).incident.revision,other);
    }finally{await f.r.close();}
  });
  test(dialect+': association storage is atomic and a restore requires a new current provider observation',async()=>{
    const f=await fixture(dialect),operator={kind:'local-operator',id:'fixture operator'},transaction=f.r.store.db.transaction.bind(f.r.store.db);try{
      await f.mr('b'.repeat(40),{number:72,delivery:'atomic-known'});const before=(await f.r.store.context(f.id)).incident.revision,count=Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_evidence'))[0].count);
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const rows=await q(sql,args);if(sql.startsWith('INSERT INTO sre_incident_change_links'))throw new StorageError(new Error('Injected association transaction failure'));return rows;}));await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',72,operator),e=>e instanceof StorageError);f.r.store.db.transaction=transaction;
      assert.equal((await f.r.store.context(f.id)).incident.revision,before);assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_evidence'))[0].count),count);assert.ok(!(await f.r.casework.timeline(f.id)).links.some(l=>l.change_number==='72'));
      const fence=await prepareRestore(f.r.store,{restoreId:'association-restore',backupSha256:'a'.repeat(64),backupAt:Date.now()-60000,reason:'Isolated association recovery',actor:operator,offline:true});await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',72,operator),/held/);
      await releaseRestore(f.r.store,{restoreId:fence.restoreId,requestId:'association-release',reason:'Reviewed isolated fixture',observedAt:await f.r.store.coordinationNow(),evidenceUrls:['https://fixture.invalid/association'],actor:operator});await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',72,operator),/historical/);
      await f.mr('c'.repeat(40),{number:72,at:(await f.r.store.coordinationNow())+1,delivery:'current-after-restore'});assert.equal((await f.r.casework.trackChange(f.id,'gitlab',72,operator)).duplicate,false);
    }finally{f.r.store.db.transaction=transaction;await f.r.close();}
  });
  test(dialect+': an explicitly linked MR refreshes its operational incident without changing another incident or its source lifecycle',async()=>{
    const f=await fixture(dialect,{localOnly:true,execute:async()=>result});try{
      const plan=await f.r.casework.createPlan(f.id),before=await f.r.store.context(f.id),unrelated=await f.r.store.context(f.other);
      const at=Date.now()+100,delivery='new-head',head='b'.repeat(40);await f.mr(head,{at,delivery});
      const changed=await f.r.store.context(f.id);assert.ok(Number(changed.incident.revision)>Number(before.incident.revision));assert.equal(changed.incident.status,'open');assert.equal(changed.session.agent_id,before.session.agent_id);assert.equal((await f.r.store.context(f.other)).incident.revision,unrelated.incident.revision);
      assert.ok(changed.evidence.some(e=>e.kind==='change'&&e.content.number===61&&e.content.sha===head),'Operational tracking must not become a pre-merge problem');
      await assert.rejects(f.r.casework.proposeFix(f.id,plan.id,f.principal,f.key,'old-plan'),/stale/);
      await f.mr(head,{at,delivery});assert.equal((await f.r.store.context(f.id)).incident.revision,changed.incident.revision);
      await f.mr(f.initial,{at:at-1,delivery:'delayed-old-head'});assert.ok((await f.r.casework.timeline(f.id)).items.some(e=>Number(e.observed_at)===at-1),'A delayed MR observation remains in immutable history');
      await f.mr(head,{at:at+1,state:'closed',delivery:'mr-closed'});await f.settle();assert.equal((await f.r.store.context(f.id)).incident.status,'open');assert.equal((await f.r.store.context(f.id)).incident.analysis.risk.scope.stage,'incident');
    }finally{await f.r.close();}
  });
  test(dialect+': source changes during local QA retain the old artifacts as superseded and notify only that incident',async()=>{
    const g=gate();let executions=0;const f=await fixture(dialect,{localOnly:true,execute:async()=>{executions++;g.enter();await g.waiting;return result;}});let running;
    try{
      const {plan,request}=await f.approve();running=f.r.casework.runOnce();await g.started;await f.mr('b'.repeat(40),{delivery:'head-during-qa'});g.open();await running;
      const q=(await f.r.casework.snapshot(f.id)).qa.find(q=>q.id===request.id);q.result=(await f.r.casework.qaRequest(f.id,q.id)).result;assert.equal(q.status,'superseded');assert.equal(q.result.patch,result.patch);assert.equal(q.result.mergeRequestDraft,result.mergeRequestDraft);assert.match(q.error,/changed|fresh/i);assert.equal(q.current,false);assert.equal(q.result.review.approvedRevision,Number(plan.payload.revision));
      const notices=(await f.r.store.snapshot()).outbox.filter(o=>o.text.startsWith('QA '+request.id));assert.equal(notices.length,2);assert.ok(notices.every(o=>o.incident_id===f.id&&o.text.includes('superseded')&&o.text.includes('fresh')));assert.ok((await f.r.operations.snapshot()).conditions.some(c=>c.code==='qa_superseded'));assert.equal(await f.r.casework.runOnce(),false);assert.equal(executions,1);
    }finally{g.open();await running;await f.r.close();}
  });
  test(dialect+': removing the requesting room during QA cannot roll back its completed result or prevent notifying the remaining group',async()=>{
    const g=gate();const f=await fixture(dialect,{localOnly:true,execute:async()=>{g.enter();await g.waiting;return result;}});let running;
    try{
      const {request}=await f.approve();running=f.r.casework.runOnce();await g.started;await f.r.store.db.query('UPDATE sre_conversations SET enabled=0 WHERE id=?',[f.key]);g.open();await running;
      const q=(await f.r.casework.snapshot(f.id)).qa.find(q=>q.id===request.id);assert.equal(q.status,'superseded');assert.equal(q.result.commit,result.commit);assert.match(q.error,/conversation|scope|access/i);
      const notices=(await f.r.store.snapshot()).outbox.filter(o=>o.text.startsWith('QA '+request.id));assert.equal(notices.length,1);assert.equal(notices[0].conversation_key,conversationKey('synthetic',f.rooms[1]));assert.equal(await f.r.casework.runOnce(),false);
    }finally{g.open();await running;await f.r.close();}
  });
  test(dialect+': completed QA becomes historical when a linked MR changes, and an unlinked CI result does not invalidate another incident',async()=>{
    const f=await fixture(dialect,{localOnly:true,execute:async()=>result});try{
      const {request}=await f.approve();await f.r.casework.runOnce();assert.equal((await f.r.casework.snapshot(f.id)).qa[0].current,true);
      const otherRevision=(await f.r.store.context(f.other)).incident.revision;await f.mr('b'.repeat(40),{delivery:'head-after-qa'});
      const view=await f.r.casework.snapshot(f.id);assert.equal(view.qa.find(q=>q.id===request.id).status,'passed');assert.equal(view.qa.find(q=>q.id===request.id).current,false);
      const unrelated=normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{sha:'e'.repeat(40),status:'success',updated_at:new Date().toISOString()}},f.service,{deliveryId:'unrelated-ci'});await f.r.store.ingest(unrelated);
      assert.equal((await f.r.store.context(f.other)).incident.revision,otherRevision);assert.ok((await f.r.store.db.query("SELECT id FROM sre_change_events WHERE stage='ci-update'")).length);
    }finally{await f.r.close();}
  });
  test(dialect+': CI for old heads and the merge commit stays linked to the reviewed incident without becoming deployment or recovery proof',async()=>{
    const f=await fixture(dialect);try{
      await f.mr('b'.repeat(40),{state:'merged',delivery:'merged-for-ci'});const otherRevision=(await f.r.store.context(f.other)).incident.revision;
      for(const [n,head]of [f.initial,'d'.repeat(40)].entries()){
        const before=(await f.r.store.context(f.id)).incident.revision;
        await f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{sha:head,status:'success',updated_at:new Date().toISOString()}},f.service,{deliveryId:'linked-ci-'+n}));
        assert.ok(Number((await f.r.store.context(f.id)).incident.revision)>Number(before));assert.equal((await f.r.store.context(f.other)).incident.revision,otherRevision);
      }
      const context=await f.r.store.context(f.id);assert.equal(context.incident.status,'open');assert.ok(!context.deployments.some(d=>d.sha==='d'.repeat(40)));assert.ok((await f.r.casework.timeline(f.id)).items.some(e=>e.stage==='ci-update'&&e.head_sha==='d'.repeat(40)));
    }finally{await f.r.close();}
  });
  test(dialect+': an approval revoked during QA supersedes its result and a fresh successful review clears that operational condition',async()=>{
    const g=gate(),f=await fixture(dialect,{localOnly:true,execute:async()=>{g.enter();await g.waiting;return result;}});let running;
    try{
      const {request}=await f.approve();running=f.r.casework.runOnce();await g.started;f.service.teams.approvers=[];g.open();await running;
      let qa=(await f.r.casework.snapshot(f.id)).qa.find(q=>q.id===request.id);assert.equal(qa.status,'superseded');assert.match(qa.error,/authority/);assert.ok((await f.r.operations.snapshot()).conditions.some(c=>c.code==='qa_superseded'));
      f.service.teams.approvers=['local-operator'];await f.approve();await f.r.casework.runOnce();assert.ok(!(await f.r.operations.snapshot()).conditions.some(c=>c.code==='qa_superseded'),'A new reviewed passing result resolves the old superseded condition without deleting its audit');
      qa=(await f.r.casework.snapshot(f.id)).qa.find(q=>q.id===request.id);assert.equal(qa.status,'superseded');assert.equal(qa.current,false);
    }finally{g.open();await running;await f.r.close();}
  });
  test(dialect+': an expired QA lease is quarantined even after the requesting room is removed, and the old worker cannot replace it',async()=>{
    const g=gate(),f=await fixture(dialect,{localOnly:true,execute:async()=>{g.enter();await g.waiting;return result;}});let running;
    try{
      const {request}=await f.approve();running=f.r.casework.runOnce();await g.started;await f.r.store.db.query('UPDATE sre_conversations SET enabled=0 WHERE id=?',[f.key]);await f.r.store.db.query('UPDATE sre_fix_requests SET lease_until=? WHERE id=?',[(await f.r.store.coordinationNow())-1,request.id]);
      assert.equal(await f.r.casework.runOnce(),false);assert.equal((await f.r.casework.snapshot(f.id)).qa.find(q=>q.id===request.id).status,'unknown');g.open();await running;
      const view=(await f.r.casework.snapshot(f.id)).qa.find(q=>q.id===request.id);assert.equal(view.status,'unknown');assert.equal(view.result,null);assert.ok((await f.r.store.db.query("SELECT id FROM sre_fix_events WHERE request_id=? AND status='late-result'",[request.id])).length);
      const notices=(await f.r.store.snapshot()).outbox.filter(o=>o.text.startsWith('QA '+request.id));assert.equal(notices.length,1);assert.equal(notices[0].conversation_key,conversationKey('synthetic',f.rooms[1]));
    }finally{g.open();await running;await f.r.close();}
  });
}

test('operator change-association HTTP requires authentication, ignores forged actor fields and retries idempotently',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});config.mode='connected';config.apiToken='fixture-operator-token';config.capabilitySecret='x'.repeat(40);config.services[0].rollback.enabled=false;
  const r=await createSreRuntime({config,autoStart:false});try{
    const id=(await seedDemo(r.store,config.services[0])).incidentId;await r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'merge_request',object_attributes:{iid:72,state:'opened',last_commit:{id:'b'.repeat(40)},updated_at:new Date().toISOString()}},config.services[0],{deliveryId:'http-observed'}));await new Promise(resolve=>r.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+r.server.address().port+'/api/incidents/'+id+'/changes',body=JSON.stringify({provider:'gitlab',number:72,actor:{kind:'teams',id:'forged'}});
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body})).status,401);const headers={'content-type':'application/json',authorization:'Bearer fixture-operator-token'};const response=await fetch(url,{method:'POST',headers,body});assert.equal(response.status,200,await response.clone().text());const first=await response.json();assert.equal(first.duplicate,false);const again=await fetch(url,{method:'POST',headers,body});assert.equal((await again.json()).duplicate,true);
    const [row]=await r.store.db.query('SELECT content FROM sre_evidence WHERE id=?',[first.evidenceId]);assert.equal(JSON.parse(row.content).association.kind,'operator-api');assert.equal(JSON.parse(row.content).association.id,'SRE_API_TOKEN');assert.ok(!row.content.includes('forged'));
    const correction={provider:'gitlab',number:72,expectedEvidenceId:first.evidenceId,reason:'Wrong issue scope',actor:{kind:'teams',id:'forged'}};
    assert.equal((await fetch(url+'/withdraw',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(correction)})).status,401);assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({...correction,action:'withdraw'})})).status,400);
    const withdrawal=await fetch(url+'/withdraw',{method:'POST',headers,body:JSON.stringify(correction)});assert.equal(withdrawal.status,200,await withdrawal.clone().text());const receipt=await withdrawal.json();assert.equal(receipt.status,'withdrawn');assert.equal((await (await fetch(url+'/withdraw',{method:'POST',headers,body:JSON.stringify(correction)})).json()).duplicate,true);assert.equal((await fetch(url,{method:'POST',headers,body})).status,409);
    const reconsider={provider:'gitlab',number:72,reconsiderEvidenceId:receipt.evidenceId,reason:'New scoped trace reviewed'};const reopened=await fetch(url+'/reconsider',{method:'POST',headers,body:JSON.stringify(reconsider)});assert.equal(reopened.status,200,await reopened.clone().text());assert.notEqual((await reopened.json()).evidenceId,first.evidenceId);assert.equal((await fetch(url+'/withdraw',{method:'POST',headers,body:JSON.stringify(correction)})).status,409);const view=await (await fetch(url.replace(/\/changes$/,''),{headers})).json();assert.equal(view.casework.associationActionVersion,1);assert.ok(!JSON.stringify(view.changeAssociations).includes('forged'));
    await r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'merge_request',object_attributes:{iid:74,state:'opened',last_commit:{id:'d'.repeat(40)},updated_at:new Date().toISOString()}},config.services[0],{deliveryId:'unlinked-reconsideration-guard'}));const malformed=await fetch(url+'/reconsider',{method:'POST',headers,body:JSON.stringify({provider:'gitlab',number:74,reason:'Missing reference must not create a new association'})});assert.equal(malformed.status,400);assert.ok(!(await r.casework.timeline(id)).links.some(l=>l.change_number==='74'));
  }finally{await r.close();}
});

test('participant change associations and their attribution survive database reopen and keep following later MR updates',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-change-association-')),f=await fixture('sqlite',undefined,{path:join(directory,'agent.sqlite')});let reopened;
  try{
    await f.mr('b'.repeat(40),{number:72,delivery:'reopen-known'});await f.send(f.rooms[0],'track-change gitlab 72','alex');const link=(await f.r.casework.timeline(f.id)).links.find(l=>l.change_number==='72'),agent=(await f.r.store.context(f.id)).session.agent_id;assert.ok(link);await f.r.close();reopened=await createSreRuntime({config:f.r.config,autoStart:false});
    const [row]=await reopened.store.db.query('SELECT content FROM sre_evidence WHERE id=?',[link.evidence_id]);assert.equal(JSON.parse(row.content).association.id,'alex');assert.equal((await reopened.store.context(f.id)).session.agent_id,agent);const revision=(await reopened.store.context(f.id)).incident.revision;
    await reopened.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'merge_request',object_attributes:{iid:72,state:'opened',last_commit:{id:'c'.repeat(40)},updated_at:new Date(Date.now()+1000).toISOString()}},f.service,{deliveryId:'after-reopen-head'}));assert.ok(Number((await reopened.store.context(f.id)).incident.revision)>Number(revision));
    const actor={kind:'local-operator',id:'reopen operator'},withdrawal=await reopened.casework.withdrawChange(f.id,'gitlab',72,actor,{expectedEvidenceId:link.evidence_id,reason:'The new provider symptom belongs to another issue'}),audit=await reopened.store.db.query('SELECT content FROM sre_evidence WHERE id=?',[withdrawal.evidenceId]);await reopened.close();reopened=await createSreRuntime({config:f.r.config,autoStart:false});assert.deepEqual(await reopened.store.db.query('SELECT content FROM sre_evidence WHERE id=?',[withdrawal.evidenceId]),audit);const stable=(await reopened.store.context(f.id)).incident.revision;assert.equal((await reopened.store.context(f.id)).changeAssociations.controls.find(c=>c.number==='72').state,'withdrawn');await reopened.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'merge_request',object_attributes:{iid:72,state:'opened',last_commit:{id:'d'.repeat(40)},updated_at:new Date(Date.now()+2000).toISOString()}},f.service,{deliveryId:'after-withdrawal-reopen'}));assert.equal((await reopened.store.context(f.id)).incident.revision,stable);
  }finally{await reopened?.close();await f.r.close();await rm(directory,{recursive:true,force:true});}
});

test('real trusted auction QA keeps its reproduced defect, corrected checks and branch when a new MR head supersedes it',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-qa-moved-head-')),adapter=createPilotQaAdapter(directory),g=gate();
  const f=await fixture('sqlite',{localOnly:true,execute:async input=>{const value=await adapter.execute(input);g.enter();await g.waiting;return value;}});let running;
  try{
    const {request}=await f.approve();running=f.r.casework.runOnce();await g.started;await f.mr('b'.repeat(40),{delivery:'real-checks-new-head'});g.open();await running;
    const q=(await f.r.casework.snapshot(f.id)).qa.find(q=>q.id===request.id);q.result=(await f.r.casework.qaRequest(f.id,q.id)).result;assert.equal(q.status,'superseded');assert.equal(q.result.reproduction.exitCode,1);assert.equal(q.result.validation.exitCode,0);assert.match(q.result.patch,/checkVersion/);assert.match(q.result.branch,/^codex\/qa-/);assert.match(q.result.mergeRequestDraft,/local MR draft/);
    const exec=promisify(execFile),repo=join(directory,'patch-apply'),env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},git=(...args)=>exec('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],{env,encoding:'utf8',timeout:15000});
    await git('clone','--no-hardlinks',seedPilot().repository,repo);await git('-C',repo,'checkout','--detach',q.result.sourceSha);const patch=join(directory,'saved.patch');await writeFile(patch,q.result.patch);await git('-C',repo,'apply','--check',patch);await git('-C',repo,'apply',patch);
    assert.equal((await git('-C',repo,'diff','--',q.result.changedPath)).stdout,q.result.patch,'The stored patch must preserve the exact git diff bytes');assert.deepEqual(await readFile(join(repo,q.result.changedPath)),await readFile(join(q.result.workspace,q.result.changedPath)));
  }finally{g.open();await running;await f.r.close();await rm(directory,{recursive:true,force:true});}
});
