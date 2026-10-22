import {randomUUID} from 'node:crypto';
import {toThreadedConversationId} from '@microsoft/teams.apps';
import {StorageError} from './database.mjs';
import {hash,redact} from './security.mjs';
import {rootConversation} from './collaboration.mjs';
import {teamsConversationAllowed} from './teams-access.mjs';
import {readContactMessage,boundTeamsText} from './contact-messages.mjs';
import {routeWaitReason,routeWaitDelayMs,alertConversationId} from './teams-routing.mjs';
import {retireObsoleteAlertFailure} from './alert-replies.mjs';

export const teamsDeliveryDefaults=Object.freeze({timeoutMs:15000,maxInFlight:4});
const leaseMs=90000,scopeSql="COALESCE(o.conversation_key,'incident:'||o.incident_id,'message:'||o.id)";
const statusOf=error=>Number(error?.status||error?.statusCode||error?.response?.status)||null;
const safeError=error=>redact(String(error?.message||'Teams transport failed')).slice(0,1000);
const remoteId=receipt=>typeof receipt?.id==='string'?receipt.id.slice(0,1000):null;
const save=(q,id,value,at)=>q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',[id,JSON.stringify(value),at]);
function retryAt(error,now){
 const header=error?.response?.headers?.['retry-after']??error?.headers?.['retry-after'];
 if(typeof header==='string'||typeof header==='number'){
  const value=String(header).trim();
  if(/^\d+$/.test(value)){const until=now+Number(value)*1000;if(Number.isSafeInteger(until))return until;}
  const at=Date.parse(value);if(Number.isSafeInteger(at))return Math.max(now,at);
 }
 return now+30000;
}

