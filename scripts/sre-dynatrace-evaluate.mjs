import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {sqliteDatabase} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {ClaudeReasoner} from '../src/sre/claude-reasoner.mjs';
import {boundedContext,modelContextLimits} from '../src/sre/model-context.mjs';
import {issueSpecMarkdown,remediationText} from '../src/sre/agent-investigation.mjs';
import {retainLogBatch,retainLogTriage} from '../src/sre/log-triage.mjs';
import {noisyLogCase} from '../fixtures/dynatrace-noise.mjs';

if(!process.argv.includes('--live'))throw Error('Use --live to explicitly run the installed Claude CLI. Telemetry and deployments are fictional; model usage is real.');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const external=arg('--gitlab-source'),source=external?JSON.parse(await readFile(resolve(external),'utf8')).source:undefined;
const cases={'regression-1':{usefulPercent:1},'regression-5':{usefulPercent:5},'regression-10':{usefulPercent:10},'incompatible-1':{variant:'incompatible',usefulPercent:1},'dependency-1':{variant:'dependency',usefulPercent:1},'regression-100k':{count:100000,usefulPercent:1},'regression-unlabelled':{structuredHints:false,usefulPercent:1}};
const names=arg('--case')?[arg('--case')]:['regression-1','regression-5','regression-10','incompatible-1','dependency-1'];
if(names.some(name=>!cases[name]))throw Error('Unknown Dynatrace evaluation case');
const directory=resolve(process.env.SRE_DYNATRACE_EVALUATION_DIRECTORY||'.local/dynatrace-development/evaluation-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(directory,{recursive:true,mode:0o700});
const report={scope:'Actual restricted Claude CLI/model. Authored Dynatrace-shaped logs, releases, health/compatibility claims, Jira and Confluence. '+(source?'Regression cases use a retrieved real GitLab fictional-sandbox snapshot. Dependency control uses authored corrected source.':'Authored GitLab source.')+' No live Dynatrace queries, production diagnosis, external messages or deployment execution.',cases:[],status:'running'};
for(const name of names){
  const settings=cases[name],sample=noisyLogCase({...settings,...(settings.variant!=='dependency'&&source?{source}:{})}),started=Date.now(),progress=[],db=sqliteDatabase(join(directory,name+'.sqlite')),store=await new SreStore(db).initialize();
  console.log(JSON.stringify({case:name,status:'running',directory}));
  try{
    for(const d of [...sample.context.deployments].reverse())await store.ingest({id:'release:'+name+':'+d.sha,source:'evaluation-release',serviceKey:sample.context.incident.service_key,kind:'deployment',at:d.at,payload:{...d,synthetic:true}});
    const {incidentId}=await store.ingest({id:'problem:'+name,source:'evaluation',serviceKey:sample.context.incident.service_key,kind:'problem',issueKey:name,status:'OPEN',at:sample.context.incident.started_at,title:sample.context.incident.title,payload:{synthetic:true}});
    const rawId=await retainLogBatch(store,incidentId,sample.raw),triageStarted=Date.now(),triage=await retainLogTriage(store,incidentId,rawId,sample.raw),triageMs=Date.now()-triageStarted;
    for(const row of sample.context.evidence.slice(1))await store.addEvidence(incidentId,row.source,row.kind,row.content);
    const context=await store.context(incidentId);context.riskScope=sample.context.riskScope;
    const view=boundedContext(context),contextBytes=Buffer.byteLength(JSON.stringify(view)),job=await store.claim('real-claude-evaluation',180000);
    const result=await new ClaudeReasoner().investigate(context,{question:'Investigate the useful minority within these noisy Dynatrace logs. Compare exact releases and the GitLab source mechanism; use the money contract from Jira and Confluence. Recommend a supported planning-only rollback or a scoped change/mitigation, distinguish persisted-data repair, and draft a developer issue specification with negative/control tests. Do not confuse expected validation errors with customer failures.',persistRemote:async state=>{await store.setRemoteState(incidentId,state,job);if(state.progress)progress.push({at:Date.now(),stage:state.progress.stage,hasText:Boolean(state.progress.preview)});}});
    const {analysis}=result,expected=sample.expected,findings=analysis.codeFindings||[],r=analysis.remediation,ids=new Set([...(analysis.issueSpec?.evidenceIds||[]),...findings.flatMap(f=>[f.evidenceId,...f.corroboratingEvidenceIds]),...(r?.evidenceIds||[])]);
    await store.finish(job,analysis,result.remoteState,Number(context.incident.revision));
    const retained=(await db.query("SELECT content FROM sre_evidence WHERE incident_id=? AND kind='log_page'",[incidentId])).reduce((n,row)=>n+JSON.parse(row.content).records.length,0);
    const checks={claude:analysis.mode==='claude',rareTailDelivered:view.evidence.some(e=>e.kind==='log_triage'&&e.content.records?.some(row=>expected.variant==='dependency'?row['error.code']==='CREDIT_PROVIDER_UNAVAILABLE':row['http.route']==='/bids'&&row.content?.includes('storedCurrentBidCents=15000000'))),boundedContext:contextBytes<=modelContextLimits.totalBytes,rawRetained:retained===expected.count,sourceLocation:expected.path?findings.some(f=>f.path===expected.path&&f.sha===expected.head&&f.lineStart<=expected.line&&f.lineEnd>=expected.line):findings.length===0,recoveryProposal:expected.variant==='dependency'?r?.kind==='dependency-mitigation':expected.variant==='incompatible'?r?.kind==='forward-fix'&&r.targetSha===null:['rollback-candidate','forward-fix'].includes(r?.kind),rollbackTarget:r?.kind==='rollback-candidate'?r.targetSha===expected.base:r?.targetSha===null,crossSource:expected.path?['dynatrace','gitlab','jira','confluence'].every(source=>view.evidence.some(row=>row.source===source&&ids.has(row.id))):true,issueSpec:Boolean(analysis.issueSpec?.acceptanceCriteria.length&&analysis.issueSpec?.openQuestions.length),streamed:progress.some(p=>p.hasText),noExecution:Number((await db.query('SELECT COUNT(*) AS count FROM sre_rollbacks'))[0].count)===0&&(await store.context(incidentId)).incident.status==='open'};
    report.cases.push({name,status:Object.values(checks).every(Boolean)?'passed':'failed',durationMs:Date.now()-started,modelMs:Date.now()-triageStarted-triageMs,triageMs,contextBytes,rawRecords:expected.count,usefulPercent:expected.usefulPercent,coverage:triage.coverage,selectedEvidence:triage.ids.length,remediation:r?.kind||null,checks});
    await writeFile(join(directory,name+'.json'),JSON.stringify({scope:report.scope,...result,checks,progress},null,2)+'\n',{mode:0o600});
    await writeFile(join(directory,name+'.md'),remediationText(r)+'\n\n'+issueSpecMarkdown(analysis.issueSpec)+'\n',{mode:0o600});
  }catch(error){report.cases.push({name,status:'failed',durationMs:Date.now()-started,error:error.message});}
  finally{await db.close();}
  console.log(JSON.stringify(report.cases.at(-1)));await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
}
report.status=report.cases.every(c=>c.status==='passed')?'passed':'failed';await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
if(report.status!=='passed')process.exitCode=1;
