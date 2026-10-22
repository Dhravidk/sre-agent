import {retainLogBatch,retainLogTriage,incidentLogReferences} from './log-triage.mjs';
import {bindSourceEvidence} from './source-evidence.mjs';
import {sourceInventoryWindow,sourceInventoryText} from './source-inventory.mjs';
import { randomUUID } from 'node:crypto';
import { hash } from './security.mjs';
import {StorageError} from './database.mjs';
import { assessRollback, releases } from './rollback.mjs';
import { riskScope } from './analytic-risk.mjs';
import { bindPolicyEvidence,comparisonComplete } from './policy-evidence.mjs';
import {contactsText} from './casework.mjs';
import {automaticAssociationAllowed,associationText} from './change-associations.mjs';
import {latestChangeState} from './change-read.mjs';
import {assessmentBrief} from './assessment-brief.mjs';
import {signalNotice,signalNoticeChanges} from './signal-notices.mjs';
import {changeObservationNotices,observedChangeText} from './change-observation-notices.mjs';
import {collectSourceEvidence,sourceReadBudget,readImmutableSource} from './source-evidence.mjs';
import {validateSourceFindings,sourceFindingInput,sourceFindingChanges} from './source-references.mjs';
import {sourceIdentityHistoryWarning} from './source-identity-history.mjs';
import {boundedContext} from './model-context.mjs';
import {collectLogSourceEvidence} from './log-source.mjs';
import {EvidenceFollowup} from './evidence-followup.mjs';
import {evidenceReadLimits,validateEvidenceRequests,retainedEvidenceReads,evidenceReadText} from './evidence-request.mjs';
import {validateInvestigation,investigationSchema} from './reasoner.mjs';
import {readEvidenceReadHistory,evidenceReadHistoryWarning} from './evidence-read-history.mjs';
import {discoveryScope} from './source-discovery-config.mjs';
import {retainDiscoveryEvidence,discoverySummary,discoverySummaryText} from './source-discovery.mjs';
import {investigationTimeBudgetMs} from './investigation-budget.mjs';

