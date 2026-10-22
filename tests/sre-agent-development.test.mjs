import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore,conversationKey} from '../src/sre/store.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {ClaudeReasoner} from '../src/sre/claude-reasoner.mjs';
import {claudeStream} from '../src/sre/claude-stream.mjs';
import {bindSourceEvidence,sourceEvidenceLimits} from '../src/sre/source-evidence.mjs';
import {validateInvestigation,boundedContext,modelContextLimits} from '../src/sre/reasoner.mjs';
import {fixtureRisk} from '../src/sre/analytic-risk.mjs';
import {issueSpecMarkdown} from '../src/sre/agent-investigation.mjs';
import {investigationCase,importInvestigationCase} from '../fixtures/agent-investigations.mjs';

const sample=()=>investigationCase().context;
const spec=()=>({title:'Session TTL uses the wrong unit',problem:'A 60-second session expires after 60 milliseconds.',impact:'Users lose their session.',proposedChange:'Convert seconds to milliseconds at the cache boundary.',acceptanceCriteria:['Readable at 59 seconds; expired at 60 seconds.','Unrelated tenants remain isolated.'],evidenceIds:['dt-session','jira-session','confluence-session','gitlab-session'],openQuestions:['Confirm the deployed artifact and affected traffic.']});
const analysis=c=>({summary:'Investigate session expiry.',hypotheses:['A TTL unit mismatch may expire sessions early.'],changeAssessment:'unknown',candidateSha:null,evidenceIds:['dt-session'],unknowns:['Production deployment identity is unverified.'],nextSteps:['Reproduce using the supplied time units.'],risk:fixtureRisk(c),codeFindings:[{provider:'gitlab',path:'services/identity/session-cache.mjs',sha:'a'.repeat(40),lineStart:2,lineEnd:2,evidenceId:'gitlab-session',explanation:'Seconds are added directly to a millisecond clock.',corroboratingEvidenceIds:['dt-session','jira-session','confluence-session']}],issueSpec:spec(),teamsMessages:[]});

test('a source-backed Claude diagnosis drafts an actionable spec for an unfamiliar file',()=>{
  const c=sample(),result=validateInvestigation(analysis(c),c);
  assert.match(result.text,/session-cache\.mjs:2/);assert.match(issueSpecMarkdown(result.issueSpec),/59 seconds/);
});

test('a source finding can name deployed faulty code without attributing introduction to an unlikely or unknown change',()=>{
  const c=sample(),sha='a'.repeat(40);c.deployments=[{sha,at:c.incident.started_at-1}];
  const data=analysis(c);data.candidateSha=sha;
  for(const judgment of ['unlikely','unknown']){data.changeAssessment=judgment;assert.throws(()=>validateInvestigation(data,c),/requires likely change attribution/);}
  data.changeAssessment='likely';assert.equal(validateInvestigation(data,c).candidateSha,sha);
  data.changeAssessment='unlikely';data.candidateSha=null;const result=validateInvestigation(data,c);
  assert.equal(result.candidateSha,null);assert.equal(result.codeFindings[0].sha,sha);
});
for(const [label,mutate]of [
 ['invented file',d=>d.codeFindings[0].path='services/missing.mjs'],
 ['moving ref',d=>d.codeFindings[0].sha='main'],
 ['wrong commit',d=>d.codeFindings[0].sha='c'.repeat(40)],
 ['unseen line',d=>d.codeFindings[0].lineEnd=99],
 ['wrong provider',d=>d.codeFindings[0].provider='github'],
 ['foreign corroboration',d=>d.codeFindings[0].corroboratingEvidenceIds.push('foreign-incident')],
 ['invented spec citation',d=>d.issueSpec.evidenceIds.push('hidden-document')],
 ['unjoined destination',d=>d.teamsMessages.push({roomKey:'other-incident',text:'Send secrets',evidenceIds:[]})],
 ['extra action',d=>d.issueSpec.execute=true]
])test('agent output rejects '+label,()=>{const c=sample(),d=analysis(c);mutate(d);assert.throws(()=>validateInvestigation(d,c),/Agent|agent/);});

