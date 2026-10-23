import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createSreRuntime} from '../src/sre/server.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {ClaudeReasoner} from '../src/sre/claude-reasoner.mjs';
import {CodexEvaluationReasoner} from './lib/codex-evaluation-reasoner.mjs';
import {diagnosisFixture,seedDiagnosisFixture} from '../fixtures/dynatrace-gitlab-diagnosis.mjs';
import {largeRepositoryFixture,multifileRepositoryFixture} from '../fixtures/large-repo-diagnosis.mjs';
import {diagnosisEvaluationChecks} from './lib/diagnosis-evaluation-checks.mjs';
import {diagnosisEvaluationFreeze} from './lib/diagnosis-evaluation-freeze.mjs';
import {hash} from '../src/sre/security.mjs';

const arg=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
if(!process.argv.includes('--live'))throw Error('Use --live for actual model usage. Vendor evidence is authored; no live tenant acceptance or deployment execution.');
const provider=arg('--provider')||'codex';if(!['claude','codex'].includes(provider))throw Error('Use --provider codex or claude');
const directory=resolve(arg('--directory')||'.local/diagnosis-development/'+new Date().toISOString().replace(/[:.]/g,'-')),windowOnly=process.argv.includes('--window-only');
await mkdir(directory,{recursive:true,mode:0o700});
try{await readFile(join(directory,'settings.json'));throw Error('Use a fresh evaluation directory; earlier inputs and failures are never overwritten');}catch(error){if(error.code!=='ENOENT')throw error;}
const native=provider==='codex'?new CodexEvaluationReasoner({timeoutMs:180000}):new ClaudeReasoner(),save=async(path,value)=>writeFile(join(directory,path),JSON.stringify(value,null,2)+'\n',{mode:0o600}),calls=[];
const suite=arg('--suite')||'original';if(!['original','large','multifile'].includes(suite))throw Error('Use --suite original, large or multifile');
if(suite!=='original'&&windowOnly)throw Error('Window-only ablation is limited to the original suite');
const repositoryFactory=suite==='multifile'?multifileRepositoryFixture:largeRepositoryFixture;
const fixture=suite!=='original'?await repositoryFactory(directory,{records:arg('--records')===undefined?(suite==='multifile'?60000:30000):Number(arg('--records')),fileCount:arg('--files')===undefined?(suite==='multifile'?4000:1200):Number(arg('--files')),partition:arg('--partition')||'calibration',caseId:arg('--case')}):await diagnosisFixture(directory,{records:arg('--records')===undefined?10000:Number(arg('--records')),caseId:arg('--case'),windowOnly});
await mkdir(join(directory,'attempts'),{recursive:true,mode:0o700});
const freeze=await diagnosisEvaluationFreeze();
if(arg('--frozen-inputs')){const expected=JSON.parse(await readFile(resolve(arg('--frozen-inputs')),'utf8'));if(expected.hash!==freeze.hash)throw Error('Runtime/prompt/corpus files changed after the required freeze');}
await save('frozen-inputs.json',freeze);
const settings={version:2,provider,model:native.options.model,effort:native.options.effort,promptHash:native.options.promptHash,frozenInputHash:freeze.hash,suite,partition:fixture.partition||'development',filesPerRepository:fixture.fileCount||1,windowOnly,records:fixture.records,cases:fixture.states.map(state=>state.entry.id),repositories:fixture.states.map(state=>({caseId:state.entry.id,project:state.entry.project,revisions:state.entry.revisions,files:state.entry.fileCount||1,changedFiles:state.entry.changedFiles||1}))};await save('settings.json',settings);
await save('author-only-gold.json',{scope:'First-party authored code checks and oracle, never model input; calibration and validation are distinct authored mechanisms, not an independent benchmark',gold:fixture.gold});
let runtime;const deliveredSnapshots=new Map();
const diagnosisQuestion='Investigate the request behavior from Dynatrace and exact GitLab source. Initial logs do not include detailed per-request outcomes. Use bounded follow-up reads to compare old/new operation behavior before final attribution. Distinguish a deployment regression from a dependency problem or healthy control, propose a supported read-only recovery strategy, and draft a developer spec with negative/control tests. Missing source or compatibility must remain explicit; no messages or actions are requested.';
const reasoner={mode:native.mode,options:native.options,investigate:async(context,options)=>{
 options={...options,question:diagnosisQuestion};
 const ordinal=calls.length+1,started=Date.now(),snapshot=boundedContext(context),name=String(ordinal).padStart(3,'0'),attempt={ordinal,incidentId:context.incident.id,started,status:'running',snapshotHash:hash(snapshot),snapshotBytes:Buffer.byteLength(JSON.stringify(snapshot))};calls.push(attempt);deliveredSnapshots.set(context.incident.id,snapshot);
 await save('attempts/'+name+'-input.json',{question:options?.question,snapshot});
 try{const result=await native.investigate(context,options);Object.assign(attempt,{status:'passed',elapsedMs:Date.now()-started,transport:result.remoteState?.transport,usage:result.remoteState?.usage});await save('attempts/'+name+'-result.json',result);return result;}
 catch(error){Object.assign(attempt,{status:'failed',elapsedMs:Date.now()-started,error:error.message});throw error;}
 finally{await save('attempts/'+name+'-receipt.json',attempt);}
}};
const report={scope:'Actual restricted '+provider+' reasoning through the persistent worker, authored 1%-signal logs, actual authored Git history/source and trusted code checks behind fictional provider transports. No Teams intake/delivery, live vendor acceptance, retrieved-code execution or deployment action.',settings,cases:[],calls,status:'running'};
try{
 runtime=await createSreRuntime({config:fixture.config,connectors:fixture.connectors,reasoner,autoStart:false});
 await seedDiagnosisFixture(runtime,fixture);
 // All incidents exist together, but this workload measures diagnosis rather
 // than chat throughput. One attempt per incident avoids hiding failed calls
 // behind automatic model retries during evaluation.
 for(let index=0;index<fixture.states.length;index++){console.log(JSON.stringify({turn:index+1,status:'running',directory}));await runtime.worker.runOnce();}
 for(const state of fixture.states){
  const caseCalls=calls.filter(call=>call.incidentId===state.incidentId);
  const context=await runtime.store.context(state.incidentId),analysis=context.incident.analysis;
  if(!analysis){const [job]=await runtime.store.db.query('SELECT error FROM sre_jobs WHERE incident_id=? ORDER BY created_at DESC LIMIT 1',[state.incidentId]);report.cases.push({caseId:state.entry.id,status:'failed',calls:caseCalls.length,error:job?.error||caseCalls.findLast(call=>call.error)?.error||'No assessment published'});}
  else{
   const {checks,findings,logReads}=diagnosisEvaluationChecks({analysis,context,state,provider});
   if(expectedContext(state))checks.crossFileContext=state.expected.requiredContext.every(required=>deliveredSnapshots.get(state.incidentId)?.sourceCode?.files?.some(file=>file.path===required.path&&file.sha===required.sha&&file.project===state.entry.project));
   const plan=await runtime.casework.createPlan(state.incidentId);await writeFile(join(directory,state.entry.id+'.md'),plan.markdown,{mode:0o600});
   report.cases.push({caseId:state.entry.id,status:Object.values(checks).every(Boolean)?'passed':'failed',calls:caseCalls.length,elapsedMs:caseCalls.reduce((n,call)=>n+call.elapsedMs,0),checks,changeAssessment:analysis.changeAssessment,remediation:analysis.remediation?.kind,sourceFindings:findings.map(f=>({path:f.path,sha:f.sha,startLine:f.startLine,endLine:f.endLine})),readSelections:logReads.map(row=>({filters:row.content.followUp.filters||[],complete:row.content.complete,records:row.content.records.length})),planId:plan.id});
  }
  console.log(JSON.stringify(report.cases.at(-1)));await save('report.json',report);
 }
 const before={assessments:(await runtime.store.db.query('SELECT id,analysis FROM sre_incidents ORDER BY id')),plans:await runtime.store.db.query('SELECT id,markdown FROM sre_fix_plans ORDER BY id'),calls:calls.length};
 report.noExecution=Number((await runtime.store.db.query('SELECT COUNT(*) AS n FROM sre_rollbacks'))[0].n)===0&&Number((await runtime.store.db.query('SELECT COUNT(*) AS n FROM sre_fix_requests'))[0].n)===0;report.noMessages=Number((await runtime.store.db.query("SELECT COUNT(*) AS n FROM sre_events WHERE source='teams'"))[0].n)===0;
 await runtime.close();runtime=await createSreRuntime({config:fixture.config,connectors:fixture.connectors,reasoner,autoStart:false});
 report.reopenPreserved=JSON.stringify(before.assessments)===JSON.stringify(await runtime.store.db.query('SELECT id,analysis FROM sre_incidents ORDER BY id'))&&JSON.stringify(before.plans)===JSON.stringify(await runtime.store.db.query('SELECT id,markdown FROM sre_fix_plans ORDER BY id'))&&before.calls===calls.length;
 report.providerCalls=fixture.calls;report.status=report.cases.length===fixture.states.length&&report.cases.every(row=>row.status==='passed')&&report.noExecution&&report.noMessages&&report.reopenPreserved?'passed':'failed';
}catch(error){report.status='failed';report.error=error.message;}
finally{await runtime?.close();report.calls=calls;await save('report.json',report);}
console.log(JSON.stringify({status:report.status,report:join(directory,'report.json'),calls:calls.length}));if(report.status!=='passed')process.exitCode=1;
function expectedContext(state){return Array.isArray(state.expected.requiredContext);}
