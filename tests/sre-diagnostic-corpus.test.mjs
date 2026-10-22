import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PGlite} from '@electric-sql/pglite';
import {createDiagnosticCorpus,runDiagnosticGold,diagnosticGit,diagnosticRecords,diagnosticSourcePath} from '../fixtures/sre-diagnostic-corpus.mjs';
import {replayDiagnosticCorpus} from '../fixtures/sre-diagnostic-replay.mjs';
import {runOfflineDiagnosticEvaluation} from '../scripts/sre-diagnostic-evaluation.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {hash} from '../src/sre/security.mjs';

const exec=promisify(execFile);let parent,corpus,gold;
before(async()=>{parent=await mkdtemp(join(tmpdir(),'sre-diagnostic-tests-'));corpus=await createDiagnosticCorpus(parent);gold=[];for(const entry of corpus.cases)gold.push(await runDiagnosticGold(corpus,entry.id));});
after(async()=>{await rm(parent,{recursive:true,force:true});});

test('the authored corpus retains three immutable source revisions per case and preserves exact Git bytes',async()=>{
 assert.equal(corpus.cases.length,6);
 for(const entry of corpus.cases){assert.equal(new Set(Object.values(entry.revisions)).size,3);assert.match(entry.revisions.observed,/^[a-f0-9]{40}$/);assert.equal(await diagnosticGit(corpus,entry.id,['remote']),'');assert.equal(await diagnosticGit(corpus,entry.id,['rev-parse',entry.revisions.observed+'^']),entry.revisions.base);for(const row of gold.find(value=>value.caseId===entry.id).results){const source=await diagnosticGit(corpus,entry.id,['show',row.sha+':'+diagnosticSourcePath],{raw:true});assert.ok(source.endsWith('\n'));assert.equal(hash(source),row.sourceHash);}}
});

for(const [id,field,baseValue,observedValue]of[['case-01','actualAttempts',1,3],['case-02','actualAppends',1,2],['case-03','actualRegion','south','north']])test(id+': actual controlled requests fail at the changed revision and pass again after correction',()=>{
 const example=gold.find(value=>value.caseId===id);assert.deepEqual(example.results.map(row=>row.exitCode),[0,1,0]);assert.ok(example.results.every(row=>row.matchesExpected));assert.ok(example.results[0].observations.every(row=>row[field]===baseValue));assert.ok(example.results[1].observations.every(row=>row[field]===observedValue));assert.ok(example.results[2].observations.every(row=>row[field]===baseValue));assert.ok(example.expectedSourceLocation.line>0);
});
test('unchanged-code dependency failure and a healthy release remain negative controls for code blame',()=>{
 const dependency=gold.find(value=>value.caseId==='case-04'),healthy=gold.find(value=>value.caseId==='case-05');assert.deepEqual(dependency.results.map(row=>row.exitCode),[1,1,1]);assert.ok(dependency.results.every(row=>row.observations.every(record=>record.status===503)));assert.equal(dependency.expectedSourceLocation,null);assert.deepEqual(healthy.results.map(row=>row.exitCode),[0,0,0]);assert.ok(healthy.results.every(row=>row.observations.every(record=>record.status===200)));assert.equal(healthy.expectedSourceLocation,null);
});
test('public request observations exclude gold verdicts and cannot silently switch case or revision',()=>{
 const entry=corpus.cases[0],observations=diagnosticRecords(entry,gold[0],Date.now()-1000);assert.equal(observations.length,3);assert.ok(observations.every(row=>row.level==='ERROR'&&!Object.hasOwn(JSON.parse(row.message),'ok')));assert.throws(()=>diagnosticRecords(entry,gold[1],Date.now()),/another case/);assert.throws(()=>diagnosticRecords({...entry,revisions:{...entry.revisions,observed:'f'.repeat(40)}},gold[0],Date.now()),/revision differs/);
});
test('gold execution refuses modified repository source before running it',async()=>{
 const entry=corpus.cases[0],original=entry.revisions.observed;
 try{await writeFile(join(entry.repository,entry.path),"throw Error('Unapproved source must not execute');\n");await diagnosticGit(corpus,entry.id,['add',entry.path]);await diagnosticGit(corpus,entry.id,['commit','-qm','Controlled source mutation for execution-boundary check']);entry.revisions.observed=await diagnosticGit(corpus,entry.id,['rev-parse','HEAD']);await assert.rejects(runDiagnosticGold(corpus,entry.id),/source differs from the authored fixture/);}finally{entry.revisions.observed=original;}
});

