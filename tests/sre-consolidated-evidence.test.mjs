import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql,StorageError} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {retainLogTriage} from '../src/sre/log-triage.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {claudeSchema} from '../src/sre/claude-reasoner.mjs';
import {sourceReadBudget} from '../src/sre/source-evidence.mjs';
import {assessmentHash,planAssessmentCurrent} from '../src/sre/qa-assessment.mjs';
import {noisyLogCase} from '../fixtures/dynatrace-noise.mjs';
import {sourceReferenceFixture,amountSourcePath,amountSourceLine} from '../fixtures/sre-source-references.mjs';
import {reportedSourceFindings,validateSourceFindings} from '../src/sre/source-references.mjs';
import {verifiedLogSourceSamples} from '../src/sre/log-source.mjs';

async function fixture(dialect){
 let db;
 if(dialect==='sqlite')db=sqliteDatabase(':memory:');
 else{const pg=new PGlite();db={dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
 const service={key:'consolidated-ledger',tenant:'fictional',environment:'testing',gitlab:{project:'31'},teams:{collaborationGroups:[],conversations:[]}},store=await new SreStore(db,{services:[service],questionBatchLimit:32,investigationConcurrency:2}).initialize();
 for(const name of ['busy','quiet'])await store.ingest({id:name,source:'evaluation',serviceKey:service.key,kind:'problem',issueKey:name,status:'OPEN',at:Date.now(),payload:{}});
 const a=await store.claim('first-owner'),b=await store.claim('second-owner');assert.ok(a&&b);assert.notEqual(a.lease_name,b.lease_name);
 const begin=(job,index=1)=>store.beginInitialRead(job,service.key,{source:'dynatrace',kind:'logs',index});
 const count=async kind=>Number((await db.query('SELECT COUNT(*) AS n FROM sre_evidence WHERE kind=?',[kind]))[0].n);
 return{db,store,service,a,b,begin,count};
}

for(const dialect of ['sqlite','postgres']){
 test(dialect+': slot-owned log reads retain the rare tail while a separate incident keeps its own evidence',async()=>{
  const f=await fixture(dialect);
  try{
   const sample=noisyLogCase({count:6000,usefulPercent:1}),start=await f.begin(f.a),other=await f.begin(f.b);
   const done=await f.store.completeInitialRead(f.a,start,{source:'dynatrace',kind:'logs',content:sample.raw},{afterSave:(query,id)=>retainLogTriage(f.store,f.a.incident_id,id,sample.raw,{query})});
   await f.store.completeInitialRead(f.b,other,{source:'dynatrace',kind:'logs',content:{records:[{timestamp:Date.now(),content:'quiet incident control'}],complete:true}});
   const context=await f.store.context(f.a.incident_id),manifest=context.evidence.find(row=>row.id===done.evidenceId);
   assert.equal(manifest.content.retention.recordsRetained,6000);assert.equal(manifest.content.rawPages.length,12);assert.equal(await f.count('log_page'),12);
   assert.equal(context.evidenceWindow.rawLogPagesRetained,12);assert.ok(!context.evidence.some(row=>row.kind==='log_page'));
   assert.ok(context.evidence.some(row=>row.kind==='log_triage'&&row.content.records.some(record=>record['error.code']==='AMOUNT_INVARIANT_MISMATCH')));
   assert.ok(boundedContext(context).evidence.some(row=>row.kind==='log_triage'));
   const quiet=await f.store.context(f.b.incident_id);assert.ok(quiet.evidence.some(row=>row.content.records?.[0]?.content==='quiet incident control'));assert.ok(!quiet.evidence.some(row=>row.kind==='log_triage'));
   const revision=Number(quiet.incident.revision);assert.ok(await f.store.recordEvidenceRead(f.b,revision,{round:0,index:0,phase:'started',request:{kind:'dynatrace_logs',from:0,to:Date.now(),reason:'Scoped test follow-up'}}));
  }finally{await f.db.close();}
 });
 test(dialect+': expiring one slot rejects its large log completion without blocking the other slot',async()=>{
  const f=await fixture(dialect);
  try{
   const start=await f.begin(f.a),other=await f.begin(f.b),sample=noisyLogCase({count:6000,usefulPercent:1});
   await f.db.query('UPDATE sre_locks SET expires_at=0 WHERE name=?',[f.a.lease_name]);
   await assert.rejects(f.store.completeInitialRead(f.a,start,{source:'dynatrace',kind:'logs',content:sample.raw}),error=>error.code==='SRE_INITIAL_EVIDENCE_FENCE');
   assert.equal(await f.count('log_page'),0);assert.equal(await f.count('log_triage'),0);
   assert.equal((await f.store.completeInitialRead(f.b,other,{source:'dynatrace',kind:'logs',content:{records:[],complete:false}})).phase,'collected');
   const changed={...f.b,incident_id:f.a.incident_id};await assert.rejects(f.store.recordEvidenceRead(changed,1,{round:0,index:0,phase:'started'}),/Evidence read job lease lost/);
  }finally{await f.db.close();}
 });
 test(dialect+': a denied completion rolls back pages and triage; replay cannot repair a missing finalized artifact',async()=>{
  const f=await fixture(dialect),transaction=f.db.transaction;
  try{
   const sample=noisyLogCase({count:6000,usefulPercent:1}),start=await f.begin(f.a),artifact={source:'dynatrace',kind:'logs',content:sample.raw},afterSave=(query,id)=>retainLogTriage(f.store,f.a.incident_id,id,sample.raw,{query});
   f.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('INSERT INTO sre_checkpoints')&&String(args[0]).startsWith('initial-read-end:'))throw new StorageError(Error('Injected completion denial'));return q(sql,args);}));
   await assert.rejects(f.store.completeInitialRead(f.a,start,artifact,{afterSave}),/temporarily unavailable/);assert.equal(await f.count('log_page'),0);assert.equal(await f.count('log_triage'),0);assert.equal(await f.count('logs'),0);
   f.db.transaction=transaction;const done=await f.store.completeInitialRead(f.a,start,artifact,{afterSave});assert.deepEqual(await f.store.completeInitialRead(f.a,start,artifact,{afterSave:()=>{throw Error('A completed read must not replay its side effects');}}),done);
   await f.db.query('DELETE FROM sre_evidence WHERE id=?',[done.evidenceId]);
   await assert.rejects(f.store.completeInitialRead(f.a,start,artifact,{afterSave}),/temporarily unavailable/);assert.equal(await f.count('logs'),0);assert.equal(await f.count('log_page'),12);
  }finally{f.db.transaction=transaction;await f.db.close();}
 });
 test(dialect+': model excerpts and opt-in numbered inspection share each immutable GitLab file read',async()=>{
  const f=await sourceReferenceFixture(dialect,{seed:false});
  try{
   const {incidentId}=await f.r.store.ingest({id:'combined-source-read',source:'evaluation',serviceKey:f.service.key,kind:'problem',issueKey:'combined-source-read',status:'OPEN',at:Date.now(),payload:{}}),job=await f.r.store.claim('combined-source-owner'),budget=sourceReadBudget();
   f.r.worker.reasoner={mode:'claude'};await f.r.worker.collect(await f.r.store.context(incidentId),new AbortController().signal,budget,job);
   const calls=f.calls.filter(call=>call.path.includes('/repository/files/')),selectors=calls.map(call=>call.path+call.query);
   assert.ok(calls.length>=2);assert.equal(new Set(selectors).size,calls.length);assert.equal(budget.reads,8-calls.length);
   const context=await f.r.store.context(incidentId);assert.ok(context.evidence.some(row=>row.content.sourceFiles?.length));assert.ok(context.evidence.some(row=>row.content.sourceInspection?.files?.length));assert.ok(boundedContext(context).sourceCode.files.length);
  }finally{await f.close();}
 });
 test(dialect+': a rare error at the tail of paged model logs retains its exact immutable source and raw provenance',async()=>{
  const f=await sourceReferenceFixture(dialect,{seed:false,logLocations:true,logReader:(_options,reply)=>({...reply,records:Array.from({length:10000},(_,n)=>n===9999?reply.records[0]:{timestamp:reply.records[0].timestamp,'deployment.environment':'testing','service.version':reply.records[0]['service.version'],loglevel:'INFO',content:'Routine successful request '+n})})});
  try{
   const {incidentId}=await f.r.store.ingest({id:'tail-location',source:'evaluation',serviceKey:f.service.key,kind:'problem',issueKey:'tail-location',status:'OPEN',at:f.manifest.observedAt,payload:{}}),job=await f.r.store.claim('tail-location-owner');
   f.r.worker.reasoner={mode:'claude'};await f.r.worker.collect(await f.r.store.context(incidentId),new AbortController().signal,sourceReadBudget(),job);
   const context=await f.r.store.context(incidentId),view=boundedContext(context),file=view.sourceCode.files.find(file=>file.path===amountSourcePath);
   assert.ok(file);assert.ok(file.lines.some(line=>line.line===amountSourceLine));assert.equal(file.sha,f.manifest.head);assert.equal(file.side,'reported-log');
   const input=reportedSourceFindings(context,view).find(finding=>finding.path===amountSourcePath),finding=validateSourceFindings([input],context,view)[0];assert.ok(finding.verifiedLocation);assert.ok(finding.reportedLogLocations.length);
   const point=context.logSourceSamples.find(point=>point.rawRecordIndex===9999);assert.ok(point);
   await assert.rejects(verifiedLogSourceSamples(context,async()=>{throw new StorageError(Error('Injected raw-page read denial'));}),/temporarily unavailable/);
   assert.deepEqual(await verifiedLogSourceSamples({...context,incident:{...context.incident,id:'unrelated-incident'}},f.r.store.db.query),[]);assert.equal(context.evidence.find(row=>row.id===point.evidenceId).kind,'log_triage');assert.ok(!context.evidence.some(row=>row.kind==='log_page'));
   assert.equal(view.logSourceSamples,undefined,'Raw-page verification is host bookkeeping, not extra model input');
   const [page]=await f.r.store.db.query('SELECT content FROM sre_evidence WHERE id=?',[point.rawEvidenceId]),original=JSON.parse(page.content);assert.equal(original.offset,9500);assert.equal(original.records[499]['code.file.path'],'/srv/ledger/'+amountSourcePath);
   await f.r.store.db.query('UPDATE sre_evidence SET content=? WHERE id=?',[JSON.stringify({...original,records:original.records.map(record=>({...record,'code.line.number':1}))}),point.rawEvidenceId]);
   let changed=await f.r.store.context(incidentId);assert.equal(changed.logSourceSamples.length,0);assert.equal(boundedContext(changed).sourceCode.files.some(file=>file.path===amountSourcePath),false,'Changed raw bytes cannot retain a reported location');
   await f.r.store.db.query('UPDATE sre_evidence SET content=? WHERE id=?',[JSON.stringify(original),point.rawEvidenceId]);assert.ok((await f.r.store.context(incidentId)).logSourceSamples.length);
   await f.r.store.db.query('DELETE FROM sre_evidence WHERE id=?',[point.rawEvidenceId]);changed=await f.r.store.context(incidentId);assert.equal(changed.logSourceSamples.length,0);assert.equal(boundedContext(changed).sourceCode.files.some(file=>file.path===amountSourcePath),false,'A missing raw page stays unavailable');
  }finally{await f.close();}
 });
}