// This bounds transport work only. Incident investigation/dispatch concurrency
// is unchanged. A timed-out underlying promise keeps its reservation until it
// settles, so an adapter that ignores cancellation cannot grow an unbounded pool.
export class TeamsOutbox {
 constructor({store,services,sender,casework,timeoutMs=teamsDeliveryDefaults.timeoutMs,maxInFlight=teamsDeliveryDefaults.maxInFlight}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isSafeInteger(maxInFlight)||maxInFlight<1||maxInFlight>16)throw Error('Invalid Teams delivery timeout or capacity');
  Object.assign(this,{store,services,sender,casework,timeoutMs,maxInFlight});this.owner=randomUUID();this.calls=new Set();this.active=new Set();this.audits=new Set();this.closed=false;
 }
 capacity(){return this.closed?0:Math.max(0,this.maxInFlight-this.calls.size);}
 deliveryState(){return {limit:this.maxInFlight,reserved:this.calls.size,unresolved:[...this.calls].filter(call=>call.submitted&&!call.settled).length,timedOut:[...this.calls].filter(call=>call.interrupted&&!call.settled).length};}
 runOnce(){
  if(!this.capacity())return Promise.resolve(false);
  const call={controller:new AbortController(),gates:[],finished:false,settled:false,submitted:false};this.calls.add(call);
  call.finalized=new Promise(resolve=>call.finalize=resolve);
  const task=this.run(call).finally(async()=>{call.finished=true;call.finalize();if(!call.submitted||call.settled){await this.releaseGates(call);this.calls.delete(call);}});
  this.active.add(task);task.then(()=>this.active.delete(task),()=>this.active.delete(task));return task;
 }
 async gate(q,call,scope,now){
  const name='teams-outbox:'+scope,owner=hash([this.owner,call.message?.id||null,randomUUID()]);
  const rows=await q('INSERT INTO sre_locks(name,owner,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE sre_locks.expires_at<=? RETURNING owner',[name,owner,now+leaseMs,now]);
  if(!rows.length)return false;call.gates.push({name,owner});return true;
 }
 async releaseGates(call){
  if(call.releasing)return call.releasing;
  call.releasing=(async()=>{for(const gate of call.gates)await this.store.db.query('DELETE FROM sre_locks WHERE name=? AND owner=?',[gate.name,gate.owner]);call.gates=[];})();
  try{await call.releasing;}finally{call.releasing=null;}
 }
 async claim(call){
  return this.store.db.transaction(async q=>{
   if(this.closed||(await this.store.restoreFence(q))?.active)return null;
   const now=await this.store.coordinationNow(q),busy=[...this.calls].filter(other=>other!==call&&other.scope).map(other=>other.scope);
   // Availability only prioritizes work. The selected recipient still passes
   // the full tenant/audience/installation checks immediately before sending.
   const roots=this.services.filter(service=>alertConversationId(service.teams)).map(service=>[service.key,service.teams.tenantId,alertConversationId(service.teams)]);
   const fallback=roots.length?' OR (ready.incident_id IS NULL AND ('+roots.map(()=>'(ready.service_key=? AND ready.tenant_id=? AND ready.conversation_id=?)').join(' OR ')+'))':'';
   const ready="o.conversation_key IS NOT NULL OR EXISTS(SELECT 1 FROM sre_conversations ready JOIN sre_incidents incident ON incident.id=o.incident_id AND incident.service_key=ready.service_key WHERE ready.enabled=1 AND (ready.incident_id=o.incident_id"+fallback+'))';
   const [row]=await q("SELECT o.* FROM sre_outbox o WHERE o.status='pending' AND o.next_at<=? AND NOT EXISTS(SELECT 1 FROM sre_locks l WHERE l.name='teams-outbox:'||"+scopeSql+" AND l.expires_at>?) AND NOT EXISTS(SELECT 1 FROM sre_outbox earlier WHERE earlier.status='pending' AND COALESCE(earlier.conversation_key,'incident:'||earlier.incident_id,'message:'||earlier.id)="+scopeSql+" AND (earlier.created_at<o.created_at OR (earlier.created_at=o.created_at AND earlier.id<o.id)))"+(busy.length?' AND '+scopeSql+' NOT IN ('+busy.map(()=>'?').join(',')+')':'')+' ORDER BY CASE WHEN o.error=? THEN 2 WHEN '+ready+' THEN 0 ELSE 1 END,o.created_at,o.id LIMIT 1',[now,now,...busy,routeWaitReason,...roots.flat()]);
   if(!row)return null;
   call.message=row;call.scope=row.conversation_key||(row.incident_id?'incident:'+row.incident_id:'message:'+row.id);
   if(!await this.gate(q,call,call.scope,now))return null;
   const [claimed]=await q("UPDATE sre_outbox SET status='sending',lease_owner=?,lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending' AND next_at<=? RETURNING *",[this.owner,now+leaseMs,row.id,now]);
   return claimed||null;
  });
 }
 async mark(message,status,error,{nextAt,remote,disable=false}={}){
  return this.store.db.transaction(async q=>{
   const now=await this.store.coordinationNow(q);
   const rows=await q("UPDATE sre_outbox SET status=?,next_at=?,remote_id=?,error=?,lease_owner=NULL WHERE id=? AND lease_owner=? AND status='sending' AND attempts=? RETURNING id",[status,nextAt??now,remote??null,error??null,message.id,this.owner,Number(message.attempts)]);
   if(rows.length&&disable)await q('UPDATE sre_conversations SET enabled=0 WHERE id=?',[message.conversation_key]);return rows.length>0;
  });
 }
 async prepare(call,conversation,text){
  const message=call.message;
  return this.store.db.transaction(async q=>{
   if((await this.store.restoreFence(q))?.active)return null;
   if(message.incident_id)await q('SELECT id FROM sre_incidents WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[message.incident_id]);
   const [owned]=await q('SELECT * FROM sre_outbox WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[message.id]),now=await this.store.coordinationNow(q);
   if(owned?.status!=='sending'||owned.lease_owner!==this.owner||Number(owned.attempts)!==Number(message.attempts))return null;
   if(Number(owned.lease_until)<=now){await q("UPDATE sre_outbox SET status='unknown',error='Delivery claim expired before transport; inspect before retrying',lease_owner=NULL WHERE id=? AND lease_owner=?",[message.id,this.owner]);return null;}
   if(await this.rateLimitRejections(q,message)>=4){await q("UPDATE sre_outbox SET status='failed',error='Teams rate-limit retry budget exhausted; inspect before another request',lease_owner=NULL WHERE id=? AND lease_owner=?",[message.id,this.owner]);return null;}
   const [room]=await q('SELECT * FROM sre_conversations WHERE id=? AND enabled=1',[conversation.id]);const service=this.services.find(s=>s.key===room?.service_key);
   if(!room||!service||service.teams.tenantId!==room.tenant_id||!teamsConversationAllowed(service.teams,room.conversation_id))throw Error('Conversation access was revoked');
   if(message.incident_id){await this.store.authorizeIncidentConversation(room.id,message.incident_id,q);if(message.conversation_key&&room.incident_id!==message.incident_id)throw Error('Conversation no longer follows this incident');}
   if(await retireObsoleteAlertFailure(this.store,q,message,room,owned))return null;
   const prepared={version:1,outboxId:message.id,incidentId:message.incident_id,conversationKey:room.id,attempt:Number(message.attempts),preparedAt:now,timeoutMs:this.timeoutMs,claimLeaseUntil:Number(owned.lease_until),originalHash:hash(message.text),text,textHash:hash(text)};
   await save(q,'teams-delivery:prepared:'+message.id+':'+message.attempts,prepared,now);
   if(Number(owned.lease_until)<=await this.store.coordinationNow(q)){await q("UPDATE sre_outbox SET status='unknown',error='Delivery claim expired while preparing transport; inspect before retrying',lease_owner=NULL WHERE id=? AND lease_owner=?",[message.id,this.owner]);return null;}
   return {prepared,room,reference:JSON.parse(room.reference)};
  });
 }
 async late(call,outcome){
  if(this.closed)return;
  const message=call.message,at=await this.store.coordinationNow(),fact={version:1,outboxId:message.id,incidentId:message.incident_id,attempt:Number(message.attempts),observedAt:at,originalHash:hash(message.text),kind:outcome.kind,remoteId:outcome.kind==='receipt'?remoteId(outcome.receipt):null,httpStatus:outcome.kind==='error'?statusOf(outcome.error):null,...(outcome.kind==='error'?{error:safeError(outcome.error)}:{})};
  await this.store.db.transaction(async q=>{
   // Serialize late facts with operator inspection of this exact delivery.
   await q('SELECT id FROM sre_outbox WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[message.id]);
   await save(q,'teams-delivery:late:'+message.id+':'+message.attempts,fact,at);
  });
 }
 async rateLimitRejections(q,message){
  const prefix='teams-delivery:outcome:'+message.id+':',pattern=prefix.replace(/[!%_]/g,character=>'!'+character)+'%';
  const rows=await q("SELECT id,value FROM sre_checkpoints WHERE id LIKE ? ESCAPE '!' ORDER BY id LIMIT 5",[pattern]);
  let count=0;
  for(const row of rows){
   let fact;try{fact=JSON.parse(row.value);if(fact.version!==1||fact.outboxId!==message.id||fact.incidentId!==message.incident_id||fact.originalHash!==hash(message.text)||!Number.isSafeInteger(fact.attempt)||fact.attempt<1||fact.attempt>=Number(message.attempts)||row.id!==prefix+fact.attempt||!['receipt','error'].includes(fact.kind))throw Error();}catch{throw new StorageError(Error('Invalid Teams delivery outcome history'));}
   if(fact.kind==='error'&&fact.httpStatus===429)count++;
  }
  if(rows.length>4)throw new StorageError(Error('Teams delivery outcome history exceeds its retry budget'));
  return count;
 }
 async outcome(call,outcome){
  const message=call.message;
  return this.store.db.transaction(async q=>{
   const now=await this.store.coordinationNow(q),fence=await this.store.restoreFence(q),[row]=await q('SELECT * FROM sre_outbox WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[message.id]);
   const owned=row?.status==='sending'&&row.lease_owner===this.owner&&Number(row.attempts)===Number(message.attempts),current=owned&&Number(row.lease_until)>now&&!fence?.active;
   if(!current){if(owned)await q("UPDATE sre_outbox SET status='unknown',error='Delivery receipt arrived after its claim expired; inspect the retained late evidence',lease_owner=NULL WHERE id=? AND lease_owner=?",[message.id,this.owner]);call.interrupted=true;return {late:true};}
   const httpStatus=outcome.kind==='error'?statusOf(outcome.error):null,accepted=outcome.kind==='receipt',rejections=httpStatus===429?1+await this.rateLimitRejections(q,message):0,retry=httpStatus===429&&rejections<4,terminal=[401,403,404].includes(httpStatus);
   const status=accepted?(outcome.receipt?.simulation===true&&this.store.simulation?'simulated':'sent'):retry?'pending':terminal||httpStatus===429?'failed':'unknown';
   const error=accepted?null:httpStatus===429&&!retry?'Teams rate-limit retry budget exhausted; inspect before another request':safeError(outcome.error);
   const fact={version:1,outboxId:message.id,incidentId:message.incident_id,attempt:Number(message.attempts),observedAt:now,originalHash:hash(message.text),kind:outcome.kind,status,httpStatus,remoteId:accepted?remoteId(outcome.receipt):null,...(httpStatus===429?{rateLimitRejections:rejections}:{})};
   await save(q,'teams-delivery:outcome:'+message.id+':'+message.attempts,fact,now);
   await q('UPDATE sre_outbox SET status=?,next_at=?,remote_id=?,error=?,lease_owner=NULL WHERE id=? AND lease_owner=? AND status=\'sending\' AND attempts=?',[status,retry?retryAt(outcome.error,now):now,fact.remoteId,error,message.id,this.owner,Number(message.attempts)]);
   if(terminal)await q('UPDATE sre_conversations SET enabled=0 WHERE id=?',[call.prepared.room.id]);return {accepted};
  });
 }
 async send(call){
  const {reference,prepared}=call.prepared,message=call.message;
  if(this.closed||call.controller.signal.aborted){await this.mark(message,'pending','Delivery stopped before transport began');return;}
  call.submitted=true;
  const transport=Promise.resolve().then(()=>this.sender.send(reference,prepared.text,{signal:call.controller.signal})).then(receipt=>({kind:'receipt',receipt}),error=>({kind:'error',error}));
  transport.then(outcome=>{call.settled=true;const audit=(async()=>{await call.finalized;if(this.closed)return;if(call.interrupted)await this.late(call,outcome);await this.releaseGates(call);this.calls.delete(call);})();this.audits.add(audit);audit.then(()=>this.audits.delete(audit),error=>{this.audits.delete(audit);this.auditError=safeError(error);});});
  let timer;const interrupted=new Promise(resolve=>{call.controller.signal.addEventListener('abort',()=>resolve({kind:'interrupted'}),{once:true});timer=setTimeout(()=>{call.interrupted=true;call.controller.abort();},this.timeoutMs);});
  try{
   const result=await Promise.race([transport,interrupted]);
   clearTimeout(timer);
   if(result.kind==='interrupted'||call.interrupted){call.interrupted=true;await this.mark(message,'unknown',this.closed?'Agent stopped while Teams delivery was in flight; inspect before retrying':'Teams send timed out; delivery may have occurred. Inspect before retrying');return;}
   const committed=await this.outcome(call,result);if(committed.late)call.interrupted=true;
   if(committed.accepted&&message.incident_id&&!call.prepared.room.incident_id&&reference.conversation.conversationType==='channel'&&result.receipt.id){
    const thread={...reference,conversation:{...reference.conversation,id:toThreadedConversationId(rootConversation(reference.conversation.id),result.receipt.id)}};
    const key=await this.store.rememberConversation({tenant:call.prepared.room.tenant_id,reference:thread,serviceKey:call.prepared.room.service_key,incidentId:message.incident_id});await this.store.bindConversation(key,message.incident_id);
   }
  }finally{clearTimeout(timer);}
 }
 async run(call){
  try{
   if((await this.store.restoreFence())?.active)return false;
   await this.store.db.query("UPDATE sre_outbox SET status='unknown',error='Delivery lease expired; inspect the conversation before retrying',lease_owner=NULL WHERE status='sending' AND lease_until<=?",[await this.store.coordinationNow()]);
   if(!this.sender||this.closed)return false;
   const message=await this.claim(call);if(!message)return false;call.message=message;
   let conversation;
   if(message.conversation_key)[conversation]=await this.store.db.query('SELECT * FROM sre_conversations WHERE id=? AND enabled=1',[message.conversation_key]);
   else if(message.incident_id){const targets=await this.store.messageTargets(message.incident_id);if(targets.length>1){await this.store.db.transaction(async q=>{
    if((await this.store.restoreFence(q))?.active)return;
    await q('SELECT id FROM sre_incidents WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[message.incident_id]);
    const [owned]=await q('SELECT status,lease_owner,lease_until,attempts FROM sre_outbox WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[message.id]),now=await this.store.coordinationNow(q);
    if(owned?.status!=='sending'||owned.lease_owner!==this.owner||Number(owned.attempts)!==Number(message.attempts))return;
    if(Number(owned.lease_until)<=now){await q("UPDATE sre_outbox SET status='unknown',error='Delivery claim expired before routing; inspect before retrying',lease_owner=NULL WHERE id=? AND lease_owner=?",[message.id,this.owner]);return;}
    const current=await this.store.messageTargets(message.incident_id,null,q);if(!current.length){await q("UPDATE sre_outbox SET status='pending',next_at=?,error=?,lease_owner=NULL WHERE id=? AND lease_owner=?",[now+routeWaitDelayMs(message.attempts),routeWaitReason,message.id,this.owner]);return;}
    const provenance=await readContactMessage(q,message);for(const target of current)await this.store.queueMessage(message.incident_id,message.text,target.id,message.id+':'+target.id,q,{contacts:provenance?.contacts,contactFormat:provenance?.format??'full'});
    await q("UPDATE sre_outbox SET status='routed',lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND status='sending'",[message.id,this.owner]);
   });return true;}conversation=targets[0];}
   if(!conversation){if(message.conversation_key){const [removed]=await this.store.db.query('SELECT enabled FROM sre_conversations WHERE id=?',[message.conversation_key]);if(removed&&Number(removed.enabled)!==1){await this.mark(message,'discarded','Conversation installation was removed');return true;}}await this.mark(message,'pending',routeWaitReason,{nextAt:await this.store.coordinationNow()+routeWaitDelayMs(message.attempts)});return false;}
   if(call.scope!==conversation.id){const acquired=await this.store.db.transaction(async q=>this.gate(q,call,conversation.id,await this.store.coordinationNow(q)));if(!acquired){await this.mark(message,'pending','Another send to this conversation is in progress',{nextAt:await this.store.coordinationNow()+1000});return false;}call.scope=conversation.id;}
   const service=this.services.find(s=>s.key===conversation.service_key);
   if(!service||service.teams.tenantId!==conversation.tenant_id||!teamsConversationAllowed(service.teams,conversation.conversation_id)){await this.mark(message,'discarded','Conversation access was revoked');return true;}
   if(message.incident_id){if(message.conversation_key&&conversation.incident_id!==message.incident_id){await this.mark(message,'discarded','Conversation no longer follows this incident');return true;}try{await this.store.authorizeIncidentConversation(conversation.id,message.incident_id);}catch(error){if(error instanceof StorageError)throw error;await this.mark(message,'discarded',safeError(error));return true;}}
   if(!this.casework&&await readContactMessage(this.store.db.query,message))throw Error('Contact delivery requires its casework preflight');
   const text=this.casework?await this.casework.contactDelivery(message,this.owner,conversation):boundTeamsText(message.text);if(text===null)return false;
   call.prepared=await this.prepare(call,conversation,text);if(!call.prepared)return false;await this.send(call);return true;
  }catch(error){if(call.submitted)call.interrupted=true;if(call.message)await this.mark(call.message,'unknown',safeError(error));else throw error;return true;}
 }
 async drainSettled(){await new Promise(resolve=>setImmediate(resolve));await Promise.allSettled([...this.audits]);}
 async close(){this.closed=true;for(const call of this.calls){call.interrupted=call.submitted;call.controller.abort();}await Promise.allSettled([...this.active]);await this.drainSettled();for(const call of this.calls)if(call.settled||!call.submitted){await this.releaseGates(call);this.calls.delete(call);}}
}
