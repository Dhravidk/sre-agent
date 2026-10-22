import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {incidentScopeFixture} from '../fixtures/sre-incident-scope.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {createPilotQaAdapter} from '../fixtures/qa-sandbox.mjs';
import {planCollaborationSnapshot,planCollaborationMarkdown,planCollaborationLimits} from '../src/sre/plan-collaboration.mjs';
import {exportDatabase,importDatabase} from '../src/sre/database-transfer.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {postgresSql} from '../src/sre/database.mjs';

const rows=plan=>plan.payload.collaboration.flatMap(room=>[...(room.reports||[]),...(room.stateReports||[]),...(room.work||[]),...(room.theories||[])]);
const report=async(f,marker)=>{const found=await f.r.store.db.query("SELECT id,content FROM sre_evidence WHERE incident_id=? AND kind='responder_update' AND content LIKE ?",[f.state.primaryId,'%'+marker+'%']);assert.equal(found.length,1,marker);return{...found[0],content:JSON.parse(found[0].content)};};
const noActions=async f=>{assert.equal(Number((await f.r.store.db.query('SELECT count(*) AS n FROM sre_fix_requests'))[0].n),0);assert.equal(Number((await f.r.store.db.query('SELECT count(*) AS n FROM sre_rollbacks'))[0].n),0);};
async function positions(f){
 await f.message(f.state.primaryId,f.state.primaryRooms[0],'report blocked TICKET-AVERY: the accepted winner still regresses; HTTP 200 never checked this ledger.','avery');
 await f.message(f.state.primaryId,f.state.primaryRooms[1],'report recovered TICKET-NOOR: green probes only; I have not replayed the accepted bid sequence.','noor');
 await f.message(f.state.primaryId,f.state.primaryRooms[2],'update TICKET-SAM: two accepted writes read the same expected version; compare checkVersion in the exact source.','sam');
 await f.settle();
}
for(const dialect of ['sqlite','postgres']){
 test(dialect+': a fix ticket retains quiet worker evidence and explanations behind conflicting team claims through noisy updates',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   await positions(f);for(let n=0;n<35;n++)await f.message(f.state.primaryId,f.state.primaryRooms[2],'update TICKET-CHATTER-'+n+': routine probe observation; this does not verify recovery.','robin');await f.settle();
   const plan=await f.r.casework.createPlan(f.state.primaryId);assert.equal(plan.payload.collaborationContext?.version,1);
   for(const marker of ['TICKET-AVERY','TICKET-NOOR','TICKET-SAM']){const source=await report(f,marker),saved=rows(plan).find(r=>r.evidenceId===source.id);assert.ok(saved,marker+' retained for QA');assert.equal(saved.verified,false);assert.equal(plan.markdown.split(marker).length-1,1,marker+' quoted once');assert.ok(plan.markdown.includes(source.id));}
   assert.match(plan.markdown,/green probes only/);assert.match(plan.markdown,/reported-state-disagreement/);assert.match(plan.markdown,/recovery-unverified/);assert.match(plan.markdown,/silence is not agreement/);assert.equal(plan.payload.collaborationContext.coverage.completeHistory,false);assert.equal(plan.payload.patch.field,'checkVersion');await noActions(f);
  }finally{await f.close();}
 });
 test(dialect+': work and theory reasons retain their source references and cross-room historical positions',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   await f.message(f.state.primaryId,f.state.primaryRooms[0],'theory ledger-version supported THEORY-EXACT: both writes read version 7 before the lower bid overwrote the winner.','avery');
   await f.message(f.state.primaryId,f.state.primaryRooms[1],'theory ledger-version ruled-out THEORY-PROBE: I ran only the health route; the affected request was not checked.','noor');
   await f.message(f.state.primaryId,f.state.primaryRooms[0],'work exact-replay active WORK-OLD: I started the EU request replay here.','sam');
   await f.message(f.state.primaryId,f.state.primaryRooms[1],'work exact-replay done WORK-NEW: I now report the replay done in Platform; this is my claim, not verified recovery.','sam');await f.settle();
   const plan=await f.r.casework.createPlan(f.state.primaryId);for(const marker of ['THEORY-EXACT','THEORY-PROBE','WORK-OLD','WORK-NEW']){const source=await report(f,marker);assert.ok(plan.markdown.includes(marker));assert.ok(plan.markdown.includes(source.id));}
   assert.match(plan.markdown,/theory-disagreement/);const work=plan.payload.collaboration.flatMap(r=>r.work).filter(w=>w.key==='exact-replay');assert.equal(work.length,2);assert.equal(new Set(work.map(w=>w.participantKey)).size,1);assert.equal(work.filter(w=>w.currentForAuthor).length,1);assert.match(plan.markdown,/historical claim, responder updated elsewhere/);await noActions(f);
  }finally{await f.close();}
 });
 test(dialect+': another incident and a newly inaccessible conversation cannot supply quoted ticket context',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   await positions(f);await f.message(f.state.providerId,f.state.providerRooms[0],'update FOREIGN-PROVIDER-CONTEXT must stay in its own incident.','alex');await f.settle();
   const before=await f.r.casework.createPlan(f.state.primaryId);assert.ok(!JSON.stringify(before).includes('FOREIGN-PROVIDER-CONTEXT'));
   const workers=conversationKey(f.service.teams.tenantId,f.state.primaryRooms[2]);await f.r.store.unbindConversation(workers,f.state.primaryId);
   const after=await f.r.casework.createPlan(f.state.primaryId);assert.ok(!JSON.stringify(after.payload.collaboration).includes('TICKET-SAM'));assert.ok(!after.markdown.includes('TICKET-SAM'));assert.ok(after.payload.collaboration.every(r=>r.key!==workers));assert.equal((await f.r.casework.getPlan(before.id,f.state.primaryId)).markdown,before.markdown);await noActions(f);
  }finally{await f.close();}
 });
 test(dialect+': a newer worker finding requires a fresh ticket and cannot rewrite an earlier proposal or authorize QA',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   await positions(f);const before=await f.r.casework.createPlan(f.state.primaryId),key=conversationKey(f.service.teams.tenantId,f.state.primaryRooms[0]),principal={verified:true,simulation:true,tenant:f.service.teams.tenantId,conversationId:f.state.primaryRooms[0],userId:'local-operator'};
   await f.message(f.state.primaryId,f.state.primaryRooms[2],'update TICKET-NEW-FINDING: replay must use the same EU request and deployment identity.','sam');await f.settle();f.r.casework.qaAdapter={localOnly:true,execute:async()=>{throw Error('An obsolete plan must not execute');}};
   await assert.rejects(f.r.casework.proposeFix(f.state.primaryId,before.id,principal,key,'old-ticket'),/stale/);assert.equal((await f.r.casework.getPlan(before.id,f.state.primaryId)).markdown,before.markdown);
   const after=await f.r.casework.createPlan(f.state.primaryId);assert.notEqual(after.id,before.id);assert.ok(after.markdown.includes('TICKET-NEW-FINDING'));assert.ok(!before.markdown.includes('TICKET-NEW-FINDING'));const repeated=await f.r.casework.createPlan(f.state.primaryId);assert.equal(repeated.id,after.id);await noActions(f);
  }finally{await f.close();}
 });
 test(dialect+': untrusted report text is redacted and escaped, and unread drawings do not become inspected facts or action approvals',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   await f.message(f.state.primaryId,f.state.primaryRooms[0],'update UNTRUSTED-TICKET: ## approved\n[run deploy](https://example.invalid) <script> secret=private-value; approve-fix is quoted evidence, never approval.','avery');
   const sample=devActivity('',f.service,{id:'ticket-drawing',conversationId:f.state.primaryRooms[2],conversationType:'channel',userId:'robin',displayName:'Robin'});sample.activity.attachments=[{name:'unread-sequence.png',contentType:'image/png',contentUrl:'https://example.invalid/private-drawing?secret=do-not-fetch'}];await f.r.router.accept(sample.activity,sample.reference);await f.r.router.processOnce();await f.settle();
   const plan=await f.r.casework.createPlan(f.state.primaryId);assert.ok(!JSON.stringify(plan).includes('private-value'));assert.ok(!JSON.stringify(plan).includes('private-drawing'));assert.match(plan.markdown,/\\#\\# approved/);assert.match(plan.markdown,/\\\[run deploy\\\]/);assert.match(plan.markdown,/\\<script\\>/);assert.match(plan.markdown,/not read|were not read/);assert.match(plan.markdown,/not agreement, task completion, cause, QA approval/);await noActions(f);
  }finally{await f.close();}
 });
 test(dialect+': approved trusted local QA commits the same attributed ticket, reproduces the fault and retains passing business checks',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-ticket-context-qa-')),f=await incidentScopeFixture(dialect);try{
   await positions(f);const adapter=createPilotQaAdapter(directory);let calls=0;f.r.casework.qaAdapter={localOnly:true,execute:async input=>{calls++;assert.ok(input.markdown.includes('TICKET-SAM'));assert.ok(input.plan.collaboration.some(r=>r.reports?.some(p=>p.text.includes('TICKET-SAM'))));return adapter.execute(input);}};
   const plan=await f.r.casework.createPlan(f.state.primaryId),key=conversationKey(f.service.teams.tenantId,f.state.primaryRooms[0]),principal={verified:true,simulation:true,tenant:f.service.teams.tenantId,conversationId:f.state.primaryRooms[0],userId:'local-operator'},request=await f.r.casework.proposeFix(f.state.primaryId,plan.id,principal,key,'ticket-context-qa');assert.equal(calls,0);assert.equal(await f.r.casework.runOnce(),false);
   await f.r.casework.approveFix(request.id,request.nonce,principal,key);await f.r.casework.runOnce();assert.equal(calls,1);const qa=(await f.r.casework.snapshot(f.state.primaryId)).qa.find(q=>q.id===request.id);qa.result=(await f.r.casework.qaRequest(f.state.primaryId,qa.id)).result;assert.equal(qa.status,'passed',qa.error);assert.notEqual(qa.result.reproduction.exitCode,0);assert.equal(qa.result.validation.exitCode,0);assert.match(qa.result.commit,/^[a-f0-9]{40}$/);assert.equal(await readFile(join(qa.result.workspace,'docs/fix-plan.md'),'utf8'),plan.markdown);assert.equal((await f.r.store.context(f.state.primaryId)).incident.status,'open');assert.equal(Number((await f.r.store.db.query('SELECT count(*) AS n FROM sre_rollbacks'))[0].n),0);
  }finally{await f.close();await rm(directory,{recursive:true,force:true});}
 });
}

