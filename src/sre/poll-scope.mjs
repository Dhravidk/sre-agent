import { hash } from './security.mjs';

export function pollScopeHash(service,source,monitor) {
  const name=monitor?'dynatrace':source,config=service[name]||{};
  const fields=['base','mode','transport','mcp','repository','project','entityId','cmdbCi','correlateDynatrace','logField','logValue','problemQuery','openProblemQuery'];
  const scope=Object.fromEntries(fields.filter(key=>config[key]!==undefined).map(key=>[key,config[key]]));
  if(config.closedStates)scope.closedStates=config.closedStates.map(String).sort();
  if(monitor)scope.monitor={id:monitor.id,name:monitor.name,selector:monitor.selector,operator:monitor.operator,threshold:monitor.threshold,unit:monitor.unit,consecutive:monitor.consecutive??3,maxSampleAgeSeconds:monitor.maxSampleAgeSeconds??180,maxSampleGapSeconds:monitor.maxSampleGapSeconds??180};
  // Discard cursors/health claims created before shared-clock coordination.
  return hash({coordinationPolicyVersion:1,...(['github','gitlab'].includes(source)?{trackedChangePolicyVersion:1}:{}),serviceKey:service.key,tenant:service.tenant,environment:service.environment,source,scope});
}
