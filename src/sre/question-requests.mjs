import {assertText,hash,redact} from './security.mjs';
import {StorageError} from './database.mjs';
import {restoreSummary} from './restore-recovery.mjs';
import {lockServiceObservations} from './initial-evidence.mjs';

const epoch=n=>Number.isSafeInteger(n)&&n>=0;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const invalid=()=>new StorageError(Error('Invalid saved operator-question receipt or source records'));
const checksum=r=>hash([r.version,r.serviceKey,r.incidentId,r.eventId,r.requestedAt,r.requestHash,r.sourceHash]);
const conflict=()=>Object.assign(Error('Question request ID was reused with different content; use a new ID for a new question.'),{status:409});

async function validateSources(q,record,externalId){
 try{
  const [row]=await q('SELECT * FROM sre_events WHERE id=?',[record.eventId]);
  if(!row)throw invalid();
  const event=JSON.parse(row.payload),expected=hash(['operator-api',record.serviceKey,externalId]);
  if(record.eventId!==expected||row.source!=='operator-api'||row.service_key!==record.serviceKey||row.kind!=='question'||row.external_id!==externalId||row.incident_id!==record.incidentId||Number(row.occurred_at)!==record.requestedAt||row.body_hash!==record.sourceHash||hash(event)!==row.body_hash||event.id!==externalId||event.source!=='operator-api'||event.serviceKey!==record.serviceKey||event.incidentId!==record.incidentId||event.kind!=='question'||event.at!==record.requestedAt||typeof event.payload?.text!=='string')throw invalid();
  const [evidence]=await q('SELECT incident_id,source,kind,observed_at,content FROM sre_evidence WHERE id=?',[hash([record.eventId,record.incidentId])]);
  const [job]=await q('SELECT incident_id,payload,created_at FROM sre_jobs WHERE id=?',[hash(['investigate',record.eventId,record.incidentId])]);
  const payload=job&&JSON.parse(job.payload);
  if(!evidence||evidence.incident_id!==record.incidentId||evidence.source!=='operator-api'||evidence.kind!=='question'||Number(evidence.observed_at)!==record.requestedAt||JSON.parse(evidence.content).text!==event.payload.text||!job||job.incident_id!==record.incidentId||payload.eventId!==record.eventId||payload.question!==event.payload.text||Number(job.created_at)!==Number(row.received_at))throw invalid();
  return event;
 }catch(error){if(error instanceof StorageError)throw error;throw invalid();}
}

// The receipt is durable SQL metadata, outside model/source snapshots. A retry
// confirms the original question; it cannot refresh its time, revive its job,
// release restore holds or authorize any action.
export async function submitOperatorQuestion(store,{incidentId,text,requestId},apply){
 assertText(incidentId,'incident ID',200);assertText(text,'question',4000);
 if(typeof requestId!=='string'||!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId))throw Error('A stable question request ID is required (1–200 letters, digits, dots, underscores, colons or hyphens)');
 return store.db.transaction(async q=>{
  if(store.db.dialect==='postgres'){await q("SET LOCAL statement_timeout = '10s'");await q("SET LOCAL lock_timeout = '3s'");}
  const [scope]=await q('SELECT service_key FROM sre_incidents WHERE id=?',[incidentId]);
  if(scope)await lockServiceObservations(store,q,scope.service_key);
  const [incident]=await q('SELECT id,service_key FROM sre_incidents WHERE id=?'+(store.db.dialect==='postgres'?' FOR UPDATE':''),[incidentId]);
  if(!incident||!store.services.some(service=>service.key===incident.service_key))throw Object.assign(Error('Incident service is not configured'),{status:404});
  if(incident.service_key!==scope.service_key)throw Object.assign(Error('Incident service changed during question admission; retry the request.'),{status:409});
  const serviceKey=incident.service_key,keyHash=hash(['operator-question:v1',serviceKey,incidentId,requestId]),key='operator-question-request:'+keyHash,externalId='operator-question:'+keyHash,eventId=hash(['operator-api',serviceKey,externalId]),requestHash=hash([serviceKey,incidentId,text]);
  const [prior]=await q('SELECT value,updated_at FROM sre_checkpoints WHERE id=?',[key]);let record,duplicate=false;
  if(prior){
   try{record=JSON.parse(prior.value);if(record.version!==1||record.serviceKey!==serviceKey||record.incidentId!==incidentId||record.eventId!==eventId||!epoch(record.requestedAt)||Number(prior.updated_at)!==record.requestedAt||!digest(record.requestHash)||!digest(record.sourceHash)||record.checksum!==checksum(record))throw invalid();}catch(error){if(error instanceof StorageError)throw error;throw invalid();}
   const event=await validateSources(q,record,externalId);
   if(record.requestHash!==requestHash)throw conflict();
   if(event.payload.text!==redact(text))throw invalid();
   duplicate=true;
  }else{
   const [orphan]=await q('SELECT id FROM sre_events WHERE id=?',[eventId]);if(orphan)throw invalid();
   const requestedAt=await store.coordinationNow(q),event={id:externalId,source:'operator-api',serviceKey,incidentId,kind:'question',at:requestedAt,payload:{text}};
   const result=await apply(q,event);if(result.duplicate||result.incidentId!==incidentId)throw invalid();
   record={version:1,serviceKey,incidentId,eventId,requestedAt,requestHash,sourceHash:hash(redact(event))};record.checksum=checksum(record);
   await validateSources(q,record,externalId);
   await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?)',[key,JSON.stringify(record),requestedAt]);
  }
  return {eventId,incidentId,requestId,requestedAt:record.requestedAt,jobId:hash(['investigate',eventId,incidentId]),queued:duplicate?0:1,duplicate,recovery:restoreSummary(await store.restoreFence(q))};
 });
}
