// Explicit local development alternative, never selected by production config.
// Uses the official CLI's saved ChatGPT login; no OAuth token/API forwarding.
import {spawn,spawnSync} from 'node:child_process';
import {assertRequestBatch} from '../../src/sre/question-batch-budget.mjs';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TextDecoder} from 'node:util';
import {claudeSchema,investigationInstructions} from '../../src/sre/claude-reasoner.mjs';
import {boundedContext,investigationSchema,validateInvestigation} from '../../src/sre/reasoner.mjs';
import {ModelQuotaError} from '../../src/sre/model-quota.mjs';
import {investigationInvocationInput} from '../../src/sre/model-citations.mjs';
import {hash} from '../../src/sre/security.mjs';

export const evaluationCliVersion='0.163.0-alpha.10.2';
const disabled=['shell_tool','apps','plugins','remote_plugin','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser','computer_use','image_generation','view_image','multi_agent','multi_agent_v2','memories','hooks','skill_search','sleep_tool','goals','tool_suggest','code_mode','code_mode_host'];
const boundary='Code Mode is unavailable because code-mode host is disabled.';
export function codexEvaluationEnvironment(env){
  const names=new Set(['PATH','HOME','USER','USERPROFILE','LOGNAME','TMPDIR','TMP','TEMP','SystemRoot','LANG','LC_ALL','TZ','CODEX_HOME','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR']);
  return Object.fromEntries(Object.entries(env).filter(([key,value])=>names.has(key)&&typeof value==='string'));
}
export function codexEvaluationSchema(snapshot){
  const schema=claudeSchema(snapshot);
  const strict=node=>{
    if(!node||typeof node!=='object')return;
    if(node.type==='object'){node.additionalProperties=false;node.required=Object.keys(node.properties||{});}
    for(const child of Object.values(node))if(Array.isArray(child))child.forEach(strict);else strict(child);
  };
  strict(schema);return schema;
}

function execute(command,args,{cwd,env,input,signal,timeoutMs,onProgress}){
  return new Promise((resolve,reject)=>{
    const started=performance.now();let firstTextMs=null;
    let child,timer,escalation,closed=false,failure,bytes=0,diagnosticBytes=0,pending='',final='',completed=false,boundarySeen=false,usage;
    const decoder=new TextDecoder('utf-8',{fatal:true});
    const kill=signal=>{try{if(child?.pid&&process.platform!=='win32')process.kill(-child.pid,signal);else child?.kill(signal);}catch{}};
    const stop=error=>{if(closed||failure)return;failure=error;kill('SIGTERM');escalation=setTimeout(()=>kill('SIGKILL'),1000);};
    const abort=()=>stop(Error('Codex evaluation cancelled'));
    const line=text=>{
      const value=JSON.parse(text);
      if(value.type==='turn.failed'||value.type==='error'){
        const e=value.error||value,code=e.code||e.codexErrorInfo;
        if(['usage_limit_reached','usageLimitExceeded','usage_limit_exceeded'].includes(code)||/^you(?:'|’)ve hit your usage limit\b/i.test(e.message||''))throw new ModelQuotaError('codex-cli');
        throw Error('Codex CLI did not complete successfully');
      }
      if(value.type==='item.completed'){
        const item=value.item;
        if(item?.type==='error'){
          if(item.message?.startsWith(boundary))boundarySeen=true;
          else if(!item.message?.startsWith('Under-development features enabled:'))throw Error('Codex CLI reported an unexpected runtime error');
        }else if(item?.type==='agent_message'){
          if(typeof item.text!=='string')throw Error('Invalid Codex message');
          if(firstTextMs===null)firstTextMs=Math.round(performance.now()-started);
          final=item.text;
          // Only deliberate user-facing prose is progress. Do not persist
          // reasoning events or the native event stream.
          if(!item.text.trimStart().startsWith('{'))onProgress?.(item.text.slice(-4000));
        }else if(item?.type!=='reasoning')throw Error('Codex evaluation attempted an unavailable tool');
      }
      if(value.type==='item.started'&&value.item&&!['agent_message','reasoning'].includes(value.item.type))throw Error('Codex evaluation attempted an unavailable tool');
      if(value.type==='turn.completed'){completed=true;usage=value.usage;}
    };
    try{child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform!=='win32'});}catch{return reject(Error('Codex CLI could not start'));}
    child.once('error',()=>{failure ||=Error('Codex CLI could not start');});
    child.stdin.on('error',()=>stop(Error('Codex CLI input could not be delivered')));
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>1024*1024)return stop(Error('Codex CLI output exceeded its byte budget'));
      if(failure)return;
      try{pending+=decoder.decode(chunk,{stream:true});let at;while((at=pending.indexOf('\n'))>=0){const next=pending.slice(0,at);pending=pending.slice(at+1);if(next.trim())line(next);}}
      catch(error){stop(error instanceof ModelQuotaError?error:Error(error.message?.startsWith('Codex ')?error.message:'Codex CLI returned invalid JSON'));}
    });
    child.stderr.on('data',chunk=>{diagnosticBytes+=chunk.length;if(diagnosticBytes>65536)stop(Error('Codex CLI diagnostics exceeded their byte budget'));});
    child.once('close',(code,endedBy)=>{
      closed=true;if(failure)kill('SIGKILL');clearTimeout(timer);clearTimeout(escalation);signal?.removeEventListener('abort',abort);
      if(failure)return reject(failure);
      try{
        pending+=decoder.decode();if(pending.trim())line(pending);
        if(code!==0||endedBy||!completed)throw Error('Codex CLI did not complete successfully');
        if(!boundarySeen)throw Error('Codex CLI disabled-tool boundary was not confirmed');
        resolve({data:JSON.parse(final),usage,transport:{elapsedMs:Math.round(performance.now()-started),firstTextMs,stdoutBytes:bytes,stderrBytes:diagnosticBytes}});
      }catch(error){reject(error instanceof ModelQuotaError?error:Error(error.message?.startsWith('Codex ')?error.message:'Codex CLI returned invalid JSON'));}
    });
    timer=setTimeout(()=>stop(Error('Codex evaluation exceeded its time budget')),timeoutMs);
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    if(!failure)child.stdin.end(input);else child.stdin.destroy();
  });
}

