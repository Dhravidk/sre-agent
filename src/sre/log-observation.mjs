import {hash} from './security.mjs';
import {StorageError} from './database.mjs';

// JSON object order is transport formatting. Array order and every retained
// value remain significant. This must not change hashes of events/approvals.
export function canonicalLogValue(value){
  if(Array.isArray(value))return value.map(canonicalLogValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalLogValue(value[key])]));
  return value;
}
export const logRecordHash=(source,record)=>hash([source,canonicalLogValue(record)]);
export const logSampleId=(source,serviceKey,ruleKey,record)=>hash([source,serviceKey,ruleKey,canonicalLogValue(record)]);
const timestamp=record=>typeof record.timestamp==='number'?record.timestamp:Date.parse(record.timestamp);
export function readLogSample(row){
  try{
    const value=JSON.parse(row.payload),record=value.record;
    if(typeof value.source!=='string'||!value.source||!record||typeof record!=='object'||Array.isArray(record)||typeof value.partial!=='boolean')throw Error();
    const scope={environment:record['deployment.environment']||record.environment,region:record['cloud.region']||record.region||'unknown',version:record['service.version']||record.sha||'unknown'},at=timestamp(record),canonicalId=logSampleId(value.source,row.service_key,row.rule_key,record);
    if(!Number.isSafeInteger(at)||at!==Number(row.observed_at)||hash(scope)!==row.scope_key||hash(canonicalLogValue(scope))!==hash(canonicalLogValue(value.scope))||![canonicalId,hash([value.source,row.service_key,row.rule_key,record])].includes(row.id))throw Error();
    return {value,canonicalId};
  }catch{throw new StorageError(Error('Invalid persisted log observation identity'));}
}

// Only derived counters are coalesced. Keep the first retained sample ID and
// raw representative so distinct legacy thresholds keep their source-event ID.
// Walk scoped, ordered batches; no new schema or global
// source-hash migration is required. Independent PostgreSQL readers serialize
// this repair with sample writes before evaluating their threshold.
export async function coalesceLogSamples(store,serviceKey,ruleKey){
  return store.db.transaction(async q=>{
    if((await store.restoreFence(q))?.active)return {ready:false};
    if(store.db.dialect==='postgres')await q('LOCK TABLE sre_log_samples IN SHARE ROW EXCLUSIVE MODE');
    if((await store.restoreFence(q))?.active)return {ready:false};
    let cursor=null,group=null,seen=new Map(),merged=0;
    for(;;){
      const where=cursor?' AND (scope_key>? OR (scope_key=? AND observed_at<?) OR (scope_key=? AND observed_at=? AND id>?))':'',args=[serviceKey,ruleKey,...(cursor?[cursor.scope_key,cursor.scope_key,Number(cursor.observed_at),cursor.scope_key,Number(cursor.observed_at),cursor.id]:[])];
      const rows=await q('SELECT * FROM sre_log_samples WHERE service_key=? AND rule_key=?'+where+' ORDER BY scope_key,observed_at DESC,id LIMIT 200',args);
      if(!rows.length)break;
      for(const row of rows){
        const currentGroup=JSON.stringify([row.scope_key,Number(row.observed_at)]);if(currentGroup!==group){group=currentGroup;seen=new Map();}
        const sample=readLogSample(row),prior=seen.get(sample.canonicalId);
        if(!prior){seen.set(sample.canonicalId,{row,value:sample.value});continue;}
        if(sample.value.partial&&!prior.value.partial){prior.value={...prior.value,partial:true};await q('UPDATE sre_log_samples SET payload=? WHERE id=?',[JSON.stringify(prior.value),prior.row.id]);}
        await q('DELETE FROM sre_log_samples WHERE id=?',[row.id]);merged++;
      }
      cursor=rows.at(-1);
    }
    return {ready:true,merged};
  });
}
