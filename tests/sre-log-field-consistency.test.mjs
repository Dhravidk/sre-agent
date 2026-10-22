import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildSignalDigest,selectSignalEvidence,signalDigestText} from '../src/sre/signal-digest.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {incidentScopeFixture} from '../fixtures/sre-incident-scope.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {exportDatabase,importDatabase} from '../src/sre/database-transfer.mjs';

const at=1760000000000,head='a'.repeat(40),other='b'.repeat(40);
const record=extra=>({timestamp:at,level:'ERROR',code:'WINNING_BID_REGRESSED',environment:'production',region:'eu-west-1',sha:head,message:'The accepted higher bid was overwritten',...extra});
const batch=records=>({id:'raw-source',source:'dynatrace',kind:'logs',observed_at:at,content:{records,complete:true}});
const digest=records=>buildSignalDigest({evidence:[batch(records)],deployments:[{provider:'gitlab',sha:head,at:at-1000,status:'success',environment:'production'}]});
const cases=[
 ['contradictory code',{'error.code':'WINNING_BID_REGRESSED',code:'CREDIT_PROVIDER_UNAVAILABLE'},'code:conflict','code',''],
 ['wrong code type',{'error.code':'WINNING_BID_REGRESSED',code:{other:'CREDIT_PROVIDER_UNAVAILABLE'}},'code:type','code',''],
 ['empty competing code',{'error.code':'WINNING_BID_REGRESSED',code:''},'code:type','code',''],
 ['contradictory severity',{level:'INFO',severity:'ERROR'},'level:conflict','level','UNKNOWN'],
 ['wrong severity type',{level:'ERROR',severity:false},'level:type','level','UNKNOWN'],
 ['contradictory environment',{'deployment.environment':'production',environment:'staging'},'environment:conflict','environment',''],
 ['wrong environment type',{environment:42},'environment:type','environment',''],
 ['contradictory region',{'cloud.region':'eu-west-1',region:'us-east-1'},'region:conflict','region',''],
 ['wrong region type',{region:{name:'eu-west-1'}},'region:type','region',''],
 ['contradictory release',{'service.version':head,sha:other},'version:conflict','version',''],
 ['wrong release type',{'service.version':head,sha:42},'version:type','version',''],
];
for(const[name,extra,issue,field,value]of cases)test(name+' is retained without choosing a convenient log alias',()=>{
 const input=record(extra),before=structuredClone(input),d=digest([input]),g=d.groups[0];
 assert.equal(d.coverage.inconsistentMetadataRecords,1);
 assert.ok(g.metadataIssues.includes(issue));assert.equal(g[field],value);
 if(field==='version')assert.deepEqual(g.deploymentMatches,[]);
 assert.match(signalDigestText(d),/unverified log fields/i);
 assert.deepEqual(input,before);
});

