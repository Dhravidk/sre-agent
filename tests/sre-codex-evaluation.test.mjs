import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {CodexEvaluationReasoner,codexEvaluationSchema,evaluationCliVersion} from '../scripts/lib/codex-evaluation-reasoner.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {fixtureRisk,riskScope} from '../src/sre/analytic-risk.mjs';
import {ModelQuotaError} from '../src/sre/model-quota.mjs';
import {hash} from '../src/sre/security.mjs';
import {citationTransport} from '../src/sre/model-citations.mjs';

function context(){
  const now=Date.now(),c={incident:{id:'inc_codex',service_key:'fixture',status:'open',started_at:now,updated_at:now,revision:1},session:{remote_state:{private:'PRIVATE_SESSION'}},evidence:[{id:'log',source:'dynatrace',kind:'log',observed_at:now,content:{text:'PRIVATE_EVIDENCE'}}],deployments:[],assessmentHistory:[],jobs:[{error:'PRIVATE_AUDIT'}]};
  c.riskScope=riskScope(c,{environment:'local'});return c;
}
function assessment(){
  const risk=fixtureRisk(context());risk.sourceQuality=[];risk.contraryEvidenceIds=[];
  return {summary:'Synthetic Codex transport result',hypotheses:['Need independent evidence.'],changeAssessment:'unknown',candidateSha:null,evidenceIds:['log'],unknowns:['Synthetic provider contracts.'],nextSteps:['Collect independent telemetry.'],risk,codeFindings:[],sourceFindings:[],evidenceRequests:[],teamsMessages:[],remediation:{kind:'collect-evidence',targetSha:null,rationale:'Cause unverified.',verificationSteps:['Check control.'],evidenceIds:['log'],blockingUnknowns:['Source missing.']},issueSpec:{title:'Investigate',problem:'Unknown cause.',impact:'Review required.',proposedChange:'Collect evidence.',acceptanceCriteria:['Use an independent control.'],evidenceIds:['log'],openQuestions:['Which source?']}};
}
const boundary={type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable features.code_mode_host.'}};
const events=data=>[boundary,{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(data).replaceAll('"log"','"MODEL_PRIMARY_EVIDENCE"')}},{type:'turn.completed',usage:{input_tokens:100,output_tokens:50}}];
const output=items=>'process.stdout.write('+JSON.stringify(items.map(v=>JSON.stringify(v)).join('\n')+'\n')+'.replaceAll("MODEL_PRIMARY_EVIDENCE",JSON.parse(input).incident.evidence.find(e=>e.content.text==="PRIVATE_EVIDENCE").id));';
async function fixture(body,{version=evaluationCliVersion,chatgpt=true,timeoutMs=3000}={}){
  const directory=await mkdtemp(join(tmpdir(),'sre-codex-test-')),command=join(directory,'codex-fixture'),record=join(directory,'record.json');
  await writeFile(command,'#!'+process.execPath+'\n'+`import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli ${version}');process.exit(0);}
if(args[0]==='login'){console.log(${JSON.stringify(chatgpt?'Logged in using ChatGPT':'Logged in using an API key - PRIVATE_KEY')});process.exit(0);}
let input='';for await(const chunk of process.stdin)input+=chunk;
writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,cwd:process.cwd(),args,input:JSON.parse(input),env:process.env,schema:JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'))}));
${body}\n`,{mode:0o700});
  const env={...process.env,SRE_API_TOKEN:'PRIVATE_SERVICE',OPENAI_API_KEY:'PRIVATE_API_KEY',CODEX_API_KEY:'PRIVATE_CODEX_KEY',CLAUDE_CODE_OAUTH_TOKEN:'PRIVATE_CLAUDE',DATABASE_URL:'PRIVATE_DB'};
  return {directory,record,reasoner:new CodexEvaluationReasoner({command,timeoutMs,env}),read:async()=>JSON.parse(await readFile(record,'utf8')),close:()=>rm(directory,{recursive:true,force:true})};
}

test('Codex delivers a complete 32-request batch and rejects excessive bytes before native startup',async()=>{
  const f=await fixture(output(events(assessment()))),requests=Array.from({length:32},(_,n)=>({jobId:'job-'+n,question:'Review supported source and recovery '+n,conversationKey:null}));
  try{await f.reasoner.investigate(context(),{requests});assert.deepEqual((await f.read()).input.requestBatch,requests);const before=(await f.read()).pid;await assert.rejects(()=>f.reasoner.investigate(context(),{requests:requests.map(r=>({...r,question:'界'.repeat(4000)}))}),/bounded/);assert.equal((await f.read()).pid,before);}
  finally{await f.close();}
});

