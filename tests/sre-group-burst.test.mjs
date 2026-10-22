import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sustainedGroupSuite} from '../fixtures/sustained-group-incidents.mjs';
import {runGroupBurstEvaluation} from '../scripts/lib/group-burst-evaluation.mjs';
import {runConcurrentGroupEvaluation} from '../scripts/lib/concurrent-group-evaluation.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {boundedContext,validateInvestigation} from '../src/sre/reasoner.mjs';
import {triageLogBatch} from '../src/sre/log-triage.mjs';
import {fixtureRisk} from '../src/sre/analytic-risk.mjs';
import {validateCollaboration} from '../src/sre/collaboration.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {sqliteDatabase} from '../src/sre/database.mjs';
import {IncidentWorker} from '../src/sre/worker.mjs';
import {fixtureIncidentConnectors} from '../fixtures/messy-dynatrace-incidents.mjs';
import {seedMessyIncidents} from '../scripts/lib/multi-incident-evaluation.mjs';

test('sustained workload keeps ten incidents, eight source scopes and 32 admitted groups distinct',()=>{
  const suite=sustainedGroupSuite({recordsPerService:6000});
  assert.equal(suite.cases.length,10);assert.equal(suite.services.length,8);assert.equal(suite.groups.length,32);
  assert.equal(new Set(suite.groups.map(g=>g.id)).size,32);
  for(const service of suite.services){validateCollaboration(service.teams);assert.equal(service.rollback.enabled,false);}
  for(let n=0;n<5;n++){
    const a=suite.cases[n],b=suite.cases[n+5];assert.notEqual(a.serviceKey,b.serviceKey);assert.notEqual(a.expected.head,b.expected.head);
    if(a.expected.path)assert.notEqual(a.expected.path,b.expected.path);
  }
});

test('expanded workload doubles scopes/groups, adds messier noise and retains the original useful witnesses and oracle',()=>{
  const parameters={recordsPerService:6000,now:Date.now(),cohorts:4,hotRooms:26},normal=sustainedGroupSuite(parameters),expanded=sustainedGroupSuite({...parameters,messiness:'saturated'});
  assert.equal(expanded.cases.length,20);assert.equal(expanded.services.length,16);assert.equal(expanded.groups.length,64);
  assert.deepEqual(expanded.cases,normal.cases);
  for(const service of expanded.services){validateCollaboration(service.teams);assert.equal(service.rollback.enabled,false);}
  for(const [key,profile]of expanded.profiles){
    const useful=p=>p.records.filter(r=>!['/health','/validation-probe','/readiness'].includes(r['http.route']));
    assert.deepEqual(useful(profile),useful(normal.profiles.get(key)));assert.equal(profile.records.length,normal.profiles.get(key).records.length);
    assert.ok(profile.records.some(r=>r['event.original']));assert.ok(profile.records.some(r=>r.timestamp==='not-a-timestamp'));assert.ok(profile.records.some(r=>r['exception.stacktrace']));
    const operations=new Set(triageLogBatch(profile.batch).groups.map(g=>g.operation));for(const operation of new Set(useful(profile).map(r=>r['http.route'])))assert.ok(operations.has(operation));
  }
  assert.throws(()=>sustainedGroupSuite({cohorts:9}),/fixture scale/);assert.throws(()=>sustainedGroupSuite({hotRooms:33}),/fixture scale/);
});

for(const recordsPerService of [6000,30000])test('independent authored dependency probes survive collection and the bounded model snapshot at '+recordsPerService+' records',async()=>{
  const suite=sustainedGroupSuite({recordsPerService}),store=await new SreStore(sqliteDatabase(':memory:'),{services:suite.services,questionBatchLimit:8}).initialize(),worker=new IncidentWorker({store,services:suite.services,connectors:fixtureIncidentConnectors(suite),reasoner:{mode:'claude'}});
  try{
    const ids=await seedMessyIncidents(store,suite);
    for(const id of ['case-04','case-09']){
      const before=Date.now();await worker.collect(await store.context(ids[id]),new AbortController().signal);
      const context=await store.context(ids[id]),view=boundedContext(context),probe=view.evidence.flatMap(e=>e.content.dependencyProbes||[])[0];
      assert.ok(probe);assert.equal(probe.synthetic,true);assert.equal(probe.statusCode,503);assert.ok(probe.observedAt>=before&&probe.observedAt<=Date.now());
      const stored=context.evidence.find(e=>e.kind==='logs'),projected=view.evidence.find(e=>e.id===stored.id);
      assert.ok(stored.content.rawPages.length>=Math.floor(recordsPerService/500));assert.ok(projected);assert.equal(projected.content.rawPages.length,0);assert.equal(projected.content.rawPageIdsOmitted,stored.content.rawPages.length);
      assert.equal(projected.content.complete,false);assert.equal(view.coverage.queryMetadataIncluded,1);assert.ok(Buffer.byteLength(JSON.stringify(view))<=160000);
    }
  }finally{await worker.close();await store.db.close();}
});

test('older workload directories cannot silently change their pinned evidence contract',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-old-group-eval-'));
  try{
    await writeFile(join(directory,'fixture.json'),JSON.stringify({seed:91573,recordsPerService:6000,now:Date.now()}));
    await assert.rejects(()=>runGroupBurstEvaluation({directory,reasoner:{mode:'claude'}}),/earlier workload contract/);
    await assert.rejects(()=>readFile(join(directory,'state.sqlite')),error=>error.code==='ENOENT');
  }finally{await rm(directory,{recursive:true,force:true});}
});

