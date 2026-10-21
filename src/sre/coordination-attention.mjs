import {hash} from './security.mjs';
import {StorageError} from './database.mjs';

const codes=new Set(['briefing-unacknowledged','briefing-delayed','briefing-delivery-unknown','briefing-delivery-failed','briefing-delivery-discarded']);
const roomKey=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value),generation=value=>Number.isSafeInteger(value)&&value>0;
const coveredId=key=>'coordination-attention-covered:'+hash(key);
const batchId=(incident,recipient,members)=>'coordination-attention:'+incident+':batch:'+recipient+':'+hash(members);
const identity=(incident,issue,recipient)=>'coordination-attention:'+incident+':'+issue.attentionGeneration+':'+issue.roomKey+':'+issue.code+':'+recipient;
const validMember=(key,incident,recipient)=>{
 if(typeof key!=='string')return false;
 const parts=key.split(':');return parts.length===6&&parts[0]==='coordination-attention'&&parts[1]===incident&&/^[1-9]\d*$/.test(parts[2])&&generation(Number(parts[2]))&&roomKey(parts[3])&&codes.has(parts[4])&&parts[5]===recipient;
};
const readRows=(q,table,fields,ids)=>ids.length?q('SELECT '+fields+' FROM '+table+' WHERE id IN ('+ids.map(()=>'?').join(',')+')',ids):[];
const invalid=()=>new StorageError(Error('Invalid retained coordination attention coverage'));
function textFor(view,issues){
 const rooms=new Map(view.rooms.map(room=>[room.key,room])),label=key=>Array.from(String(rooms.get(key)?.name||'Linked conversation').replace(/\s+/gu,' ').trim()).slice(0,80).join('');
 const lines=issues.map(issue=>{
  const state=issue.code==='briefing-unacknowledged'?'has not acknowledged briefing #'+issue.generation:issue.code==='briefing-delayed'?'has not completed delivery of briefing #'+issue.generation:'briefing #'+issue.generation+' delivery is '+issue.code.slice('briefing-delivery-'.length);
  return '- '+label(issue.roomKey)+' '+state+'; updates have been outstanding since briefing #'+issue.attentionGeneration+'.';
 });
 return ['Coordination delivery check · '+view.incidentId,issues.length+' new delivery check'+(issues.length===1?'':'s')+' in this reminder. Other reported checks remain in the current briefing and incident console.',...lines,'Read each conversation’s latest delivered briefing and acknowledge it there using the command shown in that briefing. A successful send is not a read receipt or agreement. Pending, failed or discarded delivery needs inspection; do not assume that team saw the update. Unknown sends are not replayed automatically.','Keep the incident lead informed through the common incident thread or bridge. Do not repeat a mitigation because another group is silent.'].join('\n');
}

// Caller holds the incident lock and commits coverage with the outbox. A marker
// means this check was queued for this recipient, never delivered or read.
export async function queueAttentionChecks(store,view,q){
 const issues=view.issues.filter(issue=>issue.delivery),recipients=view.rooms.filter(room=>['sent','simulated'].includes(room.briefing?.deliveryStatus));
 if(!issues.length||!recipients.length)return 0;
 if(issues.length>8||recipients.length>8||issues.some(issue=>!roomKey(issue.roomKey)||!generation(issue.generation)||!generation(issue.attentionGeneration)||!codes.has(issue.code)))throw invalid();
 const entries=recipients.flatMap(recipient=>issues.map(issue=>({recipient:recipient.key,issue,key:identity(view.incidentId,issue,recipient.key)}))),ids=entries.map(entry=>entry.key),expected=new Map(entries.map(entry=>[coveredId(entry.key),entry]));
 const legacy=await readRows(q,'sre_outbox','id,incident_id,conversation_key',ids),markers=await readRows(q,'sre_checkpoints','id,value',[...expected.keys()]),covered=new Set();
 for(const row of legacy){const entry=entries.find(entry=>entry.key===row.id);if(!entry||row.incident_id!==view.incidentId||row.conversation_key!==entry.recipient)throw invalid();covered.add(row.id);}
 const parsed=[];
 for(const row of markers)try{
  const value=JSON.parse(row.value),entry=expected.get(row.id);
  if(!entry||value.version!==1||value.incidentId!==view.incidentId||value.recipientKey!==entry.recipient||value.issueKey!==entry.key||!Array.isArray(value.members)||!value.members.length||value.members.length>8||!value.members.includes(entry.key)||value.members.some((key,i)=>!validMember(key,view.incidentId,entry.recipient)||i>0&&value.members[i-1]>=key)||value.outboxId!==batchId(view.incidentId,entry.recipient,value.members)||!/^[a-f0-9]{64}$/.test(value.textHash||'')||!Number.isSafeInteger(value.recordedAt)||value.recordedAt<0)throw invalid();
  parsed.push(value);
 }catch{throw invalid();}
 const parents=new Map((await readRows(q,'sre_outbox','id,incident_id,conversation_key,text',[...new Set(parsed.map(value=>value.outboxId))])).map(row=>[row.id,row]));
 for(const value of parsed){const parent=parents.get(value.outboxId);if(!parent||parent.incident_id!==view.incidentId||parent.conversation_key!==value.recipientKey||hash(parent.text)!==value.textHash)throw invalid();covered.add(value.issueKey);}
 let queued=0;
 for(const recipient of recipients){
  const fresh=entries.filter(entry=>entry.recipient===recipient.key&&!covered.has(entry.key)).sort((a,b)=>a.key.localeCompare(b.key));if(!fresh.length)continue;
  const members=fresh.map(entry=>entry.key).sort(),outboxId=batchId(view.incidentId,recipient.key,members),text=textFor(view,fresh.map(entry=>entry.issue));
  await store.queueMessage(view.incidentId,text,recipient.key,outboxId,q);
  const [saved]=await q('SELECT incident_id,conversation_key,text FROM sre_outbox WHERE id=?',[outboxId]);if(!saved||saved.incident_id!==view.incidentId||saved.conversation_key!==recipient.key||saved.text!==text)throw invalid();
  const now=await store.coordinationNow(q);
  for(const entry of fresh){const value={version:1,incidentId:view.incidentId,recipientKey:recipient.key,issueKey:entry.key,members,outboxId,textHash:hash(text),recordedAt:now};await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',[coveredId(entry.key),JSON.stringify(value),now]);}
  queued++;
 }
 return queued;
}
