import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeReasoner,claudeEnvironment,claudeSchema } from '../src/sre/claude-reasoner.mjs';
import { claudeOptions } from '../src/sre/claude-config.mjs';
import { riskScope,fixtureRisk } from '../src/sre/analytic-risk.mjs';
import { loadConfig,validateConfig } from '../src/sre/config.mjs';
import { assessReadiness } from '../src/sre/readiness.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { seedDemo } from '../src/sre/demo.mjs';

function context() {
  const now=Date.now(),c={incident:{id:'inc_claude',service_key:'auction-local',issue_key:'P-CLAUDE',title:'Synthetic incident',status:'open',started_at:now-1000,updated_at:now,revision:1,analysis:null},session:{agent_id:'agent_claude',remote_state:{sessionId:'older-eve-session',private:'PRIVATE_SESSION_MARKER'}},evidence:[{id:'human',source:'teams',kind:'responder_update',observed_at:now,content:{text:'PRIVATE_RESPONDER_MARKER: restarted the bidder; timeout persists.'}}],deployments:[],assessmentHistory:[],responderContext:{evidenceIds:['human'],totalAvailable:1},jobs:[{error:'PRIVATE_AUDIT_MARKER'}]};
  c.riskScope=riskScope(c,{environment:'local'});return c;
}
function analysis(c=context()) {const risk=fixtureRisk(c);risk.sourceQuality=[];risk.contraryEvidenceIds=[];return {summary:'Synthetic Claude transport result',hypotheses:['A dependency fault remains possible.'],changeAssessment:'unknown',candidateSha:null,evidenceIds:[],unknowns:['Live provider and model acceptance pending.'],nextSteps:['Review current independent telemetry.'],risk,codeFindings:[],teamsMessages:[],remediation:{kind:'collect-evidence',targetSha:null,rationale:'No supported causal strategy yet.',evidenceIds:[],verificationSteps:['Inspect scoped independent evidence.'],blockingUnknowns:['Current cause is unknown.']},issueSpec:{title:'Review incident',problem:'Cause unknown.',impact:'Needs review.',proposedChange:'Collect evidence.',acceptanceCriteria:['Reproduce the symptom.'],evidenceIds:[],openQuestions:['What failed?']}};}
const envelope=data=>({type:'result',subtype:'success',is_error:false,structured_output:data,session_id:'d24b9e23-744a-4682-a20f-805de41a7153'});
async function fixture(body,options={}) {
  const directory=await mkdtemp(join(tmpdir(),'sre-cli-test-')),command=join(directory,'fake-claude'),record=join(directory,'record.json');
  await writeFile(command,'#!'+process.execPath+'\n'+`import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input);const record=${JSON.stringify(record)};
writeFileSync(record,JSON.stringify({pid:process.pid,cwd:process.cwd(),args,request,env:process.env}));
${body}\n`,{mode:0o700});
  const env={...process.env,SRE_CLAUDE_BIN:command,SRE_API_TOKEN:'PRIVATE_SERVICE_SECRET',GITHUB_ROLLBACK_TOKEN:'PRIVATE_WRITER_SECRET',OPENAI_API_KEY:'PRIVATE_OPENAI_SECRET',DATABASE_URL:'PRIVATE_DATABASE_SECRET',...options.env};
  return {directory,command,record,env,reasoner:new ClaudeReasoner({config:{claude:{command,...options.config}},env}),read:async()=>JSON.parse(await readFile(record,'utf8')),close:()=>rm(directory,{recursive:true,force:true})};
}
const success='process.stdout.write('+JSON.stringify(JSON.stringify(envelope(analysis())))+');';

test('Claude requires a recovery proposal in both its generation schema and its host output check',async()=>{
  const c=context();assert.ok(claudeSchema({evidence:c.evidence}).required.includes('remediation'));
  const data=analysis(c);delete data.remediation;
  const f=await fixture('process.stdout.write('+JSON.stringify(JSON.stringify(envelope(data)))+');');
  try{await assert.rejects(()=>f.reasoner.investigate(c),/unsupported output shape/);}
  finally{await f.close();}
});

