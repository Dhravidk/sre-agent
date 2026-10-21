import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {noisyLogCase} from '../fixtures/dynatrace-noise.mjs';
import {triageLogBatch,retainLogBatch,retainLogTriage,logCodeReferences,logTriageLimits} from '../src/sre/log-triage.mjs';
import {logRecordHash} from '../src/sre/log-observation.mjs';
import {readInvestigationLogs as readUnscoped,logInvestigationOptions} from '../src/sre/dynatrace-log-investigation.mjs';
import {DynatraceConnector} from '../src/sre/connectors.mjs';
import {bindSourceEvidence} from '../src/sre/source-evidence.mjs';
import {sqliteDatabase} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {boundedContext,modelContextLimits,validateInvestigation} from '../src/sre/reasoner.mjs';
import {fixtureRisk} from '../src/sre/analytic-risk.mjs';
import {IncidentWorker} from '../src/sre/worker.mjs';
import {claudeSchema} from '../src/sre/claude-reasoner.mjs';
import Ajv from 'ajv';

const readInvestigationLogs=(c,o)=>readUnscoped(c,{environment:'evaluation',...o});
const row=(at=500,extra={})=>({'deployment.environment':'evaluation',timestamp:new Date(at).toISOString(),'service.name':'svc',loglevel:'INFO',content:'A bounded source sample',...extra});
const aggregate=(sample=row(),observations=10000)=>({'service.name':'svc','deployment.environment':'evaluation',observations,firstAt:sample.timestamp,lastAt:sample.timestamp,sample});
const result=(records=[],extra={})=>({records,complete:records.length<200,metadata:{grail:{sampled:false,notifications:[]}},...extra});
const client=fn=>({config:{logField:'service.name',logValue:'svc'},query:fn});

test('Claude schema constrains unsupported confidence before generation without mutating the general schema',()=>{
  for(const evidence of [[{kind:'connector_error',content:{}}],[{content:{synthetic:true}}],[{content:{complete:false}}],[{content:{truncated:true}}]])assert.deepEqual(claudeSchema({evidence}).properties.risk.properties.confidence.enum,['low','moderate']);
  assert.deepEqual(claudeSchema({evidence:[{content:{complete:true}}]}).properties.risk.properties.confidence.enum,['low','moderate','high']);
});

test('Claude citation schema excludes mentioned but undelivered pages and rejects blank source-quality assessments',()=>{
  const schema=claudeSchema({evidence:[{id:'delivered-manifest',content:{rawPages:['unseen-page']}}]}),validate=new Ajv().compile(schema.properties.risk.properties.sourceQuality);
  assert.equal(validate([{evidenceId:'unseen-page',limitations:'Mentioned in the manifest only.'}]),false);
  assert.equal(validate([{evidenceId:'delivered-manifest',limitations:''}]),false);
  assert.equal(validate([{evidenceId:'delivered-manifest',limitations:'The retained pages are outside this delivered snapshot.'}]),true);
  const empty=claudeSchema({evidence:[]});assert.equal(new Ajv().compile(empty.properties.evidenceIds)(['invented']),false);assert.equal(new Ajv().compile(empty.properties.codeFindings)([]),true);
});

for(const usefulPercent of [1,5,10])test(usefulPercent+'% useful logs survive a noisy 10,000-record tail and bounded model projection',()=>{
  const sample=noisyLogCase({usefulPercent}),triage=triageLogBatch(sample.raw),c=sample.context;
  c.evidence.unshift(...triage.groups.map((group,n)=>({id:'triage-'+n,source:'dynatrace',kind:'log_triage',observed_at:Date.now(),content:{derivedFrom:'dt-noise',records:group.samples,triage:{...group,samples:undefined},coverage:triage.coverage}})));
  const view=boundedContext(c),signal=view.evidence.filter(e=>e.kind==='log_triage').flatMap(e=>e.content.records||[]);
  assert.equal(triage.coverage.recordsScanned,10000);assert.equal(triage.coverage.recordsNotScanned,0);
  assert.ok(signal.some(r=>r['error.code']==='AMOUNT_INVARIANT_MISMATCH'&&r.content.includes('15000000')));
  assert.ok(signal.some(r=>r['service.version']===sample.expected.base));
  assert.ok(signal.some(r=>r['error.code']==='EXPECTED_TEST_REJECTION'));
  assert.ok(triage.groups.some(g=>g.references.some(r=>r.path===sample.expected.path&&r.line===sample.expected.line)));
  assert.ok(Buffer.byteLength(JSON.stringify(view))<=modelContextLimits.totalBytes);
});

