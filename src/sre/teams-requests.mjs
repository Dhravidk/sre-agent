import {assertText,hash,redact} from './security.mjs';
import {StorageError} from './database.mjs';
import {restoreSummary} from './restore-recovery.mjs';

const epoch=n=>Number.isSafeInteger(n)&&n>=0;
const digest=n=>typeof n==='string'&&/^[a-f0-9]{64}$/.test(n);
const incident=n=>n===null||typeof n==='string'&&/^inc_[a-f0-9]+$/.test(n);
const invalid=()=>new StorageError(Error('Invalid saved simulator Teams receipt or source records'));
const conflict=()=>Object.assign(Error('Teams request ID was reused with different content; use a new ID for a new message.'),{status:409});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const checksum=r=>hash([r.version,r.scopeHash,r.requestHash,r.requestedAt,r.ignored,r.eventId,r.incidentId,r.sourceHash,r.reason]);

export function simulationTeamsIdentity(scope,requestId){
 if(typeof requestId!=='string'||!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId))throw Object.assign(Error('A stable Teams request ID is required (1–200 letters, digits, dots, underscores, colons or hyphens)'),{status:400});
 for(const field of['serviceKey','tenant','baseConversationId','userId'])assertText(scope?.[field],'Teams request '+field,1024);
 if(!['personal','groupChat','channel'].includes(scope.conversationType))throw Object.assign(Error('Invalid Teams request conversation type'),{status:400});
 const keyHash=hash(['simulation-teams-request:v1',scope.serviceKey,scope.tenant,scope.baseConversationId,scope.conversationType,scope.userId,requestId]);
 // The pinned Teams SDK requires a non-zero numeric thread root. Keep the full
 // digest in decimal; converting through Number would discard identity bits.
 return {key:'simulation-teams-request:'+keyHash,activityId:(BigInt('0x'+keyHash)+1n).toString()};
}
async function validateSources(q,record,{eventId,externalId,scope,conversationId}){
 try{
  const [row]=await q('SELECT * FROM sre_events WHERE id=?',[eventId]),[command]=await q('SELECT * FROM sre_commands WHERE id=?',[eventId]);
  if(record.ignored){if(row||command)throw invalid();return null;}
  if(!row||!command)throw invalid();
  const event=JSON.parse(row.payload),message=event.payload,principal=message?.principal;
  if(record.eventId!==eventId||row.source!=='teams'||row.service_key!==scope.serviceKey||row.external_id!==externalId||row.kind!=='teams'||row.incident_id!==null||Number(row.occurred_at)!==record.requestedAt||row.body_hash!==record.sourceHash||hash(event)!==row.body_hash||event.id!==externalId||event.source!=='teams'||event.serviceKey!==scope.serviceKey||event.kind!=='teams'||event.at!==record.requestedAt||message?.at!==record.requestedAt||message.incidentId!==record.incidentId||message.serviceKey!==scope.serviceKey||message.conversationKey!==hash([scope.tenant,conversationId]).slice(0,32)||typeof message.addressed!=='boolean'||typeof message.displayName!=='string'||message.displayName.length>200||typeof message.text!=='string'||!principal||principal.verified!==true||principal.simulation!==true||principal.tenant!==scope.tenant||principal.userId!==scope.userId||principal.conversationId!==conversationId||command.id!==eventId||Number(command.created_at)!==Number(row.received_at)||!['pending','running','done','discarded'].includes(command.status)||hash(canonical(JSON.parse(command.payload)))!==hash(canonical(message)))throw invalid();
  return command;
 }catch(error){if(error instanceof StorageError)throw error;throw invalid();}
}