for(const dialect of['sqlite','postgres'])test((dialect==='postgres'?'PostgreSQL dialect (PGlite)':dialect)+': six real host investigations preserve three-group context and source denial without model, QA or deployment actions',async()=>{
 const dbPath=join(parent,'replay-'+dialect),databaseFactory=dialect==='postgres'?async()=>{const pg=new PGlite(dbPath);return{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}:undefined;
 const f=await replayDiagnosticCorpus(corpus,gold,{databasePath:dialect==='sqlite'?dbPath+ '.sqlite':':memory:',databaseFactory});
 try{const packets=await f.packets();assert.equal(f.r.config.agentMode,'rules');assert.equal(f.cases.filter(value=>value.detected).length,5);assert.ok(f.calls.every(value=>value.method==='GET'));
  for(const packet of packets){const entry=corpus.cases.find(value=>value.id===packet.caseId),encoded=JSON.stringify(packet.input);assert.equal(packet.assessment.changeAssessment,'unknown');assert.equal(packet.assessment.codeReview.findings.length,0);assert.equal(packet.plan.payload.patch,null);assert.equal(packet.collaboration.rooms.length,3);assert.ok(packet.collaboration.issues.some(issue=>issue.code==='overlapping-work'));assert.ok(packet.contacts.contacts.some(contact=>contact.role==='service-owner'));assert.ok(!encoded.includes(entry.revisions.followUp));assert.ok(!encoded.includes(gold.find(value=>value.caseId===entry.id).mechanism));assert.ok(!encoded.includes('fictional-reader-no-access'));
   assert.ok(packet.collaboration.issues.some(issue=>issue.code==='competing-theories'));for(const other of f.cases.filter(value=>value.id!==packet.caseId))assert.ok(!encoded.includes(other.incidentId),'Another incident entered this model packet');
   for(const file of packet.input.incident.sourceCode.files){assert.equal(file.project,entry.project);assert.ok([entry.revisions.base,entry.revisions.observed].includes(file.sha));const source=(await diagnosticGit(corpus,entry.id,['show',file.sha+':'+file.path],{raw:true})).split('\n');for(const line of file.lines)assert.equal(line.text,source[line.line-1]);}
  }
  const partial=packets.find(value=>value.caseId==='case-06');assert.equal(partial.input.incident.sourceCode.files.some(file=>file.sha===corpus.cases[5].revisions.observed),false);assert.equal(partial.input.incident.sourceCode.files.length,1);
  await f.deliver();for(const record of f.cases)for(const room of record.rooms)assert.ok(f.sent.some(value=>value.room===room&&value.text.includes(record.incidentId)));
  const before=packets.map(packet=>({id:packet.plan.id,markdown:packet.plan.markdown}));await f.restart();assert.deepEqual((await f.packets()).map(packet=>({id:packet.plan.id,markdown:packet.plan.markdown})),before);await f.lateWorkerUpdate();const after=await f.packets({latest:true});assert.ok(JSON.stringify(after[0].input).includes('LATE-WORKER'));assert.ok(after[0].plan.markdown.includes('LATE-WORKER'));assert.notEqual(after[0].plan.id,packets[0].plan.id);assert.equal((await f.r.casework.getPlan(before[0].id,f.cases[0].incidentId)).markdown,before[0].markdown);for(const value of after.slice(1))assert.ok(!JSON.stringify(value.input).includes('LATE-WORKER'));assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS n FROM sre_fix_requests'))[0].n),0);assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS n FROM sre_rollbacks'))[0].n),0);
 }finally{await f.close();}
});

test('diagnostic replay rejects relative and absolute default-database paths before opening storage',async()=>{
 for(const databasePath of['.local/sre.sqlite',resolve('.local/sre.sqlite')])await assert.rejects(replayDiagnosticCorpus(corpus,gold,{databasePath}),/dedicated diagnostic evaluation database/);
});

test('the offline CLI rejects model activation rather than using a configured Claude binary',async()=>{
 const cwd=await mkdtemp(join(parent,'invalid-cli-'));await assert.rejects(exec(process.execPath,[resolve('scripts/sre-diagnostic-evaluation.mjs'),'--claude'],{cwd,env:{PATH:process.env.PATH,SRE_CLAUDE_BIN:'/nonexistent-forbidden-model'}}),error=>error.code===1&&/no model or connector activation flag/.test(error.stderr));assert.deepEqual(await readdir(cwd),[]);
});
test('the full preparation report never turns code gold or rules workflow checks into a model-quality score',async()=>{
 const report=await runOfflineDiagnosticEvaluation({parent:join(parent,'command-run')});assert.equal(report.status,'offline-workflow-and-code-checks-passed');assert.equal(report.diagnosticQuality.status,'not_evaluated');assert.equal(report.diagnosticQuality.actualModelInvocations,0);assert.equal(report.diagnosticQuality.heldOut,false);assert.equal(report.summary.trustedRevisionChecks,18);assert.equal(report.summary.modelDiagnosticScore,null);assert.equal(report.databaseReopenPreservedTickets,true);
 const review=JSON.parse(await readFile(join(report.directory,'review-template.json'),'utf8'));assert.equal(review.reviewer,null);assert.ok(review.cases.every(value=>value.mechanismCorrect===null));for(const value of report.cases){const input=await readFile(join(report.directory,value.input),'utf8');assert.ok(!input.includes('expectedPass'));assert.ok(!input.includes(value.codeChecks[2].sha));assert.ok((await readFile(join(report.directory,value.ticket),'utf8')).startsWith('# Fix ticket:'));}
});