test('host rejects high confidence after byte-window omissions even when a CLI bypasses its generation schema',async()=>{
  const body=`const data=${JSON.stringify(analysis())};data.risk.likelihood='likely';data.risk.confidence='high';data.risk.sourceQuality=request.incident.evidence.slice(0,1).map(e=>({evidenceId:e.id,limitations:'The retained row is complete.'}));process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:data}));`;
  const f=await fixture(body),c=context();c.evidence=Array.from({length:40},(_,n)=>({id:'complete-'+n,source:'source',kind:'observation',observed_at:Date.now(),content:{complete:true,text:'x'.repeat(6000)}}));
  try{await assert.rejects(()=>f.reasoner.investigate(c),/High confidence/);const {request}=await f.read();assert.ok(request.incident.coverage.included<40);assert.ok(request.incident.evidence.every(e=>e.content.complete===true));}
  finally{await f.close();}
});

test('Claude records bounded inference timing and schema retry counts without provider diagnostic contents',async()=>{
  const events=[
    {type:'assistant',message:{content:[{type:'text',text:'Reading scoped logs.'},{type:'tool_use',name:'StructuredOutput',id:'attempt-1',input:{private:'PRIVATE_TOOL_INPUT'}}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'attempt-1',is_error:true,content:'PRIVATE_SCHEMA_ERROR'}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'attempt-1',is_error:true,content:'PRIVATE_REPLAY'}]}},
    {type:'assistant',parent_tool_use_id:'foreign',message:{content:[{type:'tool_use',name:'StructuredOutput',id:'foreign'}]}},
    {type:'assistant',message:{content:[{type:'tool_use',name:'StructuredOutput',id:'attempt-2'}]}},
    {...envelope(analysis()),num_turns:3,duration_api_ms:123,usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:40,private:'PRIVATE_USAGE'},private:'PRIVATE_RESULT'}
  ];
  const f=await fixture('process.stdout.write('+JSON.stringify(events.map(JSON.stringify).join('\n')+'\n')+');');
  try{
    const {remoteState}=await f.reasoner.investigate(context()),t=remoteState.transport;
    assert.equal(t.structuredOutputAttempts,2);assert.equal(t.structuredOutputFailures,1);assert.ok(t.firstTextMs>=0&&t.firstTextMs<=t.elapsedMs);
    assert.deepEqual(t.inference,{turns:3,apiDurationMs:123,inputTokens:10,outputTokens:20,cacheReadInputTokens:30,cacheCreationInputTokens:40});
    assert.ok(!JSON.stringify(remoteState).includes('PRIVATE_'));
  }finally{await f.close();}
});
async function until(fn) {for(let i=0;i<200;i++){try{const value=await fn();if(value)return value;}catch{}await delay(10);}throw Error('Fixture startup was not observed');}
function absent(pid) {assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');}

test('Claude print mode receives bounded incident context on stdin, restricted tools, and no application/OpenAI credentials',async()=>{
  const f=await fixture(success,{config:{model:'sonnet',maxBudgetUsd:0.25}}),saved=[];
  try {
    const c=context();c.evidence.push({id:'large',kind:'log',source:'logs',observed_at:1,content:{text:'🚦'.repeat(100000)}});
    const result=await f.reasoner.investigate(c,{question:'Explain the reported restart.',persistRemote:async state=>saved.push(state)}),record=await f.read();
    assert.equal(result.analysis.mode,'claude');assert.equal(saved[0].phase,'started');assert.equal(saved[0].invocationId,result.remoteState.invocationId);assert.equal(result.remoteState.phase,'completed');
    assert.ok(result.remoteState.transport.stdoutBytes>0);assert.equal(result.remoteState.transport.eventTypes.result.count,1);
    assert.equal(record.args[0],'-p');assert.ok(record.args.includes('--restricted'));assert.equal(record.args[record.args.indexOf('--tools')+1],'');assert.equal(record.args[record.args.indexOf('--model')+1],'sonnet');
    assert.equal(record.args[record.args.indexOf('--effort')+1],'medium');
    assert.ok(record.args.includes('stream-json'));assert.ok(!record.args.includes('--include-partial-messages'));
    assert.ok(record.args.includes('--no-session-persistence'));assert.ok(record.args.includes('--strict-mcp-config'));assert.ok(!record.args.includes('--resume'));assert.ok(!record.args.join(' ').includes('PRIVATE_RESPONDER_MARKER'));
    const schema=JSON.parse(record.args[record.args.indexOf('--json-schema')+1]);assert.equal(schema.properties.summary.minLength,1);assert.equal(schema.properties.summary.maxLength,600);
    assert.ok(JSON.stringify(record.request).includes('PRIVATE_RESPONDER_MARKER'));assert.ok(Buffer.byteLength(JSON.stringify(record.request.incident))<=160000);assert.ok(!JSON.stringify(record.request).includes('PRIVATE_AUDIT_MARKER'));assert.ok(!JSON.stringify(record.request).includes('PRIVATE_SESSION_MARKER'));
    assert.ok(!JSON.stringify(record.env).includes('PRIVATE_'));assert.equal(record.request.request,'Explain the reported restart.');await assert.rejects(()=>access(record.cwd));absent(record.pid);
  } finally {await f.close();}
});

test('an already cancelled request and a failed invocation checkpoint each start no CLI process',async()=>{
  const f=await fixture(success);
  try {
    await assert.rejects(()=>f.reasoner.investigate(context(),{signal:AbortSignal.abort('PRIVATE_ABORT')}),/cancelled/);await assert.rejects(()=>access(f.record));
    await assert.rejects(()=>f.reasoner.investigate(context(),{persistRemote:async()=>{throw Error('PRIVATE_STORAGE');}}),/checkpoint could not be stored/);await assert.rejects(()=>access(f.record));
    await assert.rejects(()=>f.reasoner.investigate(context(),{question:'x'.repeat(4001)}),/4000/);await assert.rejects(()=>access(f.record));
  } finally {await f.close();}
});

for(const [name,body,pattern] of [
  ['nonzero-exit',"process.stderr.write('PRIVATE_PROVIDER_DETAIL');process.stdout.write('PRIVATE_RESPONSE_DETAIL');process.exitCode=17;",/did not complete successfully/],
  ['invalid-json',"process.stdout.write('PRIVATE_INVALID_JSON');",/invalid JSON/],
  ['invalid-utf8',"process.stdout.write(Buffer.from([0xc0,0xaf]));",/invalid JSON/],
  ['error-envelope','process.stdout.write('+JSON.stringify(JSON.stringify({...envelope(analysis()),is_error:true,error:'PRIVATE_MODEL_DETAIL'}))+');',/structured result/],
  ['unstructured-envelope','process.stdout.write('+JSON.stringify(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'PRIVATE_MODEL_DETAIL'}))+');',/structured result/],
  ['foreign-evidence','process.stdout.write('+JSON.stringify(JSON.stringify(envelope({...analysis(),evidenceIds:['foreign-incident-evidence']})))+');',/outside this incident/],
  ['unknown-action','process.stdout.write('+JSON.stringify(JSON.stringify(envelope({...analysis(),executeRollback:true})))+');',/unsupported output shape/],
  ['overlong-summary','process.stdout.write('+JSON.stringify(JSON.stringify(envelope({...analysis(),summary:'x'.repeat(601)})))+');',/summary must contain 1 to 600 characters/],
  ['blank-summary','process.stdout.write('+JSON.stringify(JSON.stringify(envelope({...analysis(),summary:'   '})))+');',/summary must contain 1 to 600 characters/],
  ['stdout-budget',"process.stdout.write('x'.repeat(2*1024*1024));await new Promise(()=>{});",/output exceeded/],
  ['stderr-budget',"process.stderr.write('x'.repeat(70000));await new Promise(()=>{});",/diagnostics exceeded/],
])test('Claude '+name+' fails once with controlled diagnostics',async()=>{
  const f=await fixture(body);
  try {await assert.rejects(()=>f.reasoner.investigate(context()),error=>pattern.test(error.message)&&!error.message.includes('PRIVATE_'));const r=await f.read();absent(r.pid);await assert.rejects(()=>access(r.cwd));}
  finally {await f.close();}
});

