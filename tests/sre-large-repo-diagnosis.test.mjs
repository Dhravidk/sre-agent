import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {largeRepositoryFixture} from '../fixtures/large-repo-diagnosis.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {EvidenceFollowup} from '../src/sre/evidence-followup.mjs';
import {sourceReadBudget,readImmutableSource} from '../src/sre/source-evidence.mjs';
import {diagnosisEvaluationChecks} from '../scripts/lib/diagnosis-evaluation-checks.mjs';

for(const enabled of [true,false])test('large multi-file collection '+(enabled?'reserves a callee comparison for follow-ups':'keeps the ordinary budget when follow-ups are disabled'),async()=>{
 const directory=await mkdtemp(join(tmpdir(),'large-diagnosis-'));let runtime;
 try{
  const fixture=await largeRepositoryFixture(directory,{records:1000,fileCount:400,caseId:'sample-01'}),state=fixture.states[0],budget=sourceReadBudget();state.service.investigation.followUp.enabled=enabled;
  const options={config:fixture.config,connectors:fixture.connectors,autoStart:false,reasoner:{mode:'codex',investigate:()=>{throw Error('Offline fixture checks never invoke a model');}}};runtime=await createSreRuntime(options);
  const {incidentId}=await runtime.store.ingest({id:'large-diagnosis',source:'operator-api',serviceKey:state.service.key,kind:'problem',issueKey:'large-diagnosis',status:'OPEN',at:state.at,payload:{synthetic:true}}),job=await runtime.store.claim('large-diagnosis');
  await runtime.worker.collect(await runtime.store.context(incidentId),new AbortController().signal,budget,job);
  let context=await runtime.store.context(incidentId);const view=boundedContext(context);
  const initialReads=fixture.calls.filter(call=>call.path?.includes('/repository/files/')).length;
  assert.ok(enabled?budget.reads>=4:budget.reads===0);assert.equal(budget.initialReservation,undefined);assert.equal(initialReads+budget.reads,8);
  assert.ok(view.sourceCode.files.every(file=>file.path!==state.entry.path));assert.ok(view.sourceCode.files.some(file=>file.path===state.entry.entryPath));
  assert.ok(!JSON.stringify(view).includes(fixture.gold[0].mechanism));assert.ok(!JSON.stringify(view).includes('actual":2000'));
  if(enabled){
   const followup=new EvidenceFollowup({store:runtime.store,job,service:state.service,clients:fixture.connectors.get(state.service.key),sourceBudget:budget}),policy=await followup.policy(context,0);
   assert.equal(policy.source.remainingReads,budget.reads);assert.ok(policy.source.remainingBytes>=48000);
   await followup.run([{kind:'dynatrace_logs',from:state.at-300000,to:state.at+100,filters:[{field:'http.route',value:'/process/checkout'}],reason:'Compare old and new business outcomes'},{kind:'gitlab_tree',project:state.entry.project,sha:state.entry.revisions.observed,path:'packages/checkout/rules',reason:'Verify the imported helper directory within the fixed project'}],context,0);
   context=await runtime.store.context(incidentId);await followup.policy(context,1);
   await followup.run(['base','observed'].map(stage=>({kind:'gitlab_file',project:state.entry.project,sha:state.entry.revisions[stage],path:state.entry.path,startLine:1,endLine:3,reason:'Inspect the imported helper at each exact release'})),context,1);
   context=await runtime.store.context(incidentId);
   assert.equal(context.evidence.find(row=>row.kind==='logs'&&row.content.followUp).content.records.length,6);
   const files=context.sourceCode.files.filter(file=>file.path===state.entry.path);assert.equal(files.length,2);assert.deepEqual(new Set(files.map(file=>file.sha)),new Set(Object.values(state.entry.revisions)));assert.ok(context.sourceInventories.inventories.some(row=>row.project===state.entry.project&&row.entries.some(file=>file.path===state.entry.path)));
   assert.equal(budget.reads,policy.source.remainingReads-2);assert.equal(fixture.calls.filter(call=>call.path?.includes('/repository/files/')).length,initialReads+2);
  }
  const previous={reads:1,bytes:1000},cancelled=sourceReadBudget();cancelled.initialReservation=previous;
  await assert.rejects(()=>runtime.worker.collect(context,AbortSignal.abort(Error('collection cancelled')),cancelled,job),/cancelled/);assert.equal(cancelled.initialReservation,previous);assert.equal(cancelled.reads,8);
  if(enabled){const calls=fixture.calls.length,files=context.sourceCode.files.filter(file=>file.path===state.entry.path);await runtime.close();runtime=await createSreRuntime(options);const reopened=await runtime.store.context(incidentId);assert.deepEqual(reopened.sourceCode.files.filter(file=>file.path===state.entry.path),files);assert.deepEqual(reopened.sourceInventories,context.sourceInventories);assert.equal(fixture.calls.length,calls);}
 }finally{await runtime?.close();await rm(directory,{recursive:true,force:true});}
});

