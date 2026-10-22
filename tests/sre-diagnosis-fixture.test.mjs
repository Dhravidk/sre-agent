import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {diagnosisFixture,seedDiagnosisFixture} from '../fixtures/dynatrace-gitlab-diagnosis.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {EvidenceFollowup} from '../src/sre/evidence-followup.mjs';
import {sourceReadBudget} from '../src/sre/source-evidence.mjs';
import {RulesReasoner} from '../src/sre/reasoner.mjs';

test('diagnostic evidence flow retrieves actual authored code outcomes hidden by the noisy initial sample without leaking gold or invoking a model',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'diagnosis-fixture-'));let r;
 try{
  const fixture=await diagnosisFixture(directory,{records:1000,caseId:'case-01'}),state=fixture.states[0],budget=sourceReadBudget();
  r=await createSreRuntime({config:fixture.config,connectors:fixture.connectors,autoStart:false,reasoner:{mode:'codex',investigate:()=>{throw Error('This test must not invoke inference');}}});
  const {incidentId}=await r.store.ingest({id:'diagnosis-contract-test',source:'operator-api',serviceKey:state.service.key,kind:'problem',issueKey:'diagnostic-fixture',status:'OPEN',at:state.at,payload:{synthetic:true}}),job=await r.store.claim('diagnosis-contract-test');
  await r.worker.collect(await r.store.context(incidentId),new AbortController().signal,budget,job);let context=await r.store.context(incidentId),snapshot=boundedContext(context),input=JSON.stringify(snapshot);
  assert.ok(!input.includes(fixture.gold[0].mechanism));assert.ok(!input.includes(state.entry.revisions.followUp));assert.ok(!input.includes('actualAttempts'));assert.ok(snapshot.sourceCode.files.some(file=>file.sha===state.entry.revisions.observed&&file.path===state.entry.path));
  const followup=new EvidenceFollowup({store:r.store,job,service:state.service,clients:fixture.connectors.get(state.service.key),sourceBudget:budget});await followup.policy(context,0);
  await followup.run([{kind:'dynatrace_logs',from:state.at-300000,to:state.at+100,filters:[{field:'http.route',value:'/api/requests'}],reason:'Compare exact release request behavior'}],context,0);
  context=await r.store.context(incidentId);const rows=context.evidence.find(row=>row.kind==='logs'&&row.content.followUp).content.records;
  assert.equal(rows.length,6);assert.equal(rows.filter(row=>row['service.version']===state.entry.revisions.base).every(row=>JSON.parse(row.content).actualAttempts===1),true);assert.equal(rows.filter(row=>row['service.version']===state.entry.revisions.observed).every(row=>JSON.parse(row.content).actualAttempts===3),true);
  assert.equal(fixture.calls.filter(call=>call.kind==='dynatrace').length,1);assert.ok(fixture.calls.filter(call=>call.kind==='gitlab').every(call=>call.method==='GET'));assert.equal((await r.store.db.query('SELECT id FROM sre_rollbacks')).length,0);
 }finally{await r?.close();await rm(directory,{recursive:true,force:true});}
});

test('offline evaluation intake creates one job per case and visits every incident without replaying earlier cases',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'diagnosis-intake-'));let r;
 try{
  const fixture=await diagnosisFixture(directory,{records:1000}),visited=[],rules=new RulesReasoner();
  r=await createSreRuntime({config:fixture.config,connectors:fixture.connectors,autoStart:false,reasoner:{mode:'codex',investigate:async(...args)=>{visited.push(args[0].incident.id);return rules.investigate(...args);}}});
  await seedDiagnosisFixture(r,fixture);assert.equal((await r.store.db.query('SELECT id FROM sre_jobs')).length,6);
  for(let index=0;index<6;index++)await r.worker.runOnce();
  assert.deepEqual(new Set(visited),new Set(fixture.states.map(state=>state.incidentId)));assert.equal(visited.length,6);assert.equal((await r.store.db.query("SELECT id FROM sre_jobs WHERE status!='done'")).length,0);
  for(const state of fixture.states)assert.equal((await r.store.context(state.incidentId)).incident.analysis.mode,'rules','Offline queue verification is never an actual-model diagnosis score');
 }finally{await r?.close();await rm(directory,{recursive:true,force:true});}
});