test('cancellation terminates an active Claude child and rejects its unverified result',async()=>{
  const f=await fixture("setInterval(()=>{},1000);"),controller=new AbortController();
  try {const pending=f.reasoner.investigate(context(),{signal:controller.signal});const outcome=pending.then(value=>({value}),error=>({error}));const r=await until(()=>f.read());controller.abort('PRIVATE_ABORT');assert.match((await outcome).error.message,/cancelled/);absent(r.pid);await assert.rejects(()=>access(r.cwd));}
  finally {await f.close();}
});

test('a timed out CLI that ignores SIGTERM is killed before the worker returns',async()=>{
  const f=await fixture("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",{config:{timeoutMs:3000}});
  try {await assert.rejects(()=>f.reasoner.investigate(context()),/time budget/);const r=await f.read();absent(r.pid);await assert.rejects(()=>access(r.cwd));}
  finally {await f.close();}
});

test('a missing executable has a controlled error and never falls back to a different model provider',async()=>{
  const reasoner=new ClaudeReasoner({config:{claude:{command:'/nonexistent-sre-fixture/claude'}},env:{}});
  await assert.rejects(()=>reasoner.investigate(context()),/Claude CLI could not start/);
});

test('Claude account quota errors expose a fixed actionable message without reflecting provider output',async()=>{
  const f=await fixture(`process.stdout.write(JSON.stringify({type:'result',is_error:true,api_error_status:429,api_error:'usage_limit_reached',result:'PRIVATE_UNTRUSTED_CLI_TEXT · resets 4:10pm (America/Detroit)'}));process.exitCode=1;`);
  let runtime;
  try {
    await assert.rejects(()=>f.reasoner.investigate(context()),error=>error.retryable===false&&error.message.includes('Claude usage limit reached (resets 4:10pm America/Detroit)')&&!error.message.includes('PRIVATE_'));
    const config=loadConfig({SRE_SQLITE_PATH:':memory:'});config.mode='trial';config.agentMode='claude';config.env=f.env;
    runtime=await createSreRuntime({config,autoStart:false});
    const seeded=await seedDemo(runtime.store,config.services[0]);assert.equal(await runtime.worker.runOnce(),false);
    const c=await runtime.store.context(seeded.incidentId);assert.equal(c.incident.analysis,null);
    assert.equal(c.jobs.find(j=>j.status==='pending').attempts,0);assert.match(c.jobs.find(j=>j.status==='pending').error,/resume the model queue/);
    const hold=await runtime.store.modelQuota();assert.equal(hold.provider,'claude-cli');assert.equal(hold.resetLabel,'4:10pm America/Detroit');assert.equal(hold.retryAt,null);
    assert.equal(await runtime.worker.runOnce(),false);assert.equal((await runtime.store.conversation(seeded.incidentId)).length,0);
  } finally {await runtime?.close();await f.close();}
});

