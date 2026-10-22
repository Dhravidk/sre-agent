import {hash,redact,assertText} from './security.mjs';
import {StorageError} from './database.mjs';

const source='dynatrace-logs';
const epoch=value=>Number.isSafeInteger(value)&&value>=0;
function retained(row,serviceKey){
 try{
  const event=JSON.parse(row.payload);
  if(!event||Object.keys(event).sort().join(',')!=='at,id,kind,payload,serviceKey,source'||event.source!==source||event.serviceKey!==serviceKey||event.kind!=='log'||event.id!==row.external_id||!epoch(event.at)||event.at!==Number(row.occurred_at)||hash(event)!==row.body_hash||hash([source,serviceKey,event.id])!==row.id)throw Error();
  return event;
 }catch{throw new StorageError(Error('Invalid retained log read receipt'));}
}

// The source receipt and its first timestamp are admitted in the same inbox
// transaction. Exact replays keep the stored event; changed completeness or
// metadata is a different receipt. Global event/approval hashing is unchanged.
export function submitLogRead(store,{serviceKey,logs,until},admit){
 assertText(serviceKey,'log read service',512);
 if(!logs||typeof logs!=='object'||Array.isArray(logs)||!Array.isArray(logs.records)||logs.records.length>500||typeof logs.complete!=='boolean'||!epoch(until))throw Error('Invalid bounded log read receipt');
 // Match ingestion's redaction depth, including its enclosing payload field.
 const payload=redact({payload:logs}).payload,id=hash(['log-read-receipt-v1',payload]),legacyId=hash(logs.records),lock=hash([source,serviceKey,id]);
 return store.db.transaction(async query=>{
  if(store.db.dialect==='postgres')await query('SELECT pg_advisory_xact_lock(?::integer,?::integer)',[Number.parseInt(lock.slice(0,8),16)|0,Number.parseInt(lock.slice(8,16),16)|0]);
  const now=await store.coordinationNow(query);if(until>now)throw Error('Log read observation time is in the future');
  const rows=await query('SELECT id,external_id,occurred_at,body_hash,payload FROM sre_events WHERE source=? AND service_key=? AND external_id IN (?,?)',[source,serviceKey,id,legacyId]);
  const saved=rows.map(row=>({row,event:retained(row,serviceKey)}));
  const current=saved.find(item=>item.row.external_id===id);
  if(current&&hash(current.event.payload)!==hash(payload))throw new StorageError(Error('Retained log read receipt disagrees with its identity'));
  const matching=current||saved.find(item=>hash(item.event.payload)===hash(payload));
  if(matching)return admit(query,matching.event);
  const times=logs.records.map(record=>typeof record?.timestamp==='number'?record.timestamp:typeof record?.timestamp==='string'?Date.parse(record.timestamp):NaN).filter(value=>epoch(value)&&value<=until);
  // Missing source time uses the first query observation time, never a moving
  // overlap cursor. The transaction lock also fences simultaneous first reads.
  const event={id,source,serviceKey,kind:'log',at:times.length?Math.max(...times):until,payload};
  return admit(query,event);
 });
}