test('Codex evaluation uses a version-pinned official CLI, ChatGPT login, disabled execution host and bounded stdin',async()=>{
  const f=await fixture(output(events(assessment()))),states=[];
  try{
    const c=context();c.evidence.push({id:'large',kind:'log',source:'logs',observed_at:1,content:{text:'x'.repeat(200000)}});
    const result=await f.reasoner.investigate(c,{question:null,persistRemote:async value=>states.push(value)}),record=await f.read(),args=record.args.join(' ');
    assert.equal(result.analysis.mode,'codex');assert.equal(result.remoteState.provider,'codex-cli');assert.equal(result.remoteState.requestedModel,'gpt-6.1-sol');
    assert.equal(result.remoteState.usage.input_tokens,100);assert.equal(states[0].phase,'started');
    for(const flag of ['--ignore-user-config','--ignore-rules','--ephemeral','--strict-config','--enable code_mode_only','--disable code_mode_host','--disable shell_tool','--disable apps','--disable plugins','--disable multi_agent','web_search="disabled"','mcp_servers={}'])assert.ok(args.includes(flag),flag);
    assert.ok(!args.includes('PRIVATE_EVIDENCE'));assert.ok(record.input.incident.evidence.some(e=>e.content.text==='PRIVATE_EVIDENCE'));
    const alias=record.input.incident.evidence.find(e=>e.content.text==='PRIVATE_EVIDENCE').id;
    assert.match(alias,/^ref_[a-f0-9]{12}_\d+$/);assert.deepEqual(record.schema.properties.evidenceIds.items.enum,record.input.incident.evidence.map(e=>e.id));
    assert.deepEqual(result.analysis.evidenceIds,['log']);assert.deepEqual(result.analysis.remediation.evidenceIds,['log']);assert.deepEqual(result.analysis.issueSpec.evidenceIds,['log']);
    assert.equal(result.remoteState.transport.inputHash,hash(JSON.stringify(record.input)));assert.equal(result.remoteState.transport.inputBytes,Buffer.byteLength(JSON.stringify(record.input)));
    assert.ok(result.remoteState.transport.firstTextMs>=0&&result.remoteState.transport.firstTextMs<=result.remoteState.transport.elapsedMs);
    assert.ok(Buffer.byteLength(JSON.stringify(record.input.incident))<=160000);assert.ok(!JSON.stringify(record.input).includes('PRIVATE_AUDIT'));assert.ok(!JSON.stringify(record.input).includes('PRIVATE_SESSION'));
    assert.ok(!JSON.stringify(record.env).includes('PRIVATE_'));assert.equal(record.args[record.args.indexOf('--sandbox')+1],'read-only');
    const strict=node=>{if(!node||typeof node!=='object')return;if(node.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual(node.required,Object.keys(node.properties));}for(const v of Object.values(node))if(Array.isArray(v))v.forEach(strict);else strict(v);};strict(record.schema);
    await assert.rejects(()=>access(record.cwd));assert.throws(()=>process.kill(record.pid,0),e=>e.code==='ESRCH');
  }finally{await f.close();}
});

for(const [name,items,pattern] of [
  ['missing execution boundary',events(assessment()).slice(1),/boundary was not confirmed/],
  ['foreign evidence',events({...assessment(),evidenceIds:['other-incident']}),/outside this incident/],
  ['raw canonical evidence',[boundary,{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(assessment())}},{type:'turn.completed'}],/outside this incident/],
  ['stale snapshot evidence',events({...assessment(),evidenceIds:[citationTransport(boundedContext({...context(),incident:{...context().incident,revision:0}})).wire.evidence[0].id]}),/outside this incident/],
  ['unknown action',events({...assessment(),executeRollback:true}),/unsupported output shape/],
  ['tool execution',[boundary,{type:'item.started',item:{type:'command_execution',command:'PRIVATE_COMMAND'}}],/unavailable tool/],
  ['native failure',[{type:'turn.failed',error:{code:'unknown',message:'PRIVATE_PROVIDER_ERROR'}}],/did not complete successfully/],
])test('Codex evaluation rejects '+name+' with controlled diagnostics',async()=>{
  const f=await fixture(output(items));
  try{await assert.rejects(()=>f.reasoner.investigate(context()),e=>pattern.test(e.message)&&!e.message.includes('PRIVATE_'));}
  finally{await f.close();}
});

test('Codex native quota metadata becomes a shared hold condition, never a fabricated reset time',async()=>{
  const f=await fixture(output([{type:'turn.failed',error:{code:'usage_limit_reached',message:'PRIVATE_DETAIL'}}]));
  try{await assert.rejects(()=>f.reasoner.investigate(context()),e=>e instanceof ModelQuotaError&&e.provider==='codex-cli'&&e.retryAt===null&&!e.message.includes('PRIVATE_'));}
  finally{await f.close();}
});

test('unverified CLI versions and API-key logins start no model evaluation',async()=>{
  for(const options of [{version:'future-unknown'},{chatgpt:false}]){
    const f=await fixture(output(events(assessment())),options);
    try{await assert.rejects(()=>f.reasoner.investigate(context()),/requires/);await assert.rejects(()=>access(f.record));}
    finally{await f.close();}
  }
});

test('Codex cancellation and timeout kill the owned child without publishing a result',async()=>{
  for(const cancel of [true,false]){
    // Allow the fixture to start even when other test processes saturate the
    // host. The assertion still requires termination of its recorded PID.
    const f=await fixture("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",{timeoutMs:cancel?5000:1500}),controller=new AbortController();
    try{
      const outcome=f.reasoner.investigate(context(),{signal:controller.signal}).then(value=>({value}),error=>({error}));
      let record;for(let n=0;n<200&&!record;n++){try{record=await f.read();}catch{await delay(10);}}
      assert.ok(record);if(cancel)controller.abort();assert.match((await outcome).error.message,cancel?/cancelled/:/time budget/);
      assert.throws(()=>process.kill(record.pid,0),e=>e.code==='ESRCH');await assert.rejects(()=>access(record.cwd));
    }finally{await f.close();}
  }
});

test('Codex schema cites only evidence delivered in its bounded snapshot',()=>{
  const schema=codexEvaluationSchema(boundedContext(context()));assert.deepEqual(schema.properties.evidenceIds.items.enum,['log']);
});
