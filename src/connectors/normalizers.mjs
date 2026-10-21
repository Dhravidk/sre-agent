// Endpoint authentication happens before normalization. Never trust these fields for authorization.
export function normalizeDynatrace(payload,{tenant,service,environment}) {
  if(!payload.ProblemID || !['OPEN','CLOSED'].includes(payload.State)) throw new Error('Invalid configured Dynatrace webhook payload');
  const at=Date.parse(payload.ObservedAt);
  if(!Number.isFinite(at)) throw new Error('ObservedAt must be an ISO timestamp');
  return {id:payload.EventID||payload.ProblemID+':'+payload.State+':'+payload.ObservedAt,source:'dynatrace',tenant,service,environment,type:'problem',problemId:payload.ProblemID,status:payload.State,at,metrics:payload.LabMetrics||{}};
}
export function normalizeGitLabDeployment(payload,{tenant,service,environment,artifact,sha,rollbackCompatible=false}) {
  if(payload.object_kind!=='deployment' || !['success','failed'].includes(payload.status)) throw new Error('Unsupported GitLab deployment event');
  if(payload.environment!==environment) throw new Error('Unmapped deployment environment');
  if(!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Resolve full deployment SHA before ingesting');
  const at=Date.parse(payload.status_changed_at);
  if(!Number.isFinite(at)) throw new Error('Invalid deployment timestamp');
  return {id:String(payload.deployment_id)+':'+payload.status+':'+payload.status_changed_at,source:'gitlab',tenant,service,environment,type:'deployment',at,status:payload.status,sha,artifact,rollbackCompatible,healthy:false};
}