test('100,000 records are scanned with explicit unscanned and capacity loss, without hiding a late stack',()=>{
  const sample=noisyLogCase({count:100000}),started=performance.now(),triage=triageLogBatch({...sample.raw,records:[...sample.raw.records,row()]});
  assert.equal(triage.coverage.recordsScanned,100000);assert.equal(triage.coverage.recordsNotScanned,1);assert.ok(triage.groups.some(g=>g.code==='AMOUNT_INVARIANT_MISMATCH'));
  assert.ok(performance.now()-started<30000,'Bounded scan must finish within the worker collection budget on this host');
  const unique=Array.from({length:5000},(_,n)=>row(n,{content:'Distinct noise '+n}));unique.push(row(5500,{content:'rare business error','error.code':'DATA_INVARIANT',stack:'at mutate (src/business/ledger.mjs:54)'}));
  const capped=triageLogBatch({records:unique,complete:false});assert.equal(capped.coverage.retainedGroups,logTriageLimits.groups);assert.ok(capped.coverage.unretainedObservations>0);assert.ok(capped.groups.some(g=>g.code==='DATA_INVARIANT'));assert.ok(capped.groups.length<=20);
});

test('log reduction deduplicates canonical timestamped records, preserves unknown times, and reports invalid rows',()=>{
  const a=row(),reordered=Object.fromEntries(Object.entries(a).reverse()),missing={...a};delete missing.timestamp;
  const t=triageLogBatch({records:[a,reordered,missing,missing,null,[],{...a,content:'Different amount 100'}],complete:false});
  assert.equal(t.coverage.duplicateObservations,1);assert.equal(t.coverage.missingTimestamps,2);assert.equal(t.coverage.invalidRecords,2);assert.equal(t.groups.reduce((n,g)=>n+g.observations,0),4);assert.equal(t.coverage.sourceComplete,false);
  assert.deepEqual(logCodeReferences([{stack:'../secrets/private.js:1; at bid (src/ledger.mjs:54)'}]),[{path:'src/ledger.mjs',line:54}]);
});

test('provider stratum counts remain separate from unique sample counts',()=>{
  const sample=row(),a={sampleHash:logRecordHash('dynatrace',sample),observations:500000,firstAt:100,lastAt:900,sampleRepresentsEntireGroup:false};
  const t=triageLogBatch({records:[sample],aggregates:[a],complete:false});assert.equal(t.groups[0].observations,1);assert.equal(t.groups[0].serverAggregates[0].observations,500000);assert.match(t.interpretation,/Do not add/);
});

test('unlabelled INFO business evidence survives high-cardinality routine noise without a stack/error catalog',()=>{
  const sample=noisyLogCase({structuredHints:false}),business=sample.raw.records.filter(r=>r['http.route']==='/bids');assert.ok(business.every(r=>!r['error.code']&&!r.stack&&!r['code.filepath']));
  const noise=Array.from({length:5000},(_,n)=>row(n,{'http.route':'/health',content:'Routine diagnostic value '+n}));
  const signal=row(6000,{'http.route':'/bids',content:'inputAmountCents=150000 storedCurrentBidCents=15000000',loglevel:'INFO'}),t=triageLogBatch({records:[...noise,signal],complete:false});
  assert.ok(t.coverage.unretainedObservations>0);assert.ok(t.groups.some(g=>g.samples.some(r=>r.content===signal.content)));assert.ok(t.groups.some(g=>g.operation==='/health'));
  assert.ok(triageLogBatch(sample.raw).groups.some(g=>g.samples.some(r=>r.content.includes('storedCurrentBidCents=15000000'))));
});