// Local simulator retries only. The checkpoint is private SQL metadata, not
// source/model evidence or action authority. It commits with command admission;
// ignored outcomes also remain stable through later joins and explicit retries.
function simulationRequest(store,{scope,requestId,request,conversationId}){
 if(!store.simulation)throw Object.assign(Error('Teams request receipts are only available in the local simulator'),{status:403});
 const {key,activityId}=simulationTeamsIdentity(scope,requestId);
 assertText(conversationId,'Teams receipt conversation',1024);assertText(request?.text,'Teams request text',4500);assertText(request?.displayName,'Teams request display name',2000);
 if(typeof request.addressed!=='boolean'||!incident(request.expectedIncidentId))throw Object.assign(Error('Invalid Teams request intent'),{status:400});
 const scopeHash=hash([scope.serviceKey,scope.tenant,scope.baseConversationId,scope.conversationType,scope.userId,conversationId]),requestHash=hash([scopeHash,request.text,request.addressed,request.displayName,request.expectedIncidentId]),externalId=hash([scope.tenant,conversationId]).slice(0,32)+':'+activityId,eventId=hash(['teams',scope.serviceKey,externalId]);
 return {key,activityId,scope,requestId,request,conversationId,scopeHash,requestHash,externalId,eventId};
}
function savedRecord(prior,{scopeHash,eventId}){
 let record;try{record=JSON.parse(prior.value);if(record.version!==1||record.scopeHash!==scopeHash||!digest(record.requestHash)||!epoch(record.requestedAt)||Number(prior.updated_at)!==record.requestedAt||typeof record.ignored!=='boolean'||!incident(record.incidentId)||record.eventId!==(record.ignored?null:eventId)||(record.ignored?record.sourceHash!==null:!digest(record.sourceHash))||!(record.reason===null||typeof record.reason==='string'&&record.reason.length<=1000)||record.checksum!==checksum(record))throw invalid();}catch(error){if(error instanceof StorageError)throw error;throw invalid();}
 return record;
}
export async function submitSimulationTeams(store,input,admit){
 const identity=simulationRequest(store,input),{key,activityId,scope,requestId,request,conversationId,scopeHash,requestHash,externalId,eventId}=identity;
 return store.db.transaction(async q=>{
  if(store.db.dialect==='postgres'){await q("SET LOCAL statement_timeout = '10s'");await q("SET LOCAL lock_timeout = '3s'");}
  const inserted=await q("INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,'{}',0) ON CONFLICT DO NOTHING RETURNING id",[key]);
  const [prior]=await q('SELECT value,updated_at FROM sre_checkpoints WHERE id=?'+(store.db.dialect==='postgres'?' FOR UPDATE':''),[key]);
  let record;const duplicate=inserted.length===0;
  if(duplicate){
   record=savedRecord(prior,identity);
   await validateSources(q,record,{eventId,externalId,scope,conversationId,request});
   if(record.requestHash!==requestHash)throw conflict();
  }else{
   const [orphan]=await q('SELECT id FROM sre_events WHERE id=?',[eventId]),[orphanCommand]=await q('SELECT id FROM sre_commands WHERE id=?',[eventId]);if(orphan||orphanCommand)throw invalid();
   const requestedAt=await store.coordinationNow(q),receipt=await admit({query:q,requestedAt,activityId});
   const ignored=receipt?.ignored===true;
   if(!receipt||!ignored&&(receipt.duplicate||receipt.eventId!==eventId||receipt.commandReceipt?.id!==eventId||receipt.commandReceipt?.conversationId!==conversationId||!incident(receipt.commandReceipt?.incidentId)))throw invalid();
   const [source]=ignored?[]:await q('SELECT body_hash FROM sre_events WHERE id=?',[eventId]);
   record={version:1,scopeHash,requestHash,requestedAt,ignored,eventId:ignored?null:eventId,incidentId:ignored?null:receipt.commandReceipt.incidentId,sourceHash:ignored?null:source?.body_hash,reason:ignored&&typeof receipt.reason==='string'?redact(receipt.reason).slice(0,1000):null};record.checksum=checksum(record);
   await validateSources(q,record,{eventId,externalId,scope,conversationId,request});
   await q('UPDATE sre_checkpoints SET value=?,updated_at=? WHERE id=?',[JSON.stringify(record),requestedAt,key]);
  }
  return {...(record.ignored?{ignored:true,...(record.reason?{reason:record.reason}:{})}:{eventId,incidentId:null,queued:0,commandReceipt:{version:1,id:eventId,incidentId:record.incidentId,conversationId}}),requestId,requestedAt:record.requestedAt,duplicate,commandQueued:record.ignored||duplicate?0:1,recovery:restoreSummary(await store.restoreFence(q))};
 });
}


// Observation only: use the same exact scoped body/ID as admission. A read
// cannot enqueue work, refresh a lease, retry delivery or release a restore.
export async function simulationTeamsStatus(store,input){
 const identity=simulationRequest(store,input),{key,scope,request,requestId,conversationId,eventId}=identity;
 return readOnlyTeams(store,async q=>{
  const [prior]=await q('SELECT value,updated_at FROM sre_checkpoints WHERE id=?',[key]);
  if(!prior)throw Object.assign(Error('This saved Teams request was not found. It may not have committed or may be missing from restored history; this read did not resend it.'),{status:404});
  const record=savedRecord(prior,identity),command=await validateSources(q,record,identity);if(record.requestHash!==identity.requestHash)throw conflict();
  return observeTeamsCommand(store,q,{scope,request,requestId,conversationId,eventId,record,command});
 });
}


