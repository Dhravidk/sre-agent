import { randomUUID } from 'node:crypto';
import { hash } from './security.mjs';
import { assessRollback, releases } from './rollback.mjs';
import { riskScope } from './analytic-risk.mjs';
import { bindPolicyEvidence,comparisonComplete } from './policy-evidence.mjs';
import {contactsText} from './casework.mjs';
import {automaticAssociationAllowed,associationText} from './change-associations.mjs';
import {latestChangeState} from './change-read.mjs';
import {assessmentBrief} from './assessment-brief.mjs';

export class IncidentWorker {
  constructor({store,services,connectors,reasoner,casework,leaseMs=60000,restoreReadOnly=false}) {Object.assign(this,{store,services,connectors,reasoner,casework,leaseMs,restoreReadOnly});this.owner=randomUUID();this.running=false;}
  async collect(context,signal) {
    const service=this.services.find(x=>x.key===context.incident.service_key);
    const clients=this.connectors.get(service.key)||{};
    const tasks=[];
    const collect=async(source,kind,fn)=>{
      try {const data=await fn();const id=await this.store.addEvidence(context.incident.id,source,kind,data);if(kind==='code_review'&&this.casework){const number=data.comparison?.review?.pull?.number||data.comparison?.mergeRequest?.iid;if(number)await this.casework.linkChange(context.incident.id,source,number,id);}return data;}
      catch(error) {await this.store.addEvidence(context.incident.id,source,'connector_error',{message:error.message});return null;}
    };
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
        return bindPolicyEvidence({provider,comparisonKind:'review',baseSha,headSha,data:{...comparison,review:data,requestedBaseSha:target},files:comparison.files,complete:data.complete&&comparisonComplete(provider,comparison,baseSha,headSha),client,signal});
      }
      const baseSha=data.mergeRequest.diff_refs?.base_sha;
      return bindPolicyEvidence({provider,comparisonKind:'review',baseSha,headSha,data,files:data.files||data.diffs,complete:data.complete,client,signal});
    };
    const compare=async(provider,baseSha,headSha,comparisonKind='deployment')=>{
      const client=clients[provider],data=await client.compare(baseSha,headSha,{signal});
      return bindPolicyEvidence({provider,comparisonKind,baseSha,headSha,data,complete:comparisonComplete(provider,data,baseSha,headSha),client,signal});
    };
    const logs=clients.dynatraceLogs||(clients.dynatrace?.config.mode==='grail'?clients.dynatrace:null);
    if(logs)tasks.push(collect('dynatrace','logs',async()=>logs.logs({from:context.incident.started_at-900000,to:await this.store.coordinationNow(),signal})));
    for(const provider of ['github','gitlab'])if(clients[provider])tasks.push(collect(provider,'deployments',async()=>{
      const result=await clients[provider].deployments(service.environment,{signal});
      for(const deployment of result.items) {
        // Share polling's inbox identity and revision boundary. Direct ledger
        // inserts would let fresh deployment evidence bypass stale-work fences.
        await this.store.ingest({id:hash(deployment),source:provider,serviceKey:service.key,kind:'deployment',at:deployment.at,payload:deployment});
      }
      return result;
    }));
    const reviews=new Map();
    for(const entry of context.evidence.filter(x=>x.kind==='problem').slice(0,5)) {
      if(['github','gitlab'].includes(entry.source)&&entry.content.number&&clients[entry.source]&&!reviews.has(entry.source+':'+entry.content.number))reviews.set(entry.source+':'+entry.content.number,{provider:entry.source,number:entry.content.number,sha:entry.content.sha,baseSha:entry.content.baseSha});
      if(entry.source==='github'&&entry.content.stage==='merge-queue'&&clients.github)tasks.push(collect('github','release_diff',()=>compare('github',entry.content.baseSha,entry.content.sha,'review')));
      if(entry.source==='dynatrace'&&entry.content.problemId&&clients.dynatrace?.config.mode==='classic')tasks.push(collect('dynatrace','problem_details',()=>clients.dynatrace.problem(entry.content.problemId,{signal})));
      if(entry.source==='servicenow'&&entry.content.sys_id&&clients.servicenow)tasks.push(collect('servicenow','incident_details',()=>clients.servicenow.incident(entry.content.sys_id,{signal})));
    }
    // Forward fixes need not be in the current deployment or a bounded problem
    // window. Follow their persisted associations at the latest observed SHA.
    const links=this.casework?await this.store.db.query('SELECT provider,change_number FROM sre_incident_change_links WHERE incident_id=? ORDER BY provider,change_number LIMIT 11',[context.incident.id]):[];
    for(const link of links.slice(0,10))if(clients[link.provider]&&await automaticAssociationAllowed(this.store.db.query,context.incident,link.provider,link.change_number)){
      const {latest,conflicting}=await latestChangeState(this.store.db.query,service.key,link.provider,link.change_number,this.store.db.dialect);
      if(conflicting){
        reviews.delete(link.provider+':'+link.change_number);tasks.push(collect(link.provider,'code_review',async()=>{throw Error('Latest tracked change identities conflict at the same source timestamp; no arbitrary head is reviewed.');}));continue;
      }
      if(latest){const p=JSON.parse(latest.payload);reviews.set(link.provider+':'+link.change_number,{provider:link.provider,number:link.change_number,sha:latest.head_sha,baseSha:p.baseSha});}
    }
    if(links.length>10)tasks.push(collect('system','context_limit',async()=>({complete:false,message:'Code collection is limited to ten associated changes. Additional provider metadata remains tracked; narrow the review scope.'})));
    for(const item of reviews.values())tasks.push(collect(item.provider,'code_review',()=>review(item.provider,item.number,item.sha,item.baseSha)));
    await Promise.all(tasks);
    if(clients.servicenow?.enrich) {
      const ticket=context.evidence.find(x=>x.kind==='problem'&&x.source==='servicenow'&&x.content.sys_id);
      if(ticket)await collect('servicenow','incident_context',()=>clients.servicenow.enrich(ticket.content.sys_id,{signal}));
    }
    const timeline=await this.store.context(context.incident.id);
    for(const provider of ['github','gitlab'])if(clients[provider]) {
      const recent=releases(timeline.deployments).filter(x=>x.provider===provider&&x.at<=context.incident.started_at).slice(0,2);
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
  }
  async runOnce() {
    if(this.running)return false;
    this.running=true;let timer;let job;
    const controller=new AbortController();
    const deadline=setTimeout(()=>controller.abort(new Error('Investigation time budget exceeded')),120000);
    try {
      if((await this.store.restoreFence())?.active&&!this.restoreReadOnly)return false;
      job=await this.store.claim(this.owner,this.leaseMs);if(!job)return false;
      timer=setInterval(()=>this.store.heartbeat(this.owner,job.id,this.leaseMs).catch(error=>controller.abort(error)),Math.max(1000,this.leaseMs/3));
      const initial=await this.store.context(job.incident_id);
      await this.collect(initial,controller.signal);
      const context=await this.store.context(job.incident_id);
      context.riskScope=riskScope(context,this.services.find(x=>x.key===context.incident.service_key),await this.store.coordinationNow());
      const result=await this.reasoner.investigate(context,{question:job.payload.question,signal:controller.signal,persistRemote:state=>this.store.setRemoteState(job.incident_id,state,job)});
      result.analysis.incidentStatus=context.incident.status;
      if(controller.signal.aborted)throw controller.signal.reason;
      const service=this.services.find(x=>x.key===context.incident.service_key);
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
      if(reads.length||context.changeAssociations?.controls?.length){const message=associationText(context.changeAssociations);if(!result.analysis.text.includes(message))result.analysis.text+='\n\n'+message;}
      if(this.casework){const contacts=await this.casework.contacts(job.incident_id,{...context,assessmentStatus:{state:'current'},incident:{...context.incident,analysis:result.analysis}});result.analysis.contacts=contacts;if(contacts.contacts.length||contacts.unknowns.length)result.analysis.text+='\n\n'+contactsText(contacts);}
      const notice=assessmentBrief({...context,assessmentStatus:{state:'current'}},result.analysis);
      await this.store.finish(job,result.analysis,result.remoteState,Number(context.incident.revision),{text:notice,contactFormat:'brief'});
      return true;
    } catch(error) {
      if(job)await this.store.fail(job,error,error.retryable===false?1:3);
      else throw error;
      return false;
    } finally {clearInterval(timer);clearTimeout(deadline);this.running=false;}
  }
  async close() {await this.store.release(this.owner);}
}
