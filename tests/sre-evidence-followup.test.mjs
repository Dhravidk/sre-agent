import test from 'node:test';import assert from 'node:assert/strict';
import {sourceReferenceFixture} from '../fixtures/sre-source-references.mjs';import {EvidenceFollowup} from '../src/sre/evidence-followup.mjs';import {sourceReadBudget} from '../src/sre/source-evidence.mjs';import {validateEvidenceRequests,validateFollowupConfiguration,materialEvidenceReads,retainedEvidenceReads} from '../src/sre/evidence-request.mjs';import {sourceReferenceWindow,validateSourceFindings} from '../src/sre/source-references.mjs';import {boundedContext} from '../src/sre/model-context.mjs';
const file=(sha,extra={})=>({kind:'gitlab_file',sha,path:'src/ledger/retry.py',startLine:1,endLine:2,reason:'Compare retryability with the observed exception class.',...extra});
async function harness(options={}){const f=await sourceReferenceFixture('sqlite',{followUp:true,...options});await f.question();await f.r.store.release(f.r.worker.owner);const job=await f.r.store.claim('followup-unit-reviewer'),context=await f.r.store.context(f.id),budget=sourceReadBudget(),controller=new AbortController(),followup=new EvidenceFollowup({store:f.r.store,job,service:f.service,clients:f.r.worker.connectors.get(f.service.key),sourceBudget:budget,signal:controller.signal});await followup.policy(context,0);return{f,job,context,budget,controller,followup};}
test('follow-up output/configuration admits only explicit scoped read proposals',()=>{
 const request=file('a'.repeat(40));assert.equal(validateEvidenceRequests([request])[0].kind,'gitlab_file');
 for(const value of [true,{},[request,request,request],[{...request,url:'https://foreign'}],[{...request,project:'../foreign'}],[{...request,command:'deploy'}],[{...request,startLine:'1'}],[{...request,reason:''}],[{kind:'servicenow_update',reason:'write'}]])assert.throws(()=>validateEvidenceRequests(value));
 for(const configuration of [{followUp:true},{followUp:{enabled:'true'}},{followUp:{enabled:true,maxReads:500}},{followUp:{enabled:true},tools:['delete']}])assert.throws(()=>validateFollowupConfiguration({investigation:configuration}));assert.doesNotThrow(()=>validateFollowupConfiguration({investigation:{followUp:{enabled:false}}}));
});
test('exact follow-up source is atomically retained with its outcome and delivered as numbered source only',async()=>{
 const h=await harness();try{assert.equal(await h.followup.run([file(h.f.manifest.head)],h.context,0),true);const c=await h.f.r.store.context(h.f.id),events=c.evidence.filter(row=>row.kind==='evidence_read');assert.equal(events.length,2);const outcome=events.find(row=>row.content.phase==='collected');assert.ok(c.evidence.some(row=>row.id===outcome.content.sourceEvidenceId));const view=boundedContext(c),source=view.sourceCode.files.find(f=>f.path==='src/ledger/retry.py');assert.equal(source.side,'requested-source');assert.equal(source.lines[1].text,'    return isinstance(error, RuntimeError)');assert.equal(view.evidence.find(row=>row.id===source.evidenceId).content.requestedSource.file.content,undefined);const finding={evidenceId:source.evidenceId,provider:'gitlab',project:source.project,sha:source.sha,path:source.path,startLine:2,endLine:2,quote:source.lines[1].text,explanation:'Compare this predicate with the actual exception; cause is unknown.'};assert.equal(validateSourceFindings([finding],c,view)[0].verifiedLocation,true);
 }finally{await h.f.close();}
});
test('an explicit fixed project is the same scoped selector as its omitted form and survives retained-source validation',async()=>{
 const h=await harness();try{
  const request=file(h.f.manifest.head),project=h.f.service.gitlab.project,count=h.f.calls.length;
  await h.followup.run([{...request,project},request],h.context,0);
  assert.deepEqual(h.followup.results.map(row=>row.phase),['collected','duplicate']);assert.equal(h.f.calls.length-count,1);assert.equal(h.budget.reads,7);
  const c=await h.f.r.store.context(h.f.id),view=boundedContext(c),source=view.sourceCode.files.find(row=>row.side==='requested-source');assert.ok(source);assert.equal(source.project,project);
  const artifact=c.evidence.find(row=>row.id===source.evidenceId).content.requestedSource;assert.equal(Object.hasOwn(artifact.request,'project'),false);assert.equal(artifact.project,project);assert.equal(artifact.discoveryScopeKey,undefined);
 }finally{await h.f.close();}
});
test('unseen revisions, traversal, URLs and excessive line ranges are refused without invoking a file reader',async()=>{
 const h=await harness();try{const count=h.f.calls.length;for(const request of [file('c'.repeat(40)),file(h.f.manifest.head,{project:'foreign/project'}),file(h.f.manifest.head,{path:'../secret.py'}),file(h.f.manifest.head,{path:'https://foreign/secret.py'}),file(h.f.manifest.head,{endLine:100})])await h.followup.run([request],h.context,0);assert.equal(h.f.calls.length,count);assert.ok(h.followup.results.every(r=>r.phase==='refused'));assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_requested'")).length,0);
 }finally{await h.f.close();}
});
test('another provider deployment cannot authorize a GitLab revision and policy delivered to a reasoner cannot be mutated into authority',async()=>{
 const h=await harness();try{const sha='c'.repeat(40),c={...h.context,sourceCode:undefined,evidence:[],deployments:[{provider:'github',sha}]};const policy=await h.followup.policy(c,0);assert.equal(policy.source.allowedRevisions.includes(sha),false);policy.source.allowedRevisions.push(sha);const count=h.f.calls.length;await h.followup.run([file(sha)],c,0);assert.equal(h.f.calls.length,count);assert.equal(h.followup.results[0].phase,'refused');
 }finally{await h.f.close();}
});
test('duplicate selectors do not retry provider reads and file ranges share one scoped byte cache',async()=>{
 const h=await harness();try{const before=h.f.calls.length;await h.followup.run([file(h.f.manifest.head),file(h.f.manifest.head,{reason:'Repeat this request despite the earlier result.'})],h.context,0);assert.equal(h.f.calls.length-before,1);assert.equal(h.followup.results[1].phase,'duplicate');const c=await h.f.r.store.context(h.f.id);await h.followup.policy(c,1);await h.followup.run([file(h.f.manifest.head,{startLine:2,endLine:2})],c,1);assert.equal(h.f.calls.length-before,1);assert.equal(h.budget.reads,7);
 }finally{await h.f.close();}
});
test('log windows cannot introduce a query, service or out-of-bounds time and only two queries run per attempt',async()=>{
 const h=await harness({logLocations:true});try{const policy=await h.followup.policy(h.context,0),from=h.context.incident.started_at-1000,to=h.context.incident.started_at+1,request={kind:'dynatrace_logs',from,to,reason:'Inspect this bounded earlier error window.'},before=h.f.logCalls.length;assert.throws(()=>validateEvidenceRequests([{...request,query:'fetch everything'}]));await h.followup.run([{...request,to:policy.logs.latestTo+1000}],h.context,0);assert.equal(h.f.logCalls.length,before);await h.followup.run([request],h.context,0);const c=await h.f.r.store.context(h.f.id);await h.followup.policy(c,1);await h.followup.run([{...request,from:from-1},{...request,from:from-2}],c,1);assert.equal(h.f.logCalls.length-before,2);assert.equal(h.followup.results.at(-1).phase,'limited');
 }finally{await h.f.close();}
});
test('partial log pages retain uncertainty and overlap without advancing a provider checkpoint',async()=>{
 const h=await harness({logLocations:true});try{h.f.logReply.complete=false;const request={kind:'dynatrace_logs',from:h.context.incident.started_at-1000,to:h.context.incident.started_at+1,reason:'Read overlapping partial records.'},before=await h.f.r.store.db.query("SELECT * FROM sre_checkpoints WHERE id LIKE 'poll:%'"),groups=h.context.signalDigest.groups;await h.followup.run([request],h.context,0);const c=await h.f.r.store.context(h.f.id);assert.equal(h.followup.results[0].coverage.complete,false);assert.deepEqual(await h.f.r.store.db.query("SELECT * FROM sre_checkpoints WHERE id LIKE 'poll:%'"),before);assert.equal(c.signalDigest.groups.find(g=>g.code==='AMOUNT_PARSE').observations,groups.find(g=>g.code==='AMOUNT_PARSE').observations);assert.ok(c.signalDigest.coverage.partialResults>0);
 }finally{await h.f.close();}
});
test('denied reads are recorded as unavailable without claiming a source artifact',async()=>{
 const h=await harness();try{h.f.client.file=async()=>{throw Error('Forbidden source reader');};await h.followup.run([file(h.f.manifest.head)],h.context,0);assert.equal(h.followup.results[0].phase,'unavailable');assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_requested'")).length,0);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='evidence_read'")).length,2);
 }finally{await h.f.close();}
});
test('oversized follow-up log responses are unavailable, not silently truncated into usable complete evidence',async()=>{
 const h=await harness({logLocations:true});try{h.f.logReply.records[0].content='x'.repeat(128001);const request={kind:'dynatrace_logs',from:h.context.incident.started_at-1000,to:h.context.incident.started_at+1,reason:'Inspect the reported exception.'};await h.followup.run([request],h.context,0);assert.equal(h.followup.results[0].phase,'unavailable');assert.match(h.followup.results[0].error,/byte budget/);const rows=await h.f.r.store.db.query("SELECT content FROM sre_evidence WHERE kind='logs'");assert.equal(rows.some(row=>JSON.parse(row.content).followUp),false);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='evidence_read'")).length,2);
 }finally{await h.f.close();}
});
test('follow-up source cannot obtain a fresh file budget after initial collection has exhausted it',async()=>{
 const h=await harness();try{h.budget.reads=0;const calls=h.f.calls.length;await h.followup.run([file(h.f.manifest.head)],h.context,0);assert.equal(h.f.calls.length,calls);assert.equal(h.followup.results[0].phase,'unavailable');assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_requested'")).length,0);
 }finally{await h.f.close();}
});
test('stale revision before a request records no start and makes no provider read',async()=>{
 const h=await harness();try{const calls=h.f.calls.length;await h.f.r.store.db.query('UPDATE sre_incidents SET revision=revision+1 WHERE id=?',[h.f.id]);assert.equal(await h.followup.run([file(h.f.manifest.head)],h.context,0),false);assert.equal(h.f.calls.length,calls);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='evidence_read'")).length,0);
 }finally{await h.f.close();}
});
test('a report arriving during a file read prevents accepting its artifact or a collected outcome',async()=>{
 const h=await harness();try{let enter,release;const entered=new Promise(ok=>enter=ok),wait=new Promise(ok=>release=ok),original=h.f.client.file.bind(h.f.client);h.f.client.file=async(...args)=>{enter();await wait;return original(...args);};const pending=h.followup.run([file(h.f.manifest.head)],h.context,0);await entered;await h.f.r.store.db.query('UPDATE sre_incidents SET revision=revision+1 WHERE id=?',[h.f.id]);release();assert.equal(await pending,false);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_requested'")).length,0);const events=await h.f.r.store.db.query("SELECT content FROM sre_evidence WHERE kind='evidence_read'");assert.deepEqual(events.map(e=>JSON.parse(e.content).phase),['started']);
 }finally{await h.f.close();}
});
test('lease loss and cancellation never accept late source outcomes',async()=>{
 for(const mode of ['lease','cancel']){const h=await harness();try{let enter,release;const entered=new Promise(ok=>enter=ok),wait=new Promise(ok=>release=ok),original=h.f.client.file.bind(h.f.client);h.f.client.file=async(...args)=>{enter();await wait;return original(...args);};const pending=h.followup.run([file(h.f.manifest.head)],h.context,0);await entered;if(mode==='lease')await h.f.r.store.db.query("UPDATE sre_locks SET owner='another-investigator' WHERE name='single-agent'");else h.controller.abort(Error('Cancelled follow-up'));release();await assert.rejects(()=>pending,/lease lost|Cancelled/);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_requested'")).length,0);
 }finally{await h.f.close();}}
});
test('source artifact and terminal read event roll back together when the final insert is denied',async()=>{
 const h=await harness();try{const transaction=h.f.r.store.db.transaction;h.f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('INSERT INTO sre_evidence')&&args[3]==='evidence_read'&&JSON.parse(args[5]).phase==='collected')throw Error('Injected final outcome denial');return q(sql,args);}));await assert.rejects(()=>h.followup.run([file(h.f.manifest.head)],h.context,0),/denial/);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_requested'")).length,0);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='evidence_read'")).length,1);
 }finally{await h.f.close();}
});
test('restore hold blocks new requested reads while retaining prior request history',async()=>{
 const h=await harness();try{await h.followup.run([file(h.f.manifest.head)],h.context,0);await h.f.r.store.checkpoint('recovery:database-restore',{version:1,active:true,restoreId:'followup-hold',backupSha256:'f'.repeat(64),preparedAt:await h.f.r.store.coordinationNow()});const calls=h.f.calls.length;await assert.rejects(()=>h.followup.run([file(h.f.manifest.head,{path:'src/ledger/other.py'})],h.context,0),/held/);assert.equal(h.f.calls.length,calls);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='evidence_read'")).length,2);
 }finally{await h.f.close();}
});
test('records outside a requested log window or missing source time cannot be called a complete follow-up read',async()=>{
 for(const mode of ['outside','missing','sampled','limit']){const h=await harness({logLocations:true});try{
  const request={kind:'dynatrace_logs',from:h.context.incident.started_at-60000,to:h.context.incident.started_at-59000,reason:'Read the earlier source window.'};if(mode==='limit')h.f.logReply.records=Array.from({length:200},(_,index)=>({...h.f.logReply.records[0],timestamp:new Date(request.from+1).toISOString(),content:'record '+index}));if(mode==='missing')delete h.f.logReply.records[0].timestamp;if(mode==='sampled'){h.f.logReply.records[0].timestamp=new Date(request.from+1).toISOString();h.f.logReply.metadata={grail:{sampled:true}};}
  await h.followup.run([request],h.context,0);assert.equal(h.followup.results[0].coverage.complete,false,mode);const rows=await h.f.r.store.db.query("SELECT content FROM sre_evidence WHERE kind='logs' ORDER BY observed_at DESC"),read=rows.map(row=>JSON.parse(row.content)).find(row=>row.followUp);assert.equal(read.complete,false);assert.equal(read.followUp.sourceComplete,true);assert.deepEqual(read.records,h.f.logReply.records);
 }finally{await h.f.close();}}
});
test('a retained requested-source selector or quote cannot be changed into another file or line',async()=>{
 const h=await harness();try{await h.followup.run([file(h.f.manifest.head)],h.context,0);const c=await h.f.r.store.context(h.f.id),source=c.evidence.find(e=>e.kind==='source_requested');source.content.requestedSource.request.path='src/foreign.py';assert.equal(sourceReferenceWindow(c).files.some(f=>f.path==='src/ledger/retry.py'),false);
 }finally{await h.f.close();}
});
test('stable retained read outcomes ignore receipt identifiers and survive a later no-read turn',()=>{
 const a={kind:'gitlab_file',selector:file('a'.repeat(40)),phase:'collected',coverage:{complete:true},eventId:'old'},b={...a,eventId:'new',requestId:'different'};assert.deepEqual(materialEvidenceReads([a]),materialEvidenceReads([b]));assert.deepEqual(retainedEvidenceReads([a],[]),[a]);assert.deepEqual(retainedEvidenceReads([a],[{...b,phase:'duplicate'}]),[a]);assert.notDeepEqual(materialEvidenceReads([a]),materialEvidenceReads([{...a,phase:'unavailable'}]));
});
