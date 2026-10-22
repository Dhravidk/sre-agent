import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {sqliteDatabase} from '../../src/sre/database.mjs';
import {SreStore} from '../../src/sre/store.mjs';
import {IncidentWorker} from '../../src/sre/worker.mjs';
import {ClaudeReasoner} from '../../src/sre/claude-reasoner.mjs';
import {boundedContext,modelContextLimits} from '../../src/sre/model-context.mjs';
import {issueSpecMarkdown,remediationText} from '../../src/sre/agent-investigation.mjs';
import {hash} from '../../src/sre/security.mjs';
import {messyIncidentSuite,fixtureIncidentConnectors} from '../../fixtures/messy-dynatrace-incidents.mjs';

export async function seedMessyIncidents(store,suite,selected=suite.cases){
  const ids={};
  for(const profile of suite.profiles.values())for(const d of [...profile.deployments].reverse())await store.ingest({id:hash(d),source:'gitlab',serviceKey:profile.key,kind:'deployment',at:d.at,payload:d});
  for(const c of selected){
    const result=await store.ingest({id:c.id,source:'evaluation',serviceKey:c.serviceKey,kind:'problem',issueKey:c.id,status:'OPEN',at:c.startedAt,title:c.title,payload:{synthetic:true,operation:c.operation,scope:'Authored concurrent-incident evaluation, not live Dynatrace.'}});ids[c.id]=result.incidentId;
    for(const row of c.referenceEvidence)await store.addEvidence(result.incidentId,row.source,row.kind,row.content);
  }
  return ids;
}

export function scoreMessyAssessment(c,context,snapshot,{mode='claude'}={}){
  const a=context.incident.analysis,r=a?.remediation,findings=a?.codeFindings||[],expected=c.expected,ids=new Set(snapshot?.evidence?.map(e=>e.id)||[]);
  const citations=[...(a?.evidenceIds||[]),...(a?.issueSpec?.evidenceIds||[]),...(r?.evidenceIds||[]),...findings.flatMap(f=>[f.evidenceId,...f.corroboratingEvidenceIds]),...(a?.risk?.contraryEvidenceIds||[]),...(a?.risk?.sourceQuality||[]).map(q=>q.evidenceId)];
  return {model:a?.mode===mode,current:context.assessmentStatus.state==='current',sourceLocation:expected.path?findings.some(f=>f.path===expected.path&&f.sha===expected.head&&f.lineStart<=expected.line&&f.lineEnd>=expected.line)&&findings.every(f=>f.path===expected.path):findings.length===0,remediation:r?.kind===expected.remediation,candidate:a?.candidateSha===expected.candidate,target:r?.targetSha===(expected.remediation==='rollback-candidate'?expected.base:null),citations:citations.every(id=>ids.has(id)),issueSpec:Boolean(a?.issueSpec?.acceptanceCriteria?.length&&a.issueSpec.openQuestions?.length),stillOpen:context.incident.status==='open',boundedSnapshot:!!snapshot&&Buffer.byteLength(JSON.stringify(snapshot))<=modelContextLimits.totalBytes};
}