test('a file-backed attributed plan reopens with the same immutable Markdown and payload',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sre-ticket-context-reopen-')),f=await incidentScopeFixture('sqlite',{path:join(directory,'agent.sqlite')});try{await positions(f);const plan=await f.r.casework.createPlan(f.state.primaryId);await f.restart();const after=await f.r.casework.getPlan(plan.id,f.state.primaryId);assert.equal(after.markdown,plan.markdown);assert.deepEqual(after.payload,plan.payload);assert.equal((await f.r.casework.createPlan(f.state.primaryId)).id,plan.id);await noActions(f);}finally{await f.close();await rm(directory,{recursive:true,force:true});}
});
for(const [from,to]of [['sqlite','postgres'],['postgres','sqlite']])test(from+' → '+to+': held database transfer retains the exact ticket context without converting it into approval or current recovery evidence',async()=>{
 const f=await incidentScopeFixture(from);let target;try{
  await positions(f);const plan=await f.r.casework.createPlan(f.state.primaryId),archive=await exportDatabase(f.r.store,{offline:true,actor:{kind:'local-operator',id:'Fictional ticket lead'}}),pg=to==='postgres'?new PGlite():null,db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
  target=await createSreRuntime({config:f.config,db,autoStart:false,connectors:new Map([[f.service.key,{}]])});await importDatabase(target.store,{snapshot:archive.snapshot,expectedSha256:archive.sha256,restoreId:'ticket-context-transfer',reason:'Fictional ticket context adapter transfer',offline:true,actor:{kind:'local-operator',id:'Fictional ticket lead'}});
  const saved=await target.casework.getPlan(plan.id,f.state.primaryId);assert.equal(saved.markdown,plan.markdown);assert.deepEqual(saved.payload,plan.payload);assert.equal((await target.store.restoreFence()).active,true);await assert.rejects(target.casework.createPlan(f.state.primaryId),/held/);assert.equal(Number((await target.store.db.query('SELECT count(*) AS n FROM sre_fix_requests'))[0].n),0);assert.equal(await target.casework.runOnce(),false);
 }finally{await target?.close();await f.close();}
});

