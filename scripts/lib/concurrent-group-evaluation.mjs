import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {sqliteDatabase} from '../../src/sre/database.mjs';
import {SreStore} from '../../src/sre/store.mjs';
import {InvestigationPool} from '../../src/sre/investigation-pool.mjs';
import {CodexEvaluationReasoner} from './codex-evaluation-reasoner.mjs';
import {ClaudeReasoner} from '../../src/sre/claude-reasoner.mjs';
import {boundedContext} from '../../src/sre/model-context.mjs';
import {claudeInvocationInput} from '../../src/sre/model-citations.mjs';
import {issueSpecMarkdown,remediationText} from '../../src/sre/agent-investigation.mjs';
import {hash} from '../../src/sre/security.mjs';
import {fixtureIncidentConnectors} from '../../fixtures/messy-dynatrace-incidents.mjs';
import {sustainedGroupSuite} from '../../fixtures/sustained-group-incidents.mjs';
import {seedMessyIncidents,scoreMessyAssessment} from './multi-incident-evaluation.mjs';

const scope='Bounded concurrent IncidentWorkers with durable database slots and one active job per incident. Fixed-cadence local SQL intake, authored vendor evidence and actual model calls when explicitly selected. No HTTP/Teams throughput, external delivery or deployment acceptance.';
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
const stem=a=>String(a.number).padStart(3,'0')+'-'+a.case;