test('large redacted log batches retain every record in durable deduplicated pages across restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-log-pages-')),path=join(directory,'db.sqlite');let store=await new SreStore(sqliteDatabase(path)).initialize();
  try{
    const sample=noisyLogCase(),at=Date.now()-1000,{incidentId}=await store.ingest({id:'large-log',source:'evaluation',serviceKey:'logs',kind:'problem',issueKey:'logs',status:'OPEN',at,payload:{}});
    const id=await retainLogBatch(store,incidentId,sample.raw),selected=await retainLogTriage(store,incidentId,id,sample.raw);
    assert.equal(await retainLogBatch(store,incidentId,sample.raw),id);
    const pages=await store.db.query("SELECT content FROM sre_evidence WHERE kind='log_page'");assert.equal(pages.length,20);assert.equal(pages.reduce((n,p)=>n+JSON.parse(p.content).records.length,0),10000);
    assert.ok(pages.some(p=>JSON.parse(p.content).records.some(r=>r['error.code']==='AMOUNT_INVARIANT_MISMATCH')));
    await store.db.close();store=await new SreStore(sqliteDatabase(path)).initialize();
    const c=await store.context(incidentId),manifest=c.evidence.find(e=>e.id===id);assert.equal(manifest.content.rawPages.length,20);assert.equal(manifest.content.retention.recordsRetained,10000);assert.equal(c.evidenceWindow.rawLogPagesRetained,20);assert.ok(!c.evidence.some(e=>e.kind==='log_page'));assert.ok(selected.ids.every(id=>c.evidence.some(e=>e.id===id)));assert.ok(c.evidence.some(e=>e.kind==='log_triage'&&e.content.records.some(r=>r['error.code']==='AMOUNT_INVARIANT_MISMATCH')));
  }finally{await store.db.close();await rm(directory,{recursive:true,force:true});}
});