test('Claude hour-only reset labels remain operator guidance without an invented date',async()=>{
  const f=await fixture(`process.stdout.write(JSON.stringify({type:'result',is_error:true,api_error_status:429,api_error:'usage_limit_reached',result:'PRIVATE_TEXT · resets 7pm (America/Detroit)'}));process.exitCode=1;`);
  try {await assert.rejects(()=>f.reasoner.investigate(context()),error=>error.resetLabel==='7pm America/Detroit'&&error.retryAt===null&&!error.message.includes('PRIVATE_'));}
  finally {await f.close();}
});

test('successive turns use the current Claude credentials instead of a stale constructor snapshot',async()=>{
  const f=await fixture(success,{env:{ANTHROPIC_AUTH_TOKEN:'synthetic-first'}});
  try {await f.reasoner.investigate(context());assert.equal((await f.read()).env.ANTHROPIC_AUTH_TOKEN,'synthetic-first');f.env.ANTHROPIC_AUTH_TOKEN='synthetic-rotated';await f.reasoner.investigate(context());assert.equal((await f.read()).env.ANTHROPIC_AUTH_TOKEN,'synthetic-rotated');}
  finally {await f.close();}
});

test('cancellation kills an owned CLI process group even when its child ignores SIGTERM',async()=>{
  if(process.platform==='win32')return;
  const body=`const {spawn}=await import('node:child_process');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send({ready:true});setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});child.on('message',()=>writeFileSync(record,JSON.stringify({pid:process.pid,grandPid:child.pid,cwd:process.cwd()})));process.on('SIGTERM',()=>process.exit(0));`;
  const f=await fixture(body),controller=new AbortController();
  try {const outcome=f.reasoner.investigate(context(),{signal:controller.signal}).then(value=>({value}),error=>({error}));const r=await until(async()=>{const r=await f.read();return r.grandPid?r:null;});controller.abort();assert.match((await outcome).error.message,/cancelled/);await until(()=>{try{process.kill(r.grandPid,0);return false;}catch(error){return error.code==='ESRCH';}});absent(r.pid);absent(r.grandPid);}
  finally {await f.close();}
});

