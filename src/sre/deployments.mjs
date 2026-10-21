// A commit can be deployed repeatedly with different artifacts/configuration.
// Merge attestations only for the same deployment, never merely the same SHA.
export function deploymentKey(row) {
  const id=row.deploymentId??row.id;
  return JSON.stringify([row.provider,row.environment,id===undefined||id===null?['release',row.sha,row.at]:['deployment',String(id)]]);
}

export function deploymentHistory(deployments) {
  const grouped=new Map();
  for(const row of [...deployments].sort((a,b)=>a.at-b.at)) {
    const key=deploymentKey(row),prior=grouped.get(key);
    const conflict=prior&&(prior.sha!==row.sha||(prior.artifact&&row.artifact&&prior.artifact!==row.artifact));
    grouped.set(key,{...prior,...Object.fromEntries(Object.entries(row).filter(([,v])=>v!==undefined)),identityConflict:Boolean(prior?.identityConflict||conflict)});
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