test('agreeing aliases, severity casing and blank error fields on a health response stay ordinary observations',()=>{
 const d=digest([record({'error.code':'WINNING_BID_REGRESSED',errorCode:'WINNING_BID_REGRESSED',level:'error',severity:'ERROR','service.version':head}),record({level:'INFO',code:'',errorCode:'',operation:'/health',statusCode:200,message:'Routine probe'})]);
 assert.equal(d.coverage.inconsistentMetadataRecords,0);assert.ok(d.groups.every(g=>g.metadataIssues.length===0));
 assert.equal(d.groups[0].level,'ERROR');assert.equal(d.groups[0].deploymentMatches[0].sha,head);
 assert.ok(d.groups.some(g=>g.statusCode==='200'&&g.code===''));
});
test('missing fields and an unfamiliar but well typed code remain unknown without inventing a schema fault',()=>{
 const d=digest([{timestamp:at,message:'Unfamiliar source shape',newField:'value'},record({code:'UNFAMILIAR_ERROR',region:undefined})]);
 assert.equal(d.coverage.inconsistentMetadataRecords,1,'an explicitly supplied undefined field is malformed');
 const clean=digest([{timestamp:at,message:'Unfamiliar source shape',newField:'value'}, {timestamp:at,code:'UNFAMILIAR_ERROR'}]);
 assert.equal(clean.coverage.inconsistentMetadataRecords,0);assert.ok(clean.groups.every(g=>g.metadataIssues.length===0));
});
test('valid observations and distinct contradictory variants cannot be merged by their preferred alias',()=>{
 for(const records of [[record({}),record({'error.code':'WINNING_BID_REGRESSED',code:'CREDIT_TIMEOUT'}),record({'error.code':'WINNING_BID_REGRESSED',code:'SCHEMA_MISMATCH'})], [record({'error.code':'WINNING_BID_REGRESSED',code:'SCHEMA_MISMATCH'}),record({'error.code':'WINNING_BID_REGRESSED',code:'CREDIT_TIMEOUT'}),record({})]]){
  const d=digest(records);assert.equal(d.groups.length,3);assert.equal(d.coverage.inconsistentMetadataGroups,2);
  assert.equal(d.groups.filter(g=>!g.metadataIssues.length)[0].observations,1);
  assert.equal(new Set(d.groups.map(g=>g.key)).size,3);
 }
});
test('exact repeated malformed records retain overlap counts and their uncertainty',()=>{
 const r=record({level:'INFO',severity:'ERROR'}),d=buildSignalDigest({evidence:[batch([r]),{...batch([r]),id:'overlapping-read'}]});
 assert.equal(d.groups.length,1);assert.equal(d.groups[0].observations,1);assert.equal(d.groups[0].duplicateObservations,1);
 assert.equal(d.coverage.inconsistentMetadataRecords,2);assert.equal(d.coverage.duplicateObservations,1);
});
test('a quiet contradictory severity is retained before routine probe groups under the display limit',()=>{
 const d=digest([...Array.from({length:30},(_,n)=>record({level:'INFO',code:'',operation:'/health',statusCode:200,message:'Routine probe '+n})),record({level:'INFO',severity:'ERROR',code:'UNFAMILIAR_ERROR',message:'QUIET-EXPORTER-CONFLICT'})]);
 assert.ok(d.groups[0].message.includes('QUIET-EXPORTER-CONFLICT'));assert.ok(d.groups[0].metadataIssues.includes('level:conflict'));
 assert.equal(d.coverage.omittedInconsistentMetadataGroups,0);assert.ok(d.coverage.omittedGroups>0);
});
test('omitted contradictory groups remain an explicit coverage gap',()=>{
 const d=digest(Array.from({length:20},(_,n)=>record({level:'INFO',severity:'ERROR',code:'UNKNOWN_'+n,message:'Distinct conflict '+n})));
 assert.equal(d.coverage.inconsistentMetadataGroups,20);assert.equal(d.coverage.omittedInconsistentMetadataGroups,8);
 assert.match(signalDigestText(d),/20 records with unverified log fields/);
});
test('a health response with contradictory region fields cannot enter the safe informational omission count',()=>{
 const d=digest(Array.from({length:20},(_,n)=>record({level:'INFO',code:'',operation:'/health',statusCode:200,'cloud.region':'eu-west-1',region:'us-east-1',message:'Probe '+n})));
 assert.equal(d.coverage.omittedGroups,8);assert.equal(d.coverage.omittedHealthSuccessGroups,0);assert.equal(d.coverage.omittedInconsistentMetadataGroups,8);
});
test('host monitor selection cannot collapse contradictory variants into the valid preferred signature',()=>{
 const rows=[record({}),record({'error.code':'WINNING_BID_REGRESSED',code:'CREDIT_TIMEOUT'}),record({'error.code':'WINNING_BID_REGRESSED',code:'SCHEMA_MISMATCH'})].map((r,n)=>({...batch([r]),id:'monitor-'+n,source:'log-monitor',kind:'problem'}));
 assert.equal(selectSignalEvidence(rows).selected.length,3);
});
test('bounded model context preserves field uncertainty and only available source citations',()=>{
 const evidence=[batch([record({level:'INFO',severity:'ERROR'})])],d=buildSignalDigest({evidence}),model=boundedContext({incident:{id:'fixture'},session:{agent_id:'fixture'},evidence,deployments:[],signalDigest:d});
 assert.equal(model.signalDigest.coverage.inconsistentMetadataRecords,1);
 assert.ok(model.signalDigest.groups[0].metadataIssues.includes('level:conflict'));
 assert.deepEqual(model.signalDigest.groups[0].evidenceIds,['raw-source']);
});

