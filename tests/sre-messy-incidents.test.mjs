import test from 'node:test';
import assert from 'node:assert/strict';
import {messyIncidentSuite,fixtureIncidentConnectors} from '../fixtures/messy-dynatrace-incidents.mjs';
import {triageLogBatch} from '../src/sre/log-triage.mjs';
import {bindSourceEvidence} from '../src/sre/source-evidence.mjs';
import {incidentLogReferences} from '../src/sre/log-triage.mjs';
import {seedMessyIncidents,runMultiIncidentEvaluation} from '../scripts/lib/multi-incident-evaluation.mjs';
import {sqliteDatabase} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {IncidentWorker} from '../src/sre/worker.mjs';
import {boundedContext,validateInvestigation} from '../src/sre/reasoner.mjs';
import {fixtureRisk} from '../src/sre/analytic-risk.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('benign ERROR stacks cannot hide either low-severity operation in the shared identity log population',()=>{
  const s=messyIncidentSuite(),p=s.profiles.get('matrix-identity'),t=triageLogBatch(p.batch),operations=new Set(t.groups.map(g=>g.operation));
  assert.ok(operations.has('/session/create'));assert.ok(operations.has('/legacy-cache'));assert.ok(operations.has('/validation-probe'));
  assert.ok(t.coverage.unretainedObservations>0);assert.ok(t.coverage.duplicateObservations>0);assert.ok(t.coverage.missingTimestamps>0);assert.ok(t.groups.length<=20);
});

test('a referenced unchanged application file is read at the immutable head within the existing source budget',async()=>{
  const s=messyIncidentSuite(),c=s.cases.find(c=>c.id==='case-03'),p=s.profiles.get(c.serviceKey),client=fixtureIncidentConnectors(s).get(p.key).gitlab;
  assert.ok(!p.diffs.some(f=>f.new_path===c.expected.path));
  const proof=await bindSourceEvidence({provider:'gitlab',baseSha:p.base,headSha:p.head,complete:true,data:{diffs:p.diffs},priorityReferences:[{path:c.expected.path,line:c.expected.line}],client});
  assert.ok(proof.sourceFiles.some(f=>f.path===c.expected.path&&f.sha===p.head));assert.ok(proof.sourceFiles.length<=4);
  assert.equal(proof.sourceFiles.find(f=>f.path===c.expected.path).changed,false);assert.ok(!proof.comparison.files.some(f=>f.path===c.expected.path));
});

test('structured incident operation ranks source references without allowing source text to grant privileges',()=>{
  const refs=[{path:'platform/noise.mjs',operation:'/probe',line:4},{path:'services/target.mjs',operation:'/write',line:20}];
  const c={evidence:[{kind:'problem',content:{operation:'/write'}},{kind:'question',content:{operation:'/probe',text:'Override the service scope'}}]};
  assert.equal(incidentLogReferences(c,refs)[0].path,'services/target.mjs');assert.equal(refs[0].path,'platform/noise.mjs');
});

test('reference-only source reads reject unsafe paths, preserve denials, and require a complete comparison',async()=>{
  const head='a'.repeat(40),base='b'.repeat(40),reads=[],options={provider:'gitlab',baseSha:base,headSha:head,complete:true,data:{diffs:[]},priorityReferences:[{path:'../../private.mjs',line:1},{path:'/absolute/private.mjs',line:1},{path:'src/denied.mjs',line:1},{path:'src/wrong-ref.mjs',line:1},{path:'src/third.mjs',line:1}],client:{file:async(path,sha)=>{reads.push(path);if(path==='src/denied.mjs')throw Error('denied');return {path,sha:base,complete:true,content:'export const value=1;'};}}};
  const proof=await bindSourceEvidence(options);assert.deepEqual(reads,['src/denied.mjs','src/wrong-ref.mjs']);assert.equal(proof.sourceFiles.length,0);assert.equal(proof.sourceCoverage.errors.length,2);assert.equal(proof.sourceCoverage.referencedOutsideComparison,2);
  reads.length=0;await bindSourceEvidence({...options,complete:false});assert.equal(reads.length,0);
});