test('investigation reads aggregate strata before limits, priority and broad baseline with exact scope and cost bounds',async()=>{
  const calls=[],c=client(async(query,options)=>{calls.push({query,options});return result(query.includes('summarize')?[aggregate()]:[row()]);});
  const r=await readInvestigationLogs(c,{from:0,to:1000});assert.equal(calls.length,3);assert.equal(r.complete,true);assert.equal(r.records.length,1);assert.equal(r.aggregates[0].observations,10000);
  assert.match(calls[0].query,/summarize observations=count\(\).*takeAny\(record\(/);assert.match(calls[0].query,/sort observations asc \| limit 200$/);
  assert.ok(calls.every(c=>c.query.includes('samplingRatio:1')&&c.query.includes('service.name == "svc"')&&c.query.includes('timestamp < toTimestamp("1970-01-01T00:00:01.000Z")')&&c.options.scanLimitGbytes===0.125&&c.options.fetchTimeoutSeconds===10));
  assert.equal(r.coverage.maxScanGbytes,1);assert.equal(r.coverage.aggregateComplete,true);
});

test('aggregate projections and full query records retain one enriched witness without inflating triage',async()=>{
  const complete={...row(),customBusinessContext:'Retain this useful full-record attribute'};
  const c=client(async query=>result(query.includes('summarize')?[aggregate()]:[complete]));
  const logs=await readInvestigationLogs(c,{from:0,to:1000});assert.equal(logs.records.length,1);assert.equal(logs.records[0].customBusinessContext,complete.customBusinessContext);
  assert.equal(logs.aggregates[0].sampleHash,logRecordHash('dynatrace',complete));
  assert.equal(triageLogBatch(logs).groups.reduce((n,g)=>n+g.observations,0),1);
});

test('different full records sharing the query projection remain distinct and explicitly ambiguous',async()=>{
  const first={...row(),customBusinessContext:'first'},second={...row(),customBusinessContext:'second'};
  const c=client(async query=>result(query.includes('summarize')?[aggregate()]:[first,second]));
  const logs=await readInvestigationLogs(c,{from:0,to:1000});assert.equal(logs.records.length,2);assert.deepEqual(logs.records.map(r=>r.customBusinessContext),['first','second']);
  assert.equal(logs.coverage.ambiguousProjections,1);assert.match(logs.interpretation,/not provider-event identity/);
});

test('truncated priority windows split within eight queries and keep baseline truncation unknown',async()=>{
  const calls=[],c=client(async(query,o)=>{calls.push({query,...o});if(query.includes('summarize'))return result([]);if(query.includes('isNotNull')&&o.to-o.from>1000||!query.includes('isNotNull'))return result(Array.from({length:200},(_,n)=>row(o.from+n%(o.to-o.from))));return result([row(o.from+1)]);});
  const r=await readInvestigationLogs(c,{from:0,to:8000});assert.equal(calls.length,8);assert.equal(r.complete,false);assert.equal(r.coverage.baselineComplete,false);assert.equal(r.coverage.priorityComplete,false);assert.ok(r.coverage.remainingWindows>0);assert.ok(calls.every(c=>c.from>=0&&c.to<=8000));
});

test('a priority tree can close independently of a capped broad baseline',async()=>{
  const c=client(async(query,o)=>query.includes('summarize')?result([]):query.includes('isNotNull')&&o.to-o.from===2000||!query.includes('isNotNull')?result(Array.from({length:200},(_,n)=>row(o.from+n))):result([row(o.from+1)]));
  const r=await readInvestigationLogs(c,{from:0,to:2000});assert.equal(r.coverage.queries,5);assert.equal(r.coverage.priorityComplete,true);assert.equal(r.coverage.baselineComplete,false);assert.equal(r.complete,false);
});

for(const [name,change]of [
  ['sampled',r=>{r.metadata.grail.sampled=true;r.complete=false;}],
  ['warning',r=>{r.metadata.grail.notifications=[{severity:'WARN'}];}],
  ['missing metadata',r=>{delete r.metadata;}],
  ['missing timestamp',r=>{if(r.records[0]?.sample)delete r.records[0].sample.timestamp;else delete r.records[0]?.timestamp;}]
])test('query coverage remains unknown for '+name,async()=>{
  const c=client(async q=>{const r=result(q.includes('summarize')?[aggregate()]:[row()]);change(r);return r;});const r=await readInvestigationLogs(c,{from:0,to:1000});assert.equal(r.complete,false);assert.ok(r.coverage.receipts.some(x=>!x.complete));
});

for(const [name,extra]of [['another environment',{'deployment.environment':'foreign'}],['missing environment',{'deployment.environment':undefined}],['another service',{'service.name':'other'}],['missing service',{'service.name':undefined}],['before the window',{timestamp:new Date(-1).toISOString()}],['at exclusive end',{timestamp:new Date(1000).toISOString()}]])test('investigation rejects '+name,async()=>{
  const c=client(async q=>result(q.includes('summarize')?[aggregate(row(500,extra))]:[row(500,extra)]));await assert.rejects(()=>readInvestigationLogs(c,{from:0,to:1000}),/outside.*scope/);
});

test('denied/schema-failed queries stop within budget; cancellation remains cancellation',async()=>{
  let calls=0;const denied=client(async()=>{calls++;throw Error('403 denied');});const r=await readInvestigationLogs(denied,{from:0,to:1000});assert.equal(calls,1);assert.equal(r.complete,false);assert.equal(r.coverage.failed,true);assert.equal(r.records.length,0);
  const malformed=client(async()=>result([aggregate(),{...aggregate(),observations:'many'}]));const bad=await readInvestigationLogs(malformed,{from:0,to:1000});assert.equal(bad.complete,false);assert.equal(bad.records.length,0);assert.equal(bad.aggregates.length,0);
  const controller=new AbortController(),cancelled=client(async()=>{controller.abort(Error('cancelled by test'));throw controller.signal.reason;});await assert.rejects(()=>readInvestigationLogs(cancelled,{from:0,to:1000,signal:controller.signal}),/cancelled/);
  const deadline=client(async(q,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));deadline.config.logInvestigation={timeoutMs:100};
  // AbortSignal.timeout is unref'ed; keep this test alive until it fires.
  const keep=setInterval(()=>{},1000);try{const expired=await readInvestigationLogs(deadline,{from:0,to:1000});assert.equal(expired.complete,false);assert.equal(expired.coverage.deadlineExceeded,true);}finally{clearInterval(keep);}
  for(const config of [{maxQueries:20},{maxQueries:2},{scanLimitGbytes:2},{levelField:'x | fetch secrets'},{unexpected:true}])assert.throws(()=>logInvestigationOptions({logInvestigation:config}),/Invalid/);
});

test('actual HTTP connector sends explicit no-sampling and budgets for all three query kinds',async()=>{
  const calls=[],dt=new DynatraceConnector({base:'https://dt.invalid',mode:'grail',tokenEnv:'TOKEN',logField:'service.name',logValue:'svc'},{env:{TOKEN:'fixture'},fetcher:async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});return new Response(JSON.stringify({state:'SUCCEEDED',result:{records:body.query.includes('summarize')?[aggregate()]:[row()],metadata:{grail:{sampled:false,notifications:[]}}}}),{headers:{'content-type':'application/json'}});}});
  assert.equal((await dt.investigationLogs({from:0,to:1000,environment:'evaluation'})).complete,true);assert.equal(calls.length,3);assert.ok(calls.every(c=>c.url.endsWith('query:execute')&&c.body.defaultSamplingRatio===1&&c.body.defaultScanLimitGbytes===0.125&&c.body.maxResultRecords===200&&c.body.maxResultBytes===500000));
});

