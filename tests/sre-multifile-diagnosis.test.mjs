import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {multifileRepositoryFixture} from '../fixtures/large-repo-diagnosis.mjs';
import {seedDiagnosisFixture} from '../fixtures/dynatrace-gitlab-diagnosis.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {EvidenceFollowup} from '../src/sre/evidence-followup.mjs';
import {sourceReadBudget} from '../src/sre/source-evidence.mjs';
import {diagnosisEvaluationChecks} from '../scripts/lib/diagnosis-evaluation-checks.mjs';

test('a caller/adapter/helper investigation navigates five large source sides beyond lexical decoys and survives SQL reopening within the HTTP/byte caps',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'multifile-diagnosis-'));let runtime;
 try{
  const fixture=await multifileRepositoryFixture(directory,{records:2000,fileCount:400,caseId:'chain-c02'}),state=fixture.states[0],budget=sourceReadBudget(),options={config:fixture.config,connectors:fixture.connectors,autoStart:false,reasoner:{mode:'codex',investigate:()=>{throw Error('Offline transport test never invokes a model');}}};
  runtime=await createSreRuntime(options);await seedDiagnosisFixture(runtime,fixture);const job=await runtime.store.claim('multi-file-unit');await runtime.worker.collect(await runtime.store.context(state.incidentId),new AbortController().signal,budget,job);
  let context=await runtime.store.context(state.incidentId),view=boundedContext(context);assert.ok(budget.reads>=4);assert.ok(budget.bytes>=48000);assert.equal(budget.initialReservation,undefined);assert.ok(view.sourceCode.files.length>0);assert.ok(!view.sourceCode.files.some(file=>[state.entry.entryPath,state.entry.adapterPath,state.entry.path].includes(file.path)));assert.ok(!JSON.stringify(view).includes(fixture.gold[0].mechanism));assert.ok(!JSON.stringify(view).includes('actual":1100'));
  const followup=new EvidenceFollowup({store:runtime.store,job,service:state.service,clients:fixture.connectors.get(state.service.key),sourceBudget:budget});await followup.policy(context,0);
  const file=(path,stage)=>({kind:'gitlab_file',project:state.entry.project,sha:state.entry.revisions[stage],path,startLine:1,endLine:5,reason:'Compare the imported implementation and its exact prior version'});
  await followup.run([{kind:'dynatrace_logs',from:state.at-300000,to:state.at+100,filters:[{field:'http.route',value:'/process/discounting'}],reason:'Compare business input and output across both exact releases'},file(state.entry.entryPath,'observed')],context,0);
  context=await runtime.store.context(state.incidentId);await followup.policy(context,1);await followup.run([file(state.entry.adapterPath,'observed'),file(state.entry.adapterPath,'base')],context,1);
  context=await runtime.store.context(state.incidentId);await followup.policy(context,2);await followup.run([file(state.entry.path,'observed'),file(state.entry.path,'base')],context,2);context=await runtime.store.context(state.incidentId);view=boundedContext(context);
  assert.equal(followup.results.filter(row=>row.phase==='collected').length,6);assert.equal(followup.used,6);assert.equal(followup.logQueries,1);assert.ok(budget.reads>=0);assert.ok(budget.bytes>=0);
  for(const [path,stage]of [[state.entry.path,'observed'],[state.entry.path,'base'],[state.entry.adapterPath,'observed'],[state.entry.adapterPath,'base']])assert.ok(view.sourceCode.files.some(file=>file.path===path&&file.sha===state.entry.revisions[stage]));
  const reads=fixture.calls.filter(call=>call.path?.includes('/repository/files/'));assert.ok(reads.length<=8);assert.ok(reads.some(call=>call.responseBytes>8000));assert.ok(64000-budget.bytes<=64000);
  assert.equal(fixture.gold[0].compositions.length,2);assert.ok(fixture.gold[0].compositions.every(row=>row.matchesExpected&&!row.invariantPasses),'Neither one-file counterfactual correction meets the authored contract');
  const before=fixture.calls.length,sources=context.sourceCode;await runtime.close();runtime=await createSreRuntime(options);assert.deepEqual((await runtime.store.context(state.incidentId)).sourceCode,sources);assert.equal(fixture.calls.length,before);assert.equal((await runtime.store.db.query('SELECT id FROM sre_rollbacks')).length,0);
 }finally{await runtime?.close();await rm(directory,{recursive:true,force:true});}
});

test('multi-file accuracy requires both culprit locations and rejects a healthy caller or an old-release accusation',()=>{
 const sha='b'.repeat(40),old='a'.repeat(40),sources=[{path:'services/domain/adapter.mjs',line:3},{path:'packages/domain/rules/helper.mjs',line:2}],state={entry:{project:'fixture/domain',revisions:{base:old,observed:sha}},expected:{source:sources[0],sources,sourceAvailable:true,findingRevisions:[sha],remediation:['forward-fix'],candidate:sha,target:null,attribution:'likely'}},context={evidence:[{id:'logs',kind:'logs',content:{followUp:{}}}]},findings=sources.map(source=>({provider:'gitlab',project:'fixture/domain',path:source.path,sha,startLine:source.line,endLine:source.line})),analysis={mode:'codex',sourceFindings:findings,changeAssessment:'likely',candidateSha:sha,evidenceIds:['logs'],remediation:{kind:'forward-fix',targetSha:null},issueSpec:{acceptanceCriteria:['A one-file change must not mask the other fault'],openQuestions:['Confirm runtime binding']}};
 const check=sourceFindings=>diagnosisEvaluationChecks({analysis:{...analysis,sourceFindings},context,state,provider:'codex'}).checks;
 assert.equal(Object.values(check(findings)).every(Boolean),true);assert.equal(check([findings[0]]).exactSource,false);assert.equal(check([findings[1]]).exactSource,false);assert.equal(check([...findings,{...findings[0],path:'services/edge/dispatch.mjs'}]).noFalseCandidateFiles,false);assert.equal(check([...findings,{...findings[0],sha:old}]).noFalseCandidateFiles,false);
});
