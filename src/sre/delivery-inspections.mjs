import {hash,redact,assertText} from './security.mjs';
import {StorageError} from './database.mjs';
const failure=(status,message)=>Object.assign(Error(message),{status});
const kinds=['prepared','outcome','late'],eligible=status=>['unknown','failed'].includes(status),same=(a,b)=>'('+a+'='+b+' OR ('+a+' IS NULL AND '+b+' IS NULL))';
export function preparedDeliveryRecipient(row,prepared){
 const key=prepared.conversationKey;
 if(key===undefined)return null; // Older retained v1 records may omit it.
 if(typeof key!=='string'||!/^[a-f0-9]{32}$/.test(key)||row.conversation_key&&row.conversation_key!==key)throw new StorageError(Error('Invalid prepared delivery recipient'));
 return key;
}
const factsFrom=(row,raw,restoreId,scope)=>({outboxId:row.id,scope,status:row.status,attempt:Number(row.attempts),originalHash:hash(row.text),text:row.text,error:row.error??null,remoteId:row.remote_id??null,conversationKey:row.conversation_key??null,incidentId:row.incident_id??null,createdAt:Number(row.created_at),preparedValue:raw.prepared??null,outcomeValue:raw.outcome??null,lateValue:raw.late??null,restoreId:restoreId??null});
export function handledDeliveryInspectionSql(alias='o'){
 const joins='LEFT JOIN sre_incidents scope_incident ON scope_incident.id='+alias+'.incident_id LEFT JOIN sre_conversations scope_room ON scope_room.id='+alias+'.conversation_key '+kinds.map(kind=>'LEFT JOIN sre_checkpoints '+kind+" ON "+kind+".id='teams-delivery:"+kind+":'||"+alias+".id||':'||CAST("+alias+'.attempts AS TEXT)').join(' ');
 const matches=[['status_snapshot','status'],['text_snapshot','text'],['error_snapshot','error'],['remote_id_snapshot','remote_id'],['conversation_key_snapshot','conversation_key'],['incident_id_snapshot','incident_id']].map(([field,column])=>same('review.'+field,alias+'.'+column));
 matches.push(same('review.service_key','COALESCE(scope_incident.service_key,scope_room.service_key)'),same('review.tenant_id_snapshot','scope_room.tenant_id'),same('review.conversation_service_snapshot','scope_room.service_key'));
 return 'EXISTS(SELECT 1 FROM sre_delivery_inspections review '+joins+' WHERE review.outbox_id='+alias+".id AND review.follow_up='handled' AND review.attempts_snapshot="+alias+'.attempts AND review.created_at_snapshot='+alias+'.created_at AND '+matches.join(' AND ')+' AND '+kinds.map(kind=>same('review.'+kind+'_snapshot',kind+'.value')).join(' AND ')+' AND '+"review.restore_id IS NOT DISTINCT FROM ?"+' AND NOT EXISTS(SELECT 1 FROM sre_delivery_inspections newer WHERE newer.outbox_id=review.outbox_id AND newer.generation>review.generation))';
}
function inspection(row,factsHash,restoreId,latestId){
 try{
  const references=JSON.parse(row.references_json);
  if(!Array.isArray(references)||!['observed','not_found','inconclusive'].includes(row.finding)||!['required','handled'].includes(row.follow_up)||!Number.isSafeInteger(Number(row.generation))||Number(row.generation)<1)throw Error();
  return {id:row.id,generation:Number(row.generation),requestId:row.request_id,actor:{kind:row.actor_kind,id:row.actor_id},finding:row.finding,followUp:row.follow_up,reason:row.reason,observedAt:Number(row.observed_at),recordedAt:Number(row.recorded_at),references,current:row.id===latestId&&row.facts_hash===factsHash&&(row.restore_id??null)===(restoreId??null),historicalAfterRestore:(row.restore_id??null)!==(restoreId??null)};
 }catch{throw new StorageError(Error('Invalid retained delivery inspection'));}
}
function parseFacts(row,raw){
 const facts={};
 for(const kind of kinds)if(raw[kind])try{const value=JSON.parse(raw[kind]);if(value.version!==1||value.outboxId!==row.id||value.incidentId!==row.incident_id||Number(value.attempt)!==Number(row.attempts)||value.originalHash!==hash(row.text))throw Error();if(kind==='prepared'){if(typeof value.text!=='string'||value.textHash!==hash(value.text))throw Error();preparedDeliveryRecipient(row,value);}facts[kind]=value;}catch{throw new StorageError(Error('Invalid delivery facts for inspection'));}
 return facts;
}
export async function projectDeliveryInspections(store,rows,deliveryRecords,restoreId){
 if(!rows.length)return;
 const ids=rows.map(row=>row.id),reviews=await store.db.query('SELECT review.*,COALESCE(i.service_key,c.service_key) AS current_service_key,c.tenant_id AS current_tenant_id,c.service_key AS current_conversation_service FROM sre_delivery_inspections review JOIN sre_outbox o ON o.id=review.outbox_id LEFT JOIN sre_incidents i ON i.id=o.incident_id LEFT JOIN sre_conversations c ON c.id=o.conversation_key WHERE review.outbox_id IN ('+ids.map(()=>'?').join(',')+') AND NOT EXISTS(SELECT 1 FROM sre_delivery_inspections newer WHERE newer.outbox_id=review.outbox_id AND newer.generation>review.generation)',ids),records=new Map(deliveryRecords.map(row=>[row.id,row.value]));
 for(const row of rows){const review=reviews.find(review=>review.outbox_id===row.id);if(!review)continue;const raw=Object.fromEntries(kinds.map(kind=>[kind,records.get('teams-delivery:'+kind+':'+row.id+':'+row.attempts)||null])),facts=factsFrom(row,raw,restoreId,{serviceKey:review.current_service_key,tenantId:review.current_tenant_id??null,conversationServiceKey:review.current_conversation_service??null}),current=inspection(review,hash(facts),restoreId,review.id);row.deliveryInspection={...current,attentionRequired:eligible(row.status)&&(!current.current||current.followUp!=='handled')};}
}
export class DeliveryInspections{
 constructor({store,services}){Object.assign(this,{store,services});}
 async load(id,q=this.store.db.query,{lock=false}={}){
  if(typeof id!=='string'||!id||id.length>1024||/[\u0000-\u001f\u007f]/.test(id))throw failure(400,'Invalid delivery identity');
  const [row]=await q('SELECT * FROM sre_outbox WHERE id=?'+(lock&&this.store.db.dialect==='postgres'?' FOR UPDATE':''),[id]);if(!row)throw failure(404,'Delivery was not found');
  const [incident]=row.incident_id?await q('SELECT service_key FROM sre_incidents WHERE id=?',[row.incident_id]):[],[room]=row.conversation_key?await q('SELECT * FROM sre_conversations WHERE id=?',[row.conversation_key]):[];
  const service=this.services.find(service=>service.key===(incident?.service_key||room?.service_key));if(!service||row.incident_id&&!incident)throw failure(404,'Delivery has no configured service scope');
  if(room&&(room.service_key!==service.key||room.tenant_id!==service.teams.tenantId))throw failure(403,'Delivery conversation is outside its configured tenant and service');
  const fence=await this.store.restoreFence(q),keys=kinds.map(kind=>'teams-delivery:'+kind+':'+id+':'+row.attempts),values=await q('SELECT id,value FROM sre_checkpoints WHERE id IN (?,?,?)',keys),map=new Map(values.map(row=>[row.id,row.value]));
  const raw=Object.fromEntries(kinds.map((kind,i)=>[kind,map.get(keys[i])||null])),facts=factsFrom(row,raw,fence?.restoreId,{serviceKey:service.key,tenantId:room?.tenant_id??null,conversationServiceKey:room?.service_key??null}),parsed=parseFacts(row,raw),history=await q('SELECT * FROM sre_delivery_inspections WHERE outbox_id=? ORDER BY generation DESC LIMIT 21',[id]);
  return {row,service,room,fence,facts,parsed,factsHash:hash(facts),history};
 }
 project(context){
  const {row,room,service,fence,facts,parsed,factsHash,history}=context,latest=history[0],records=history.slice(0,20).map(record=>inspection(record,factsHash,facts.restoreId,latest?.id)),current=records[0]||null;
  return {inspectionVersion:1,message:{id:row.id,incidentId:row.incident_id,serviceKey:service.key,conversationKey:row.conversation_key,conversationId:room?.conversation_id||null,status:row.status,attempt:Number(row.attempts),text:row.text,error:row.error,createdAt:Number(row.created_at)},facts:{originalHash:facts.originalHash,prepared:parsed.prepared||null,outcome:parsed.outcome||null,late:parsed.late||null},reviewFingerprint:hash([factsHash,latest?.id||null,latest?.request_hash||null]),inspection:current,history:records,historyLimited:history.length>20,attentionRequired:eligible(row.status)&&(!current?.current||current.followUp!=='handled'),canRecord:eligible(row.status)&&!fence?.active,held:fence?.active===true,limits:'Operator observations and manual follow-up are reports. They do not change transport state, resend a message, grant an action, or establish recipient acknowledgement.'};
 }
 async view(id){return this.project(await this.load(id));}
 validate(input,actor){
  const allowed=new Set(['requestId','expectedFingerprint','finding','followUp','reason','observedAt','references']);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.has(key)))throw failure(400,'Use only delivery inspection fields');
  if(!actor||!['local-operator','operator-api'].includes(actor.kind))throw failure(403,'An operator credential is required for delivery inspection');assertText(actor.id,'operator credential identity',512);
  if(typeof input.requestId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId)||!/^[a-f0-9]{64}$/.test(input.expectedFingerprint||''))throw failure(400,'A request identity and reviewed fingerprint are required');
  if(!['observed','not_found','inconclusive'].includes(input.finding)||!['required','handled'].includes(input.followUp))throw failure(400,'Choose an observation and follow-up status');
  const reason=redact(assertText(input.reason,'inspection reason',2000).trim());if(reason.length<10)throw failure(400,'Describe the reviewed window and follow-up in at least ten characters');
  if(!Number.isSafeInteger(input.observedAt)||input.observedAt<0||!Array.isArray(input.references)||input.references.length>5||input.finding==='observed'&&!input.references.length)throw failure(400,'Include a bounded observation time and evidence references');
  const references=input.references.map(reference=>{try{assertText(reference,'inspection reference',1000);const url=new URL(reference);if(url.protocol!=='https:'||url.username||url.password||[...url.searchParams.keys()].some(key=>/token|secret|password|authorization/i.test(key)))throw Error();return url.href;}catch{throw failure(400,'Use HTTPS evidence links without credentials or token parameters');}});
  return {requestId:input.requestId,expectedFingerprint:input.expectedFingerprint,finding:input.finding,followUp:input.followUp,reason,observedAt:input.observedAt,references};
 }
 async record(id,input,actor){
  const body=this.validate(input,actor),requestHash=hash([body,actor]);
  const result=await this.store.db.transaction(async q=>{
   const context=await this.load(id,q,{lock:true}),view=this.project(context),prior=context.history.find(row=>row.request_id===body.requestId)||(await q('SELECT * FROM sre_delivery_inspections WHERE outbox_id=? AND request_id=?',[id,body.requestId]))[0];
   if(prior){if(prior.request_hash!==requestHash)throw failure(409,'Inspection request identity was reused with different content');return {id:prior.id,duplicate:true};}
   if(context.fence?.active)throw failure(409,'Delivery inspection is held during database restore reconciliation');
   if(!eligible(context.row.status))throw failure(409,'Only uncertain or failed deliveries need this inspection');
   if(view.reviewFingerprint!==body.expectedFingerprint)throw failure(409,'Delivery facts or a previous inspection changed. Review the current snapshot before recording follow-up');
   const now=await this.store.coordinationNow(q);if(body.observedAt>now||now-body.observedAt>600000||body.observedAt<Number(context.row.created_at))throw failure(400,'Use a fresh observation time after this message was queued');
   const generation=Number(context.history[0]?.generation||0)+1;if(!Number.isSafeInteger(generation))throw failure(409,'Delivery inspection history requires maintenance');
   const inspectionId='inspection_'+hash([id,body.requestId]),f=context.facts;
   await q('INSERT INTO sre_delivery_inspections(id,outbox_id,generation,request_id,request_hash,service_key,actor_kind,actor_id,finding,follow_up,reason,observed_at,recorded_at,restore_id,facts_hash,tenant_id_snapshot,conversation_service_snapshot,status_snapshot,attempts_snapshot,text_snapshot,error_snapshot,remote_id_snapshot,conversation_key_snapshot,incident_id_snapshot,created_at_snapshot,prepared_snapshot,outcome_snapshot,late_snapshot,references_json) VALUES('+Array(29).fill('?').join(',')+')',[inspectionId,id,generation,body.requestId,requestHash,context.service.key,actor.kind,actor.id,body.finding,body.followUp,body.reason,body.observedAt,now,f.restoreId,context.factsHash,f.scope.tenantId,f.scope.conversationServiceKey,f.status,f.attempt,f.text,f.error,f.remoteId,f.conversationKey,f.incidentId,f.createdAt,f.preparedValue,f.outcomeValue,f.lateValue,JSON.stringify(body.references)]);
   return {id:inspectionId,duplicate:false};
  });
  const view=await this.view(id);return {...view,duplicate:result.duplicate,recordedInspectionId:result.id};
 }
}