test('stack-referenced files outside the initial four receive immutable source budget and line focus',async()=>{
  const head='a'.repeat(40),base='b'.repeat(40),files=Array.from({length:8},(_,n)=>({new_path:'src/part-'+n+'.mjs',diff:'@@ -1 +1 @@\n-old\n+new'})),reads=[];
  const proof=await bindSourceEvidence({provider:'gitlab',baseSha:base,headSha:head,complete:true,data:{diffs:files},priorityReferences:[{path:'src/part-7.mjs',line:120}],client:{file:async(path,sha)=>{reads.push(path);return {path,sha,complete:true,content:Array.from({length:180},(_,n)=>'// source line '+(n+1)).join('\n')};}}});
  assert.equal(reads.length,4);assert.equal(reads[0],'src/part-7.mjs');const f=proof.sourceFiles[0];assert.ok(f.startLine<=120&&f.content.includes('// source line 120'));assert.equal(f.sha,head);assert.equal(proof.sourceCoverage.omitted,4);
});

const proposal=c=>({summary:'Compare code and telemetry.',hypotheses:['An amount conversion may corrupt current bid amounts.'],changeAssessment:'likely',candidateSha:c.deployments[0].sha,evidenceIds:['dt-noise'],unknowns:['Synthetic evidence only.'],nextSteps:['Reproduce the mismatch.'],risk:fixtureRisk(c),remediation:{kind:'rollback-candidate',targetSha:c.deployments[1].sha,rationale:'A distinct compatible immutable baseline is supplied as healthy in this evaluation.',evidenceIds:['dt-noise','gitlab-amounts'],verificationSteps:['Recheck current artifact and independently test monetary invariants.'],blockingUnknowns:['Actual production state is unverified.']}});
test('planning-only rollback preserves immutable target and compatibility checks',()=>{
  const c=noisyLogCase().context,a=proposal(c);assert.match(validateInvestigation(a,c).text,/does not authorize execution/);
  for(const mutate of [x=>x.deployments[1].healthy=false,x=>x.deployments[0].dataRollbackSafe=false,x=>x.deployments[1].schemaVersion=2,x=>delete x.deployments[1].artifact,x=>x.deployments[1].project='foreign',x=>x.deployments[1].provider='github',x=>x.deployments[1].healthVerifiedAt=Date.now()+999999]){const copy=structuredClone(c);mutate(copy);assert.throws(()=>validateInvestigation(a,copy),/rollback candidate/);}
  assert.throws(()=>validateInvestigation({...a,remediation:{...a.remediation,targetSha:'main'}},c),/rollback candidate/);
  assert.throws(()=>validateInvestigation({...a,remediation:{...a.remediation,kind:'forward-fix'}},c),/only valid/);
});

test('Claude collection retains raw pages and derived samples before using their stack to prioritize GitLab',async()=>{
  const store=await new SreStore(sqliteDatabase(':memory:')).initialize(),sample=noisyLogCase(),key='logs',at=Date.now()-1000;
  try{
    const {incidentId}=await store.ingest({id:'worker-log',source:'evaluation',serviceKey:key,kind:'problem',issueKey:'worker-log',status:'OPEN',at,payload:{}}),order=[];
    const worker=new IncidentWorker({store,services:[{key,environment:'evaluation'}],connectors:new Map([[key,{dynatraceLogs:{investigationLogs:async()=>{order.push('logs');return sample.raw;},logs:()=>{throw Error('legacy newest-200 path must not be used');}},gitlab:{deployments:async()=>{order.push('deployments');return {items:[],complete:true};}}}]]),reasoner:{mode:'claude'}});
    await worker.collect(await store.context(incidentId),new AbortController().signal);assert.deepEqual(order,['logs','deployments']);const c=await store.context(incidentId);assert.equal(c.evidenceWindow.rawLogPagesRetained,20);assert.ok(c.evidence.some(e=>e.kind==='log_triage'&&e.content.records.some(r=>r['error.code']==='AMOUNT_INVARIANT_MISMATCH')));assert.equal(Number((await store.db.query('SELECT COUNT(*) AS count FROM sre_rollbacks'))[0].count),0);
  }finally{await store.db.close();}
});