export function readOnlyTeams(store,read){
 if(!store.simulation)throw Object.assign(Error('Saved instruction reads are only available in the local simulator'),{status:403});
 return store.db.transaction(async q=>{if(store.db.dialect==='postgres'){await q('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await q("SET LOCAL statement_timeout = '10s'");await q("SET LOCAL lock_timeout = '3s'");}return read(q);}).catch(error=>{if(error instanceof StorageError||[400,403,404,409].includes(error?.status))throw error;throw new StorageError(error);});
}
export async function observeTeamsCommand(store,q,{scope,request,requestId=null,conversationId,eventId,record,command}){
  const observedAt=await store.coordinationNow(q),conversationKey=hash([scope.tenant,conversationId]).slice(0,32);
  const [conversation]=await q('SELECT service_key,tenant_id,conversation_id,incident_id,enabled FROM sre_conversations WHERE id=?',[conversationKey]);
  if(conversation&&(conversation.service_key!==scope.serviceKey||conversation.tenant_id!==scope.tenant||conversation.conversation_id!==conversationId||!incident(conversation.incident_id)||![0,1].includes(Number(conversation.enabled))))throw invalid();
  let reply=null;
  if(command){
   const [row]=await q('SELECT id,incident_id,conversation_key,status,SUBSTR(text,1,12000) AS text,LENGTH(text) AS text_length,error,created_at FROM sre_outbox WHERE id=?',['command:'+eventId]);
   if(row){
    const joinTarget=request.addressed&&request.text.trim().match(/^join\s+(inc_[a-f0-9]+)\s*$/i)?.[1];
    if(row.conversation_key!==conversationKey||!incident(row.incident_id)||row.incident_id!==null&&row.incident_id!==record.incidentId&&row.incident_id!==joinTarget||!['pending','sending','sent','simulated','failed','unknown','discarded','held_restore'].includes(row.status)||!epoch(Number(row.created_at))||typeof row.text!=='string'||!Number.isSafeInteger(Number(row.text_length))||Number(row.text_length)<Array.from(row.text).length)throw invalid();
    const safe=redact(row.text);let excerpt=safe.slice(0,12000);if(/[\uD800-\uDBFF]$/.test(excerpt))excerpt=excerpt.slice(0,-1);
    reply={id:row.id,incidentId:row.incident_id,status:row.status,text:excerpt,truncated:Number(row.text_length)>12000||excerpt.length<safe.length,error:row.error?redact(String(row.error)).slice(0,1000):null,createdAt:Number(row.created_at)};
   }
  }
  const state=record.ignored?'ignored':command.status,leaseUntil=command?.status==='running'?Number(command.lease_until):null;
  if(state==='running'&&!epoch(leaseUntil))throw invalid();
  return {version:1,requestId,requestedAt:record.requestedAt,observedAt,eventId:record.eventId,ignored:record.ignored,commandReceipt:record.ignored?null:{version:1,id:eventId,incidentId:record.incidentId,conversationId},processing:{state,leaseExpired:state==='running'&&leaseUntil<=observedAt,error:record.ignored?record.reason:command.error?redact(String(command.error)).slice(0,1000):null},binding:{enabled:Boolean(conversation&&Number(conversation.enabled)===1),incidentId:conversation?.incident_id??null},reply,recovery:restoreSummary(await store.restoreFence(q))};
}

// Validate retained source and command without reconstructing a raw retry body.
// This proves original capture, not current conversation membership or action.
export function validateRecordedTeamsCommand(row,command){
 try{
  if(!row||!command)throw invalid();const event=JSON.parse(row.payload),message=event.payload,p=message?.principal;
  if(row.source!=='teams'||row.kind!=='teams'||row.incident_id!==null||!digest(row.id)||row.id!==hash(['teams',row.service_key,row.external_id])||!epoch(Number(row.occurred_at))||!epoch(Number(row.received_at))||hash(event)!==row.body_hash||event.id!==row.external_id||event.source!=='teams'||event.kind!=='teams'||event.serviceKey!==row.service_key||event.at!==Number(row.occurred_at)||message?.at!==event.at||message.serviceKey!==row.service_key||!incident(message.incidentId)||typeof message.text!=='string'||typeof message.displayName!=='string'||message.displayName.length>200||typeof message.addressed!=='boolean'||!p||p.verified!==true||p.simulation!==true||typeof p.tenant!=='string'||!p.tenant||typeof p.userId!=='string'||!p.userId||typeof p.conversationId!=='string'||!p.conversationId||message.conversationKey!==hash([p.tenant,p.conversationId]).slice(0,32)||!row.external_id.startsWith(message.conversationKey+':')||command.id!==row.id||Number(command.created_at)!==Number(row.received_at)||!['pending','running','done','discarded'].includes(command.status)||hash(canonical(JSON.parse(command.payload)))!==hash(canonical(message)))throw invalid();
  return {row,command,message};
 }catch(error){if(error instanceof StorageError)throw error;throw invalid();}
}
