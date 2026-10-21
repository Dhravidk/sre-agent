// Correlated tickets share an investigation, but retain independent lifecycle state.
export function sourceStateKey(event) {
  if(event.source==='alerts'){
    const {provider,alertId}=event.payload||{};
    if(!['datadog','dynatrace'].includes(provider)||typeof alertId!=='string'||!/^[A-Za-z0-9_.:/-]{1,150}$/.test(alertId))throw Error('Workflow alert state requires a provider and native alert ID');
    return 'alerts:'+provider+':'+alertId;
  }
  if(event.source!=='servicenow')return event.source;
  const id=event.payload?.sys_id;
  if(!/^[a-f0-9]{32}$/.test(id||''))throw new Error('ServiceNow source state requires its native sys_id');
  return 'servicenow:'+id;
}

export const staleSourceUpdate=(previous,event)=>previous&&(event.at<previous.at||(event.at===previous.at&&previous.status==='CLOSED'&&event.status==='OPEN'));
export const sourceState=event=>({at:event.at,status:event.status,source:event.source,...(event.source==='servicenow'?{sourceId:event.payload.sys_id}:{}),...(event.source==='alerts'?{observationHash:alertObservationHash(event)}:{})});
export const sameAlertObservation=(previous,event)=>event.source==='alerts'&&previous?.at===event.at&&previous.status===event.status&&previous.observationHash===alertObservationHash(event);

export function restoreServiceNowStates(legacy,events) {
  const states={};let covered=false;
  for(const event of events) {
    if(event.source!=='servicenow'||!Number.isFinite(event.at)||!Number.isFinite(event.startedAt??event.at)||(event.startedAt??event.at)>event.at||!['OPEN','CLOSED'].includes(event.status))throw new Error('Legacy ServiceNow state requires a valid durable source audit before startup');
    const key=sourceStateKey(event);
    if(!staleSourceUpdate(states[key],event))states[key]=sourceState(event);
    if(event.at===legacy.at&&event.status===legacy.status)covered=true;
  }
  if(!covered)throw new Error('Legacy ServiceNow state is missing its durable source audit; reconcile it before startup');
  return states;
}
import {alertObservationHash} from './runtime-problems.mjs';