test('model schemas offer only the source finding format backed by delivered evidence',()=>{
 const evidence=[{id:'excerpt',source:'gitlab',kind:'release_diff',content:{sourceFiles:[{path:'src/a.py',sha:'a'.repeat(40),content:'pass\n',startLine:1}]}},{id:'numbered',source:'gitlab',kind:'source_requested',content:{}}];
 const excerpt=claudeSchema({evidence});assert.equal(excerpt.properties.sourceFindings.maxItems,0);assert.equal(excerpt.properties.evidenceRequests.maxItems,0);assert.equal(excerpt.properties.codeFindings.maxItems,8);
 const numbered=claudeSchema({evidence:evidence.slice(1),sourceCode:{files:[{evidenceId:'numbered'}]}});assert.equal(numbered.properties.codeFindings.maxItems,0);assert.deepEqual(numbered.properties.sourceFindings.items.properties.evidenceId.enum,['numbered']);
 const absent=claudeSchema({evidence});assert.equal(absent.properties.sourceFindings.maxItems,0);
 const mixed=claudeSchema({evidence,sourceCode:{files:[{evidenceId:'numbered',path:'src/numbered.py',sha:'b'.repeat(40),project:'31'}]}});
 assert.deepEqual(mixed.properties.codeFindings.items.properties.evidenceId.enum,['excerpt']);assert.deepEqual(mixed.properties.codeFindings.items.properties.path.enum,['src/a.py']);assert.deepEqual(mixed.properties.codeFindings.items.properties.sha.enum,['a'.repeat(40)]);
 assert.deepEqual(mixed.properties.sourceFindings.items.properties.path.enum,['src/numbered.py']);assert.deepEqual(mixed.properties.sourceFindings.items.properties.sha.enum,['b'.repeat(40)]);assert.deepEqual(mixed.properties.sourceFindings.items.properties.project.enum,['31']);
});

test('reviewed plan identity retains legacy facts and detects changed model source findings, recovery or specification',()=>{
 const legacy={summary:'Retained fixture assessment',changeAssessment:'unknown',candidateSha:null,evidenceIds:['fixture-evidence'],unknowns:['Runtime identity not verified']};
 assert.equal(assessmentHash(legacy),'135c92fa1a7e6f9a106e6bebe913001db45c8be6e064bcabea3618b0355d2552');
 const current={...legacy,codeFindings:[{provider:'gitlab',path:'src/a.py',sha:'a'.repeat(40),lineStart:1,lineEnd:1}],remediation:{kind:'collect-evidence',targetSha:null},issueSpec:{title:'Review the wire contract',proposedChange:'Collect the missing producer contract.'}},plan={assessmentHash:assessmentHash(current)};
 assert.ok(planAssessmentCurrent(plan,current));
 for(const changed of [{...current,codeFindings:[{...current.codeFindings[0],path:'src/b.py'}]},{...current,remediation:{kind:'forward-fix',targetSha:null}},{...current,issueSpec:{...current.issueSpec,proposedChange:'Change parsing after verifying the contract.'}}])assert.equal(planAssessmentCurrent(plan,changed),false);
});
