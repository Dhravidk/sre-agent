import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sourceReferenceFixture,amountSourcePath} from '../fixtures/sre-source-references.mjs';
import {sourceDiscoveryFixture,discoveryProjects,discoverySourcePath} from '../fixtures/sre-source-discovery.mjs';
import {hash} from '../src/sre/security.mjs';
import {StorageError} from '../src/sre/database.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {reportedSourceFindings,sourceFindingInput,validateSourceFindings} from '../src/sre/source-references.mjs';
import {readSourceIdentityHistory,sourceIdentityState,sourceIdentityHistoryLimits} from '../src/sre/source-identity-history.mjs';
import {exportDatabase,importDatabase} from '../src/sre/database-transfer.mjs';

async function locationSeed(f){const context=await f.r.store.context(f.id),row=context.evidence.find(row=>row.kind==='source_locations'),file=row.content.logSource.files.find(file=>file.path===amountSourcePath),log=context.evidence.find(row=>row.id===file.locations[0].evidenceId);return{context,row,file,log};}
async function appendLocation(f,seed,n,{newLog=false,content=seed.file.content.replace('return int(raw.strip())','return float(raw.strip())'),mutate,incidentId=f.id}={}){
 const packet=structuredClone(seed.row.content),file=packet.logSource.files.find(file=>file.path===amountSourcePath),at=Number(seed.row.observed_at)+n+1;
 file.content=content;file.contentHash=hash(content);file.sourceContentHash=hash(content);file.lineCount=content.split(/\r?\n/).length;
 if(newLog){const log=structuredClone(seed.log.content);log.records[0]['request.id']='identity-history-request-'+n;log.records[0].timestamp=new Date(at).toISOString();const id=await f.r.store.addEvidence(incidentId,seed.log.source,seed.log.kind,log,at);file.locations[0]={...file.locations[0],evidenceId:id,recordHash:hash(log.records[0])};}
 packet.logSource.coverage.recordsAvailable+=n;mutate?.(packet,file);
 return f.r.store.addEvidence(incidentId,'gitlab','source_locations',packet,at);
}
const identity=(c,path=amountSourcePath)=>c.sourceIdentityHistory.identities.find(file=>file.path===path);

