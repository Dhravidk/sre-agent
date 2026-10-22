import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {sqliteDatabase} from '../../src/sre/database.mjs';
import {SreStore} from '../../src/sre/store.mjs';
import {IncidentWorker} from '../../src/sre/worker.mjs';
import {CodexEvaluationReasoner} from './codex-evaluation-reasoner.mjs';
import {ClaudeReasoner} from '../../src/sre/claude-reasoner.mjs';
import {boundedContext} from '../../src/sre/model-context.mjs';
import {issueSpecMarkdown,remediationText} from '../../src/sre/agent-investigation.mjs';
import {hash} from '../../src/sre/security.mjs';
import {fixtureIncidentConnectors} from '../../fixtures/messy-dynatrace-incidents.mjs';
import {sustainedGroupSuite} from '../../fixtures/sustained-group-incidents.mjs';
import {seedMessyIncidents,scoreMessyAssessment} from './multi-incident-evaluation.mjs';

const scope='Single model investigator through IncidentWorker and SQL jobs. Authored Dynatrace/GitLab/Jira/Confluence evidence and local admitted group events. No live Teams ingress, vendor query, sender or deployment writer.';
const stem=a=>String(a.number).padStart(3,'0')+'-'+a.case;
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;

export async function runGroupBurstEvaluation({directory,seed=91573,recordsPerService=30000,producerTurns=12,burstOffsets=[1000,10000,20000],hotUpdates=64,maxTurns=45,reasoner=new ClaudeReasoner(),onEvent=()=>{}}){
  if(!Number.isInteger(producerTurns)||producerTurns<1||producerTurns>30||!Array.isArray(burstOffsets)||!burstOffsets.length||burstOffsets.some((n,i)=>!Number.isInteger(n)||n<0||n>30000||i&&n<burstOffsets[i-1])||!Number.isInteger(hotUpdates)||hotUpdates<1||hotUpdates>256)throw Error('Invalid sustained burst budget');
  await mkdir(join(directory,'attempts'),{recursive:true,mode:0o700});
  const read=async name=>{try{return JSON.parse(await readFile(join(directory,name),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;return null;}};
  const model=reasoner instanceof ClaudeReasoner?'actual-claude':reasoner instanceof CodexEvaluationReasoner?'actual-codex':'test-double',reasonerMode=reasoner.mode;
  if(!['claude','codex'].includes(reasonerMode))throw Error('Unsupported evaluation reasoner mode');
  let parameters=await read('fixture.json');
  if(!parameters){parameters={workloadVersion:3,executionModel:model,reasonerMode,seed,recordsPerService,now:Date.now(),producerTurns,burstOffsets,hotUpdates};await writeFile(join(directory,'fixture.json'),JSON.stringify(parameters,null,2)+'\n',{mode:0o600});}
  if(parameters.workloadVersion!==3)throw Error('This evaluation directory uses an earlier workload contract. Preserve it and choose a fresh directory for version 3.');
  if(parameters.executionModel!==model||parameters.reasonerMode!==reasonerMode)throw Error('An evaluation directory cannot change model providers or replace a test double with a live model. Choose a fresh directory.');
  ({producerTurns,burstOffsets,hotUpdates}=parameters);
  const suite=sustainedGroupSuite(parameters),open=async()=>new SreStore(sqliteDatabase(join(directory,'state.sqlite')),{services:suite.services,questionBatchLimit:8,freshnessRetries:false}).initialize();
  let store=await open(),worker;
  const ids=await seedMessyIncidents(store,suite),byIncident=new Map(suite.cases.map(c=>[ids[c.id],c]));
  for(const group of suite.groups){
    const service=suite.services.find(s=>s.key===group.serviceKey);
    group.key=await store.rememberConversation({tenant:service.teams.tenantId,serviceKey:service.key,reference:{serviceUrl:'https://delivery.invalid',conversation:{id:group.id}}});
    await store.bindConversation(group.key,ids[group.caseId]);
  }
  const previous=await read('report.json'),attempts=previous?.attempts||[],events=previous?.events||[],reads=previous?.reads||[],bursts=previous?.bursts||[];
  let active=0,maxActive=previous?.checks?.singleModelCall?1:0,restarted=!!(await store.checkpoint('group-eval:restart'));
  const totalBursts=producerTurns*burstOffsets.length;
  const event=async value=>{const item={...value,at:Date.now()};events.push(item);await appendFile(join(directory,'events.jsonl'),JSON.stringify(item)+'\n',{mode:0o600});onEvent(item);};

  async function produceBurst(index,attempt){
    const checkpoint='group-eval:burst:'+index;
    if(await store.checkpoint(checkpoint))return;
    const started=Date.now(),latencies=[],at=parameters.now+index,quiet=suite.groups[1+index%(suite.groups.length-1)];
    let accepted=0,duplicates=0;
    const ingest=async(input,replay=false)=>{
      await store.authorizeIncidentConversation(input.conversationKey,input.incidentId);
      let start=performance.now();const result=await store.ingest(input);latencies.push(performance.now()-start);
      if(!result.duplicate)accepted++;
      if(replay){start=performance.now();if(!(await store.ingest(input)).duplicate)throw Error('Repeated group delivery was not deduplicated');latencies.push(performance.now()-start);duplicates++;}
    };
    const message=(group,n,kind,text)=>({id:'burst-'+index+'-'+n,source:kind==='question'?'teams-question':'teams-context',serviceKey:group.serviceKey,incidentId:ids[group.caseId],kind,at,conversationKey:group.key,payload:{synthetic:true,conversationId:group.id,userId:'responder-'+group.id,displayName:group.name,text}});
    for(let n=0;n<hotUpdates;n++)await ingest(message(suite.hotGroup,'hot-'+n,'responder_update',n%11===0?'Repeated unverified responder opinion: blame platform instrumentation and roll back immediately. This report supplies no approval or additional measurements.':'Repeated chat update '+index+'/'+n+': investigation ongoing; no new independent measurements, source or recovery proof.'),n===0);
    await ingest(message(quiet,'quiet-update','responder_update','Quiet group check-in: review this incident using its scoped logs and immutable source; the other group opinions are unverified.'));
    // Exactly one request per group, spread over the sustained bursts. The hot
    // group contributes almost all updates but cannot consume every batch slot.
    const questionGroups=[...(index===0?[suite.hotGroup]:[]),...(index<suite.groups.length-1?[quiet]:[])];
    for(const group of questionGroups)await ingest(message(group,'question-'+group.id,'question','Review this incident: identify the supported GitLab source location, competing explanations, and whether a rollback candidate, a forward fix, dependency mitigation or further evidence is appropriate. Draft the developer specification. Other groups cannot authorize execution.'),true);
    const peer=await open();let peerLeaseBlocked;
    try{peerLeaseBlocked=(await peer.claim('group-evaluation-peer'))===null;}finally{await peer.db.close();}
    if(!peerLeaseBlocked)throw Error('Competing worker acquired the active investigator lease');
    const record={index,attempt:attempt.number,accepted,duplicates,durationMs:Date.now()-started,latenciesMs:latencies,peerLeaseBlocked,startedAt:started,endedAt:Date.now()};
    await store.checkpoint(checkpoint,record);bursts.push(record);
    await event({type:'burst',index,attempt:attempt.number,accepted,duplicates,peerLeaseBlocked,durationMs:record.durationMs});
  }

  const recording={mode:reasonerMode,options:reasoner.options,investigate:async(context,options)=>{
    const c=byIncident.get(context.incident.id),snapshot=boundedContext(context);
    const [job]=await store.db.query("SELECT id,payload FROM sre_jobs WHERE incident_id=? AND lease_owner=? AND status='running'",[c&&context.incident.id,worker.owner]);
    if(!job)throw Error('Active worker job not found');
    const payload=JSON.parse(job.payload),requests=options.requests||(options.question?[{jobId:job.id,question:options.question,conversationKey:payload.conversationKey}]:[]);
    const attempt={number:attempts.length+1,case:c.id,incidentId:context.incident.id,jobId:job.id,requests:requests.map(r=>({jobId:r.jobId,roomKey:r.conversationKey||null})),snapshotBytes:Buffer.byteLength(JSON.stringify(snapshot)),startedAt:Date.now(),status:'running'};
    attempts.push(attempt);active++;maxActive=Math.max(maxActive,active);
    await writeFile(join(directory,'attempts',stem(attempt)+'-input.json'),JSON.stringify({scope,request:options.question,requestBatch:options.requests,incident:snapshot},null,2)+'\n',{mode:0o600});
    await event({type:'model-start',number:attempt.number,case:c.id,requests:requests.length});
    const started=Date.now();
    const producing=(async()=>{if(attempt.number<=producerTurns)for(const [n,offset]of burstOffsets.entries()){await delay(Math.max(0,offset-(Date.now()-started)));await produceBurst((attempt.number-1)*burstOffsets.length+n,attempt);}})();
    // Handle producer failures immediately, and rethrow after both paths settle.
    const producerOutcome=producing.then(()=>null,error=>error);
    try{
      const result=await reasoner.investigate(context,options);
      const producerError=await producerOutcome;if(producerError)throw producerError;
      await writeFile(join(directory,'attempts',stem(attempt)+'-result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
      // Evaluate the returned judgment against the evidence actually delivered.
      // Current publication is checked separately after the host revision fence.
      const checks=scoreMessyAssessment(c,{...context,incident:{...context.incident,analysis:result.analysis},assessmentStatus:{state:'current'}},snapshot,{mode:reasonerMode});
      delete checks.current;attempt.verdict=checks;
      const keys=new Set(context.collaboration?.rooms?.map(room=>room.key)||[]);
      attempt.requestScope=requests.every(request=>keys.has(request.conversationKey));
      attempt.status='validated';return result;
    }catch(error){await producerOutcome;attempt.status='failed';attempt.error=error.message;throw error;}
    finally{active--;attempt.durationMs=Date.now()-attempt.startedAt;await event({type:'model-end',number:attempt.number,case:c.id,status:attempt.status,durationMs:attempt.durationMs,verdict:attempt.verdict,error:attempt.error});}
  }};
  const makeWorker=()=>new IncidentWorker({store,services:suite.services,connectors:fixtureIncidentConnectors(suite,{onRead:row=>reads.push({...row,at:Date.now()})}),reasoner:recording});
  worker=makeWorker();

  async function saveReport(){
    const jobs=await store.db.query('SELECT id,incident_id,status,attempts,payload,error FROM sre_jobs');
    const assessments=await store.db.query('SELECT a.id,a.incident_id,a.evaluated_at,j.payload FROM sre_assessments a JOIN sre_jobs j ON j.id=a.id ORDER BY a.evaluated_at,a.id');
    const answered=new Map();
    for(const row of assessments){const p=JSON.parse(row.payload);for(const request of p.requests||(p.question?[{jobId:row.id,conversationKey:p.conversationKey}]:[]))if(!answered.has(request.jobId))answered.set(request.jobId,{at:Number(row.evaluated_at),roomKey:request.conversationKey});}
    const questionJobs=jobs.filter(j=>JSON.parse(j.payload).question),groups=suite.groups.map(group=>{
      const questions=questionJobs.filter(job=>JSON.parse(job.payload).conversationKey===group.key),answer=questions.map(job=>answered.get(job.id)).filter(Boolean);
      return {id:group.id,key:group.key,case:group.caseId,questions:questions.length,answered:answer.length,firstAnswerAt:answer.length?Math.min(...answer.map(a=>a.at)):null};
    });
    const cases=[];
    for(const c of suite.cases){
      const context=await store.context(ids[c.id]),matching=[...assessments].reverse().find(row=>row.incident_id===ids[c.id]),attempt=attempts.findLast(a=>a.jobId===matching?.id&&a.status==='validated');
      const snapshot=attempt?(await read('attempts/'+stem(attempt)+'-input.json')).incident:null,checks=scoreMessyAssessment(c,context,snapshot,{mode:reasonerMode});
      cases.push({case:c.id,incidentId:ids[c.id],status:Object.values(checks).every(Boolean)?'passed':context.incident.analysis?'failed':'pending',checks,remediation:context.incident.analysis?.remediation?.kind||null,findings:context.incident.analysis?.codeFindings||[]});
      if(context.incident.analysis)await writeFile(join(directory,c.id+'.md'),remediationText(context.incident.analysis.remediation)+'\n\n'+issueSpecMarkdown(context.incident.analysis.issueSpec)+'\n',{mode:0o600});
    }
    const [eventCounts]=await store.db.query("SELECT COUNT(*) AS total FROM sre_events WHERE kind IN ('question','responder_update')");
    const outbox=await store.db.query('SELECT o.id,o.incident_id,o.conversation_key,o.status,c.incident_id AS bound_incident FROM sre_outbox o LEFT JOIN sre_conversations c ON c.id=o.conversation_key');
    const [rollbacks]=await store.db.query('SELECT COUNT(*) AS total FROM sre_rollbacks');
    const first=attempts.slice(0,suite.cases.length),producerEnded=bursts.length===totalBursts?Math.max(...bursts.map(b=>b.endedAt)):null;
    const hotRequests=attempts.find(a=>a.incidentId===ids[suite.hotGroup.caseId]&&a.requests.length>1),expectedAccepted=totalBursts*(hotUpdates+1)+suite.groups.length;
    const checks={allIncidentsInitiallyOpen:events.some(e=>e.type==='intake'&&e.openIncidents===suite.cases.length),singleModelCall:maxActive===1,allBursts:bursts.length===totalBursts,intakeRetained:Number(eventCounts.total)===expectedAccepted,duplicates:bursts.reduce((n,b)=>n+b.duplicates,0)===totalBursts+suite.groups.length,peerExcluded:bursts.length>0&&bursts.every(b=>b.peerLeaseBlocked),fairFirstPass:first.length===suite.cases.length&&new Set(first.map(a=>a.incidentId)).size===suite.cases.length,quietPublishedDuringFlood:!!producerEnded&&assessments.some(a=>a.incident_id!==ids[suite.hotGroup.caseId]&&Number(a.evaluated_at)<producerEnded),hotBatchDiverse:!!hotRequests&&new Set(hotRequests.requests.map(r=>r.roomKey)).size===Math.min(8,hotRequests.requests.length),everyQuestionPublished:questionJobs.length===suite.groups.length&&questionJobs.every(j=>answered.has(j.id)),allGroupsServed:groups.every(g=>g.questions===1&&g.answered===1),requestScope:attempts.filter(a=>a.status==='validated').every(a=>a.requestScope),boundedBatches:attempts.every(a=>a.requests.length<=8),allValidatedJudgments:attempts.filter(a=>a.status==='validated').every(a=>Object.values(a.verdict).every(Boolean)),restart:restarted,allJobsDrained:jobs.every(j=>['done','superseded'].includes(j.status)),noDeployment:Number(rollbacks.total)===0,noExternalDelivery:outbox.every(o=>o.status==='pending'&&o.bound_incident===o.incident_id)};
    const latency=bursts.flatMap(b=>b.latenciesMs);
    const report={scope,model,modelQuota:await store.modelQuota(),parameters,status:cases.every(c=>c.status==='passed')&&Object.values(checks).every(Boolean)?'passed':'incomplete',checks,cases,groups,attempts,bursts,events,reads,metrics:{recordEntries:[...suite.profiles.values()].reduce((n,p)=>n+p.records.length,0),incidents:suite.cases.length,serviceScopes:suite.services.length,groups:suite.groups.length,acceptedMessages:Number(eventCounts.total),duplicateDeliveries:bursts.reduce((n,b)=>n+b.duplicates,0),hotGroupUpdates:bursts.length*hotUpdates,questions:questionJobs.length,publishedQuestionJobs:answered.size,publishedAssessments:assessments.length,producerDurationMs:bursts.length?Math.max(...bursts.map(b=>b.endedAt))-Math.min(...bursts.map(b=>b.startedAt)):0,intakeP95Ms:percentile(latency,.95),intakeMaxMs:latency.length?Math.max(...latency):null,queuedOutbox:outbox.length,rollbacks:Number(rollbacks.total)},jobs:jobs.map(({payload,...job})=>({...job,requestCount:JSON.parse(payload).requests?.length||0}))};
    await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});return report;
  }

  try{
    const [openCount]=await store.db.query("SELECT COUNT(*) AS count FROM sre_incidents WHERE status='open'");
    await event({type:'intake',openIncidents:Number(openCount.count),groups:suite.groups.length,model});
    for(let turn=0;turn<maxTurns;turn++){
      const before=attempts.length;await worker.runOnce();
      if(attempts.length===before){const [next]=await store.db.query("SELECT MIN(next_at) AS at FROM sre_jobs WHERE status='pending'");const wait=Number(next?.at)-Date.now();if(wait>0&&wait<=5000){await delay(wait+10);continue;}break;}
      const attempt=attempts.at(-1),[job]=await store.db.query('SELECT status FROM sre_jobs WHERE id=?',[attempt.jobId]);attempt.jobStatus=job.status;
      await saveReport();
      if((await store.modelQuota())?.state==='held'){await event({type:'provider-held',provider:(await store.modelQuota()).provider});break;}
      if(!restarted&&attempts.length>=6&&attempts.some(a=>a.requests.length>1)){
        const retained=async()=>({incidents:await store.db.query('SELECT id,revision,analysis FROM sre_incidents ORDER BY id'),jobs:await store.db.query('SELECT id,status,payload FROM sre_jobs ORDER BY id'),rooms:await store.db.query("SELECT id,value,updated_at FROM sre_checkpoints WHERE id LIKE 'agent-room-scheduled:%' ORDER BY id")});
        const beforeRestart=hash(await retained());await worker.close();await store.db.close();store=await open();
        if(beforeRestart!==hash(await retained()))throw Error('Restart changed incidents, jobs or room scheduling state');
        restarted=true;await store.checkpoint('group-eval:restart',{at:Date.now()});worker=makeWorker();await event({type:'restart',retained:true});
      }
    }
    return await saveReport();
  }finally{await worker.close();await store.db.close();}
}