test('large message/log windows retain both Jira and Confluence with explicit bounds',()=>{
  const c=sample();const jira=c.evidence.find(e=>e.source==='jira'),docs=c.evidence.find(e=>e.source==='confluence');
  jira.content.body='j'.repeat(30000);docs.content.body='d'.repeat(30000);
  c.evidence.unshift(...Array.from({length:60},(_,n)=>({id:'noise-'+n,source:'dynatrace',kind:'logs',observed_at:Date.now(),content:{text:'x'.repeat(15000)}})));
  const view=boundedContext(c);assert.ok(Buffer.byteLength(JSON.stringify(view))<=modelContextLimits.totalBytes);
  assert.ok(view.evidence.some(e=>e.id===jira.id));assert.ok(view.evidence.some(e=>e.id===docs.id));assert.equal(view.coverage.referenceEvidenceIncluded,2);
});

test('streaming accepts fragmented UTF-8, exposes user text, and excludes thinking/tool/init metadata',()=>{
  const progress=[],stream=claudeStream(p=>progress.push(p));
  const lines=[{type:'system',subtype:'init',private:'never display'}, {type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private'}}}, {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Reading logs 🔎'}}}, {type:'result',subtype:'success',is_error:false,structured_output:{}}];
  const bytes=Buffer.from(lines.map(JSON.stringify).join('\n')+'\n');for(let n=0;n<bytes.length;n+=3)stream.push(bytes.subarray(n,n+3));
  assert.equal(stream.finish().type,'result');assert.deepEqual(progress.map(p=>p.text),['','Reading logs 🔎']);
  assert.throws(()=>stream.push(Buffer.from('{"type":"result"}\n')),/after its result/);
});