export class IncidentWorker {
  constructor({store,services,connectors,reasoner,casework,leaseMs=60000,restoreReadOnly=false}) {Object.assign(this,{store,services,connectors,reasoner,casework,leaseMs,restoreReadOnly});this.owner=randomUUID();this.running=false;}
  async collect(context,signal,sourceBudget=sourceReadBudget(),job) {
    const collectionAbort=new AbortController();signal=AbortSignal.any([collectionAbort.signal,...(signal?[signal]:[])]);
    const service=this.services.find(x=>x.key===context.incident.service_key);
    const clients=this.connectors.get(service.key)||{};
    const modelBacked=['claude','codex'].includes(this.reasoner?.mode);let priorityReferences=[];
    const fixed=provider=>clients[provider]&&(provider!=='gitlab'||Boolean(service.gitlab?.project));
    const sourceProof=async(parameters)=>{
      const original=parameters.client;
      // Explicit source inspection and model excerpts share immutable reads.
      // A denied or exhausted read remains unavailable for both projections.
      const client=parameters.provider==='gitlab'&&service.gitlab?.sourceInspection?.enabled?Object.assign(Object.create(original),{file:async(path,sha)=>{
        const file=await readImmutableSource(path,sha,{service,client:original,budget:sourceBudget,signal});
        if(file.state!=='available')throw Error(file.error||'Immutable source unavailable');
        return {path:file.path,sha:file.sha,complete:true,content:file.content};
      }}):original;
      const options={...parameters,client},proof=modelBacked?await bindSourceEvidence({...options,priorityReferences}):await bindPolicyEvidence(options);
      const policy=modelBacked&&service.gitlab?.sourceInspection?.enabled?await bindPolicyEvidence(options):proof;
      const sourceInspection=await collectSourceEvidence({...policy,complete:parameters.complete},{service,client:original,budget:sourceBudget,signal});
      if(sourceInspection)proof.sourceInspection=sourceInspection;
      return proof;
    };
    const tasks=[],background=task=>tasks.push(Promise.resolve(task).then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason})));let readIndex=0;
    const collect=async(source,kind,fn)=>{
      try{
        signal.throwIfAborted();const start=job?await this.store.beginInitialRead(job,service.key,{source,kind,index:++readIndex,allowHeldReads:this.restoreReadOnly===true,signal}):null;signal.throwIfAborted();
        let data,failure;try{data=await fn();if(data===undefined||kind==='deployments'&&!Array.isArray(data?.items))throw Error('Connector returned an invalid evidence result');}
        catch(error){if(signal.aborted||error instanceof StorageError||error?.code==='SRE_INITIAL_EVIDENCE_FENCE')throw error;failure=error;}
        signal.throwIfAborted();const artifact={source,kind:failure?'connector_error':kind,content:failure?{message:String(failure.message||failure)}:data};
        const afterSave=async(query,id)=>{
          if(!failure&&modelBacked&&source==='dynatrace'&&kind==='logs'){const retained=await retainLogTriage(this.store,context.incident.id,id,data,{query});priorityReferences=incidentLogReferences(context,retained.references);}
          if(!failure&&kind==='deployments'&&['github','gitlab'].includes(source))for(const deployment of data.items)await this.store.ingest({id:hash(deployment),source,serviceKey:service.key,kind:'deployment',at:deployment.at,payload:deployment},query?{query}:undefined);
          if(!failure&&kind==='code_review'&&this.casework){const number=data.comparison?.review?.pull?.number||data.comparison?.mergeRequest?.iid;if(number)await this.casework.linkChange(context.incident.id,source,number,id,query);}
        };
        if(job)await this.store.completeInitialRead(job,start,artifact,{afterSave,signal});
        else{const id=modelBacked&&artifact.source==='dynatrace'&&artifact.kind==='logs'?await retainLogBatch(this.store,context.incident.id,artifact.content):await this.store.addEvidence(context.incident.id,artifact.source,artifact.kind,artifact.content);await afterSave(undefined,id);}
        return failure?null:data;
      }catch(error){collectionAbort.abort(error);throw error;}
    };
    try{
    const review=async(provider,number,expectedSha,expectedBase)=>{
      const client=clients[provider],data=provider==='github'?await client.pull(number,{signal,expectedSha}):await client.mergeRequest(number,{signal,expectedSha});
      const headSha=provider==='github'?data.pull.head.sha:(data.mergeRequest.diff_refs?.head_sha||data.mergeRequest.sha);
      if(provider==='github') {
        const target=data.pull.base?.sha||expectedBase;
        let comparison=await client.compare(target,headSha,{signal});
        const baseSha=comparison.merge_base_commit?.sha;
        // Target branch HEAD can contain work that this topic branch never had.
        // Review an immutable ancestor/head pair, rather than calling those
        // unrelated target changes a regression introduced by the PR.
        if(baseSha&&baseSha!==target)comparison=await client.compare(baseSha,headSha,{signal});
        return sourceProof({provider,comparisonKind:'review',baseSha,headSha,data:{...comparison,review:data,requestedBaseSha:target},files:comparison.files,complete:data.complete&&comparisonComplete(provider,comparison,baseSha,headSha),client,signal});
      }
      const baseSha=data.mergeRequest.diff_refs?.base_sha;
      return sourceProof({provider,comparisonKind:'review',baseSha,headSha,data,files:data.files||data.diffs,complete:data.complete,client,signal});
    };
    const compare=async(provider,baseSha,headSha,comparisonKind='deployment')=>{
      const client=clients[provider],data=await client.compare(baseSha,headSha,{signal});
      return sourceProof({provider,comparisonKind,baseSha,headSha,data,complete:comparisonComplete(provider,data,baseSha,headSha),client,signal});
    };
    const logs=clients.dynatraceLogs||(clients.dynatrace?.config.mode==='grail'?clients.dynatrace:null);
    const readLogs=()=>collect('dynatrace','logs',async()=>(modelBacked&&logs.investigationLogs?logs.investigationLogs.bind(logs):logs.logs.bind(logs))({from:Math.max(0,context.incident.started_at-900000),to:await this.store.coordinationNow(),environment:service.environment,signal}));
    const orderedLogs=modelBacked||discoveryScope(service)||service.gitlab?.sourceInspection?.enabled&&service.gitlab.sourceInspection.logLocations;
    if(logs&&orderedLogs)await readLogs();
    if(discoveryScope(service)){
      if(clients.gitlab&&job&&!await retainDiscoveryEvidence({store:this.store,job,context:await this.store.context(context.incident.id),service,client:clients.gitlab,budget:sourceBudget,signal}))throw Error('Incident changed during source discovery');
    }else if(service.gitlab?.sourceInspection?.enabled&&service.gitlab.sourceInspection.logLocations){
      if(clients.gitlab)await collect('gitlab','source_locations',async()=>({logSource:await collectLogSourceEvidence(await this.store.context(context.incident.id),{service,client:clients.gitlab,budget:sourceBudget,signal})}));
    }
    if(logs&&!orderedLogs)background(readLogs());
    // A job-owned read admits its packet and all scoped deployment observations
    // in one lease-checked transaction, using polling's existing inbox identity.
    for(const provider of ['github','gitlab'])if(fixed(provider))background(collect(provider,'deployments',()=>clients[provider].deployments(service.environment,{signal})));
    const reviews=new Map();
    for(const entry of context.evidence.filter(x=>x.kind==='problem').slice(0,5)) {
      if(['github','gitlab'].includes(entry.source)&&entry.content.number&&fixed(entry.source)&&!reviews.has(entry.source+':'+entry.content.number))reviews.set(entry.source+':'+entry.content.number,{provider:entry.source,number:entry.content.number,sha:entry.content.sha,baseSha:entry.content.baseSha});
      if(entry.source==='github'&&entry.content.stage==='merge-queue'&&clients.github)background(collect('github','release_diff',()=>compare('github',entry.content.baseSha,entry.content.sha,'review')));
      if(entry.source==='dynatrace'&&entry.content.problemId&&clients.dynatrace?.config.mode==='classic')background(collect('dynatrace','problem_details',()=>clients.dynatrace.problem(entry.content.problemId,{signal})));
      if(entry.source==='servicenow'&&entry.content.sys_id&&clients.servicenow)background(collect('servicenow','incident_details',()=>clients.servicenow.incident(entry.content.sys_id,{signal})));
    }
    // Forward fixes need not be in the current deployment or a bounded problem
    // window. Follow their persisted associations at the latest observed SHA.
    const links=this.casework?await this.store.db.query('SELECT provider,change_number FROM sre_incident_change_links WHERE incident_id=? ORDER BY provider,change_number LIMIT 11',[context.incident.id]):[];
    for(const link of links.slice(0,10))if(fixed(link.provider)&&await automaticAssociationAllowed(this.store.db.query,context.incident,link.provider,link.change_number)){
      const {latest,conflicting}=await latestChangeState(this.store.db.query,service.key,link.provider,link.change_number,this.store.db.dialect);
      if(conflicting){
        reviews.delete(link.provider+':'+link.change_number);background(collect(link.provider,'code_review',async()=>{throw Error('Latest tracked change identities conflict at the same source timestamp; no arbitrary head is reviewed.');}));continue;
      }
      if(latest){const p=JSON.parse(latest.payload);reviews.set(link.provider+':'+link.change_number,{provider:link.provider,number:link.change_number,sha:latest.head_sha,baseSha:p.baseSha});}
    }
    if(links.length>10)background(collect('system','context_limit',async()=>({complete:false,message:'Code collection is limited to ten associated changes. Additional provider metadata remains tracked; narrow the review scope.'})));
    for(const item of reviews.values())background(collect(item.provider,'code_review',()=>review(item.provider,item.number,item.sha,item.baseSha)));
    const results=await Promise.all(tasks),failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    if(clients.servicenow?.enrich) {
      const ticket=context.evidence.find(x=>x.kind==='problem'&&x.source==='servicenow'&&x.content.sys_id);
      if(ticket)await collect('servicenow','incident_context',()=>clients.servicenow.enrich(ticket.content.sys_id,{signal}));
    }
    const timeline=await this.store.context(context.incident.id);
    for(const provider of ['github','gitlab'])if(fixed(provider)) {
      const recent=releases(timeline.deployments.filter(x=>x.at<=context.incident.started_at)).filter(x=>x.provider===provider).slice(0,2);
      if(recent[0]) {
        const linked=await collect(provider,'linked_changes',()=>clients[provider].linkedChanges(recent[0].sha,{signal}));
        for(const change of (linked?.items||[]).slice(0,3))await collect(provider,'code_review',()=>review(provider,provider==='github'?change.number:change.iid));
      }
      if(recent.length===2)await collect(provider,'release_diff',()=>compare(provider,recent[1].sha,recent[0].sha));
    }
    const refreshed=await this.store.context(context.incident.id);
    if(clients.jira) {
      const text=JSON.stringify([refreshed.evidence,refreshed.deployments]);
      const keys=[...new Set(text.match(/\b[A-Z][A-Z0-9_]*-\d+\b/g)||[])].filter(key=>service.jira.projects.includes(key.replace(/-\d+$/,''))).slice(0,10);
      for(const key of keys)await collect('jira','ticket',()=>clients.jira.issue(key,{signal}));
    }
    }catch(error){collectionAbort.abort(error);throw error;}
    finally{await Promise.all(tasks);}
  }
  async runOnce() {
    if(this.running||this.closed)return false;
    this.running=true;this.done=new Promise(resolve=>{this.end=resolve;});let timer;let job;
    const controller=new AbortController();this.controller=controller;
    // Grail collection can use 30 seconds before the separately bounded model
    // subprocess starts. Leave a minute for collection and persistence;
    // retain the existing shorter budget for non-model fixture workers.
    const deadline=setTimeout(()=>controller.abort(new Error('Investigation time budget exceeded')),investigationTimeBudgetMs(this.reasoner));
    try {
      if((await this.store.restoreFence())?.active&&!this.restoreReadOnly)return false;
      job=await this.store.claim(this.owner,this.leaseMs);if(!job)return false;
      timer=setInterval(()=>this.store.heartbeat(this.owner,job.id,this.leaseMs,job.lease_name).catch(error=>controller.abort(error)),Math.max(1000,this.leaseMs/3));
      const initial=await this.store.context(job.incident_id);
      const sourceBudget=sourceReadBudget();await this.collect(initial,controller.signal,sourceBudget,job);
      let context=await this.store.context(job.incident_id),result;
      const service=this.services.find(x=>x.key===context.incident.service_key),followup=new EvidenceFollowup({store:this.store,job,service,clients:this.connectors.get(service.key)||{},sourceBudget,signal:controller.signal});
      for(let round=0;round<=evidenceReadLimits.rounds;round++){
        await this.store.assertInitialReadOwner(job,service.key,{allowHeldReads:this.restoreReadOnly===true,signal:controller.signal});
        context.riskScope=riskScope(context,service,await this.store.coordinationNow());
        if(service.investigation?.followUp?.enabled)context.evidenceAcquisition=await followup.policy(context,round);
        result=await this.reasoner.investigate(context,{question:job.payload.question,requests:job.payload.requests,requestBatchVersion:job.payload.requestBatchVersion??1,signal:controller.signal,persistRemote:state=>this.store.setRemoteState(job.incident_id,state,job)});
        const requests=validateEvidenceRequests(result.analysis.evidenceRequests);if(!requests.length)break;
        if(!context.evidenceAcquisition?.enabled)throw Error('Follow-up evidence reads are not enabled');
        const accepted=await followup.run(requests,context,round,{limited:round===evidenceReadLimits.rounds});if(!accepted)break;
        if(round===evidenceReadLimits.rounds){
          const input=Object.fromEntries(Object.keys(investigationSchema.properties).filter(key=>result.analysis[key]!==undefined).map(key=>[key,result.analysis[key]]));
          input.evidenceRequests=[];if(input.sourceFindings)input.sourceFindings=sourceFindingInput(input.sourceFindings);
          input.summary='Investigation remains inconclusive because additional requested evidence was not collected within the host read budget.';input.changeAssessment='unknown';input.candidateSha=null;input.unknowns=[...input.unknowns.slice(0,9),'Additional requested evidence remains unavailable; narrow the next investigation or obtain the missing evidence.'];input.risk={...input.risk,likelihood:'unknown',likelihoodRationale:'Additional requested evidence was not collected.',confidence:'low',confidenceRationale:'The follow-up evidence budget was exhausted before the requested investigation completed.'};
          result.analysis={...validateInvestigation(input,context),mode:result.analysis.mode};break;
        }
        context=await this.store.context(job.incident_id);
      }
      delete result.analysis.evidenceAcquisition;
      delete result.analysis.sourceDiscovery;
      delete result.analysis.sourceInventories;
      const inventory=sourceInventoryWindow(context);if(inventory.inventories.length){result.analysis.sourceInventories=inventory;result.analysis.text+='\n\n'+sourceInventoryText(inventory);}
      const discovery=discoverySummary(context);if(discovery){result.analysis.sourceDiscovery=discovery;result.analysis.text+='\n\n'+discoverySummaryText(discovery);}
      const readHistory=await readEvidenceReadHistory(this.store,context),retainedReads=retainedEvidenceReads(readHistory.outcomes,followup.results),readWarning=evidenceReadHistoryWarning(readHistory.coverage);
      if(retainedReads.length||readWarning){result.analysis.evidenceAcquisition={version:1,requests:followup.used,logQueries:followup.logQueries,outcomes:retainedReads,history:readHistory.coverage};result.analysis.text+='\n\nRetained host follow-up evidence: '+(retainedReads.length?retainedReads.map(evidenceReadText).join('; '):'No verified terminal outcome in this bounded view')+'. Observations may be historical; a read result is not cause, health or approval.'+(readWarning?' '+readWarning:'');}
      const identityWarning=sourceIdentityHistoryWarning(context);if(identityWarning){result.analysis.unknowns=[identityWarning,...result.analysis.unknowns.filter(value=>value!==identityWarning)].slice(0,10);result.analysis.text+='\n\n'+identityWarning;}
      if(result.analysis.sourceFindings?.length){
        result.analysis.sourceFindings=validateSourceFindings(sourceFindingInput(result.analysis.sourceFindings),context,boundedContext(context));
        if(result.analysis.sourceFindings.some(finding=>!result.analysis.evidenceIds.includes(finding.evidenceId)))throw Error('Source finding lacks its supporting investigation evidence reference');
      }
      const sourceChanges=sourceFindingChanges(context.incident.analysis?.sourceFindings,result.analysis.sourceFindings);
      delete result.analysis.sourceFindingChanges;
      if(sourceChanges.added||sourceChanges.removed)result.analysis.sourceFindingChanges=sourceChanges;
      result.analysis.incidentStatus=context.incident.status;
      if(controller.signal.aborted)throw controller.signal.reason;
      // Evaluate the new draft against the revision it just investigated.
      // Publishing still fences that revision; action paths independently
      // require the persisted assessment to be current.
      const rollback=assessRollback({...context,assessmentStatus:{state:'current'},incident:{...context.incident,analysis:result.analysis}},service,await this.store.coordinationNow());
      result.analysis.rollback={eligible:rollback.eligible,reasons:rollback.reasons,targetSha:rollback.target?.sha||null};
      if(!rollback.eligible) {
        result.analysis.nextSteps=result.analysis.nextSteps.filter(x=>!/roll\s*back|revert|redeploy/i.test(x));
        result.analysis.text=result.analysis.text.split('\n').filter(x=>!/^Next:.*(?:roll\s*back|revert|redeploy)/i.test(x)).join('\n');
      }
      result.analysis.text+='\nRollback policy: '+(rollback.eligible?'Eligible for an explicit approval request; target '+rollback.target.sha:rollback.reasons.join(' ')+' '+rollback.alternative);
      const reads=context.changeAssociations?.reads||[];
      // Only stable, host-derived changes affect proactive notifications. Read
      // times, delivery IDs and repeated observations must not create chatter.
      result.analysis.trackedChanges=reads.map(r=>({provider:r.provider,number:r.number,headSha:r.headSha,stage:r.stage,complete:r.complete,historicalAfterRestore:r.historicalAfterRestore,ci:{state:r.ci?.state||'unknown',status:r.ci?.status||null,pipelineId:r.ci?.pipelineId||null,sha:r.ci?.sha||null,consistency:r.ci?.consistency?.state||null,otherStatuses:(r.ci?.consistency?.latest||[]).map(o=>o.status).sort()}})).sort((a,b)=>(a.provider+':'+a.number).localeCompare(b.provider+':'+b.number));
      const observations=await changeObservationNotices(this.store,context,service,this.casework);
      result.analysis.observedChanges=observations.changes;result.analysis.observedChangesLimited=observations.limited;
      result.analysis.observedChangeRegistry=observations.registry;
      if(observations.changes.length)result.analysis.text+='\n\nLinked change observations (bounded source history, not deployment or recovery proof):\n'+[...observations.changes].sort((a,b)=>b.materialRevision-a.materialRevision).slice(0,3).map(observedChangeText).join('\n')+(observations.limited||observations.changes.length>3?'\nFurther linked changes are omitted.':'');
      if(reads.length||context.changeAssociations?.controls?.length){const message=associationText(context.changeAssociations);if(!result.analysis.text.includes(message))result.analysis.text+='\n\n'+message;}
      if(this.casework){const contacts=await this.casework.contacts(job.incident_id,{...context,assessmentStatus:{state:'current'},incident:{...context.incident,analysis:result.analysis}});result.analysis.contacts=contacts;if(contacts.contacts.length||contacts.unknowns.length)result.analysis.text+='\n\n'+contactsText(contacts);}
      result.analysis.observedSignals=signalNotice(context.signalDigest);
      result.analysis.observedSignalChanges=signalNoticeChanges(context.incident.analysis?.observedSignals,result.analysis.observedSignals);
      const notice=assessmentBrief({...context,assessmentStatus:{state:'current'}},result.analysis);
      await this.store.finish(job,result.analysis,result.remoteState,Number(context.incident.revision),{text:notice,contactFormat:'brief'});
      return true;
    } catch(error) {
      if(job)await this.store.fail(job,error,error.retryable===false?1:3);
      else throw error;
      return false;
    } finally {clearInterval(timer);clearTimeout(deadline);this.running=false;this.controller=null;this.end?.();}
  }
  stop(){this.closed=true;this.controller?.abort(new Error('SRE worker shutting down'));}
  async close() {this.stop();await this.done;await this.store.release(this.owner);}
}