for(const {concurrent,expanded}of [{concurrent:false,expanded:false},{concurrent:true,expanded:false},{concurrent:true,expanded:true}])test((expanded?'expanded ':'' )+(concurrent?'concurrent':'serial')+' sustained evaluator drains real worker jobs across groups and preserves restart/resume (test-double reasoning)',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-group-burst-')),suite=sustainedGroupSuite({recordsPerService:6000,...(expanded?{cohorts:4,hotRooms:26,messiness:'saturated'}:{})});let calls=0;
  const reasoner={mode:'claude',investigate:async context=>{
    calls++;
    if(concurrent)await delay(30);
    const c=suite.cases.find(c=>c.id===context.incident.issue_key),view=boundedContext(context),source=view.evidence.find(e=>e.content.sourceFiles?.some(f=>f.path===c.expected.path)),evidenceIds=view.evidence.slice(0,3).map(e=>e.id);
    const data={summary:'Synthetic workload check '+c.id,hypotheses:['Test-double judgment only.'],changeAssessment:c.expected.candidate?'likely':'unknown',candidateSha:c.expected.candidate,evidenceIds,unknowns:['No real model used in this unit test.'],nextSteps:['Review independent evidence.'],risk:fixtureRisk(view),codeFindings:c.expected.path?[{provider:'gitlab',path:c.expected.path,sha:c.expected.head,lineStart:c.expected.line,lineEnd:c.expected.line,evidenceId:source.id,explanation:'Test-double source binding.',corroboratingEvidenceIds:evidenceIds}]:[],teamsMessages:[],issueSpec:{title:'Synthetic queue check',problem:'Authored workload.',impact:'Test only.',proposedChange:'Review evidence.',acceptanceCriteria:['Check the independent fixture.'],evidenceIds,openQuestions:['Live model verification remains separate.']},remediation:{kind:c.expected.remediation,targetSha:c.expected.remediation==='rollback-candidate'?c.expected.base:null,rationale:'Synthetic test proposal.',evidenceIds,verificationSteps:['Verify independently.'],blockingUnknowns:['Test only.']}};
    return {analysis:{...validateInvestigation(data,{...context,evidence:view.evidence}),mode:'claude'}};
  }};
  try{
    const evaluate=concurrent?runConcurrentGroupEvaluation:runGroupBurstEvaluation;
    const report=await evaluate({directory,recordsPerService:6000,burstOffsets:[0,1,2],burstIntervalMs:25,hotUpdates:4,maxTurns:expanded?500:60,expanded,reasoner});
    assert.equal(report.model,'test-double');assert.equal(report.status,'passed',JSON.stringify({checks:report.checks,cases:report.cases.map(c=>({case:c.case,checks:c.checks}))}));
    assert.equal(report.metrics.acceptedMessages,expanded?424:212);assert.equal(report.metrics.duplicateDeliveries,expanded?136:68);assert.equal(report.metrics.questions,suite.groups.length);assert.equal(report.metrics.publishedQuestionJobs,suite.groups.length);
    if(!concurrent)assert.ok(report.attempts.some(a=>a.jobStatus==='superseded'||a.jobStatus==='pending'),'new evidence must fence stale model publication');
    if(concurrent){assert.equal(report.metrics.maxActive,4);assert.ok(report.metrics.questionPublicationP95Ms>=0);assert.equal(report.parameters.workloadVersion,7);assert.equal(report.parameters.questionBatchLimit,32);assert.equal(report.checks.boundedRequestBytes,true);assert.equal(report.checks.allQuestionRepliesQueued,true);assert.equal(report.metrics.queuedQuestionReplies,suite.groups.length);}
    assert.equal(report.bursts.length,expanded?72:36);assert.equal(report.groups.filter(g=>g.answered===1).length,suite.groups.length);
    assert.ok(report.events.some(e=>e.type==='restart'));assert.equal(report.metrics.rollbacks,0);
    const before=calls,resumed=await evaluate({directory,reasoner});assert.equal(calls,before);assert.equal(resumed.status,'passed');assert.equal(resumed.attempts.length,report.attempts.length);
    if(concurrent){await assert.rejects(()=>evaluate({directory,reasoner,concurrency:2}),/cannot change concurrency/);await assert.rejects(()=>evaluate({directory,reasoner,expanded:!expanded}),/cannot change its workload/);for(const key of ['citationProtocol','promptHash'])await assert.rejects(()=>evaluate({directory,reasoner:{...reasoner,options:{[key]:'changed'}}}),/citation protocol or prompt hash/);}
    const first=report.attempts[0],inputs=(await readFile(join(directory,'attempts',String(first.number).padStart(3,'0')+'-'+first.case+'-input.json'),'utf8'));
    assert.ok(!inputs.includes('"expected"'));assert.ok(!inputs.includes('"remediation":"rollback-candidate"'));
    const parameters=JSON.parse(await readFile(join(directory,'fixture.json'),'utf8'));
    if(concurrent){for(const field of ['questionBatchLimit','requestBatchMaxBytes']){await writeFile(join(directory,'fixture.json'),JSON.stringify({...parameters,[field]:parameters[field]-1}));await assert.rejects(()=>evaluate({directory,reasoner}),/pinned request batching contract/);}await writeFile(join(directory,'fixture.json'),JSON.stringify(parameters));}
    await writeFile(join(directory,'fixture.json'),JSON.stringify({...parameters,executionModel:'actual-claude'}));
    await assert.rejects(()=>evaluate({directory,reasoner}),/cannot change model providers/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
