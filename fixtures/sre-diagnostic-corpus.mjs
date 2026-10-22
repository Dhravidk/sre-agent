import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hash} from '../src/sre/security.mjs';

const exec=promisify(execFile);
const environment={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
export const diagnosticSourcePath='src/runtime/service.mjs';
const retry=`export async function handle(client, requestId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await client(requestId); }
    catch (error) {
      const retryable = error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 3) throw error;
    }
  }
}
`;
const webhook=`export function createHandler(append) {
  const entries = new Map();
  return async eventId => {
    if (entries.has(eventId)) return entries.get(eventId);
    const pending = Promise.resolve().then(() => append(eventId));
    entries.set(eventId, pending);
    return pending;
  };
}
`;
const cache=`export function createHandler(load) {
  const cache = new Map();
  return async ({ sku, region }) => {
    const key = JSON.stringify([sku, region]);
    if (!cache.has(key)) cache.set(key, await load({ sku, region }));
    return cache.get(key);
  };
}
`;
const retryChanged=retry.replace('error.status === 429 || error.status >= 500','error.status >= 400');
const webhookChanged=webhook.replace('const pending = Promise.resolve().then(() => append(eventId));\n    entries.set(eventId, pending);\n    return pending;','const result = await append(eventId);\n    entries.set(eventId, result);\n    return result;');
const cacheChanged=cache.replace('JSON.stringify([sku, region])','JSON.stringify([sku])');

// Gold labels and executable checks are authoring material, never model input.
// These are authored candidate cases, not a held-out model benchmark.
const definitions=[
  {id:'case-01',name:'Notifier delivery pressure',kind:'retry',good:retry,observed:retryChanged,code:'RETRY_PRESSURE',mechanism:'Terminal 422 responses are retried because the retry predicate accepts every 4xx response.',faultText:'const retryable = error.status >= 400;',passes:[true,false,true]},
  {id:'case-02',name:'Repeated event append',kind:'webhook',good:webhook,observed:webhookChanged,code:'APPEND_REPEATED',mechanism:'Concurrent deliveries both pass the cache check before the awaited append is recorded.',faultText:'const result = await append(eventId);',passes:[true,false,true]},
  {id:'case-03',name:'Regional stock disagreement',kind:'cache',good:cache,observed:cacheChanged,code:'CACHE_REGION_DIFFERENCE',mechanism:'The cache key omits region and returns a previous region inventory result.',faultText:'const key = JSON.stringify([sku]);',passes:[true,false,true]},
  {id:'case-04',name:'Upstream request failures',kind:'dependency',good:retry,observed:retry,code:'DEPENDENCY_UNAVAILABLE',mechanism:'The controlled upstream returns 503 at all revisions, including before the instrumentation-only change.',passes:[false,false,false]},
  {id:'case-05',name:'Routine delivery review',kind:'healthy',good:retry,observed:retry,code:'REQUEST_OK',mechanism:'The controlled requests succeed at all revisions; no code defect is planted.',passes:[true,true,true]},
  {id:'case-06',name:'Notifier review with unavailable source',kind:'retry',good:retry,observed:retryChanged,code:'RETRY_PRESSURE',denyObservedSource:true,mechanism:'Same terminal-retry defect as case01, but the full observed source read is denied. The comparison diff remains visible; source-read coverage is incomplete.',faultText:'const retryable = error.status >= 400;',passes:[true,false,true]}
];
export const diagnosticCaseIds=Object.freeze(definitions.map(value=>value.id));
const definitionFor=id=>{const value=definitions.find(value=>value.id===id);if(!value)throw Error('Unknown authored diagnostic case');return value;};
const stages=['base','observed','followUp'];
const sourceFor=(definition,stage)=>(stage==='observed'?definition.observed:definition.good)+"\nexport const instrumentationVersion = '"+({base:'2026.1',observed:'2026.2',followUp:'2026.3'}[stage])+"';\n";

async function git(repository,args,{signal,date,raw=false}={}){
  const value=(await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',repository,...args],{env:{...environment,...(date?{GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}:{})},encoding:'utf8',timeout:15000,maxBuffer:1024*1024,signal})).stdout;return raw?value:value.trim();
}

export async function createDiagnosticCorpus(parent=tmpdir()){
  await mkdir(parent,{recursive:true,mode:0o700});
  const directory=await mkdtemp(join(parent,'diagnostic-')),cases=[];
  for(const [index,definition]of definitions.entries()){
    const repository=join(directory,definition.id,'repository');await mkdir(join(repository,'src/runtime'),{recursive:true,mode:0o700});
    await git(repository,['init','-b','codex/diagnostic-'+definition.id]);await git(repository,['config','user.name','Fictional Diagnostic Fixture']);await git(repository,['config','user.email','diagnostic@example.invalid']);
    const revisions={};for(const [stageIndex,stage]of stages.entries()){
      const content=sourceFor(definition,stage);await writeFile(join(repository,diagnosticSourcePath),content,{mode:0o600});
      await git(repository,['add',diagnosticSourcePath]);await git(repository,['commit','-qm',['Add delivery adapter','Normalize request handling','Refine request handling'][stageIndex]],{date:'2026-01-'+String(index+1).padStart(2,'0')+'T12:0'+stageIndex+':00Z'});
      revisions[stage]=await git(repository,['rev-parse','HEAD']);
    }
    cases.push({id:definition.id,name:definition.name,project:'fixture/diagnostic-'+String(index+1),repository,path:diagnosticSourcePath,revisions,code:definition.code,denyObservedSource:definition.denyObservedSource===true});
  }
  return{version:1,directory,cases,scope:'Authored first-party fixture Git; no remote repository or model invocation'};
}

export async function diagnosticGit(corpus,caseId,args,options){
  const entry=corpus.cases.find(value=>value.id===caseId);if(!entry)throw Error('Unknown corpus entry');return git(entry.repository,args,options);
}

const probeSource=definition=>`import test from 'node:test';
import assert from 'node:assert/strict';
import * as service from '../src/runtime/service.mjs';
test('controlled request invariant', async () => {
  const rows = [];
  ${definition.kind==='webhook'?`const writes = [];
  const handle = service.createHandler(async id => { await Promise.resolve(); writes.push(id); return {id}; });
  for (let n = 0; n < 3; n++) {
    const id = 'event-' + n; await Promise.all([handle(id), handle(id)]);
    const count = writes.filter(value => value === id).length;
    rows.push({ok:count === 1, requestId:id, actualAppends:count});
  }`:definition.kind==='cache'?`const handle = service.createHandler(async ({sku,region}) => ({sku,region,stock:region === 'north' ? 12 : 4}));
  for (let n = 0; n < 3; n++) {
    const sku = 'sku-' + n; await handle({sku,region:'north'}); const actual = await handle({sku,region:'south'});
    rows.push({ok:actual.region === 'south' && actual.stock === 4,requestId:sku,requestedRegion:'south',actualRegion:actual.region,actualStock:actual.stock});
  }`:`for (let n = 0; n < 3; n++) {
    let calls = 0, status; const requestId = 'delivery-' + n;
    const client = async () => { calls++; ${definition.kind==='healthy'?`return {status:200};`:`throw Object.assign(new Error('Controlled upstream response'), {status:${definition.kind==='dependency'?503:422}});`} };
    try { status = (await service.handle(client,requestId)).status; } catch (error) { status = error.status; }
    rows.push({ok:${definition.kind==='healthy'?'status === 200':definition.kind==='dependency'?'status === 200':'status === 422 && calls === 1'},requestId,status,actualAttempts:calls});
  }`}
  console.log('DIAGNOSTIC_OBSERVATIONS ' + JSON.stringify(rows));
  assert.ok(rows.every(row => row.ok), 'The controlled request invariant failed');
});
`;

// Execute only bytes authored above in a fresh private workspace. GitLab source
// retrieval is a separate read-as-data path; it cannot select an executable.
export async function runDiagnosticGold(corpus,caseId,{signal}={}){
  const definition=definitionFor(caseId),entry=corpus.cases.find(value=>value.id===caseId);if(!entry)throw Error('Unknown corpus entry');
  const results=[];
  for(const [index,stage]of stages.entries()){
    signal?.throwIfAborted();if(!/^[a-f0-9]{40}$/.test(entry.revisions[stage]))throw Error('Gold execution requires an immutable authored revision');const source=await diagnosticGit(corpus,caseId,['show',entry.revisions[stage]+':'+diagnosticSourcePath],{raw:true});
    const expected=sourceFor(definition,stage);if(hash(source)!==hash(expected))throw Error('Gold execution source differs from the authored fixture');
    const workspace=await mkdtemp(join(corpus.directory,'trusted-check-'));
    try{
      await mkdir(join(workspace,'src/runtime'),{recursive:true});await mkdir(join(workspace,'tests'));await writeFile(join(workspace,diagnosticSourcePath),expected,{mode:0o600,signal});await writeFile(join(workspace,'tests/invariant.test.mjs'),probeSource(definition),{mode:0o600,signal});
      let output,exitCode;try{const result=await exec(process.execPath,['--test','tests/invariant.test.mjs'],{cwd:workspace,env:environment,encoding:'utf8',timeout:15000,maxBuffer:256*1024,signal});output=result.stdout+result.stderr;exitCode=0;}catch(error){if(typeof error.code!=='number')throw error;output=(error.stdout||'')+(error.stderr||'');exitCode=error.code;}
      const match=output.match(/DIAGNOSTIC_OBSERVATIONS (\[[^\n]+\])/);if(!match)throw Error('Trusted diagnostic check returned no observations');const observations=JSON.parse(match[1]);if(observations.length!==3)throw Error('Incomplete authored diagnostic observations');
      results.push({stage,sha:entry.revisions[stage],sourceHash:hash(expected),exitCode,expectedPass:definition.passes[index],matchesExpected:(exitCode===0)===definition.passes[index],observations,output});
    }finally{await rm(workspace,{recursive:true,force:true});}
  }
  return{caseId,kind:definition.kind,mechanism:definition.mechanism,expectedSourceLocation:definition.faultText?{path:diagnosticSourcePath,line:definition.observed.split('\n').findIndex(line=>line.includes(definition.faultText))+1}:null,publicEvidenceLimit:definition.denyObservedSource?'Full observed source is denied; base source and comparison diff remain visible. Author-only gold is withheld.':'Authored trace and before/observed source; deployment/provider facts are fictional.',results};
}

export function diagnosticRecords(entry,gold,at){
  if(gold?.caseId!==entry.id)throw Error('Diagnostic observations belong to another case');const result=gold.results.find(value=>value.stage==='observed');if(result.sha!==entry.revisions.observed)throw Error('Diagnostic observation revision differs from its case');return result.observations.map(({ok,...facts},index)=>({timestamp:new Date(at+index).toISOString(),level:ok?'INFO':'ERROR',code:ok?'REQUEST_OBSERVED':entry.code,environment:'testing',region:'fixture-region',sha:entry.revisions.observed,requestId:entry.id+':'+facts.requestId,operation:'/api/requests',message:JSON.stringify(facts),synthetic:true}));
}