export class CodexEvaluationReasoner {
  constructor({command=process.env.SRE_CODEX_BIN||'codex',timeoutMs=180000,env=process.env}={}){
    if(typeof command!=='string'||!command.trim()||command.length>4096||/[\0\r\n]/.test(command)||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>300000)throw Error('Invalid Codex evaluation CLI options');
    this.mode='codex';this.options={command,timeoutMs,model:'gpt-6.1-sol',effort:'medium',citationProtocol:'snapshot-alias-v1',promptHash:hash(investigationInstructions)};this.env=env;
  }
  async investigate(context,{question,requests,requestBatchVersion,signal,persistRemote}={}){
    question??=undefined;
    if(question!==undefined&&(typeof question!=='string'||question.length>4000))throw Error('Operator request must be text of at most 4000 characters');
    assertRequestBatch(requests,requestBatchVersion);
    if(signal?.aborted)throw Error('Codex evaluation cancelled');
    const {command,model,effort,timeoutMs}=this.options,env=codexEvaluationEnvironment(this.env);
    const version=spawnSync(command,['--version'],{env,encoding:'utf8',timeout:10000,maxBuffer:4096});
    // The disabled Code Mode host behavior was checked on this exact CLI.
    // Reject other builds instead of assuming their tool registration matches.
    if(version.status!==0||version.stdout.trim()!=='codex-cli '+evaluationCliVersion)throw Error('Codex evaluation requires verified CLI '+evaluationCliVersion);
    const login=spawnSync(command,['login','status'],{env,encoding:'utf8',timeout:10000,maxBuffer:4096});
    if(login.status!==0||!/^Logged in using ChatGPT\b/m.test(login.stdout+login.stderr))throw Error('Codex evaluation requires an existing official ChatGPT login');
    const invocationId=randomUUID(),snapshot=boundedContext(context),{input,wire,restore}=investigationInvocationInput(snapshot,{question,requests}),schema=codexEvaluationSchema(wire);
    try{await persistRemote?.({provider:'codex-cli',invocationId,phase:'started',transcriptPersistence:false,requestedModel:model,cliVersion:evaluationCliVersion});}
    catch{throw Error('Codex invocation checkpoint could not be stored');}
    if(signal?.aborted)throw Error('Codex evaluation cancelled');
    const cwd=await mkdtemp(join(tmpdir(),'sre-codex-evaluation-'));
    try{
      const path=join(cwd,'schema.json');await writeFile(path,JSON.stringify(schema),{mode:0o600});
      const args=['exec','--strict-config','--ignore-user-config','--ignore-rules','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--json','--output-schema',path,'--model',model,'--enable','code_mode_only'];
      for(const name of disabled)args.push('--disable',name);
      for(const value of ['forced_login_method="chatgpt"','agents.enabled=false','web_search="disabled"','mcp_servers={}','tools.update_plan.enabled=false','tools.experimental_request_user_input.enabled=false','features.skip_host_skill_discovery=true','hide_agent_reasoning=true','show_raw_agent_reasoning=false','model_reasoning_effort='+JSON.stringify(effort),'project_doc_max_bytes=0','developer_instructions='+JSON.stringify(investigationInstructions+'\nThis is a local Codex evaluation. Tool execution, including exec/wait wrappers, is intentionally unavailable. Do not call tools. Use only the supplied evidence. Do not refer to the model as Claude.')])args.push('-c',value);
      args.push('-');
      let checkpoint=Promise.resolve(),checkpointFailed=false;
      const onProgress=text=>{checkpoint=checkpoint.then(()=>persistRemote?.({provider:'codex-cli',invocationId,phase:'started',transcriptPersistence:false,requestedModel:model,cliVersion:evaluationCliVersion,progress:{stage:'message',preview:text}})).catch(()=>{checkpointFailed=true;});};
      const result=await execute(command,args,{cwd,env,input,signal,timeoutMs,onProgress});await checkpoint;
      if(checkpointFailed)throw Error('Codex progress checkpoint could not be stored');
      if(signal?.aborted)throw Error('Codex evaluation cancelled');
      const data=restore(result.data);
      if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!Object.hasOwn(investigationSchema.properties,key))||schema.required.some(key=>!Object.hasOwn(data,key)))throw Error('Codex investigation returned an unsupported output shape');
      if(typeof data.summary!=='string'||!data.summary.trim()||[...data.summary].length>600)throw Error('Codex investigation summary must contain 1 to 600 characters');
      const analysis={...validateInvestigation(data,context,{deliveredContext:snapshot}),mode:'codex'};
      return {analysis,remoteState:{provider:'codex-cli',invocationId,phase:'completed',transcriptPersistence:false,requestedModel:model,cliVersion:evaluationCliVersion,usage:result.usage,transport:{...result.transport,inputHash:hash(input),inputBytes:Buffer.byteLength(input),snapshotBytes:Buffer.byteLength(JSON.stringify(wire)),schemaBytes:Buffer.byteLength(JSON.stringify(schema))}}};
    }finally{await rm(cwd,{recursive:true,force:true});}
  }
}