for(const dialect of ['sqlite','postgres']){
 test(dialect+': retained identity history checks actual collected source without manufacturing new citation parents',async()=>{
  const f=await sourceReferenceFixture(dialect,{logLocations:true});try{const c=await f.r.store.context(f.id);assert.equal(c.sourceIdentityHistory.coverage.unverifiedIdentities,0);assert.equal(c.sourceIdentityHistory.coverage.conflictingIdentities,0);assert.ok(c.sourceIdentityHistory.identities.every(file=>file.state==='consistent'&&file.sourceContentHashes.length===1));assert.equal(c.incident.analysis.sourceFindings.length,1);assert.ok(c.incident.analysis.contacts.contacts.some(contact=>contact.id==='ledger-owner'));const packet=boundedContext(c);assert.equal(packet.sourceCode.coverage.identityHistory.identitiesChecked,3);assert.equal(packet.sourceIdentityHistory,undefined,'Witness packets are not new model evidence or log parents');assert.equal(c.sourceIdentityHistory.coverage.completeHistory,false);
  }finally{await f.close();}
 });
 for(const pressure of ['deduplicated-log-parents','evicted-source-packets'])test(dialect+': '+pressure+' cannot erase a known immutable conflict or restore an owner/citation',async()=>{
  const f=await sourceReferenceFixture(dialect,{logLocations:true});try{
   const seed=await locationSeed(f),plan=await f.r.casework.createPlan(f.id);await f.deliver();f.sent.length=0;await appendLocation(f,seed,0);assert.equal((await f.r.store.context(f.id)).sourceCode.coverage.conflictingFiles,1);
   const repeats=pressure==='deduplicated-log-parents'?130:270;for(let n=1;n<=repeats;n++)await appendLocation(f,seed,n,{newLog:pressure==='deduplicated-log-parents'});
   const c=await f.r.store.context(f.id),window=boundedContext(c);assert.equal(c.sourceCode.coverage.conflictingFiles,1);assert.equal(identity(c).state,'conflicting');assert.equal(identity(c).sourceContentHashes.length,2);assert.equal(reportedSourceFindings(c,window).length,0);assert.throws(()=>validateSourceFindings(sourceFindingInput(seed.context.incident.analysis.sourceFindings),c,window),/source finding|conflicting|unverified/);assert.ok(c.sourceIdentityHistory.coverage.witnessesRead<=c.sourceIdentityHistory.coverage.identitiesChecked*2);
   assert.equal((await f.r.store.db.query('SELECT id FROM sre_evidence WHERE id=?',[seed.row.id])).length,1);if(pressure==='evicted-source-packets'){assert.equal(c.evidence.some(row=>row.id===seed.row.id),false);assert.equal(c.evidenceWindow.candidatesLimited,true);}
   const contacts=await f.r.casework.contacts(f.id);assert.ok(!contacts.contacts.some(contact=>contact.id==='ledger-owner'));assert.ok(contacts.contacts.some(contact=>contact.id==='ledger-escalation'));assert.ok(contacts.unknowns.some(value=>value.includes('retained bytes')));await f.r.casework.publishContacts(f.id);await f.deliver();for(const room of f.rooms)assert.ok(f.sent.some(value=>value.room===room&&value.text.includes('component-owner recommendations are withheld')));
   await assert.rejects(f.r.casework.createPlan(f.id),/source finding|conflicting|unverified/);assert.equal((await f.r.casework.getPlan(plan.id,f.id)).markdown,plan.markdown);
   await f.question();await f.settle();await f.deliver();const after=await f.r.store.context(f.id);assert.equal(after.incident.analysis.sourceFindings,undefined);assert.equal(after.incident.analysis.sourceFindingChanges.removed,1);for(const room of f.rooms)assert.ok(f.sent.some(value=>value.room===room&&value.text.includes('Earlier source hypothesis locations are absent')&&value.text.includes('Retained source responses disagree')));const current=await f.r.casework.createPlan(f.id);assert.equal(current.payload.patch,null);assert.ok(!current.payload.contacts.contacts.some(contact=>contact.id==='ledger-owner'));assert.equal((await f.r.casework.getPlan(plan.id,f.id)).markdown,plan.markdown);assert.equal((await f.r.store.db.query('SELECT id FROM sre_fix_requests')).length,0);assert.equal((await f.r.store.db.query('SELECT id FROM sre_rollbacks')).length,0);
   f.sent.length=0;await f.question();await f.settle();await f.deliver();assert.equal(f.sent.filter(value=>value.text.startsWith('Incident brief')).length,0,'Repeated uncertainty is quiet');
  }finally{await f.close();}
 });
 test(dialect+': malformed or oversized disagreement stays unverified rather than selecting a convenient hash',async()=>{
  for(const variant of ['bad-content-hash','oversized-packet']){const f=await sourceReferenceFixture(dialect,{logLocations:true});try{const seed=await locationSeed(f);await appendLocation(f,seed,1,{mutate:(packet,file)=>{if(variant==='bad-content-hash')file.contentHash='f'.repeat(64);else packet.padding=Array.from({length:20},()=> 'x'.repeat(16000));}});const c=await f.r.store.context(f.id);assert.equal(identity(c).state,'unverified');assert.ok(c.sourceCode.files.find(file=>file.path===amountSourcePath).identityHistoryUnverified);assert.equal(reportedSourceFindings(c,boundedContext(c)).length,0);assert.throws(()=>validateSourceFindings(sourceFindingInput(seed.context.incident.analysis.sourceFindings),c,boundedContext(c)),/unverified/);assert.ok(!(await f.r.casework.contacts(f.id)).contacts.some(contact=>contact.id==='ledger-owner'));}finally{await f.close();}}
 });
 test(dialect+': unrelated incidents, projects, revisions and failed reads do not poison the selected immutable file',async()=>{
  const f=await sourceReferenceFixture(dialect,{logLocations:true});try{const seed=await locationSeed(f);await appendLocation(f,seed,1,{incidentId:'inc_other_history_fixture'});await appendLocation(f,seed,2,{mutate:packet=>{packet.logSource.project='foreign/project';}});await appendLocation(f,seed,3,{mutate:(_packet,file)=>{file.sha='f'.repeat(40);}});await appendLocation(f,seed,4,{mutate:(_packet,file)=>{file.state='unavailable';file.error='Controlled denial';}});const c=await f.r.store.context(f.id);assert.equal(identity(c).state,'consistent');assert.equal(c.sourceCode.coverage.conflictingFiles,0);assert.equal(reportedSourceFindings(c,boundedContext(c)).length,1);assert.ok((await f.r.casework.contacts(f.id)).contacts.some(contact=>contact.id==='ledger-owner'));
  }finally{await f.close();}
 });
 test(dialect+': denied identity history makes context and contacts unavailable instead of falsely verifying a source',async()=>{
  const f=await sourceReferenceFixture(dialect,{logLocations:true}),query=f.r.store.db.query;try{f.r.store.db.query=async(sql,args)=>{if(sql.includes('distinct_versions AS'))throw new StorageError(Error('Controlled identity-history storage denial'));return query(sql,args);};await assert.rejects(f.r.store.context(f.id),/storage is temporarily unavailable/);await assert.rejects(f.r.casework.contacts(f.id),/storage is temporarily unavailable/);}finally{f.r.store.db.query=query;await f.close();}
 });
 test(dialect+': comparison source conflicts are checked across omitted packets as well as log locations',async()=>{
  const f=await sourceReferenceFixture(dialect);try{const c=await f.r.store.context(f.id),row=c.evidence.find(row=>row.kind==='release_diff'),packet=structuredClone(row.content),file=packet.sourceInspection.files[0].head;file.content+='\n# Controlled contradictory bytes\n';file.lineCount=file.content.split(/\r?\n/).length;file.contentHash=hash(file.content);file.sourceContentHash=file.contentHash;await f.r.store.addEvidence(f.id,'gitlab','release_diff',packet,Number(row.observed_at)-1);for(let n=0;n<270;n++)await f.r.store.addEvidence(f.id,'gitlab','release_diff',{...row.content,receiptObservation:n},Number(row.observed_at)+n+1);const after=await f.r.store.context(f.id);assert.ok(after.sourceCode.files.some(item=>item.sha===file.sha&&item.path===file.path&&item.conflicting));assert.equal(after.sourceIdentityHistory.identities.find(item=>item.sha===file.sha&&item.path===file.path).state,'conflicting');
  }finally{await f.close();}
 });
}

