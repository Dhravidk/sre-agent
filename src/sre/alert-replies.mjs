import {hash,redact} from './security.mjs';
import {StorageError} from './database.mjs';
import {briefText} from './contact-messages.mjs';

const checkpointId=(incidentId,conversationKey)=>'alert-thread-reply:'+hash([incidentId,conversationKey]);
const unavailableId=value=>'alert-thread-unavailable:'+hash([value.incidentId,value.conversationKey,value.eventId]);
const supersededReason=id=>'Unsent investigation failure notice superseded by a completed result; replacement reply '+id;
const save=(q,id,value,now)=>q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[id,JSON.stringify(value),now]);
class AlertReplyIntegrityError extends StorageError {}
const invalid=()=>new AlertReplyIntegrityError(Error('Stored workflow-thread reply is inconsistent'));

// An addressed reply belongs to the incident/thread, rather than the lifetime
// of one investigation attempt. Keep it in the existing transactional store.
export async function rememberAlertReply(q,{incidentId,conversationKey,eventId,now}) {
  await save(q,checkpointId(incidentId,conversationKey),{version:1,incidentId,conversationKey,eventId,createdAt:now,status:'pending'},now);
}

export async function readAlertReplies(q,incidentId,targets) {
  const replies=new Map();
  for(const target of targets.filter(room=>room.incident_id===incidentId)) {
    const id=checkpointId(incidentId,target.id),[row]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[id]);
    if(!row)continue;let value;
    try{value=JSON.parse(row.value);}catch{throw invalid();}
    if(value?.version!==1||value.incidentId!==incidentId||value.conversationKey!==target.id||!['pending','queued','cancelled'].includes(value.status)||!Number.isSafeInteger(value.createdAt)||value.createdAt<0)throw invalid();
    if(value.status!=='cancelled') {
      if(!/^[a-f0-9]{64}$/.test(value.eventId||''))throw invalid();
      const [source]=await q("SELECT t.created_at,e.service_key FROM sre_alert_threads t JOIN sre_events e ON e.id=t.event_id AND e.incident_id=t.incident_id WHERE t.event_id=? AND t.incident_id=? AND t.conversation_key=? AND e.source='alerts' AND e.kind='problem'",[value.eventId,incidentId,target.id]);
      if(!source||source.service_key!==target.service_key||Number(source.created_at)!==value.createdAt)throw invalid();
      if(value.status==='queued') {
        if(typeof value.outboxId!=='string'||!Number.isSafeInteger(value.queuedAt)||value.queuedAt<0)throw invalid();
        const [outbox]=await q('SELECT incident_id,conversation_key FROM sre_outbox WHERE id=?',[value.outboxId]);
        if(!outbox||outbox.incident_id!==incidentId||outbox.conversation_key!==target.id)throw invalid();
      }
    }
    replies.set(target.id,{id,raw:row.value,value});
  }
  return replies;
}

export async function completeAlertReply(q,reply,outboxId,now) {
  if(reply?.value.status!=='pending')return;
  const [outbox]=await q('SELECT incident_id,conversation_key FROM sre_outbox WHERE id=?',[outboxId]);
  if(!outbox||outbox.incident_id!==reply.value.incidentId||outbox.conversation_key!==reply.value.conversationKey)throw invalid();
  const value={...reply.value,status:'queued',outboxId,queuedAt:now};
  const rows=await q('UPDATE sre_checkpoints SET value=?,updated_at=? WHERE id=? AND value=? RETURNING id',[JSON.stringify(value),now,reply.id,reply.raw]);
  if(rows.length!==1)throw invalid();
  // The result/obligation and retirement of still-queued feedback are atomic.
  // A claimed send may already have reached transport, so leave it alone here.
  await q("UPDATE sre_outbox SET status='discarded',error=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND incident_id=? AND conversation_key=? AND status='pending'",[supersededReason(outboxId),unavailableId(reply.value),reply.value.incidentId,reply.value.conversationKey]);
}

