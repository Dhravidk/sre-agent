import {hash,equalSecret} from './security.mjs';
import {StorageError} from './database.mjs';

const lock=store=>store.db.dialect==='postgres'?' FOR UPDATE':'';
const epoch=value=>Number.isSafeInteger(value)&&value>=0;
const identity=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const corrupt=()=>new StorageError(Error('Invalid retained QA approval provenance'));
const review=()=>Error('Yes cannot identify a delivered, reviewed QA proposal for this message. Use the exact approve-fix command from the proposal.');

// The command claim is host metadata. Approval timestamps come from the
// immutable admitted activity, never from model text or caller-supplied dates.
export async function qaApprovalCommand(store,q,command,principal,conversationKey,{bareYes,id,nonce}){
  if(!command)return null;
  if(!identity(command.id)||!epoch(command.leaseUntil))throw Error('Invalid QA command claim');
  const [row]=await q('SELECT * FROM sre_commands WHERE id=?'+lock(store),[command.id]);
  const claim={...command};await assertQaCommandClaim(store,q,claim,row);
  const [source]=await q('SELECT * FROM sre_events WHERE id=?',[command.id]);
  let event,message;
  try{
    event=JSON.parse(source?.payload);message=JSON.parse(row.payload);
    if(source.source!=='teams'||source.kind!=='teams'||event.source!=='teams'||event.kind!=='teams'||event.serviceKey!==source.service_key||hash([event.source,event.serviceKey,event.id])!==source.id||hash(event)!==source.body_hash||hash(event.payload)!==hash(message)||Number(source.occurred_at)!==event.at||message.at!==event.at||source.external_id!==event.id||message.serviceKey!==source.service_key||message.conversationKey!==conversationKey||hash(message.principal)!==hash(principal)||message.addressed!==true)throw Error();
    const expected=bareYes?'yes':'approve-fix '+id+' '+nonce;
    if(message.text.trim().split(/\s+/).join(' ').toLowerCase()!==expected.toLowerCase())throw Error();
  }catch{throw corrupt();}
  const binding={commandId:source.id,sourceHash:source.body_hash,conversationKey,serviceKey:source.service_key,principal,mode:bareYes?'yes':'exact',inputRequestId:bareYes?null:id,nonceHash:bareYes?null:hash(nonce)};
  return {...claim,message,sourceAt:Number(source.occurred_at),receivedAt:Number(source.received_at),receiptId:hash(['qa-approval-receipt',source.id]),fingerprint:hash(binding),binding};
}

export async function assertQaCommandClaim(store,q,claim,row){
  if(!claim)return;
  if(!row)[row]=await q('SELECT status,lease_until FROM sre_commands WHERE id=?',[claim.id]);
  if(row?.status!=='running'||Number(row.lease_until)!==claim.leaseUntil)throw Error('QA command lease was reclaimed; this attempt cannot approve');
  if(claim.leaseUntil<=await store.coordinationNow(q))throw Error('QA command lease expired before approval committed');
}

export async function qaApprovalReceipt(q,claim){
  if(!claim)return null;
  const [row]=await q('SELECT * FROM sre_fix_events WHERE id=?',[claim.receiptId]);if(!row)return null;
  try{
    const receipt=JSON.parse(row.payload);
    if(row.status!=='approval-receipt'||receipt.version!==1||receipt.commandId!==claim.id||receipt.commandFingerprint!==claim.fingerprint||receipt.requestId!==row.request_id||!epoch(receipt.recordedAt)||typeof receipt.applied!=='boolean')throw Error();
    return receipt;
  }catch{throw corrupt();}
}

export async function recordQaApprovalReceipt(store,q,claim,row,{applied,delivery=null}){
  if(!claim)return;
  const at=await store.coordinationNow(q),receipt={version:1,commandId:claim.id,commandFingerprint:claim.fingerprint,sourceHash:claim.binding.sourceHash,sourceAt:claim.sourceAt,receivedAt:claim.receivedAt,requestId:row.id,conversationKey:row.conversation_key,actor:row.requested_by,mode:claim.binding.mode,recordedAt:at,applied,delivery,restoreId:(await store.restoreFence(q))?.restoreId??null};
  await q('INSERT INTO sre_fix_events(id,request_id,status,at,payload) VALUES(?,?,?,?,?)',[claim.receiptId,row.id,'approval-receipt',at,JSON.stringify(receipt)]);
}