test('identity history refuses broader project/ref/path/count selectors before querying and does not trust a stale successful history',async()=>{
 let calls=0;const store={db:{dialect:'sqlite',query:async()=>{calls++;return[];}}},context={incident:{id:'inc_scoped_history'},sourceScope:{project:'approved/project'}},file={project:'approved/project',sha:'a'.repeat(40),path:'src/worker.py',sourceContentHash:'b'.repeat(64)};
 for(const files of [[{...file,project:'foreign/project'}],[{...file,sha:'main'}],[{...file,path:'../outside.py'}],Array.from({length:9},(_,n)=>({...file,path:'src/file-'+n+'.py'}))])await assert.rejects(readSourceIdentityHistory(store,context,files),/bounded currently scoped/);assert.equal(calls,0);
 const checked={...context,sourceIdentityHistory:{version:1,identities:[{...file,state:'consistent',sourceContentHashes:[file.sourceContentHash]}]}};assert.equal(sourceIdentityState(checked,file),'consistent');assert.equal(sourceIdentityState(checked,{...file,sourceContentHash:'c'.repeat(64)}),'unverified');assert.equal(sourceIdentityState(checked,{...file,path:'src/other.py'}),'unverified');
});

test('file reopen retains the conflict and immutable ticket without provider reads or a new action',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sre-source-identity-reopen-')),f=await sourceReferenceFixture('sqlite',{logLocations:true,directory,databasePath:join(directory,'agent.sqlite')});try{const seed=await locationSeed(f),plan=await f.r.casework.createPlan(f.id);await appendLocation(f,seed,1,{newLog:true});const calls=f.calls.length;await f.restart();assert.equal(f.calls.length,calls);assert.equal(identity(await f.r.store.context(f.id)).state,'conflicting');assert.equal((await f.r.casework.getPlan(plan.id,f.id)).markdown,plan.markdown);assert.ok(!(await f.r.casework.contacts(f.id)).contacts.some(contact=>contact.id==='ledger-owner'));}finally{await f.close();await rm(directory,{recursive:true,force:true});}
});

