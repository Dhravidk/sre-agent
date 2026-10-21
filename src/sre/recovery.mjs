import { releases, deploymentBlockers } from './deployments.mjs';

export function verifyRecovery(context,proof,service,now=Date.now()) {
  const {incident,deployments}=context;
  if(incident.status!=='verifying')throw new Error('Recovery requires all incident sources to close first');
  if(proof?.incidentId!==incident.id||proof.environment!==service.environment||proof.healthy!==true)throw new Error('Invalid scoped health verification');
  if(proof.checks?.technical!==true||proof.checks?.businessInvariants!==true)throw new Error('Recovery requires technical health and business invariant checks');
  if(typeof proof.evidenceUrl!=='string'||proof.evidenceUrl.length>4000)throw new Error('Recovery evidence URL required');
  const evidenceUrl=new URL(proof.evidenceUrl);
  if(evidenceUrl.protocol!=='https:'||evidenceUrl.username||evidenceUrl.password)throw new Error('HTTPS recovery evidence URL without embedded credentials required');
  const maxAge=(service.verification?.maxAgeSeconds??180)*1000;
  if(!Number.isFinite(proof.observedAt)||proof.observedAt>now||now-proof.observedAt>maxAge||proof.observedAt<Number(incident.updated_at))throw new Error('Recovery evidence is stale, in the future, or predates source closure');
  const current=releases(deployments)[0];
  if(!current||current.environment!==service.environment||deploymentBlockers(deployments,current).length)throw new Error('Recovery deployment is missing or unsettled');
  if(!current.artifact||proof.artifact!==current.artifact||proof.sha!==current.sha||proof.deploymentAt!==current.at||proof.observedAt<current.at)throw new Error('Recovery evidence does not identify the current deployed artifact');
  const id=current.deploymentId??current.id;
  if(id!==undefined&&id!==null&&String(proof.deploymentId)!==String(id))throw new Error('Recovery evidence does not identify the current deployment');
  return current;
}