// Called only by the owning delivery preflight, before a transport preparation
// receipt is written. This closes the race where claim preceded result commit.
// Once preparation/transport begins the existing uncertain-send rules apply.
export async function retireObsoleteAlertFailure(store,q,message,room,owned) {
  if(!message.id.startsWith('alert-thread-unavailable:')||!message.incident_id||message.conversation_key!==room.id)return false;
  const reply=(await readAlertReplies(q,message.incident_id,[room])).get(room.id);
  if(!reply||unavailableId(reply.value)!==message.id||!['queued','cancelled'].includes(reply.value.status))return false;
  const expired=Number(owned.lease_until)<=await store.coordinationNow(q),reason=expired?'Delivery claim expired while checking workflow feedback; inspect before retrying':reply.value.status==='queued'?supersededReason(reply.value.outboxId):'Workflow alert reply was cancelled before failure notice transport preparation';
  await q("UPDATE sre_outbox SET status=?,error=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND incident_id=? AND conversation_key=? AND status='sending' AND lease_owner=? AND attempts=?",[expired?'unknown':'discarded',reason,message.id,message.incident_id,room.id,owned.lease_owner,Number(message.attempts)]);
  return true;
}

// An exhausted attempt is useful feedback, not the promised diagnosis. Queue
// at most one such notice for this pending incident/thread/source promise.
// Keep the promise pending for a later successful assessment; an uncertain
// notice delivery retains the ordinary outbox inspection boundary.
export async function queueAlertInvestigationFailure(store,q,job,error,now) {
  if((await store.restoreFence(q,{lock:true}))?.active)return;
  const [incident]=await q('SELECT service_key FROM sre_incidents WHERE id=?'+(store.db.dialect==='postgres'?' FOR UPDATE':''),[job.incident_id]);
  if(!incident||!store.services.some(service=>service.key===incident.service_key))return;
  const targets=await store.messageTargets(job.incident_id,null,q);
  for(const room of targets.filter(target=>target.incident_id===job.incident_id)) {
    let reply;try{reply=(await readAlertReplies(q,job.incident_id,[room])).get(room.id);}catch(error){if(error instanceof AlertReplyIntegrityError)continue;throw error;}
    // A corrupt ancillary promise cannot authorize a notice or prevent the
    // failed job audit. Actual storage failures still roll back this write.
    if(reply?.value.status!=='pending')continue;
    const id=unavailableId(reply.value);
    const [prior]=await q('SELECT id FROM sre_outbox WHERE id=?',[id]);
    if(prior)continue;
    const text=['Investigation needs attention · '+job.incident_id,
      'This attempt exhausted its investigation retries without completing a fresh assessment. The diagnosis reply for this workflow alert is still pending.',
      'Failure observed '+new Date(now).toISOString()+' · job '+job.id+' · attempt '+job.attempts+'.',
      'Last attempt error (excerpt, not a diagnosis): '+briefText(redact(String(error?.message||error||'Investigation failed')),240),
      'Inspect the saved failure and evidence in the incident console. After correcting the cause, an authorized responder can @mention the agent with: retry '+job.incident_id+' '+job.id+' <reason>.',
      'A later successful investigation can answer this alert. Retrying investigation does not approve a deployment or retry an uncertain delivery.'].join('\n');
    await store.queueMessage(job.incident_id,text,room.id,id,q);
  }
}

export async function cancelAlertReply(q,incidentId,conversationKey,now,reason) {
  const id=checkpointId(incidentId,conversationKey),[row]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[id]);
  if(!row)return;let prior;try{prior=JSON.parse(row.value);}catch{}
  if(prior?.status==='queued'||prior?.status==='cancelled')return;
  // Revocation must still work if an ancillary reply receipt is damaged.
  await save(q,id,{version:1,incidentId,conversationKey,eventId:/^[a-f0-9]{64}$/.test(prior?.eventId||'')?prior.eventId:null,createdAt:Number.isSafeInteger(prior?.createdAt)&&prior.createdAt>=0?prior.createdAt:now,status:'cancelled',cancelledAt:now,reason,previousHash:hash(row.value)},now);
}
