import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sourceReferenceFixture,ledgerSourcePath} from '../fixtures/sre-source-references.mjs';
import {sourceOutputDouble} from '../fixtures/source-output-double.mjs';
import {RulesReasoner} from '../src/sre/reasoner.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {exportDatabase,importDatabase} from '../src/sre/database-transfer.mjs';

for(const dialect of ['sqlite','postgres']){
 test(dialect+': the real GitLab connector reads non-auction files through the worker at both actual generated commits',async()=>{
  const f=await sourceReferenceFixture(dialect);try{const c=await f.r.store.context(f.id),view=boundedContext(c);
   assert.equal(c.sourceScope.project,'fixture/ledger');assert.equal(c.sourceCode.files.length,2);assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.equal(c.incident.analysis.codeReview.findings.length,0);
   for(const file of c.sourceCode.files){const source=execFileSync('git',['-C',f.repository,'show',file.sha+':'+file.path],{encoding:'utf8'}).split(/\r?\n/);for(const line of file.lines)assert.equal(line.text,source[line.line-1]);}
   assert.ok(f.calls.every(call=>call.method==='GET'));assert.ok(f.calls.filter(call=>call.path.includes('/repository/files/')).every(call=>[f.manifest.base,f.manifest.head].includes(new URLSearchParams(call.query).get('ref'))));
   assert.ok(view.sourceCode.files.some(file=>file.sha===f.manifest.head));assert.ok(!JSON.stringify(view).includes('fictional-source-reader'));assert.equal((await f.r.store.db.query('SELECT id FROM sre_fix_requests')).length,0);
  }finally{await f.close();}
 });
 test(dialect+': scripted location findings are validated, retained in the ticket and shared once with both groups',async()=>{
  const f=await sourceReferenceFixture(dialect,{reasoner:sourceOutputDouble()});try{
   await f.message(f.rooms[0],'report blocked SOURCE-AVERY: accepted bids still disappear in the exact ledger replay.','avery');await f.message(f.rooms[1],'report recovered SOURCE-NOOR: health checks only; I have not replayed concurrent writes.','noor');await f.question();await f.settle();await f.message(f.rooms[0],'sync');await f.deliver();
   const c=await f.r.store.context(f.id),finding=c.incident.analysis.sourceFindings[0],plan=await f.r.casework.createPlan(f.id);
   assert.equal(finding.verifiedLocation,true);assert.equal(finding.path,ledgerSourcePath);assert.equal(finding.sha,f.manifest.head);assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.equal(c.incident.analysis.candidateSha,null);assert.equal(plan.payload.patch,null);
   assert.equal(plan.payload.sourceFindings[0].quote,finding.quote);assert.match(plan.markdown,/Source hypotheses \(verified locations; cause unverified\)/);assert.ok(plan.markdown.includes(f.manifest.head));assert.ok(plan.markdown.includes('SOURCE-AVERY'));assert.ok(plan.markdown.includes('SOURCE-NOOR'));
   assert.ok(plan.payload.contacts.contacts.some(contact=>contact.id==='ledger-owner'&&/cause remains a hypothesis/.test(contact.reason)));
   for(const room of f.rooms){assert.ok(f.sent.some(message=>message.room===room&&message.text.includes('Source hypotheses')&&message.text.includes(ledgerSourcePath)));assert.ok(f.sent.some(message=>message.room===room&&message.text.includes('SOURCE-AVERY')&&message.text.includes('SOURCE-NOOR')));}
   f.sent.length=0;await f.question();await f.settle();await f.deliver();assert.equal(f.sent.filter(message=>message.text.startsWith('Incident brief')).length,0);assert.equal((await f.r.store.db.query('SELECT id FROM sre_fix_requests')).length,0);assert.equal((await f.r.store.db.query('SELECT id FROM sre_rollbacks')).length,0);
  }finally{await f.close();}
 });
 test(dialect+': the worker independently rejects a source claim outside the configured project before publication',async()=>{
  const f=await sourceReferenceFixture(dialect,{reasoner:sourceOutputDouble()});try{
   await f.deliver();f.sent.length=0;const before=(await f.r.store.context(f.id)).incident.analysis,investigate=f.r.worker.reasoner.investigate;
   f.r.worker.reasoner={investigate:async(...args)=>{const result=await investigate(...args);result.analysis.sourceFindings[0].project='foreign/ledger';return result;}};
   await f.question();assert.equal(await f.r.worker.runOnce(),false);await f.deliver();const after=await f.r.store.context(f.id);
   assert.deepEqual(after.incident.analysis,before);assert.ok(after.jobs.some(job=>job.error?.includes('Source finding')));assert.equal(f.sent.length,0);assert.equal((await f.r.store.db.query('SELECT id FROM sre_fix_requests')).length,0);
  }finally{await f.close();}
 });
 test(dialect+': withdrawing a current source hypothesis tells both peers without erasing its saved artifact',async()=>{
  const f=await sourceReferenceFixture(dialect,{reasoner:sourceOutputDouble()});try{
   const plan=await f.r.casework.createPlan(f.id);await f.deliver();f.sent.length=0;f.r.worker.reasoner=new RulesReasoner();await f.question();await f.settle();await f.deliver();
   const c=await f.r.store.context(f.id);assert.equal(c.incident.analysis.sourceFindings,undefined);assert.equal(c.incident.analysis.sourceFindingChanges.removed,1);assert.equal((await f.r.casework.getPlan(plan.id,f.id)).markdown,plan.markdown);
   for(const room of f.rooms)assert.ok(f.sent.some(message=>message.room===room&&message.text.includes('Earlier source hypothesis locations are absent')));
  }finally{await f.close();}
 });
 test(dialect+': a changed source explanation reaches both peers even when its location and the overall summary stay unchanged',async()=>{
  const f=await sourceReferenceFixture(dialect,{reasoner:sourceOutputDouble()});try{
   const prior=(await f.r.store.context(f.id)).incident.analysis;await f.deliver();f.sent.length=0;const investigate=f.r.worker.reasoner.investigate;
   f.r.worker.reasoner={investigate:async(...args)=>{const result=await investigate(...args);result.analysis.sourceFindings[0].explanation='UPDATED-SOURCE-HYPOTHESIS: check whether the database transaction supplies the missing guard before changing this code.';return result;}};
   await f.question();await f.settle();await f.deliver();const current=(await f.r.store.context(f.id)).incident.analysis;
   assert.equal(current.summary,prior.summary);assert.equal(current.sourceFindings[0].startLine,prior.sourceFindings[0].startLine);assert.equal(current.sourceFindingChanges,undefined);
   for(const room of f.rooms)assert.ok(f.sent.some(message=>message.room===room&&message.text.includes('UPDATED-SOURCE-HYPOTHESIS')));
   f.sent.length=0;await f.question();await f.settle();await f.deliver();assert.equal(f.sent.filter(message=>message.text.startsWith('Incident brief')).length,0);
  }finally{await f.close();}
 });
}
test('file reopen preserves exact source bytes, references and the immutable Markdown ticket',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sre-source-flow-')),f=await sourceReferenceFixture('sqlite',{directory,databasePath:join(directory,'agent.sqlite'),reasoner:sourceOutputDouble()});try{
  const plan=await f.r.casework.createPlan(f.id),before=await f.r.store.db.query('SELECT * FROM sre_evidence ORDER BY id');await f.restart();assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_evidence ORDER BY id'),before);assert.equal((await f.r.casework.getPlan(plan.id,f.id)).markdown,plan.markdown);const c=await f.r.store.context(f.id);assert.equal(c.incident.analysis.sourceFindings[0].verifiedLocation,true);assert.equal(c.sourceCode.files.length,2);
 }finally{await f.close();await rm(directory,{recursive:true,force:true});}
});
for(const[from,to]of [['sqlite','postgres'],['postgres','sqlite']])test(from+' → '+to+': source references survive database transfer without reading or executing restored code',async()=>{
 const source=await sourceReferenceFixture(from,{reasoner:sourceOutputDouble()}),target=await sourceReferenceFixture(to,{directory:source.directory,seed:false});try{
  const plan=await source.r.casework.createPlan(source.id),actor={kind:'local-operator',id:'Fictional source transfer reviewer'},archive=await exportDatabase(source.r.store,{offline:true,actor});
  await importDatabase(target.r.store,{snapshot:archive.snapshot,expectedSha256:archive.sha256,restoreId:'source-reference-cutover',reason:'Fictional immutable source transfer',offline:true,actor});target.id=source.id;
  const c=await target.r.store.context(source.id);assert.equal(c.recoveryFence.active,true);assert.equal(c.sourceCode.files.length,2);assert.equal(c.incident.analysis,null);const saved=await target.r.store.db.query('SELECT body FROM sre_assessments WHERE incident_id=?',[source.id]);assert.ok(saved.some(row=>JSON.parse(row.body).sourceFindings?.[0]?.verifiedLocation===true));assert.equal((await target.r.casework.getPlan(plan.id,source.id)).markdown,plan.markdown);assert.equal(target.calls.length,0);assert.equal(await target.r.outbox.runOnce(),false);await assert.rejects(()=>target.r.casework.createPlan(source.id),/held/);
 }finally{await target.close();await source.close();}
});
