import {hash} from './security.mjs';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const scalar=value=>typeof value==='string'||typeof value==='number'?String(value):null;
export function problemIdentity(row){
  const content=row.content||{};
  if(row.source==='alerts')return ['datadog','dynatrace'].includes(content.provider)&&/^[A-Za-z0-9_.:/-]{1,150}$/.test(content.alertId||'')?JSON.stringify(['alerts',content.provider,content.alertId]):null;
  const native=content.problemId??content.ProblemID??content['event.id']??content.sys_id;
  return scalar(native)?JSON.stringify([row.source,scalar(native)]):null;
}
function normalizedMetrics(raw){
  const metrics=raw&&typeof raw==='object'&&!Array.isArray(raw)?{...raw}:raw;
  if(metrics&&typeof metrics==='object'&&!Array.isArray(metrics))for(const key of ['codes','violations'])if(Array.isArray(metrics[key])&&metrics[key].every(value=>typeof value==='string'))metrics[key]=[...new Set(metrics[key])].sort();
  return metrics;
}
function metricSignature(row){
  const content=row.content||{},metrics=normalizedMetrics(content.metrics??content.LabMetrics);
  return hash(canonical({metrics:metrics===undefined?'[missing metrics]':metrics,status:content.State??content.status??content.state??content['event.status']??null}));
}

// Equal source times do not order contradictory snapshots. Preserve variants
// until a strictly newer version, without using delivery IDs as a tie-breaker.
export function latestProblemSnapshots(rows,{fallback}={}){
  const groups=new Map(),unscoped=[];
  for(const row of rows){
    const key=problemIdentity(row)||fallback?.(row),at=Number(row.observed_at);
    if(!key||!Number.isSafeInteger(at)||at<0){unscoped.push(row);continue;}
    const prior=groups.get(key);if(!prior||at>prior.at)groups.set(key,{at,variants:new Map([[metricSignature(row),row]])});
    else if(at===prior.at&&!prior.variants.has(metricSignature(row)))prior.variants.set(metricSignature(row),row);
  }
  return {selected:[...unscoped,...[...groups.values()].flatMap(group=>[...group.variants.values()])],conflicts:[...groups].filter(([,group])=>group.variants.size>1).map(([key])=>key)};
}

export function alertObservationHash(event){
  const p=event.payload||{};
  return hash(canonical({provider:p.provider,alertId:p.alertId,groupKey:p.groupKey,title:p.title,metrics:normalizedMetrics(p.metrics),status:event.status,at:event.at,startedAt:event.startedAt,synthetic:p.synthetic===true}));
}
