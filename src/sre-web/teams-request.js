const epoch=n=>Number.isSafeInteger(n)&&n>=0;
const incident=n=>n===null||typeof n==='string'&&/^inc_[a-f0-9]+$/.test(n);
const commandStates=['pending','running','done','discarded','ignored'];
const deliveryStates=['pending','sending','sent','simulated','failed','unknown','discarded','held_restore'];
const time=value=>new Date(value).toLocaleString();
const sameRecovery=(a,b)=>a&&b&&['active','restoreId','questionsHeld'].every(k=>a[k]===b[k]);
const invalid=()=>Error('The saved instruction status could not be verified. This check did not resend it.');
function validate(entry,value){
 const {body,receipt}=entry,r=value?.commandReceipt;
 if(value?.version!==1||value.requestId!==(entry.recorded?null:body.requestId)||!epoch(value.requestedAt)||!epoch(value.observedAt)||typeof value.ignored!=='boolean'||!commandStates.includes(value.processing?.state)||typeof value.processing.leaseExpired!=='boolean'||!(value.processing.error===null||typeof value.processing.error==='string')||typeof value.binding?.enabled!=='boolean'||!incident(value.binding.incidentId))throw invalid();
 if(value.ignored){if(value.eventId!==null||r!==null||value.processing.state!=='ignored'||value.reply!==null)throw invalid();}
 else if(!/^[a-f0-9]{64}$/.test(value.eventId||'')||r?.version!==1||r.id!==value.eventId||r.conversationId!==body.conversationId||!incident(r.incidentId)||r.incidentId!==null&&r.incidentId!==body.expectedIncidentId||value.processing.state==='ignored')throw invalid();
 if(receipt&&(receipt.requestedAt!==value.requestedAt||Boolean(receipt.ignored)!==value.ignored||!value.ignored&&(receipt.eventId!==value.eventId||receipt.commandReceipt.incidentId!==r.incidentId)))throw invalid();
 if(entry.recorded&&(value.commandId!==entry.recorded.id||value.eventId!==entry.recorded.id||value.requestedAt!==entry.recorded.sourceAt||value.admittedAt!==entry.recorded.admittedAt||r?.incidentId!==body.expectedIncidentId))throw invalid();
 const reply=value.reply,joinTarget=String(body.text||'').trim().match(/^join\s+(inc_[a-f0-9]+)\s*$/i)?.[1];
 if(reply!==null&&(!reply||reply.id!=='command:'+value.eventId||!incident(reply.incidentId)||reply.incidentId!==null&&reply.incidentId!==r?.incidentId&&reply.incidentId!==joinTarget||!deliveryStates.includes(reply.status)||typeof reply.text!=='string'||reply.text.length>12000||typeof reply.truncated!=='boolean'||!epoch(reply.createdAt)||!(reply.error===null||typeof reply.error==='string')))throw invalid();
 return value;
}