for(const [from,to]of [['sqlite','postgres'],['postgres','sqlite']])test(from+' → '+to+': held transfer preserves source disagreement without replaying providers or rewriting earlier Markdown',async()=>{
 const f=await sourceReferenceFixture(from,{logLocations:true}),target=await sourceReferenceFixture(to,{directory:f.directory,seed:false,logLocations:true});try{const seed=await locationSeed(f),plan=await f.r.casework.createPlan(f.id);await appendLocation(f,seed,1,{newLog:true});const actor={kind:'local-operator',id:'Fictional source identity transfer reviewer'},archive=await exportDatabase(f.r.store,{offline:true,actor});await importDatabase(target.r.store,{snapshot:archive.snapshot,expectedSha256:archive.sha256,restoreId:'source-identity-transfer',reason:'Preserve contradictory immutable source observations',offline:true,actor});const c=await target.r.store.context(f.id);assert.equal(c.incident.analysis,null);assert.equal(c.sourceCode.historicalAfterRestore,true);assert.equal(identity(c).state,'conflicting');assert.equal((await target.r.casework.getPlan(plan.id,f.id)).markdown,plan.markdown);assert.equal(target.calls.length,0);assert.equal(await target.r.outbox.runOnce(),false);await assert.rejects(target.r.casework.createPlan(f.id),/held/);
 }finally{await target.close();await f.close();}
});

for(const dialect of ['sqlite','postgres'])test(dialect+': candidate and parent-history bytes remain conflicting after their earlier packets leave the display window',async()=>{
 const f=await sourceDiscoveryFixture(dialect,{history:true});try{const context=await f.r.store.context(f.id),row=context.evidence.find(value=>value.kind==='source_discovery'),packet=structuredClone(row.content),probe=packet.sourceDiscovery.probes.find(value=>value.project===discoveryProjects[0]),parent=probe.files[0].history.parents[0].source;parent.content='def retryable(error):\n    return False\n';parent.contentHash=hash(parent.content);parent.sourceContentHash=parent.contentHash;parent.lineCount=parent.content.split('\n').length;const id=await f.r.store.addEvidence(f.id,'gitlab','source_discovery',packet,Number(row.observed_at)-1);for(let n=0;n<270;n++)await f.r.store.addEvidence(f.id,'gitlab','source_discovery',{...row.content,receiptObservation:n},Number(row.observed_at)+n+1);const c=await f.r.store.context(f.id);assert.equal(c.evidence.some(value=>value.id===id),false);const checked=c.sourceIdentityHistory.identities.find(value=>value.project===discoveryProjects[0]&&value.sha===parent.sha&&value.path===discoverySourcePath);assert.ok(checked&&checked.state!=='consistent','A malformed history delta cannot turn its contradictory bytes into a successful identity read');assert.ok(!c.sourceCode.files.some(value=>value.project===discoveryProjects[0]&&value.side==='history-parent'&&!value.conflicting&&!value.identityHistoryUnverified));
 }finally{await f.close();}
});