export async function runMultiIncidentEvaluation({directory,seed=73421,recordsPerService=30000,caseIds,reasoner=new ClaudeReasoner(),maxTurns=10,injectQuestions=true,restart=true,onEvent=()=>{}}){
  await mkdir(directory,{recursive:true,mode:0o700});await mkdir(join(directory,'attempts'),{recursive:true,mode:0o700});
  const metadataPath=join(directory,'fixture.json');let parameters;
  try{parameters=JSON.parse(await readFile(metadataPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;parameters={seed,recordsPerService,now:Date.now(),caseIds:caseIds||null};await writeFile(metadataPath,JSON.stringify(parameters,null,2)+'\n',{mode:0o600});}
  const suite=messyIncidentSuite(parameters),selected=suite.cases.filter(c=>!parameters.caseIds||parameters.caseIds.includes(c.id));if(!selected.length)throw Error('No selected messy incident cases');
  const path=join(directory,'state.sqlite'),open=async()=>new SreStore(sqliteDatabase(path),{services:suite.services,questionBatchLimit:8,freshnessRetries:false}).initialize();let store=await open(),worker;
  const ids=await seedMessyIncidents(store,suite,selected),byId=new Map(selected.map(c=>[ids[c.id],c]));
  let previous;try{previous=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let active=0,maxActive=previous?.checks?.singleClaudeCall?1:0,burstInjected=!!(await store.checkpoint('evaluation:question-burst')),peerDenied=previous?.checks?.peerLeaseBlocked===true,restarted=!!(await store.checkpoint('evaluation:restarted')),successes=0;
  const attempts=previous?.attempts||[],reads=previous?.reads||[],snapshots=new Map(),events=previous?.events||[],model=reasoner instanceof ClaudeReasoner?'actual-claude':'test-double',scope=(model==='actual-claude'?'Actual restricted Claude CLI/model':'Synthetic test-double reasoning')+' through IncidentWorker and durable SQLite jobs. Authored GitLab source contracts, Dynatrace-shaped logs, Jira, Confluence, deployments and health/compatibility claims. No live vendor query, external message or deployment execution.';
  for(const attempt of attempts.filter(a=>a.status==='passed')){const input=JSON.parse(await readFile(join(directory,'attempts',String(attempt.number).padStart(2,'0')+'-'+attempt.case+'-input.json'),'utf8'));snapshots.set(attempt.incidentId,input.incident);}
  const event=async value=>{events.push(value);await appendFile(join(directory,'events.jsonl'),JSON.stringify(value)+'\n',{mode:0o600});onEvent(value);};
  const saveReport=async()=>{
    const cases=[];
    for(const c of selected){const context=await store.context(ids[c.id]),latest=attempts.findLast(a=>a.incidentId===ids[c.id]&&a.status==='passed'),snapshot=snapshots.get(ids[c.id])||(latest?.snapshot||null);const checks=scoreMessyAssessment(c,context,snapshot),status=Object.values(checks).every(Boolean)?'passed':context.incident.analysis?'failed':'pending';cases.push({case:c.id,incidentId:ids[c.id],service:c.serviceKey,operation:c.operation,status,checks,remediation:context.incident.analysis?.remediation?.kind||null,findings:context.incident.analysis?.codeFindings||[]});}
    const jobs=await store.db.query('SELECT id,incident_id,status,attempts,error,payload FROM sre_jobs'),questions=await store.db.query("SELECT external_id,incident_id FROM sre_events WHERE kind='question'"),rollbacks=Number((await store.db.query('SELECT COUNT(*) AS count FROM sre_rollbacks'))[0].count),outbox=Number((await store.db.query('SELECT COUNT(*) AS count FROM sre_outbox'))[0].count);
    const first=attempts.slice(0,selected.length),checks={allIncidentsInitiallyOpen:byId.size===selected.length,singleClaudeCall:maxActive===1,peerLeaseBlocked:!injectQuestions||selected.length<2||peerDenied,questionIntake:!injectQuestions||selected.length<2||questions.length===8,questionBatchDrained:!injectQuestions||selected.length<2||attempts.some(a=>a.requests===8&&a.status==='passed'),fairFirstPass:new Set(first.map(a=>a.incidentId)).size===Math.min(first.length,selected.length),restart:!restart||selected.length<2||restarted,noWrites:rollbacks===0&&outbox===0,allJobsDrained:jobs.every(j=>['done','superseded'].includes(j.status))};
    const report={scope,model,seed:parameters.seed,status:cases.every(c=>c.status==='passed')&&Object.values(checks).every(Boolean)?'passed':'incomplete',cases,checks,attempts,reads,jobs:jobs.map(({payload,...j})=>({...j,requestCount:JSON.parse(payload).requests?.length||0})),questions:questions.length,rollbacks,outbox,events};await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});return report;
  };
  const recording={mode:'claude',options:reasoner.options,investigate:async(context,options)=>{
    const snapshot=boundedContext(context),n=attempts.length+1,started=Date.now(),c=byId.get(context.incident.id),stem=String(n).padStart(2,'0')+'-'+c.id;active++;maxActive=Math.max(maxActive,active);snapshots.set(context.incident.id,snapshot);
    const attempt={number:n,case:c.id,incidentId:context.incident.id,requests:options.requests?.length||0,snapshotBytes:Buffer.byteLength(JSON.stringify(snapshot)),startedAt:started,status:'running'};attempts.push(attempt);
    await writeFile(join(directory,'attempts',stem+'-input.json'),JSON.stringify({scope,request:options.question,requestBatch:options.requests,incident:snapshot},null,2)+'\n',{mode:0o600});await event({type:'model-start',case:c.id,incidentId:context.incident.id,requests:attempt.requests,activeIncidents:byId.size,at:started});
    try{
      const result=await reasoner.investigate(context,{...options,persistRemote:async state=>{
        await options.persistRemote?.(state);
        if(injectQuestions&&selected.length>1&&!burstInjected&&state.progress?.preview){
          burstInjected=true;const target=selected.find(c=>ids[c.id]!==context.incident.id),at=await store.coordinationNow();
          for(let q=0;q<8;q++){const input={id:'burst-question-'+q,source:'operator-api',serviceKey:target.serviceKey,incidentId:ids[target.id],kind:'question',at,payload:{text:'Review request '+(q+1)+': explain the candidate source, competing explanations and whether rollback, a fix or further evidence is appropriate. Keep the reported operation separate from other open alerts.'}};await store.ingest(input);if(!(await store.ingest(input)).duplicate)throw Error('Duplicate question was not deduplicated');}
          const peer=await open();try{peerDenied=(await peer.claim('evaluation-competing-worker'))===null;}finally{await peer.db.close();}
          if(!peerDenied)throw Error('A second worker acquired the active investigator lease');
          await store.checkpoint('evaluation:question-burst',{incidentId:ids[target.id],at});await event({type:'question-burst',target:target.id,count:8,duplicatesRejected:8,peerLeaseBlocked:peerDenied,at});
        }
      }});
      attempt.status='passed';attempt.durationMs=Date.now()-started;
      await writeFile(join(directory,'attempts',stem+'-result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
    }catch(error){attempt.status='failed';attempt.durationMs=Date.now()-started;attempt.error=error.message;throw error;}
    finally{active--;await event({type:'model-end',case:c.id,status:attempt.status,durationMs:attempt.durationMs,error:attempt.error,at:Date.now()});}
  }};
  const createWorker=()=>new IncidentWorker({store,services:suite.services,connectors:fixtureIncidentConnectors(suite,{onRead:read=>reads.push({...read,at:Date.now()})}),reasoner:recording});worker=createWorker();
  try{
    await event({type:'intake-complete',incidents:selected.length,serviceScopes:suite.services.length,rawPopulation:[...suite.profiles.values()].reduce((n,p)=>n+p.records.length,0),at:Date.now()});
    for(let turn=0;turn<maxTurns;turn++){
      const before=attempts.length,done=await worker.runOnce();if(done)successes++;
      if(attempts.length===before){const [next]=await store.db.query("SELECT MIN(next_at) AS at FROM sre_jobs WHERE status='pending'");const wait=Number(next?.at)-Date.now();if(wait>0&&wait<=5000){await delay(wait+10);continue;}break;}
      const current=await store.context(attempts.at(-1).incidentId),analysis=current.incident.analysis;
      if(done&&analysis)await writeFile(join(directory,byId.get(current.incident.id).id+'.md'),remediationText(analysis.remediation)+'\n\n'+issueSpecMarkdown(analysis.issueSpec)+'\n',{mode:0o600});
      await saveReport();
      if(restart&&selected.length>1&&!restarted&&successes>=2){
        const beforeJobs=await store.db.query('SELECT id,status FROM sre_jobs ORDER BY id'),beforeIncidents=await store.db.query('SELECT id,analysis,revision FROM sre_incidents ORDER BY id');await worker.close();await store.db.close();store=await open();
        if(JSON.stringify(beforeJobs)!==JSON.stringify(await store.db.query('SELECT id,status FROM sre_jobs ORDER BY id'))||JSON.stringify(beforeIncidents)!==JSON.stringify(await store.db.query('SELECT id,analysis,revision FROM sre_incidents ORDER BY id')))throw Error('Restart changed persisted work or analysis');
        restarted=true;await store.checkpoint('evaluation:restarted',{at:Date.now()});worker=createWorker();await event({type:'restart',retainedIncidents:beforeIncidents.length,retainedJobs:beforeJobs.length,at:Date.now()});
      }
    }
    return await saveReport();
  }finally{await worker.close();await store.db.close();}
}