async function addContradiction(f,extra={}){
 const time=await f.r.store.coordinationNow();
 return f.r.store.addEvidence(f.state.primaryId,'dynatrace','logs',{records:[record({timestamp:time-1,environment:f.service.environment,sha:f.state.badSha,'error.code':'WINNING_BID_REGRESSED',code:'CREDIT_PROVIDER_UNAVAILABLE',message:'CONFLICTING-EXPORTER-FIELDS: inspect the mapping before selecting a cause',...extra})],complete:true},time);
}
for(const dialect of ['sqlite','postgres']){
 test(dialect+': new field warnings require a fresh cached assessment and independently stop an approved saved patch',async()=>{
  const f=await incidentScopeFixture(dialect);let executions=0;try{
   const plan=await f.r.casework.createPlan(f.state.primaryId),room=f.state.primaryRooms[0],key=conversationKey(f.service.teams.tenantId,room),principal={verified:true,tenant:f.service.teams.tenantId,userId:f.service.teams.approvers[0],conversationId:room};
   f.r.casework.qaAdapter={localOnly:true,execute:async()=>{executions++;throw Error('Uncertain patch must not execute');}};
   const request=await f.r.casework.proposeFix(f.state.primaryId,plan.id,principal,key,'before-mapping-change');
   await f.r.casework.approveFix(request.id,request.nonce,principal,key);
   await addContradiction(f);
   // Source collection can add evidence before a queued investigation runs.
   // Revision-only checks must not certify the cached older interpretation.
   const c=await f.r.store.context(f.state.primaryId);assert.equal(Number(c.incident.revision),plan.payload.revision);assert.equal(c.incident.analysis.changeAssessment,'likely');
   await assert.rejects(()=>f.r.casework.createPlan(f.state.primaryId),/fresh investigation/);
   await assert.rejects(()=>f.r.casework.proposeFix(f.state.primaryId,plan.id,principal,key,'after-mapping-change'),/log fields/);
   assert.equal(await f.r.casework.runOnce(),true);assert.equal(executions,0);
   const [row]=await f.r.store.db.query('SELECT status,error FROM sre_fix_requests WHERE id=?',[request.id]);assert.equal(row.status,'failed');assert.match(row.error,/log fields/);
   assert.equal(await f.r.casework.runOnce(),false);assert.equal((await f.r.casework.getPlan(plan.id,f.state.primaryId)).markdown,plan.markdown);
  }finally{await f.close();}
 });
 for(const[name,extra]of [['code',{}],['severity',{'error.code':'WINNING_BID_REGRESSED',code:'WINNING_BID_REGRESSED',level:'INFO',severity:'ERROR'}],['wrong type',{'error.code':'WINNING_BID_REGRESSED',code:{foreign:'CREDIT_PROVIDER_UNAVAILABLE'}}]])test(dialect+': '+name+' uncertainty blocks a patch while retaining the actual source finding',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   const old=await f.r.casework.createPlan(f.state.primaryId);assert.ok(old.payload.patch);
   const id=await addContradiction(f,extra);await f.question();await f.settle();
   const c=await f.r.store.context(f.state.primaryId),p=await f.r.casework.createPlan(f.state.primaryId);
   assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.equal(c.incident.analysis.candidateSha,null);
   assert.ok(c.incident.analysis.codeReview.findings.some(f=>f.path==='src/auction/rules.mjs'));
   assert.ok(c.incident.analysis.unknowns.some(s=>/contradictory or malformed log fields/i.test(s)));
   assert.ok(c.incident.analysis.evidenceIds.includes(id));assert.equal(p.payload.patch,null);
   assert.match(p.markdown,/Unverified log fields/);assert.equal((await f.r.casework.getPlan(old.id,f.state.primaryId)).markdown,old.markdown);
   assert.equal((await f.r.casework.snapshot(f.state.primaryId)).plans.find(p=>p.id===old.id).current,false);
   assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
  }finally{await f.close();}
 });
 test(dialect+': two teams retain conflicting reports and the quiet field warning; the other incident keeps its participant scope',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   await f.message(f.state.primaryId,f.state.primaryRooms[0],'report blocked LOG-FIELDS-AVERY: exact bid reproduction still fails.','avery');
   await f.message(f.state.primaryId,f.state.primaryRooms[1],'report recovered LOG-FIELDS-NOOR: probes pass, but exporter aliases disagree.','noor');
   await f.message(f.state.providerId,f.state.providerRooms[0],'update OTHER-INCIDENT-PARTICIPANT: separate provider review.','alex');
   await addContradiction(f);await f.question();await f.settle();await f.message(f.state.primaryId,f.state.primaryRooms[0],'sync');await f.deliver();
   const c=await f.r.store.context(f.state.primaryId),p=await f.r.casework.createPlan(f.state.primaryId);
   assert.ok(c.collaboration.issues.some(i=>i.code==='reported-state-disagreement'));
   for(const room of f.state.primaryRooms.slice(0,2)){
    assert.ok(f.sent.some(m=>m.room===room&&/unverified log fields/i.test(m.text)));
    assert.ok(f.sent.some(m=>m.room===room&&m.text.includes('LOG-FIELDS-AVERY')&&m.text.includes('LOG-FIELDS-NOOR')));
    assert.ok(f.sent.filter(m=>m.room===room).every(m=>!m.text.includes('OTHER-INCIDENT-PARTICIPANT')));
   }
   assert.match(p.markdown,/LOG-FIELDS-AVERY/);assert.match(p.markdown,/LOG-FIELDS-NOOR/);assert.equal(p.payload.patch,null);
   assert.equal((await f.r.store.context(f.state.providerId)).incident.analysis.codeReview.findings.length,0);
   assert.equal((await f.r.store.db.query('SELECT id FROM sre_fix_requests')).length,0);
  }finally{await f.close();}
 });
 test(dialect+': a later clean source page cannot erase retained contradictory observations',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   const id=await addContradiction(f);await f.question();await f.settle();const time=await f.r.store.coordinationNow();
   await f.r.store.addEvidence(f.state.primaryId,'dynatrace','logs',{records:[record({timestamp:time,environment:f.service.environment,sha:f.state.badSha})],complete:true},time);
   await f.question();await f.settle();const c=await f.r.store.context(f.state.primaryId);
   assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.ok(c.evidence.some(e=>e.id===id));assert.equal(c.signalDigest.coverage.inconsistentMetadataRecords,1);
  }finally{await f.close();}
 });
}
test('file reopen preserves the contradictory source and ticket without manufacturing a patch or redoing action work',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sre-log-fields-')),f=await incidentScopeFixture('sqlite',{path:join(directory,'agent.sqlite')});try{
  await addContradiction(f);await f.question();await f.settle();const p=await f.r.casework.createPlan(f.state.primaryId),rows=await f.r.store.db.query('SELECT * FROM sre_evidence ORDER BY id');
  await f.restart();assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_evidence ORDER BY id'),rows);
  assert.equal((await f.r.casework.getPlan(p.id,f.state.primaryId)).markdown,p.markdown);
  assert.equal((await f.r.store.context(f.state.primaryId)).signalDigest.coverage.inconsistentMetadataRecords,1);
  assert.equal((await f.r.store.db.query('SELECT id FROM sre_fix_requests')).length,0);
 }finally{await f.close();await rm(directory,{recursive:true,force:true});}
});
for(const[from,to]of [['sqlite','postgres'],['postgres','sqlite']])test(from+' → '+to+': contradictory logs and immutable tickets survive adapter transfer under restore hold',async()=>{
 const source=await incidentScopeFixture(from),target=await incidentScopeFixture(to,{initialize:false});try{
  await addContradiction(source);await source.question();await source.settle();const p=await source.r.casework.createPlan(source.state.primaryId);
  const actor={kind:'local-operator',id:'Fictional log mapping reviewer'},archive=await exportDatabase(source.r.store,{offline:true,actor});
  await importDatabase(target.r.store,{snapshot:archive.snapshot,expectedSha256:archive.sha256,restoreId:'log-field-cutover',reason:'Fictional log consistency cutover',offline:true,actor});
  const c=await target.r.store.context(source.state.primaryId);assert.equal(c.recoveryFence.active,true);assert.equal(c.signalDigest.coverage.inconsistentMetadataRecords,1);
  assert.equal((await target.r.casework.getPlan(p.id,source.state.primaryId)).markdown,p.markdown);assert.equal(await target.r.outbox.runOnce(),false);
 }finally{await source.close();await target.close();}
});
