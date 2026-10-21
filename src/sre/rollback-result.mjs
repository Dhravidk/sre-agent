import { releases,deploymentBlockers } from './deployments.mjs';
import { hash } from './security.mjs';
import { proposalWorkflowRequest } from './workflow-contract.mjs';

export function verifyRollbackNoChange({incident,deployments,rollback},proof,service,now=Date.now()) {
  if(!rollback||!['dispatched','unknown'].includes(rollback.status))throw new Error('No-change verification requires a submitted or uncertain rollback');
  const proposal=JSON.parse(rollback.proposal),approvedAt=Number(rollback.approved_at),expiresAt=Number(rollback.expires_at);
  if(proof.kind!=='rollback_no_change'||proof.incidentId!==incident.id||proof.rollbackRequestId!==rollback.id||proposal.incidentId!==incident.id||proposal.serviceKey!==service.key||proposal.environment!==service.environment||proof.environment!==service.environment||proof.provider!==proposal.provider)throw new Error('No-change verification is outside the rollback scope');
  const repository=service[proposal.provider]||{},base=repository.base||(proposal.provider==='github'?'https://api.github.com':null);
  if(proposal.tenant!==service.tenant||service.rollback?.provider!==proposal.provider||proposal.scope?.provider!==proposal.provider||proposal.scope.repository!==(repository.repository||repository.project)||proposal.scope.base!==base||proposal.scope.environment!==service.environment)throw new Error('No-change verification repository or tenant mapping changed');
  if(proof.terminal!==true||proof.deploymentStarted!==false||proof.outcome!=='blocked')throw new Error('Only a terminal workflow blocked before deployment can be reconciled without recovery');
  if(typeof proof.reason!=='string'||!proof.reason.trim()||proof.reason.length>1000)throw new Error('No-change verification requires a bounded rejection reason');
  if(rollback.approved_at==null||rollback.expires_at==null||!Number.isSafeInteger(approvedAt)||!Number.isSafeInteger(expiresAt)||approvedAt>=expiresAt||proof.requestHash!=='sha256:'+hash(proposalWorkflowRequest(proposal,{approvedAt,expiresAt})))throw new Error('No-change verification does not bind the exact approved workflow inputs');
  const runId=String(proof.runId??'');
  if(!/^[1-9]\d{0,24}$/.test(runId))throw new Error('A native workflow run or pipeline ID is required');
  const receipt=rollback.external_ref?JSON.parse(rollback.external_ref):null,knownRun=receipt?.workflowRunId??receipt?.pipelineId;
  if(knownRun!==undefined&&knownRun!==null&&String(knownRun)!==runId)throw new Error('No-change verification identifies a different native workflow');
  const maxAge=(service.verification?.maxAgeSeconds??180)*1000;
  if(!Number.isSafeInteger(proof.observedAt)||proof.observedAt>now||now-proof.observedAt>maxAge||proof.observedAt<approvedAt||proof.observedAt<Number(incident.updated_at))throw new Error('No-change verification is stale, future dated, or predates current incident evidence');
  if(typeof proof.evidenceUrl!=='string'||proof.evidenceUrl.length>4000)throw new Error('No-change verification evidence URL required');
  const url=new URL(proof.evidenceUrl);if(url.protocol!=='https:'||url.username||url.password)throw new Error('HTTPS no-change evidence without embedded credentials required');
  const current=releases(deployments)[0];
  if(!current||current.provider!==proposal.provider||current.environment!==service.environment||deploymentBlockers(deployments,current).length)throw new Error('No-change verification requires a settled current deployment ledger');
  if(proof.sha!==current.sha||!current.artifact||proof.artifact!==current.artifact||proof.deploymentAt!==current.at||proof.observedAt<current.at)throw new Error('No-change proof does not identify the actual recorded deployment');
  const id=current.deploymentId??current.id;
  if(id!==undefined&&id!==null&&String(proof.deploymentId)!==String(id))throw new Error('No-change proof identifies a different current deployment');
  return {...receipt,provider:proposal.provider,requestId:rollback.id,[proposal.provider==='github'?'workflowRunId':'pipelineId']:runId,noChangeVerified:true,verificationEvidenceUrl:proof.evidenceUrl};
}