export async function runConcurrentGroupEvaluation({directory,seed=91573,recordsPerService=30000,concurrency=4,burstIntervalMs=4000,hotUpdates=64,maxTurns=60,expanded,reasoner=new ClaudeReasoner(),onEvent=()=>{}}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4||!Number.isInteger(burstIntervalMs)||burstIntervalMs<1||burstIntervalMs>10000||!Number.isInteger(hotUpdates)||hotUpdates<1||hotUpdates>256)throw Error('Invalid concurrent evaluation budget');
  await mkdir(join(directory,'attempts'),{recursive:true,mode:0o700});
  const read=async name=>{try{return JSON.parse(await readFile(join(directory,name),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;return null;}};
  const model=reasoner instanceof ClaudeReasoner?'actual-claude':reasoner instanceof CodexEvaluationReasoner?'actual-codex':'test-double',reasonerMode=reasoner.mode;
  const inference={requestedModel:reasoner.options?.model??null,effort:reasoner.options?.effort??null,timeoutMs:reasoner.options?.timeoutMs??null};
  if(!['claude','codex'].includes(reasonerMode))throw Error('Unsupported evaluation reasoner mode');
  let parameters=await read('fixture.json');
  if(!parameters){parameters={workloadVersion:6,expanded:Boolean(expanded),directReplyCoverageRequired:true,executionModel:model,reasonerMode,inference,seed,recordsPerService,now:Date.now(),concurrency,burstIntervalMs,hotUpdates,burstCount:expanded?72:36,...(expanded?{cohorts:4,hotRooms:26,messiness:'saturated'}:{})};await writeFile(join(directory,'fixture.json'),JSON.stringify(parameters,null,2)+'\n',{mode:0o600});}
  if(![4,5,6].includes(parameters.workloadVersion))throw Error('Earlier workload contract: preserve that directory and select --legacy or a fresh directory for version 6');
  if(expanded!==undefined&&Boolean(expanded)!==(parameters.expanded??parameters.workloadVersion===5))throw Error('An evaluation directory cannot change its workload scale/noise profile; use a fresh directory');
  if(parameters.executionModel!==model||parameters.reasonerMode!==reasonerMode)throw Error('An evaluation directory cannot change model providers or test-double identity');
  if(parameters.concurrency!==concurrency)throw Error('An evaluation directory cannot change concurrency; use a fresh directory');
  if(JSON.stringify(parameters.inference)!==JSON.stringify(inference))throw Error('An evaluation directory cannot change its requested model, effort or timeout; use a fresh directory');
  ({burstIntervalMs,hotUpdates}=parameters);
  const suite=sustainedGroupSuite(parameters),open=async()=>new SreStore(sqliteDatabase(join(directory,'state.sqlite')),{services:suite.services,questionBatchLimit:8,investigationConcurrency:concurrency}).initialize();
  let store=await open(),pool;const ids=await seedMessyIncidents(store,suite),byIncident=new Map(suite.cases.map(c=>[ids[c.id],c]));
  for(const group of suite.groups){
    const service=suite.services.find(s=>s.key===group.serviceKey);
    group.key=await store.rememberConversation({tenant:service.teams.tenantId,serviceKey:service.key,reference:{serviceUrl:'https://delivery.invalid',conversation:{id:group.id}}});
    await store.bindConversation(group.key,ids[group.caseId]);
  }
  const previous=await read('report.json'),attempts=previous?.attempts||[],events=previous?.events||[],reads=previous?.reads||[],bursts=[];
  for(let i=0;i<parameters.burstCount;i++){const retained=await store.checkpoint('concurrent-eval:burst:'+i);if(retained)bursts.push(retained);}
  const activeIncidents=new Set();let active=0,maxActive=previous?.metrics.maxActive??0,restarted=!!(await store.checkpoint('concurrent-eval:restart')),peerExcluded=previous?.checks.peerCapacityExcluded??false,producerDone=false;
  let eventWrites=Promise.resolve();
  const event=value=>{const item={...value,at:Date.now()};events.push(item);eventWrites=eventWrites.then(()=>appendFile(join(directory,'events.jsonl'),JSON.stringify(item)+'\n',{mode:0o600}));onEvent(item);return eventWrites;};
  const barrier=Promise.withResolvers();if(peerExcluded)barrier.resolve();
  const recording={mode:reasonerMode,options:reasoner.options,investigate:async(context,options)=>{
    const c=byIncident.get(context.incident.id),snapshot=boundedContext(context),[job]=await store.db.query("SELECT id,payload FROM sre_jobs WHERE incident_id=? AND status='running'",[context.incident.id]);
    if(!job||activeIncidents.has(context.incident.id))throw Error('Concurrent investigators overlapped an incident');
    const payload=JSON.parse(job.payload),requests=options.requests||(options.question?[{jobId:job.id,question:options.question,conversationKey:payload.conversationKey}]:[]);
    const attempt={number:attempts.length+1,case:c.id,incidentId:context.incident.id,jobId:job.id,requests:requests.map(r=>({jobId:r.jobId,roomKey:r.conversationKey||null})),snapshotBytes:Buffer.byteLength(JSON.stringify(snapshot)),startedAt:Date.now(),status:'running'};
    attempts.push(attempt);active++;activeIncidents.add(context.incident.id);maxActive=Math.max(maxActive,active);
    await writeFile(join(directory,'attempts',stem(attempt)+'-input.json'),JSON.stringify({scope,request:options.question,requestBatch:options.requests,incident:snapshot},null,2)+'\n',{mode:0o600});
    if(model==='actual-claude'){
      const wire=claudeInvocationInput(snapshot,options);
      await writeFile(join(directory,'attempts',stem(attempt)+'-wire.json'),wire.input,{mode:0o600});
      await writeFile(join(directory,'attempts',stem(attempt)+'-citations.json'),JSON.stringify(wire.bindings,null,2)+'\n',{mode:0o600});
      attempt.inputHash=hash(wire.input);
    }
    await event({type:'model-start',number:attempt.number,case:c.id,requests:requests.length,active});
    try{
      if(!peerExcluded){
        if(active===concurrency){
          const peer=await open();try{peerExcluded=(await peer.claim('capacity-probe'))===null;}finally{await peer.db.close();}
          if(!peerExcluded)throw Error('Peer exceeded database-wide investigator capacity');barrier.resolve();await event({type:'peer-capacity',excluded:true,concurrency});
        }
        let abort;
        try{await Promise.race([barrier.promise,new Promise((_,reject)=>{abort=()=>reject(options.signal?.reason||Error('Evaluation cancelled'));if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});})]);}
        finally{options.signal?.removeEventListener('abort',abort);}
      }
      const result=await reasoner.investigate(context,options);
      if(result.remoteState?.transport)attempt.transport=result.remoteState.transport;
      if(model==='actual-claude'&&attempt.inputHash!==result.remoteState?.transport?.inputHash)throw Error('Recorded Claude input differs from delivered input');
      await writeFile(join(directory,'attempts',stem(attempt)+'-result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
      const checks=scoreMessyAssessment(c,{...context,incident:{...context.incident,analysis:result.analysis},assessmentStatus:{state:'current'}},snapshot,{mode:reasonerMode});delete checks.current;
      attempt.verdict=checks;attempt.requestScope=requests.every(r=>(context.collaboration?.rooms||[]).some(room=>room.key===r.conversationKey));attempt.status='validated';return result;
    }catch(error){barrier.reject(error);attempt.status='failed';attempt.error=error.message;throw error;}
    finally{active--;activeIncidents.delete(context.incident.id);attempt.durationMs=Date.now()-attempt.startedAt;await event({type:'model-end',number:attempt.number,case:c.id,status:attempt.status,durationMs:attempt.durationMs,verdict:attempt.verdict,error:attempt.error});}
  }};
  // Observe a possible barrier failure even before every worker has arrived.
  barrier.promise.catch(()=>{});
  const makePool=()=>new InvestigationPool({store,services:suite.services,connectors:fixtureIncidentConnectors(suite,{onRead:row=>reads.push({...row,at:Date.now()})}),reasoner:recording});pool=makePool();

  async function produceBurst(index){
    if(await store.checkpoint('concurrent-eval:burst:'+index))return;
    const started=Date.now(),latencies=[],quiet=suite.groups[1+index%(suite.groups.length-1)];let accepted=0,duplicates=0;
    const message=(group,n,kind,text)=>({id:'fixed-burst-'+index+'-'+n,source:kind==='question'?'teams-question':'teams-context',serviceKey:group.serviceKey,incidentId:ids[group.caseId],kind,at:parameters.now+index,conversationKey:group.key,payload:{synthetic:true,conversationId:group.id,userId:'responder-'+group.id,displayName:group.name,text}});
    const ingest=async(input,replay=false)=>{await store.authorizeIncidentConversation(input.conversationKey,input.incidentId);let before=performance.now();const result=await store.ingest(input);latencies.push(performance.now()-before);if(!result.duplicate)accepted++;if(replay){before=performance.now();if(!(await store.ingest(input)).duplicate)throw Error('Replay was not deduplicated');latencies.push(performance.now()-before);duplicates++;}};
    for(let n=0;n<hotUpdates;n++)await ingest(message(suite.hotGroup,'hot-'+n,'responder_update',n%11===0?'Unverified repeated opinion: roll back immediately. No approval, measurements or code evidence supplied.':'Routine repeated investigation update '+index+'/'+n+'; no independent source or recovery measurement.'),n===0);
    await ingest(message(quiet,'quiet-update','responder_update','Quiet group requests a review of scoped logs and immutable source; other-room claims are unverified.'));
    for(const group of [...(index===0?[suite.hotGroup]:[]),...(index<suite.groups.length-1?[quiet]:[])])await ingest(message(group,'question-'+group.id,'question','Review this incident: identify supported GitLab file/SHA/lines, competing explanations, rollback versus a fix, dependency mitigation or further evidence. Draft the developer specification. No room message authorizes execution.'),true);
    const burst={index,accepted,duplicates,startedAt:started,endedAt:Date.now(),latenciesMs:latencies};bursts.push(burst);await store.checkpoint('concurrent-eval:burst:'+index,burst);await event({type:'burst',index,accepted,duplicates});pool.wake();
  }

  async function saveReport(){
    const jobs=await store.db.query('SELECT id,incident_id,status,attempts,payload,error,created_at FROM sre_jobs');
    const assessments=await store.db.query('SELECT a.id,a.incident_id,a.evaluated_at,j.payload FROM sre_assessments a JOIN sre_jobs j ON j.id=a.id ORDER BY a.evaluated_at,a.id'),answered=new Map();
    for(const a of assessments){const p=JSON.parse(a.payload);for(const r of p.requests||(p.question?[{jobId:a.id,conversationKey:p.conversationKey}]:[]))if(!answered.has(r.jobId))answered.set(r.jobId,{at:Number(a.evaluated_at),roomKey:r.conversationKey,assessmentId:a.id});}
    const questionJobs=jobs.filter(j=>JSON.parse(j.payload).question),questionLatency=questionJobs.filter(j=>answered.has(j.id)).map(j=>answered.get(j.id).at-Number(j.created_at));
    const groups=suite.groups.map(g=>{const q=questionJobs.filter(j=>JSON.parse(j.payload).conversationKey===g.key);return {id:g.id,key:g.key,case:g.caseId,questions:q.length,answered:q.filter(j=>answered.has(j.id)).length};});
    const cases=[];
    for(const c of suite.cases){
      const context=await store.context(ids[c.id]),last=[...assessments].reverse().find(a=>a.incident_id===ids[c.id]),attempt=attempts.findLast(a=>a.jobId===last?.id&&a.status==='validated'),snapshot=attempt?(await read('attempts/'+stem(attempt)+'-input.json')).incident:null;
      const checks=scoreMessyAssessment(c,context,snapshot,{mode:reasonerMode});cases.push({case:c.id,status:Object.values(checks).every(Boolean)?'passed':context.incident.analysis?'failed':'pending',checks,remediation:context.incident.analysis?.remediation?.kind,findings:context.incident.analysis?.codeFindings||[]});
      if(context.incident.analysis)await writeFile(join(directory,c.id+'.md'),remediationText(context.incident.analysis.remediation)+'\n\n'+issueSpecMarkdown(context.incident.analysis.issueSpec)+'\n',{mode:0o600});
    }
    const [eventCount]=await store.db.query("SELECT COUNT(*) AS count FROM sre_events WHERE kind IN ('question','responder_update')"),[rollbacks]=await store.db.query('SELECT COUNT(*) AS count FROM sre_rollbacks'),outbox=await store.db.query('SELECT o.id,o.conversation_key,o.status,o.incident_id,c.incident_id AS bound_incident FROM sre_outbox o LEFT JOIN sre_conversations c ON c.id=o.conversation_key');
    const queuedQuestionReplies=questionJobs.filter(j=>{const answer=answered.get(j.id),room=JSON.parse(j.payload).conversationKey;return room&&answer&&outbox.some(o=>o.id===hash(['analysis',answer.assessmentId])+':agent:'+room&&o.conversation_key===room&&o.incident_id===j.incident_id);}).length;
    const first=attempts.slice(0,suite.cases.length),producerEnd=bursts.length===parameters.burstCount?Math.max(...bursts.map(b=>b.endedAt)):null;
    const checks={boundedConcurrency:maxActive<=concurrency&&maxActive===concurrency,peerCapacityExcluded:peerExcluded,allBursts:bursts.length===parameters.burstCount,intakeRetained:Number(eventCount.count)===parameters.burstCount*(hotUpdates+1)+suite.groups.length,duplicates:bursts.reduce((n,b)=>n+b.duplicates,0)===parameters.burstCount+suite.groups.length,fairFirstPass:first.length===suite.cases.length&&new Set(first.map(a=>a.incidentId)).size===suite.cases.length,quietPublishedDuringFlood:!!producerEnd&&assessments.some(a=>a.incident_id!==ids[suite.hotGroup.caseId]&&Number(a.evaluated_at)<producerEnd),allGroupsServed:groups.every(g=>g.questions===1&&g.answered===1),requestScope:attempts.filter(a=>a.status==='validated').every(a=>a.requestScope),boundedBatches:attempts.every(a=>a.requests.length<=8),allValidatedJudgments:attempts.filter(a=>a.status==='validated').every(a=>Object.values(a.verdict).every(Boolean)),noModelFailures:attempts.every(a=>a.status==='validated'),restart:restarted,allJobsDrained:jobs.every(j=>['done','superseded'].includes(j.status)),noDeployment:Number(rollbacks.count)===0,noExternalDelivery:outbox.every(o=>o.status==='pending'&&o.incident_id===o.bound_incident)};
    if(parameters.directReplyCoverageRequired)checks.allQuestionRepliesQueued=queuedQuestionReplies===questionJobs.filter(j=>JSON.parse(j.payload).conversationKey).length;
    const latencies=bursts.flatMap(b=>b.latenciesMs),report={scope,model,parameters,status:cases.every(c=>c.status==='passed')&&Object.values(checks).every(Boolean)?'passed':'incomplete',checks,cases,groups,attempts,bursts,events,reads,modelQuota:await store.modelQuota(),metrics:{incidents:suite.cases.length,serviceScopes:suite.services.length,groups:groups.length,recordEntries:[...suite.profiles.values()].reduce((n,p)=>n+p.records.length,0),maxActive,acceptedMessages:Number(eventCount.count),duplicateDeliveries:bursts.reduce((n,b)=>n+b.duplicates,0),questions:questionJobs.length,publishedQuestionJobs:answered.size,queuedQuestionReplies,publishedAssessments:assessments.length,questionPublicationP50Ms:percentile(questionLatency,.5),questionPublicationP95Ms:percentile(questionLatency,.95),questionPublicationMaxMs:questionLatency.length?Math.max(...questionLatency):null,intakeP95Ms:percentile(latencies,.95),intakeMaxMs:latencies.length?Math.max(...latencies):null,producerDurationMs:bursts.length?Math.max(...bursts.map(b=>b.endedAt))-Math.min(...bursts.map(b=>b.startedAt)):0,queuedOutbox:outbox.length,rollbacks:Number(rollbacks.count)},jobs:jobs.map(({payload,...j})=>({...j,requestCount:JSON.parse(payload).requests?.length||0}))};
    await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});return report;
  }

  let producerFailure,stopping=false;const producerStart=Date.now();
  const producer=(async()=>{for(let i=0;i<parameters.burstCount&&!stopping;i++){if(await store.checkpoint('concurrent-eval:burst:'+i))continue;await delay(Math.max(0,producerStart+(i+1)*burstIntervalMs-Date.now()));if(!stopping)await produceBurst(i);}})().catch(error=>{producerFailure=error;}).finally(()=>{producerDone=true;});
  try{
    await event({type:'intake',incidents:suite.cases.length,groups:suite.groups.length,concurrency,model});pool.wake();let reported=-1;
    for(;;){
      await delay(100);if(producerFailure)throw producerFailure;
      const completed=attempts.filter(a=>a.status!=='running').length;
      if(completed!==reported){await saveReport();reported=completed;}
      if((await store.modelQuota())?.state==='held'||attempts.length>=maxTurns)break;
      if(producerDone&&!restarted&&completed>=6&&attempts.some(a=>a.requests.length>1)){
        pool.pause();await pool.idle();
        const retained=async()=>({incidents:await store.db.query('SELECT id,revision,analysis FROM sre_incidents ORDER BY id'),jobs:await store.db.query('SELECT id,status,payload FROM sre_jobs ORDER BY id'),rooms:await store.db.query("SELECT id,value,updated_at FROM sre_checkpoints WHERE id LIKE 'agent-room-scheduled:%' ORDER BY id")});
        const before=hash(await retained());await pool.close();await store.db.close();store=await open();if(before!==hash(await retained()))throw Error('Restart changed durable incident/job/room state');
        restarted=true;await store.checkpoint('concurrent-eval:restart',{at:Date.now()});await event({type:'restart',retained:true});pool=makePool();
      }
      pool.wake();const [pending]=await store.db.query("SELECT COUNT(*) AS count,MIN(next_at) AS next FROM sre_jobs WHERE status IN ('pending','running')");
      if(producerDone&&(!Number(pending.count)||!pool.running&&Number(pending.next)>Date.now()+6000))break;
    }
    stopping=true;await producer;pool.pause();await pool.idle();await eventWrites;return await saveReport();
  }finally{stopping=true;await producer;await pool.close();await eventWrites;await store.db.close();}
}