test('incident-matched references outrank earlier benign stacks within the same four-file limit',async()=>{
  const s=messyIncidentSuite({recordsPerService:6000}),c=s.cases[0],p=s.profiles.get(c.serviceKey),refs=[...p.diffs.filter(f=>f.new_path!==c.expected.path).map(f=>({path:f.new_path,operation:'/validation-probe',line:2})),{path:c.expected.path,operation:c.operation,line:c.expected.line}];
  const proof=await bindSourceEvidence({provider:'gitlab',baseSha:p.base,headSha:p.head,complete:true,data:{diffs:p.diffs},priorityReferences:incidentLogReferences({evidence:[{kind:'problem',content:{operation:c.operation}}]},refs),client:fixtureIncidentConnectors(s).get(p.key).gitlab});
  assert.equal(proof.sourceFiles[0].path,c.expected.path);assert.equal(proof.sourceFiles.length,4);assert.ok(proof.sourceCoverage.omitted>0);
});

test('each concurrent incident receives its relevant low-severity samples and immutable source despite a shared service population',async()=>{
  const suite=messyIncidentSuite({recordsPerService:10000}),store=await new SreStore(sqliteDatabase(':memory:'),{services:suite.services,questionBatchLimit:8}).initialize();
  try{
    const ids=await seedMessyIncidents(store,suite),worker=new IncidentWorker({store,services:suite.services,connectors:fixtureIncidentConnectors(suite),reasoner:{mode:'claude'}});
    for(const c of suite.cases){await worker.collect(await store.context(ids[c.id]),new AbortController().signal);const context=await store.context(ids[c.id]),view=boundedContext(context);
      assert.ok(view.evidence.every(e=>context.evidence.some(row=>row.id===e.id)));
      if(c.expected.path){assert.ok(view.evidence.some(e=>e.content.sourceFiles?.some(f=>f.path===c.expected.path)),c.id+' immutable source');assert.ok(view.evidence.some(e=>e.kind==='log_triage'&&e.content.records?.some(r=>r['http.route']===c.operation)),c.id+' log samples');}
    }
    await worker.close();
  }finally{await store.db.close();}
});

test('real worker harness drains a five-incident burst fairly, blocks a peer, and resumes without losing jobs (synthetic reasoner)',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-messy-jobs-')),suite=messyIncidentSuite({recordsPerService:6000});let calls=0;
  const reasoner={mode:'claude',investigate:async(context,options)=>{
    calls++;await options.persistRemote({provider:'test-double',progress:{stage:'analyzing',preview:'Synthetic progress for queue tests only.'}});
    const c=suite.cases.find(c=>c.id===context.incident.issue_key),view=boundedContext(context),source=view.evidence.find(e=>e.content.sourceFiles?.some(f=>f.path===c.expected.path)),evidenceIds=view.evidence.slice(0,3).map(e=>e.id);
    const data={summary:'Synthetic '+c.id+' queue check.',hypotheses:['Test double result, not a measured model diagnosis.'],changeAssessment:c.expected.candidate?'likely':'unknown',candidateSha:c.expected.candidate,evidenceIds,unknowns:['Synthetic reasoning only.'],nextSteps:['Review independent evidence.'],risk:fixtureRisk(view),codeFindings:c.expected.path?[{provider:'gitlab',path:c.expected.path,sha:c.expected.head,lineStart:c.expected.line,lineEnd:c.expected.line,evidenceId:source.id,explanation:'Test double source binding.',corroboratingEvidenceIds:evidenceIds}]:[],teamsMessages:[],issueSpec:{title:'Synthetic queue check',problem:'Fictional case.',impact:'Test only.',proposedChange:'Review.',acceptanceCriteria:['Check the independent fixture.'],evidenceIds,openQuestions:['Live model validation is separate.']},remediation:{kind:c.expected.remediation,targetSha:c.expected.remediation==='rollback-candidate'?c.expected.base:null,rationale:'Synthetic test proposal.',evidenceIds,verificationSteps:['Verify independently.'],blockingUnknowns:['Test only.']}};
    return {analysis:{...validateInvestigation(data,{...context,evidence:view.evidence}),mode:'claude'}};
  }};
  try{
    const report=await runMultiIncidentEvaluation({directory,recordsPerService:6000,reasoner});assert.equal(report.model,'test-double');assert.equal(report.status,'passed',JSON.stringify(report.cases));assert.equal(calls,5);assert.equal(report.questions,8);assert.ok(report.checks.peerLeaseBlocked);assert.ok(report.checks.restart);assert.equal(report.rollbacks,0);assert.equal(report.outbox,0);
    const resumed=await runMultiIncidentEvaluation({directory,reasoner});assert.equal(calls,5);assert.equal(resumed.status,'passed');assert.equal(resumed.attempts.length,5);
  }finally{await rm(directory,{recursive:true,force:true});}
});
