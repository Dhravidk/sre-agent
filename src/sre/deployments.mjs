// A commit can be deployed repeatedly with different artifacts/configuration.
// Merge attestations only for the same deployment, never merely the same SHA.
import {isDeepStrictEqual} from 'node:util';

export const deploymentAttestationFields=Object.freeze(['healthy','healthVerifiedAt','rollbackCompatible','dataRollbackSafe','schemaVersion','dependencyFingerprint','configurationFingerprint','featureFlagsFingerprint','rollbackRequestId']);

export function deploymentKey(row) {
  const id=row.deploymentId??row.id;
  return JSON.stringify([row.provider,row.environment,id===undefined||id===null?['release',row.sha,row.at]:['deployment',String(id)]]);
}

export function deploymentHistory(deployments) {
  const grouped=new Map(),attestations=new Map();
  for(const row of [...deployments].sort((a,b)=>a.at-b.at)) {
    const key=deploymentKey(row),prior=grouped.get(key);
    const fields=attestations.get(key)||new Map();attestations.set(key,fields);
    for(const field of deploymentAttestationFields)if(row[field]!==undefined){
      const old=fields.get(field);
      if(!old||row.at>old.at)fields.set(field,{at:row.at,value:row[field],conflict:false});
      else if(row.at===old.at&&!isDeepStrictEqual(old.value,row[field]))old.conflict=true;
    }
    // Host projections carry conflict time separately from a later status-only
    // observation. Only a newer explicit value for that field can reconcile it.
    for(const item of Array.isArray(row.attestationConflicts)?row.attestationConflicts:[])if(item&&deploymentAttestationFields.includes(item.field)&&Number.isSafeInteger(item.at)&&item.at>=0){
      const old=fields.get(item.field);if(!old||item.at>old.at)fields.set(item.field,{at:item.at,conflict:true});else if(item.at===old.at)old.conflict=true;
    }
    const conflict=prior&&(prior.sha!==row.sha||(prior.artifact&&row.artifact&&prior.artifact!==row.artifact));
    const statusConflict=Boolean(row.statusConflict||prior&&row.at===prior.at&&(prior.statusConflict||row.status!==prior.status));
    const merged={...prior,...Object.fromEntries(Object.entries(row).filter(([,v])=>v!==undefined)),identityConflict:Boolean(row.identityConflict||prior?.identityConflict||conflict),...(row.historyIncomplete||prior?.historyIncomplete?{historyIncomplete:true}:{})};
    if(statusConflict)merged.statusConflict=true;else delete merged.statusConflict;
    grouped.set(key,merged);
  }
  for(const[key,row]of grouped){
    const conflicts=deploymentAttestationFields.filter(field=>attestations.get(key).get(field)?.conflict).map(field=>({field,at:attestations.get(key).get(field).at}));
    delete row.attestationConflicts;
    if(conflicts.length){row.attestationConflicts=conflicts;for(const {field}of conflicts)delete row[field];}
  }
  return [...grouped.values()].sort((a,b)=>b.at-a.at);
}

export function releases(deployments) {
  return deploymentHistory(deployments.filter(row=>row.status==='success'&&row.sha));
}

export function deploymentBlockers(deployments,current) {
  if(!current)return ['No successful deployment is recorded.'];
  const history=deploymentHistory(deployments);
  const blockers=[];
  if(current.identityConflict)blockers.push('Conflicting SHA or artifact metadata identifies the same deployment.');
  if(current.statusConflict)blockers.push('Conflicting deployment statuses share the latest source observation time; reconcile the actual running state.');
  if(current.attestationConflicts?.length)blockers.push('Conflicting deployment attestations require newer explicit evidence for: '+current.attestationConflicts.map(item=>item.field).join(', ')+'.');
  if(current.historyIncomplete)blockers.push('The current deployment history is incomplete or its identity/scope is unverified; reconcile the deployment first.');
  if(history.some(row=>row.historyIncomplete&&row.at>=current.at))blockers.push('A later deployment observation has incomplete identity history; reconcile the actual running version first.');
  if(history.some(row=>row.statusConflict&&row.at>=current.at))blockers.push('A current or later deployment has conflicting status observations.');
  if(history.some(row=>row.attestationConflicts?.length&&row.at>=current.at))blockers.push('A current or later deployment has unresolved health or compatibility attestations.');
  if(history.some(row=>row.status!=='success'&&row.status!=='inactive'&&row.at>=current.at))blockers.push('A later deployment failed, is still in progress, or has unknown status; reconcile the actual running version first.');
  if(history.some(row=>row.status==='inactive'&&deploymentKey(row)===deploymentKey(current)))blockers.push('The recorded deployment is inactive; reconcile the actual running version first.');
  if(history.some(row=>row.status==='success'&&row.at>=current.at&&deploymentKey(row)!==deploymentKey(current)&&(row.provider!==current.provider||row.sha!==current.sha||row.artifact!==current.artifact)))blockers.push('Conflicting deployments make the current runtime identity ambiguous.');
  return blockers;
}

export function githubDeploymentStatus(state) {
  if(state==='success')return 'success';
  if(state==='failure'||state==='error')return 'failed';
  if(state==='inactive')return 'inactive';
  if(['pending','queued','in_progress'].includes(state))return 'pending';
  return 'unknown';
}

export function gitlabDeploymentStatus(state) {
  if(state==='success')return 'success';
  if(state==='failed'||state==='canceled')return 'failed';
  if(['created','running','blocked'].includes(state))return 'pending';
  return 'unknown';
}