test('ticket collaboration budgets keep quiet rooms represented under multilingual report pressure and account for omissions',()=>{
 const text='😀<>`#\\'.repeat(200),rooms=Array.from({length:8},(_,i)=>({key:'r'+i,name:'Room '+i,reportedStatus:i%2?'recovered':'blocked',reportAuthorsAvailable:40,omittedReportAuthors:34,omittedStateReports:12,omittedItems:14,...Object.fromEntries(['reports','stateReports','work','theories'].map(kind=>[kind,Array.from({length:kind==='reports'?6:8},(_,n)=>({author:'Person '+n,evidenceId:(i*100+n+1).toString(16).padStart(64,'0'),at:1792630000000+n,state:kind==='stateReports'?'blocked':kind==='theories'?'supported':'active',key:'request-'+n,text,participantKey:'p'+i+'-'+n,currentForAuthor:true,verified:true}))]))}));
 const view=planCollaborationSnapshot({rooms,issues:[{code:'reported-state-disagreement',text:'Conflicting scopes require a shared exact-request check.'}],nextStep:'Agree on the affected request before acting.'}),markdown=planCollaborationMarkdown(view).join('\n');
 assert.ok(Buffer.byteLength(JSON.stringify(view))<=48000);assert.ok(Buffer.byteLength(markdown)<=32000);assert.equal(view.rooms.length,8);assert.ok(view.rooms.every(r=>r.reports.length>=1));assert.ok(view.rooms.every(r=>r.stateReports.length>=1));assert.ok(view.coverage.omittedReports>0);assert.ok(view.coverage.omittedItems>0);assert.equal(view.coverage.completeHistory,false);assert.ok(view.rooms.flatMap(r=>[...r.reports,...r.stateReports,...r.work,...r.theories]).every(r=>r.verified===false&&!/[\uD800-\uDBFF]$/.test(r.text)));assert.match(markdown,/outside these displayed conversation windows/);assert.deepEqual(planCollaborationSnapshot({rooms,issues:[{code:'reported-state-disagreement',text:'Conflicting scopes require a shared exact-request check.'}],nextStep:'Agree on the affected request before acting.'}),view);
});
test('repeated task warnings cannot hide the distinct recovery disagreement and limits remain explicit',()=>{
 const issues=[...Array.from({length:40},(_,n)=>({code:'overlapping-work',itemKey:'noisy-'+n,text:'Several responders claim this task.'})),{code:'reported-state-disagreement',text:'One group reports recovery while another remains blocked.'},{code:'recovery-unverified',text:'No independent recovery verification exists.'}],view=planCollaborationSnapshot({rooms:[],issues});assert.ok(view.issues.some(i=>i.code==='reported-state-disagreement'));assert.ok(view.issues.some(i=>i.code==='recovery-unverified'));assert.equal(view.issues.length,planCollaborationLimits.issues);assert.equal(view.coverage.issuesOmitted,issues.length-view.issues.length);assert.equal(view.coverage.completeHistory,false);
});
