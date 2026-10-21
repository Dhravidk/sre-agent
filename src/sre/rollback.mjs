import { randomBytes, randomUUID } from 'node:crypto';
import { equalSecret, hash, redact } from './security.mjs';
import { releases, deploymentKey, deploymentBlockers } from './deployments.mjs';
import { rollbackDispatchContractVersion,approvalWindow } from './workflow-contract.mjs';
import { RequestNotSubmittedError } from './submission.mjs';
import { isSimulationMode } from './runtime-mode.mjs';
import {teamsConversationAllowed} from './teams-access.mjs';
export { releases } from './deployments.mjs';

const scope=service=>{
  const provider=service.rollback?.provider,repository=service[provider]||{};
  return {provider,base:repository.base||(provider==='github'?'https://api.github.com':null),repository:repository.repository||repository.project,environment:service.environment};
};
const policyHash=service=>hash({dispatchContractVersion:rollbackDispatchContractVersion,coordinationPolicyVersion:1,policy:service.rollback,scope:scope(service),tenant:service.tenant});

export function assessRollback(context,service,now=Date.now()) {
  const reasons=[];const policy=service.rollback||{};const analysis=context.incident.analysis||{};
  if(context.assessmentStatus&&context.assessmentStatus.state!=='current')reasons.push('A current audited assessment is required before proposing or dispatching a rollback.');
  if(context.recoveryFence?.active)reasons.push('Database restore reconciliation is holding outbound actions.');
  if(context.simulatedRollback)reasons.push('A rollback simulation for this incident already ran. Start a new synthetic incident to repeat the approval exercise.');
  if(!policy.enabled)reasons.push('Rollback execution is not configured for this service.');
  if(context.incident.status==='resolved')reasons.push('The incident is already resolved.');
  if(analysis.changeAssessment!=='likely')reasons.push('The investigation has not established a likely deployment-related regression.');
  const all=releases(context.deployments);
  const current=all.find(x=>x.provider===policy.provider);
  const maxAge=(policy.maxAgeHours||24)*3600000;
  const maxTargetAge=(policy.maxTargetAgeHours||24)*3600000;
  if(!current)reasons.push('No successful deployment is recorded for the configured provider.');
  if(current && (now-current.at>maxAge || current.at>context.incident.started_at || context.incident.started_at-current.at>maxAge))reasons.push('The deployed change is too old or happened after the incident began. Reverting long-lived feature history is not an eligible rollback.');
  if(current && analysis.candidateSha!==current.sha)reasons.push('The suspected commit is not the currently recorded deployment.');
  if(current)reasons.push(...deploymentBlockers(context.deployments,current));
  const target=all.find(x=>x.provider===policy.provider && x.sha!==current?.sha && x.at<current?.at && x.healthy===true && Number.isFinite(x.healthVerifiedAt) && x.healthVerifiedAt>=x.at && x.healthVerifiedAt<=context.incident.started_at && now-x.healthVerifiedAt<=maxTargetAge && now-x.at<=maxTargetAge);
  if(!target)reasons.push('No recent, independently verified healthy artifact is available.');
  if(target?.identityConflict)reasons.push('The target deployment has conflicting SHA or artifact metadata.');
  for(const [name,release] of [['current',current],['target',target]]) {
    if(release&&(!Number.isSafeInteger(release.at)||release.at<0))reasons.push('The '+name+' deployment lacks a valid epoch-millisecond timestamp.');
    if(release && !/^(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(release.artifact||''))reasons.push('The '+name+' release lacks an immutable artifact digest.');
    if(release && release.environment!==service.environment)reasons.push('The '+name+' release belongs to a different environment.');
  }
  if(current && (current.rollbackCompatible!==true || current.dataRollbackSafe!==true))reasons.push('Backward compatibility and data safety have not both been verified.');
  if(current&&target) {
    for(const field of ['schemaVersion','dependencyFingerprint','configurationFingerprint','featureFlagsFingerprint']) {
      if(current[field]===undefined || target[field]===undefined || current[field]!==target[field])reasons.push(field+' is missing or differs between releases.');
    }
  }
  const runtimeEvidence=context.evidence.filter(x=>x.kind==='problem' && !x.content?.reviewOnly && x.source!=='github' && x.source!=='gitlab');
  if(!runtimeEvidence.length)reasons.push('A code review alone is not evidence of a runtime regression.');
  if(!Array.isArray(analysis.evidenceIds)||!runtimeEvidence.some(x=>analysis.evidenceIds.includes(x.id)))reasons.push('The rollback hypothesis does not cite runtime evidence from this incident.');
  return {eligible:reasons.length===0,reasons,current,target,alternative:'Investigate a scoped feature flag, traffic isolation, dependency recovery, or a forward fix. Preserve and reconcile affected auction transactions.'};
}

export class Rollbacks {
  constructor({store,services,connectors,mode='local'}) {if(!['local','trial','connected'].includes(mode))throw new Error('Invalid rollback runtime mode');Object.assign(this,{store,services,connectors,mode});this.simulation=isSimulationMode(mode);}
  service(key) {const s=this.services.find(x=>x.key===key);if(!s)throw new Error('Unknown service');return s;}
  authorize(principal,service,{approve=false}={}) {
    if(!principal?.verified || principal.tenant!==service.teams.tenantId || !teamsConversationAllowed(service.teams,principal.rootConversationId||principal.conversationId))throw new Error('Teams identity or conversation is not authorized');
    if(approve && (!service.teams.approvers.includes(principal.userId)||!service.teams.conversations.includes(principal.rootConversationId||principal.conversationId)))throw new Error('This Teams user or conversation is not an authorized rollback approver');
    if(this.mode==='connected' && principal.simulation)throw new Error('Playground identities cannot approve connected rollbacks');
  }
  async propose(incidentId,principal,{requestId}={}) {
    const context=await this.store.context(incidentId);const service=this.service(context.incident.service_key);
    this.authorize(principal,service);
    const id='rb_'+(requestId?hash(requestId).slice(0,32):randomUUID());
    const [existing]=await this.store.db.query('SELECT proposal,status,expires_at FROM sre_rollbacks WHERE id=?',[id]);
    if(existing) {
      const prior=JSON.parse(existing.proposal);
      return {eligible:existing.status==='pending',id,expiresAt:Number(existing.expires_at),text:prior.approvalText};
    }
    const now=await this.store.coordinationNow();
    const assessment=assessRollback(context,service,now);
    if(!assessment.eligible)return {eligible:false,text:'Rollback is unsuitable:\n'+assessment.reasons.map(x=>'- '+x).join('\n')+'\n'+assessment.alternative};
    const nonce=randomBytes(12).toString('hex');
    const proposal={id,incidentId,serviceKey:service.key,environment:service.environment,provider:service.rollback.provider,scope:scope(service),current:assessment.current,target:assessment.target,conversationId:principal.conversationId,tenant:principal.tenant,policyHash:policyHash(service),simulation:this.simulation};
    const expires=now+(service.rollback.approvalMinutes||10)*60000;
    proposal.approvalText=[proposal.simulation?'LOCAL SIMULATION — no deployment will be changed.':'Rollback approval required',service.name+' / '+service.environment,'Current commit: '+proposal.current.sha,'Current deployment: '+(proposal.current.deploymentId??proposal.current.id??'release attestation')+' at '+new Date(proposal.current.at).toISOString(),'Current artifact: '+proposal.current.artifact,'Target commit: '+proposal.target.sha,'Target artifact: '+proposal.target.artifact,'This redeploys the artifact; it does not undo or repair auction transactions.','Expires: '+new Date(expires).toISOString(),'Approval must remain valid when deployment begins; an expired queued request needs a new proposal.','An authorized approver must send: approve '+id+' '+nonce].join('\n');
    await this.store.db.query(`INSERT INTO sre_rollbacks(id,incident_id,proposal,nonce_hash,expires_at,status,created_at) VALUES(?,?,?,?,?,'pending',?) ON CONFLICT DO NOTHING`,[id,incidentId,JSON.stringify(proposal),hash(nonce),expires,now]);
    return {eligible:true,id,expiresAt:expires,text:proposal.approvalText};
  }
  async approve(id,nonce,principal) {
    return this.store.db.transaction(async(q)=>{
      if((await this.store.restoreFence(q))?.active)throw new Error('Database restore reconciliation is holding approvals');
      const [row]=await q('SELECT * FROM sre_rollbacks WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[id]);
      if(!row)throw new Error('Unknown rollback proposal');
      const proposal=JSON.parse(row.proposal);const service=this.service(proposal.serviceKey);
      this.authorize(principal,service,{approve:true});
      if(principal.conversationId!==proposal.conversationId || principal.tenant!==proposal.tenant)throw new Error('Approve in the conversation where the proposal was requested');
      if(row.status!=='pending')throw new Error('This proposal has already been handled');
      const now=await this.store.coordinationNow(q);
      if(Number(row.expires_at)<=now)throw new Error('Rollback proposal has expired');
      if(!equalSecret(hash(nonce),row.nonce_hash))throw new Error('Invalid approval nonce');
      if(proposal.policyHash!==policyHash(service))throw new Error('Rollback policy or repository scope changed; request a new proposal');
      await q("UPDATE sre_rollbacks SET status='approved',approved_by=?,approved_at=? WHERE id=?",[principal.userId,now,id]);
      return {id,status:'approved',text:'Approval recorded. The deployment and compatibility checks will run again before dispatch.'};
    });
  }
  async executeNext() {
    const owner=randomUUID();
    const row=await this.store.db.transaction(async(q)=>{
      if((await this.store.restoreFence(q))?.active)return null;
      const [next]=await q("SELECT * FROM sre_rollbacks WHERE status='approved' ORDER BY created_at LIMIT 1"+(this.store.db.dialect==='postgres'?' FOR UPDATE SKIP LOCKED':''));
      if(!next)return null;
      const now=await this.store.coordinationNow(q);
      const proposal=JSON.parse(next.proposal),lockScope='rollback:'+hash(proposal.scope||proposal.serviceKey),leaseUntil=now+180000;
      const lock=await q(`INSERT INTO sre_locks(name,owner,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE sre_locks.expires_at<=? RETURNING owner`,[lockScope,owner,leaseUntil,now]);
      if(!lock.length)return null;
      const result=await q("UPDATE sre_rollbacks SET status='checking',lease_until=? WHERE id=? AND status='approved' RETURNING id",[leaseUntil,next.id]);
      return result.length?{...next,lease_until:leaseUntil,scope:lockScope}:null;
    });
    if(!row)return false;
    const proposal=JSON.parse(row.proposal);const service=this.service(proposal.serviceKey);
    try {
      if(Number(row.expires_at)<=await this.store.coordinationNow()||proposal.policyHash!==policyHash(service))throw new Error('Proposal expired or policy/repository scope changed');
      if(!service.teams.approvers.includes(row.approved_by)||service.teams.tenantId!==proposal.tenant||!service.teams.conversations.includes(proposal.conversationId.split(';messageid=')[0]))throw new Error('The approver or conversation is no longer authorized');
      const outstanding=await this.store.db.query("SELECT proposal,status FROM sre_rollbacks WHERE id<>? AND status IN ('dispatching','dispatched','unknown','simulated')",[row.id]);
      if(this.simulation&&outstanding.some(x=>x.status==='simulated'&&JSON.parse(x.proposal).incidentId===row.incident_id))throw new Error('An earlier rollback simulation for this incident already ran. Start a new synthetic incident to replay the approval exercise.');
      if(outstanding.filter(x=>x.status!=='simulated').some(x=>{const prior=JSON.parse(x.proposal);return prior.serviceKey===service.key||(prior.scope&&hash(prior.scope)===hash(proposal.scope));}))throw new Error('An earlier rollback dispatch is unresolved; reconcile its deployment and health before another action.');
      const context=await this.store.context(row.incident_id);
      const check=assessRollback(context,service,await this.store.coordinationNow());
      if(!check.eligible || check.current.sha!==proposal.current.sha || check.current.artifact!==proposal.current.artifact || check.target.sha!==proposal.target.sha || check.target.artifact!==proposal.target.artifact)throw new Error('Rollback is stale or no longer eligible: '+check.reasons.join(' '));
      const clients=this.connectors.get(service.key);
      if(this.mode==='connected') {
        const live=await clients[proposal.provider].deployments(service.environment,{signal:AbortSignal.timeout(30000)});
        const latest=releases(live.items)[0];
        if(!live.complete || !latest || latest.environment!==service.environment || deploymentKey(latest)!==deploymentKey(proposal.current) || latest.sha!==proposal.current.sha || (latest.artifact&&latest.artifact!==proposal.current.artifact) || deploymentBlockers(live.items,latest).length)throw new Error('Current deployment changed, is unsettled, or could not be revalidated');
      }
      // Remote reads can outlast the lease or race a new incident/deployment.
      // Fence this exact attempt in the same transaction as the dispatch intent.
      await this.store.db.transaction(async q=>{
        if((await this.store.restoreFence(q))?.active)throw new Error('Database restore reconciliation is holding dispatch');
        const [lock]=await q('SELECT * FROM sre_locks WHERE name=?',[row.scope]);
        const [incident]=await q('SELECT revision FROM sre_incidents WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[row.incident_id]);
        const now=await this.store.coordinationNow(q);
        if(!lock||lock.owner!==owner||Number(lock.expires_at)<=now)throw new Error('Rollback execution lease expired or was lost');
        if(Number(incident.revision)!==context.incident.revision)throw new Error('Incident or deployment evidence changed during revalidation; request a fresh assessment');
        if(Number(row.expires_at)<=now||proposal.policyHash!==policyHash(service))throw new Error('Proposal expired or policy/repository scope changed during revalidation');
        if(!service.teams.approvers.includes(row.approved_by)||service.teams.tenantId!==proposal.tenant||!service.teams.conversations.includes(proposal.conversationId.split(';messageid=')[0]))throw new Error('The approver or conversation is no longer authorized');
        const changed=await q("UPDATE sre_rollbacks SET status='dispatching' WHERE id=? AND status='checking' AND lease_until=? AND lease_until>? RETURNING id",[row.id,row.lease_until,now]);
        if(!changed.length)throw new Error('Rollback execution lease expired or was lost');
      });
      // Once dispatch starts, never automatically retry an ambiguous result.
      const approval=approvalWindow({approvedAt:row.approved_at==null?undefined:Number(row.approved_at),expiresAt:row.expires_at==null?undefined:Number(row.expires_at)},await this.store.coordinationNow());
      if((await this.store.restoreFence())?.active)throw new RequestNotSubmittedError('Database restore reconciliation is holding dispatch');
      const receipt=this.simulation?{status:'simulated',requestId:row.id}:await clients.rollback.dispatch({...proposal,approval});
      await this.store.db.transaction(async q=>{
        const changed=await q("UPDATE sre_rollbacks SET status=?,external_ref=? WHERE id=? AND status IN ('dispatching','unknown') AND lease_until=? RETURNING id",[this.simulation?'simulated':'dispatched',JSON.stringify(receipt),row.id,row.lease_until]);
        if(changed.length)await this.store.queueMessage(row.incident_id,'Rollback '+(this.simulation?'simulated':'workflow dispatched')+' for '+service.name+'. Request '+row.id+'. This is not confirmation of recovery; wait for deployment completion and independent health verification.',null,'rollback:'+row.id+':'+(this.simulation?'simulated':'dispatched'),q);
      });
    } catch(error) {
      await this.store.db.transaction(async q=>{
        const [latest]=await q('SELECT status,lease_until FROM sre_rollbacks WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[row.id]);
        if(['checking','dispatching'].includes(latest?.status)&&Number(latest.lease_until)===row.lease_until) {
          const uncertain=latest.status==='dispatching'&&!(error instanceof RequestNotSubmittedError),status=uncertain?'unknown':'blocked',message=redact(String(error.message)).slice(0,2000);
          const changed=await q('UPDATE sre_rollbacks SET status=?,error=? WHERE id=? AND status=? AND lease_until=? RETURNING id',[status,message,row.id,latest.status,row.lease_until]);
          if(changed.length)await this.store.queueMessage(row.incident_id,'Rollback '+(uncertain?'dispatch outcome is unknown; reconcile the workflow before any retry.':'was blocked: '+message),null,'rollback:'+row.id+':'+status,q);
        }
      });
    } finally {
      await this.store.db.query('DELETE FROM sre_locks WHERE name=? AND owner=?',[row.scope,owner]);
    }
    return true;
  }
  async recoverInterrupted() {
    await this.store.db.transaction(async q=>{
      if((await this.store.restoreFence(q))?.active)return;
      const now=await this.store.coordinationNow(q);
      const interrupted=await q("UPDATE sre_rollbacks SET status='unknown',error='Dispatch lease expired; reconcile the workflow before retrying' WHERE status='dispatching' AND lease_until<=? RETURNING id,incident_id",[now]);
      for(const row of interrupted)await this.store.queueMessage(row.incident_id,'Rollback dispatch outcome is unknown; its execution lease expired. Reconcile request '+row.id+' with the workflow before any retry.',null,'rollback:'+row.id+':unknown',q);
      await q("UPDATE sre_rollbacks SET status='approved' WHERE status='checking' AND lease_until<=?",[await this.store.coordinationNow(q)]);
    });
  }
}