// The browser keeps only the latest request pointer per incident. Its source,
// processing and delivery remain SQL records; reading never resends a command.
export function createTeamsRequestView({element:$,read,selection}){
 const entries=new Map();
 const current=()=>entries.get(selection().incidentId);
 function render(){
  const entry=current(),ready=selection().ready;
  $('teams-request').hidden=!entry||!ready;if(!entry||!ready)return;
  $('teams-request-label').textContent=(entry.recorded?'Selected recorded instruction from ':'Latest instruction from ')+entry.body.displayName+' · '+entry.body.conversationId;
  $('teams-request-check').disabled=entry.reading;
  let text=entry.reading?'Checking the saved instruction… ':'';
  const v=entry.observation,restoreChanged=v&&selection().recovery&&!sameRecovery(v.recovery,selection().recovery);
  if(entry.error)text+='Status unavailable: '+entry.error+' '+(v&&!restoreChanged?'The following is an earlier observation. ':'');
  if(v){
   if(restoreChanged)text+='This is an earlier observation; the restore state changed. Check the saved instruction again. ';
   text+='Observed '+time(v.observedAt)+'. ';
   const state=v.processing.state;
   text+=state==='ignored'?'Earlier message ignored; no command was queued. ':state==='pending'?(v.recovery?.active?'Saved; processing is paused by the database restore hold. ':'Saved; waiting for command processing. '):state==='running'?(v.processing.leaseExpired?'The previous processing lease expired. Recovery has not been observed. This check did not retry it. ':'Command processing is in progress. '):state==='discarded'?'Instruction discarded. Review its reason and current incident link before sending a new instruction. ':'Command processed; read the saved reply for its result. Further investigation, delivery or actions may still be pending. ';
   if(v.processing.error)text+='Reason: '+v.processing.error+' ';
   text+=!v.binding.enabled?'The conversation is not currently enabled. ':v.binding.incidentId?'The conversation currently follows '+v.binding.incidentId+'. ':'The conversation currently has no incident link. ';
   if(v.reply){text+=({pending:'Reply queued.',sending:'Reply send in progress.',sent:'A reply transport receipt is recorded; reading is unconfirmed.',simulated:'Reply prepared by the local simulator; Microsoft delivery is unverified.',failed:'Reply delivery failed; inspect before resending.',unknown:'Reply delivery is unknown; inspect before resending.',discarded:'Reply discarded.',held_restore:'Reply delivery is held for restore reconciliation.'})[v.reply.status];if(v.reply.error)text+=' '+v.reply.error;if(v.reply.truncated)text+=' Reply excerpt shortened; review the complete saved outbox or ticket.';}
   else text+='No command reply is recorded in this snapshot.';
  }else if(!entry.error)text+=entry.receipt?.ignored?'The earlier message was ignored. Check its saved outcome without resending.':entry.receipt?'Admission acknowledged. Command processing has not been checked.':'Admission has not been confirmed. Check the saved request without resending; a missing result does not prove it never committed.';
  $('teams-request-status').textContent=text;
  $('teams-request-reply').hidden=!v?.reply;$('teams-request-reply').textContent=v?.reply?.text||'';
 }
 function remember(incidentId,body,intent){
  let entry=entries.get(incidentId);
  if(entry?.intent!==intent){entry={incidentId,body:{...body,requestId:intent.requestId},intent,receipt:null,observation:null,error:null,reading:false,serial:0};entries.set(incidentId,entry);}
  render();return entry;
 }
 function acknowledge(incidentId,intent,receipt){const entry=entries.get(incidentId);if(entry?.intent===intent){entry.receipt=receipt;render();}}
 async function check(){
  const entry=current();if(!entry||!selection().ready)return;
  const serial=++entry.serial;entry.reading=true;entry.error=null;render();
  try{const value=await read(entry.recorded?'/api/incidents/'+entry.incidentId+'/teams-instructions/'+entry.recorded.id:'/api/dev/teams/requests/status',entry.recorded?undefined:entry.body);if(entries.get(entry.incidentId)!==entry||entry.serial!==serial)return;const verified=validate(entry,value);if(selection().recovery&&!sameRecovery(verified.recovery,selection().recovery))throw Error('Restore state changed while this instruction was being checked. Check it again; this read did not resend it.');entry.observation=verified;}
  catch(error){if(entries.get(entry.incidentId)===entry&&entry.serial===serial)entry.error=error.message;}
  finally{if(entries.get(entry.incidentId)===entry&&entry.serial===serial){entry.reading=false;render();}}
 }
 $('teams-request-check').onclick=check;
 async function openRecorded(incidentId,item){const entry={incidentId,body:{text:'',displayName:item.actor.name,conversationId:item.conversationId,expectedIncidentId:incidentId},recorded:item,receipt:null,observation:null,error:null,reading:false,serial:0};entries.set(incidentId,entry);render();await check();}
 return {remember,acknowledge,render,check,openRecorded};
}


