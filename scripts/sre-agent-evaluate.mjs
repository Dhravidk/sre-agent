import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {ClaudeReasoner} from '../src/sre/claude-reasoner.mjs';
import {issueSpecMarkdown} from '../src/sre/agent-investigation.mjs';
import {investigationCase} from '../fixtures/agent-investigations.mjs';

if(!process.argv.includes('--live'))throw Error('Use --live to explicitly run the installed Claude CLI against fictional evidence. This consumes model usage.');
const arg=process.argv.indexOf('--case'),names=arg<0?['session-expiry','dependency-outage','missing-source']:[process.argv[arg+1]];
const directory=resolve(process.env.SRE_AGENT_EVALUATION_DIRECTORY||'.local/claude-development/evaluation');await mkdir(directory,{recursive:true,mode:0o700});
const report={scope:'Actual Claude CLI/model with fictional logs, tickets, documents and immutable code. No vendor acceptance or Teams messages.',cases:[],status:'running'};
for(const name of names){
  const sample=investigationCase(name),started=Date.now(),progress=[];
  console.log(JSON.stringify({case:name,status:'running'}));
  try{
    const reasoner=new ClaudeReasoner();
    const result=await reasoner.investigate(sample.context,{question:'Investigate this unfamiliar service. Correlate Dynatrace, Jira, Confluence and GitLab evidence, identify a candidate file only when supported, and draft an actionable issue specification. Distinguish a source defect from an independent dependency failure.',persistRemote:async state=>{if(state.progress)progress.push({at:Date.now(),stage:state.progress.stage,hasText:Boolean(state.progress.preview)});}});
    const {analysis}=result,findings=analysis.codeFindings||[],spec=analysis.issueSpec;
    const checks={claude:analysis.mode==='claude',specification:Boolean(spec?.acceptanceCriteria.length&&spec?.openQuestions.length),streamBeforeCompletion:progress.some(p=>p.hasText&&p.at<Date.now()),expectedFile:sample.expectedPath?findings.some(f=>f.path===sample.expectedPath&&f.lineStart<=2&&f.lineEnd>=2):findings.length===0,crossSourceReferences:sample.expectedPath?['dt-session','jira-session','confluence-session','gitlab-session'].every(id=>new Set([...(spec?.evidenceIds||[]),...findings.flatMap(f=>[f.evidenceId,...f.corroboratingEvidenceIds])]).has(id)):true};
    const passed=Object.values(checks).every(Boolean);report.cases.push({name,status:passed?'passed':'failed',durationMs:Date.now()-started,checks,progressEvents:progress.length});
    await writeFile(join(directory,name+'.json'),JSON.stringify({scope:report.scope,...result,checks,progress},null,2)+'\n',{mode:0o600});
    if(spec)await writeFile(join(directory,name+'.md'),issueSpecMarkdown(spec)+'\n',{mode:0o600});
    console.log(JSON.stringify(report.cases.at(-1)));
  }catch(error){report.cases.push({name,status:'failed',durationMs:Date.now()-started,error:error.message});console.log(JSON.stringify(report.cases.at(-1)));}
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
}
report.status=report.cases.every(c=>c.status==='passed')?'passed':'failed';await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
if(report.status!=='passed')process.exitCode=1;