test('initial and pending-file reservations compose without caching a deferred read or replenishing consumed attempts',async()=>{
 const budget=sourceReadBudget(),service={key:'reservation',environment:'testing',gitlab:{base:'https://fixture.invalid',project:'fixture/reservation',sourceInspection:{enabled:true}}},sha='a'.repeat(40),calls=[],client={file:async(path,sha)=>{calls.push(path);if(path==='denied.mjs')throw Error('403 denied');return{path,sha,complete:true,content:'x'.repeat(15000)};}};
 budget.reads=3;budget.initialReservation={reads:2,bytes:32000};
 const deferred=await readImmutableSource('helper.mjs',sha,{service,client,budget,reserveReads:1,reserveBytes:16000});assert.equal(deferred.state,'unavailable');assert.equal(calls.length,0);assert.equal(budget.files.size,0);
 const denied=await readImmutableSource('denied.mjs',sha,{service,client,budget});assert.equal(denied.state,'unavailable');assert.equal(budget.reads,2);
 assert.equal((await readImmutableSource('helper.mjs',sha,{service,client,budget})).state,'unavailable');assert.equal(budget.files.size,1);
 delete budget.initialReservation;
 assert.equal((await readImmutableSource('helper.mjs',sha,{service,client,budget})).state,'available');assert.equal(budget.reads,1);
 assert.equal((await readImmutableSource('denied.mjs',sha,{service,client,budget})).state,'unavailable');assert.equal(calls.length,2);assert.equal(budget.reads,1);
 budget.bytes=32000;budget.initialReservation={reads:0,bytes:32000};assert.equal((await readImmutableSource('later.mjs',sha,{service,client,budget})).state,'unavailable');delete budget.initialReservation;
 assert.equal((await readImmutableSource('later.mjs',sha,{service,client,budget})).state,'available');assert.equal(budget.bytes,17000);assert.equal(budget.reads,0);
});

test('accuracy scoring rejects a decoy accusation even when the correct helper is also found',()=>{
 const sha='b'.repeat(40),path='packages/domain/rules/helper.mjs',finding={provider:'gitlab',project:'fixture/domain',path,sha,startLine:2,endLine:2},state={entry:{project:'fixture/domain',revisions:{base:'a'.repeat(40),observed:sha}},expected:{source:{path,line:2},sourceAvailable:true,remediation:['forward-fix'],candidate:sha,target:null,attribution:'likely'}},context={evidence:[{id:'logs',kind:'logs',content:{followUp:{}}}]},analysis={mode:'codex',sourceFindings:[finding],changeAssessment:'likely',candidateSha:sha,evidenceIds:['logs'],remediation:{kind:'forward-fix',targetSha:null},issueSpec:{acceptanceCriteria:['Boundary and unaffected inputs'],openQuestions:['Confirm runtime identity']}};
 const score=overrides=>diagnosisEvaluationChecks({analysis:{...analysis,...overrides},context,state,provider:'codex'}).checks;
 assert.equal(Object.values(score({})).every(Boolean),true);
 const decoy=score({sourceFindings:[finding,{...finding,path:'packages/other/rules/helper.mjs'}]});assert.equal(decoy.exactSource,true);assert.equal(decoy.noFalseCandidateFiles,false);
 assert.equal(score({sourceFindings:[{...finding,sha:state.entry.revisions.base}]}).exactSource,false);
 assert.equal(score({sourceFindings:[{...finding,project:'foreign/domain'}]}).noFalseCandidateFiles,false);
 assert.equal(score({remediation:{kind:'rollback-candidate',targetSha:sha}}).recoveryStrategy,false);assert.equal(score({remediation:{kind:'rollback-candidate',targetSha:sha}}).rollbackTarget,false);
});