// A late/unknown send or an operator inspection is not delivery proof. Bare
// yes needs the normal receipt for the exact proposal in this conversation.
// Exact nonce commands remain available when timing or old provenance is unclear.
export async function deliveredQaProposal(store,q,row,claim){
  if(!claim)throw review();
  const [proposed]=await q("SELECT payload FROM sre_fix_events WHERE request_id=? AND status='proposed' ORDER BY at,id LIMIT 1",[row.id]);
  let proposal;try{proposal=JSON.parse(proposed?.payload);}catch{throw review();}
  if(!identity(proposal?.requestId)||proposal.actor!==row.requested_by||proposal.planId!==row.plan_id||'fix_'+hash([row.incident_id,proposal.requestId]).slice(0,24)!==row.id)throw review();
  const [command]=await q('SELECT status,payload FROM sre_commands WHERE id=?',[proposal.requestId]);
  if(command?.status!=='done')throw review();
  let message;try{message=JSON.parse(command.payload);}catch{throw corrupt();}
  if(message.text.trim().split(/\s+/).join(' ')!=='fix '+row.plan_id||message.principal?.userId!==row.requested_by||message.conversationKey!==row.conversation_key||message.incidentId!==row.incident_id)throw review();
  const [delivery]=await q('SELECT * FROM sre_outbox WHERE id=?'+lock(store),['command:'+proposal.requestId]);
  if(!delivery||!['sent',...(store.simulation?['simulated']:[])].includes(delivery.status)||delivery.incident_id!==row.incident_id||delivery.conversation_key!==row.conversation_key||!delivery.remote_id)throw review();
  const nonce=delivery.text.match(/\bapprove-fix (fix_[a-f0-9]{24}) ([a-f0-9]{36})\b/);
  if(nonce?.[1]!==row.id||!equalSecret(hash(nonce?.[2]||''),row.nonce_hash))throw review();
  const keys=['prepared','outcome','late'].map(kind=>'teams-delivery:'+kind+':'+delivery.id+':'+delivery.attempts),records=await q('SELECT id,value FROM sre_checkpoints WHERE id IN (?,?,?)',keys),values=new Map(records.map(r=>[r.id,r.value]));
  if(!values.has(keys[0])||!values.has(keys[1])||values.has(keys[2]))throw review();
  let prepared,outcome;
  try{
    [prepared,outcome]=keys.slice(0,2).map(key=>JSON.parse(values.get(key)));
    for(const fact of [prepared,outcome])if(fact.version!==1||fact.outboxId!==delivery.id||fact.incidentId!==row.incident_id||Number(fact.attempt)!==Number(delivery.attempts)||fact.originalHash!==hash(delivery.text))throw Error();
    if(prepared.conversationKey!==row.conversation_key||prepared.text!==delivery.text||prepared.textHash!==hash(prepared.text)||!epoch(prepared.preparedAt)||!epoch(prepared.claimLeaseUntil)||!epoch(outcome.observedAt)||outcome.observedAt<prepared.preparedAt||outcome.observedAt>=prepared.claimLeaseUntil||outcome.kind!=='receipt'||outcome.status!==delivery.status||outcome.remoteId!==delivery.remote_id)throw Error();
  }catch{throw corrupt();}
  const now=await store.coordinationNow(q);
  if(!epoch(claim.sourceAt)||!epoch(claim.receivedAt)||claim.sourceAt>now||claim.receivedAt>now||outcome.observedAt>now||outcome.observedAt<Number(row.created_at)||claim.sourceAt<=outcome.observedAt||claim.receivedAt<=outcome.observedAt)throw review();
  return {outboxId:delivery.id,attempt:Number(delivery.attempts),observedAt:outcome.observedAt,remoteId:delivery.remote_id,textHash:prepared.textHash};
}