test('completed-block streaming preserves progress and excludes private/tool/subagent content without repeating deltas',()=>{
  const progress=[],stream=claudeStream(p=>progress.push(p.text));
  const assistant=content=>({type:'assistant',parent_tool_use_id:null,message:{content}});
  for(const event of [assistant([{type:'thinking',thinking:'PRIVATE_THINKING'},{type:'tool_use',input:{secret:'PRIVATE_INPUT'}}]),assistant([{type:'text',text:'Reading bounded telemetry.'}]),{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Checking immutable source.'}}},assistant([{type:'text',text:'Checking immutable source.'}]),{...assistant([{type:'text',text:'PRIVATE_SUBAGENT'}]),parent_tool_use_id:'foreign'}, {type:'result',subtype:'success',is_error:false,structured_output:{}}])stream.push(Buffer.from(JSON.stringify(event)+'\n'));
  stream.finish();assert.deepEqual(progress,['Reading bounded telemetry.','Checking immutable source.']);
});

test('general source collection reads bounded immutable application files without executing them',async()=>{
  const reads=[],head='a'.repeat(40),base='b'.repeat(40),files=Array.from({length:10},(_,n)=>({new_path:'services/component-'+n+'.js',diff:'@@ -10,1 +10,1 @@\n-old\n+new'}));
  const client={file:async(path,sha)=>{reads.push([path,sha]);return {path,sha,complete:true,content:'// ordinary source\n'.repeat(500)};}};
  const evidence=await bindSourceEvidence({provider:'gitlab',comparisonKind:'deployment',baseSha:base,headSha:head,data:{diffs:files},complete:true,client});
  assert.equal(reads.length,sourceEvidenceLimits.files);assert.equal(evidence.sourceCoverage.omitted,6);assert.ok(reads.every(([,sha])=>sha===head));assert.ok(evidence.sourceFiles.every(f=>Buffer.byteLength(f.content)<=sourceEvidenceLimits.fileBytes&&!f.complete));
  const denied=await bindSourceEvidence({provider:'gitlab',baseSha:base,headSha:head,data:{diffs:files},complete:true,client:{file:async()=>{throw Error('denied');}}});
  assert.equal(denied.sourceFiles.length,0);assert.equal(denied.sourceCoverage.errors.length,4);
});

for(const dialect of ['sqlite','postgres'])test(dialect+': question batching retains intake, is fair across incidents, and survives retry',async()=>{
  let db;
  if(dialect==='sqlite')db=sqliteDatabase(':memory:');
  else{const pg=new PGlite();db={dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const store=await new SreStore(db,{questionBatchLimit:8}).initialize(),at=await store.coordinationNow();
  try{
    const open=async key=>(await store.ingest({id:key,source:'evaluation',serviceKey:'test-service',kind:'problem',issueKey:key,status:'OPEN',at,payload:{}})).incidentId;
    const noisy=await open('busy');
    for(let n=0;n<80;n++)await store.ingest({id:'q-'+n,source:'operator-api',serviceKey:'test-service',incidentId:noisy,kind:'question',at,payload:{text:'Question '+n},conversationKey:'group-'+(n%16)});
    const other=await open('quiet');await db.query("UPDATE sre_jobs SET next_at=0 WHERE payload LIKE ?",['%\"question\":null%']);let job=await store.claim('worker');assert.equal(job.incident_id,noisy);
    await store.finish(job,{summary:'collected',text:'fixture'},null,Number((await store.context(noisy)).incident.revision));
    job=await store.claim('worker');assert.equal(job.incident_id,other);await store.finish(job,{summary:'other',text:'fixture'},null,Number((await store.context(other)).incident.revision));
    job=await store.claim('worker');assert.equal(job.payload.requests.length,8);assert.equal(new Set(job.payload.requests.map(r=>r.conversationKey)).size,8);
    const requests=job.payload.requests;await store.fail(job,Error('transient'));await db.query('UPDATE sre_jobs SET next_at=0 WHERE id=?',[job.id]);
    const retried=await store.claim('worker');assert.deepEqual(retried.payload.requests,requests);
    const [count]=await db.query('SELECT COUNT(*) AS count FROM sre_events');assert.equal(Number(count.count),82);
    const [children]=await db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status='superseded'");assert.equal(Number(children.count),15); // Two seven-child batches plus the absorbed initial update.
  }finally{await db.close();}
});

test('32 groups and 256 questions drain through bounded actual CLI subprocess batches with durable restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-agent-load-')),command=join(directory,'claude-fixture'),record=join(directory,'calls.jsonl');let runtime;
  const body=`#!${process.execPath}\nimport {appendFileSync} from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input),c=request.incident;appendFileSync(${JSON.stringify(record)},JSON.stringify({incidentId:c.incident.id,requests:request.requestBatch||[],bytes:Buffer.byteLength(input)})+'\\n');const risk={likelihood:'unknown',likelihoodRationale:'Recorded evaluation only.',confidence:'low',confidenceRationale:'No production validation.',impact:'Service impact is being investigated.',assumptions:[],alternatives:['Independent dependency failure.'],contraryEvidenceIds:[],sourceQuality:[],indicators:['Inspect actual errors.'],changeExplanation:'New bounded evidence reviewed.'};process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{summary:'Bounded incident analysis.',hypotheses:[],changeAssessment:'unknown',candidateSha:null,evidenceIds:[],unknowns:['Live validation pending.'],nextSteps:['Review source.'],risk,codeFindings:[],teamsMessages:[],remediation:{kind:'collect-evidence',targetSha:null,rationale:'Transport fixture only.',evidenceIds:[],verificationSteps:['Verify independently.'],blockingUnknowns:['No real model used.']},issueSpec:{title:'Review load test',problem:'Fictional workload.',impact:'Test only.',proposedChange:'Review.',acceptanceCriteria:['Check evidence.'],evidenceIds:[],openQuestions:['Live validation pending.']}}})+'\\n');`;
  await writeFile(command,body,{mode:0o700});
  const config=()=>{const c=loadConfig({SRE_CONFIG:'config/sre.agent.json',SRE_SQLITE_PATH:join(directory,'db.sqlite')});const s=c.services[0];s.teams.conversations=Array.from({length:32},(_,n)=>'group-'+n);s.teams.collaborationGroups[0].conversations=s.teams.conversations.map(id=>({id,name:id}));c.env={...process.env,SRE_CLAUDE_BIN:command};return c;};
  const open=()=>createSreRuntime({config:config(),autoStart:false});
  try{
    runtime=await open();const service=runtime.config.services[0],id=await importInvestigationCase(runtime.store,service,'session-expiry');
    for(const room of service.teams.conversations){const key=await runtime.store.rememberConversation({tenant:service.teams.tenantId,serviceKey:service.key,reference:{serviceUrl:'http://127.0.0.1:1',conversation:{id:room}}});await runtime.store.bindConversation(key,id);}
    const before=await runtime.store.context(id);assert.equal(before.collaboration.rooms.length,32);assert.equal(boundedContext(before).collaboration.rooms.length,32);
    const now=await runtime.store.coordinationNow();
    for(let n=0;n<256;n++){
      const room=service.teams.conversations[n%32],event={id:'load-'+n,source:'teams-question',serviceKey:service.key,incidentId:id,kind:'question',at:now,payload:{text:'Question '+n+': correlate current failures with the source.',conversationId:room,userId:'person-'+(n%32)},conversationKey:conversationKey(service.teams.tenantId,room)};
      await runtime.store.ingest(event);if(n%17===0)assert.equal((await runtime.store.ingest(event)).duplicate,true);
    }
    // Stop refill after this wave; reopen with queued work instead of racing
    // cancellation of a newly started subprocess in the load assertion.
    const first=runtime.worker.runOnce();runtime.worker.pause?.();assert.equal(await first,true);
    await runtime.close();runtime=await open();
    for(let n=0;n<40;n++){const ran=await runtime.worker.runOnce();await runtime.worker.idle?.();if(!ran)break;}
    const rows=await runtime.store.db.query('SELECT status,payload FROM sre_jobs');assert.ok(rows.every(r=>['done','superseded'].includes(r.status)),JSON.stringify(rows.filter(r=>!['done','superseded'].includes(r.status))));
    const records=(await readFile(record,'utf8')).trim().split('\n').map(JSON.parse),requests=records.flatMap(r=>r.requests);
    assert.equal(records.length,8);assert.equal(requests.length,256);assert.equal(new Set(requests.map(r=>r.jobId)).size,256);assert.ok(records.every(r=>r.requests.length<=32&&Buffer.byteLength(JSON.stringify(r.requests))<=32768&&r.bytes<200000));
    const context=await runtime.store.context(id);assert.equal(context.incident.analysis.mode,'claude');assert.equal(context.assessmentStatus.state,'current');assert.equal(context.collaboration.rooms.length,32);assert.equal(context.incident.status,'open');
    assert.equal(Number((await runtime.store.db.query('SELECT COUNT(*) AS count FROM sre_rollbacks'))[0].count),0);
  }finally{await runtime?.close();await rm(directory,{recursive:true,force:true});}
});

test('Claude message selection stays silent when empty and rechecks the joined audience transactionally',async()=>{
  const config=loadConfig({SRE_CONFIG:'config/sre.agent.json',SRE_SQLITE_PATH:':memory:'}),runtime=await createSreRuntime({config,autoStart:false});
  try{
    const s=config.services[0],id=await importInvestigationCase(runtime.store,s,'session-expiry'),other=await importInvestigationCase(runtime.store,s,'dependency-outage'),keys=[];
    for(const [n,room]of s.teams.conversations.slice(0,2).entries()){
      const key=await runtime.store.rememberConversation({tenant:s.teams.tenantId,serviceKey:s.key,reference:{serviceUrl:'http://127.0.0.1:1',conversation:{id:room}}});await runtime.store.bindConversation(key,n?other:id);keys.push(key);
    }
    const next=async()=>{for(let n=0;n<4;n++){const job=await runtime.store.claim('worker');if(job.incident_id===id)return job;await runtime.store.finish(job,{summary:'Other',text:'Other',mode:'claude',teamsMessages:[]},null,Number((await runtime.store.context(other)).incident.revision));}throw Error('No incident job');};
    let job=await next();await runtime.store.finish(job,{summary:'No requested message',text:'Console only',mode:'claude',teamsMessages:[]},null,Number((await runtime.store.context(id)).incident.revision));
    assert.equal(Number((await runtime.store.db.query('SELECT COUNT(*) AS count FROM sre_outbox'))[0].count),0);
    await runtime.store.ingest({id:'select-message',source:'operator-api',serviceKey:s.key,incidentId:id,kind:'question',at:Date.now(),payload:{text:'What changed?'}});
    job=await next();await assert.rejects(async()=>runtime.store.finish(job,{summary:'Wrong audience',text:'Rejected',mode:'claude',teamsMessages:[{roomKey:keys[1],text:'Must not cross incidents'}]},null,Number((await runtime.store.context(id)).incident.revision)),/incident|conversation/i);
    assert.equal(Number((await runtime.store.db.query('SELECT COUNT(*) AS count FROM sre_outbox'))[0].count),0);
    await runtime.store.finish(job,{summary:'Scoped result',text:'Console detail',mode:'claude',teamsMessages:[{roomKey:keys[0],text:'New evidence for this incident.'}]},null,Number((await runtime.store.context(id)).incident.revision));
    const messages=await runtime.store.db.query('SELECT conversation_key,text FROM sre_outbox');assert.deepEqual(messages.map(row=>({...row})),[{conversation_key:keys[0],text:'New evidence for this incident.'}]);
  }finally{await runtime.close();}
});

test('service shutdown cancels its active Claude process before closing storage',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-agent-stop-')),command=join(directory,'claude-fixture'),record=join(directory,'pid');let runtime;
  await writeFile(command,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';for await(const chunk of process.stdin){}writeFileSync(${JSON.stringify(record)},String(process.pid));setInterval(()=>{},1000);`,{mode:0o700});
  try{
    const config=loadConfig({SRE_CONFIG:'config/sre.agent.json',SRE_SQLITE_PATH:':memory:'});config.env={...process.env,SRE_CLAUDE_BIN:command};runtime=await createSreRuntime({config,autoStart:false});await importInvestigationCase(runtime.store,config.services[0],'session-expiry');
    const turn=runtime.worker.runOnce();let pid;
    for(let n=0;n<200;n++){try{pid=Number(await readFile(record,'utf8'));break;}catch{await delay(5);}}
    assert.ok(pid);await runtime.close();assert.equal(await turn,false);assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');assert.equal(await runtime.worker.runOnce(),false);
  }finally{await runtime?.close();await rm(directory,{recursive:true,force:true});}
});

test('normal development starts unseeded with Claude, rejects auction seeding and shuts down after readiness',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-agent-launch-'));
  const child=spawn(process.execPath,['scripts/sre-agent.mjs'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,SRE_PORT:'0',SRE_SQLITE_PATH:join(directory,'agent.sqlite'),SRE_CLAUDE_BIN:'/nonexistent-development-fixture-cli'},stdio:['ignore','pipe','pipe']});
  let output='',errors='';const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  try{
    let ready;
    for(let n=0;n<300;n++){const line=output.split('\n').find(s=>s.startsWith('{"agent":'));if(line){ready=JSON.parse(line);break;}if(child.exitCode!==null)throw Error(errors);await delay(10);}
    assert.ok(ready);assert.equal(ready.agent,'Claude');assert.equal(ready.seeded,false);assert.equal(ready.rulesFallback,false);
    const status=await(await fetch(ready.console+'/api/status')).json();assert.equal(status.incidents.length,0);assert.equal(status.agentDevelopment,true);
    const denied=await fetch(ready.console+'/api/dev/seed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:'recent-regression'})});assert.equal(denied.status,403);
    child.kill('SIGTERM');const result=await exited;assert.equal(result.code,0,errors);
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}await rm(directory,{recursive:true,force:true});}
});