test('connected configuration defaults to Claude without Eve/OpenAI credentials and validates CLI controls',()=>{
  const config=loadConfig({});config.mode='connected';delete config.agentMode;config.services[0].rollback.enabled=false;
  const env={SRE_API_TOKEN:'synthetic',SRE_CAPABILITY_SECRET:'s'.repeat(32)};
  assert.equal(validateConfig(structuredClone(config),env).agentMode,'claude');const readiness=assessReadiness(config,env);assert.equal(readiness.core.runtimeConfigurationValid,true);assert.equal(readiness.modelRuntime.command,'claude -p');assert.equal(readiness.modelRuntime.authentication,'unverified');
  assert.throws(()=>validateConfig({...structuredClone(config),claude:{bare:'true'}},env),/bare/);assert.throws(()=>claudeOptions({claude:{timeoutMs:0}}),/timeout/);
  assert.throws(()=>claudeOptions({claude:{command:'claude\n-p'}}),/executable/);assert.throws(()=>claudeOptions({claude:{maxBudgetUsd:0}}),/maxBudget/);
  assert.equal(claudeOptions({}, {SRE_CLAUDE_MODEL:''}).model,undefined);
  assert.equal(claudeOptions({claude:{effort:'high'}},{SRE_CLAUDE_EFFORT:'low'}).effort,'low');assert.throws(()=>claudeOptions({claude:{effort:'unbounded'}}),/effort/);
  assert.equal(claudeEnvironment({ANTHROPIC_API_KEY:'synthetic',AWS_PROFILE:'ally-fixture',OPENAI_API_KEY:'blocked',SRE_API_TOKEN:'blocked'}).OPENAI_API_KEY,undefined);
  const local=loadConfig({});assert.throws(()=>validateConfig(local,{SRE_AGENT_MODE:'claude'}),/Local mode is offline/);
});

test('the real service uses Claude CLI and resumes durable incident conversation after SQLite reopen',async()=>{
  const body=`const data=${JSON.stringify(analysis())};data.summary=request.request;data.evidenceIds=request.incident.evidence.slice(0,1).map(e=>e.id);process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:data}));`;
  const f=await fixture(body);let runtime;const database=join(f.directory,'agent.sqlite');
  const config=()=>{const c=loadConfig({SRE_SQLITE_PATH:database});c.mode='connected';c.agentMode='claude';c.env={...process.env,SRE_CLAUDE_BIN:f.command};c.services[0].rollback.enabled=false;c.teamsMode='off';return c;};
  const open=()=>createSreRuntime({config:config(),connectors:new Map([['auction-local',{}]]),autoStart:false});
  try {
    runtime=await open();const seeded=await seedDemo(runtime.store,runtime.config.services[0]);const worked=await runtime.worker.runOnce();assert.equal(worked,true,JSON.stringify((await runtime.store.context(seeded.incidentId)).jobs.map(job=>({status:job.status,error:job.error}))));
    let c=await runtime.store.context(seeded.incidentId);const agentId=c.session.agent_id;assert.equal(c.incident.analysis.mode,'claude');assert.equal(c.session.remote_state.provider,'claude-cli');
    const firstHistory=await runtime.store.conversation(seeded.incidentId);assert.equal(firstHistory[0].mode,'claude');
    await runtime.close();runtime=await open();assert.deepEqual(await runtime.store.conversation(seeded.incidentId),firstHistory);
    await runtime.store.ingest({id:'claude-followup',source:'operator-api',serviceKey:'auction-local',kind:'question',incidentId:seeded.incidentId,at:Date.now(),payload:{text:'Compare the new evidence with our prior assessment.'}});
    assert.equal(await runtime.worker.runOnce(),true);c=await runtime.store.context(seeded.incidentId);assert.equal(c.session.agent_id,agentId);assert.equal(c.incident.analysis.mode,'claude');assert.equal(c.incident.analysis.summary,'Compare the new evidence with our prior assessment.');
    const call=await f.read();assert.equal(call.request.incident.incident.id,seeded.incidentId);assert.ok(call.request.incident.assessmentHistory.length>0);assert.ok(!call.args.includes('--resume'));
  } finally {await runtime?.close();await f.close();}
});