const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function validateHistory(id,value){
 const c=value?.coverage,items=value?.items;
 if(value?.version!==1||value.incidentId!==id||!epoch(value.observedAt)||!Array.isArray(items)||items.length>20||c?.selection!=='original-command-binding'||c.pageSize!==20||!Number.isInteger(c.scanned)||c.scanned<0||c.scanned>20||!Number.isInteger(c.inaccessible)||c.inaccessible<0||c.inaccessible+items.length!==c.scanned||typeof c.hasMore!=='boolean'||c.completeHistory!==false||(c.hasMore?typeof value.nextCursor!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(value.nextCursor):value.nextCursor!==null))throw Error('The saved-instruction history could not be verified. No instruction was sent.');
 const ids=new Set();for(const item of items){if(!/^[a-f0-9]{64}$/.test(item?.id||'')||ids.has(item.id)||item.incidentId!==id||!epoch(item.sourceAt)||!epoch(item.admittedAt)||typeof item.conversationId!=='string'||!item.conversationId||typeof item.actor?.id!=='string'||!item.actor.id||typeof item.actor.name!=='string'||item.actor.name.length>200||typeof item.preview!=='string'||item.preview.length>180||!['pending','running','done','discarded'].includes(item.processingState))throw Error('The saved-instruction history has an invalid scope or source record. No instruction was sent.');ids.add(item.id);}
 return value;
}
export function createTeamsHistoryView({element:$,read,selection,onOpen}){
 const pages=new Map(),current=()=>pages.get(selection().incidentId);
 function render(){
  const {incidentId,ready}=selection(),page=pages.get(incidentId);$('teams-history').hidden=!ready;
  if(!ready)return;
  $('teams-history-load').disabled=Boolean(page?.reading);$('teams-history-older').disabled=!page?.view?.nextCursor||Boolean(page?.reading);
  let text=page?.reading?'Reading saved instructions… ':'';
  if(page?.error)text+='History unavailable: '+page.error+' ';
  const v=page?.view,stale=v&&(page.error||selection().recovery&&!sameRecovery(v.recovery,selection().recovery));
  if(v){if(stale)text+='This is an earlier page; refresh it for current history. ';text+='Observed '+time(v.observedAt)+'. '+v.items.length+' accessible instructions from '+v.coverage.scanned+' stored sources on this page. ';if(v.coverage.inaccessible)text+=v.coverage.inaccessible+' sources outside current sharing access are omitted. ';text+=v.coverage.hasMore?'Older entries are available. ':'No older retained entries were found in this selection. ';text+='Earlier unlinked or ignored messages are excluded. Missing history does not prove an instruction never ran.';}
  else if(!page?.error)text+='Load retained instructions linked to this incident when they arrived. Earlier unlinked or ignored messages are excluded. This read does not send or retry an instruction.';
  $('teams-history-status').textContent=text;
  const html=v?v.items.map(item=>'<article><p><b>'+escape(item.actor.name)+'</b> · '+escape(item.conversationId)+'<br>Received '+escape(time(item.admittedAt))+' · message time '+escape(time(item.sourceAt))+' · processing '+escape(item.processingState)+'</p><p>'+escape(item.preview)+'</p><button type="button" class="secondary" data-instruction="'+item.id+'">Inspect saved instruction</button></article>').join(''):'';
  if($('teams-history-items').innerHTML!==html){$('teams-history-items').innerHTML=html;for(const button of $('teams-history-items').querySelectorAll('button')){button.onclick=()=>{const item=page.view?.items.find(i=>i.id===button.dataset.instruction);if(item&&selection().incidentId===incidentId&&selection().ready&&pages.get(incidentId)===page)void onOpen(incidentId,item);};}}
 }
 async function load(older=false){
  const {incidentId,ready}=selection();if(!incidentId||!ready)return;let page=pages.get(incidentId);
  if(!page){page={view:null,error:null,serial:0,reading:false};pages.set(incidentId,page);}
  const cursor=older?page.view?.nextCursor:null;if(older&&!cursor)return;
  const serial=++page.serial;page.reading=true;page.error=null;render();
  try{const result=await read('/api/incidents/'+incidentId+'/teams-instructions'+(cursor?'?cursor='+encodeURIComponent(cursor):''));if(pages.get(incidentId)!==page||page.serial!==serial)return;const v=validateHistory(incidentId,result);if(selection().incidentId===incidentId&&selection().recovery&&!sameRecovery(v.recovery,selection().recovery))throw Error('Restore state changed while history was being read. Load it again.');page.view=v;}
  catch(error){if(pages.get(incidentId)===page&&page.serial===serial)page.error=error.message;}
  finally{if(pages.get(incidentId)===page&&page.serial===serial){page.reading=false;render();}}
 }
 $('teams-history-load').onclick=()=>load(false);$('teams-history-older').onclick=()=>load(true);
 return{render,load};
}
