const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=value=>Number.isSafeInteger(value)?new Date(value).toLocaleString():'unknown';
const localTime=()=>new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,23);
export function deliveryRecipientLabel(message,names){
 const prepared=message.deliveryAttempt?.conversationKey,queued=message.conversation_key,key=prepared||queued;
 if(key)return (prepared?'prepared for ':'queued for ')+(names.get(key)||'conversation key '+key);
 return message.status==='pending'&&!message.deliveryAttempt?.preparedAt?'awaiting a linked group':'recipient not recorded';
}

// Inspection belongs to a message, independent of the selected incident. Keep
// the reviewed snapshot stable while polling and retain drafts through reads.
export function createDeliveryInspectionView({element:$,load,save,refreshStatus=()=>{},onError=()=>{}}){
 let current=null;
 const fieldNames=['finding','follow-up','reason','observed-at','references'];
 const path=id=>'/api/deliveries/'+encodeURIComponent(id)+'/inspection';
 function controls(s){
  if(current!==s)return;
  $('delivery-inspection-submit').disabled=!s.ready||s.busy||s.stale||!s.view?.canRecord;
  $('delivery-inspection-refresh').disabled=s.busy||s.reading;
  $('delivery-inspection-state').textContent=s.busy?'Saving the reviewed observation…':s.error?s.error:s.stale?'Delivery evidence or inspection history changed. Review current facts before recording. Your draft is retained.':!s.ready?'Loading delivery facts…':s.view.held?'Database restore reconciliation is holding new inspections.':!s.view.canRecord?'This delivery no longer requires an uncertainty inspection.':s.view.attentionRequired?'Follow-up still needs attention.':'Operator reported follow-up handled. Transport remains '+s.view.message.status+'.';
 }
 function render(s){
  const v=s.view,m=v.message;
  $('delivery-inspection-title').textContent='Inspect delivery · '+m.status;
  $('delivery-inspection-reference').textContent=m.id+' · '+(m.incidentId||'Teams command')+' · '+(m.conversationId||(v.facts.prepared?.conversationKey?'prepared conversation key '+v.facts.prepared.conversationKey:'recipient not recorded'))+' · attempt '+m.attempt;
  const fact=(label,value)=>value?'<details><summary>'+label+'</summary><pre>'+escape(JSON.stringify(value,null,2))+'</pre></details>':'';
  $('delivery-inspection-facts').innerHTML='<details><summary>Original queued message</summary><pre>'+escape(m.text)+'</pre></details>'+(m.error?'<p>'+escape(m.error)+'</p>':'')+fact('Prepared send body · preparation is not delivery',v.facts.prepared)+fact('Recorded transport outcome',v.facts.outcome)+fact('Late transport evidence · inspect the conversation',v.facts.late);
  $('delivery-inspection-history').innerHTML=(v.history||[]).map(r=>'<article><p><b>Operator reported '+escape(r.finding.replaceAll('_',' '))+'</b> · follow-up '+escape(r.followUp)+(r.current?' · current reviewed snapshot':' · historical; review current evidence')+(r.historicalAfterRestore?' · before database restore':'')+'<br>'+escape(r.actor.kind)+' / '+escape(r.actor.id)+' · recorded '+escape(time(r.recordedAt))+'<br>Observation time '+escape(time(r.observedAt))+'</p><p>'+escape(r.reason)+'</p>'+(r.references||[]).map(link=>'<p><a href="'+escape(link)+'" target="_blank" rel="noopener noreferrer">'+escape(link)+'</a></p>').join('')+'</article>').join('')||'<p>No operator inspection has been recorded.</p>';
  if(v.historyLimited)$('delivery-inspection-history').innerHTML+='<p>Earlier inspection records remain in the database.</p>';
  controls(s);
 }
 async function read(s,adopt){
  if(current!==s||s.busy||!adopt&&(s.reading||!s.ready))return;
  const serial=++s.serial;s.reading=true;if(adopt){s.ready=false;s.error=null;}controls(s);
  try{
   const data=await load(path(s.id));if(current!==s||serial!==s.serial)return;
   if(adopt){s.view=data;s.ready=true;s.stale=false;s.intent=null;render(s);}
   else if(data.reviewFingerprint!==s.view.reviewFingerprint||data.canRecord!==s.view.canRecord){s.stale=true;controls(s);}
  }catch(error){if(current===s&&serial===s.serial){s.error=error.message;onError(error);}}
  finally{if(current===s&&serial===s.serial){s.reading=false;controls(s);}}
 }
 async function open(id){
  if(current?.id===id){$('delivery-inspection').hidden=false;return;}
  const s={id,serial:0,ready:false,reading:false,busy:false,stale:false,view:null,intent:null};current=s;
  $('delivery-inspection').hidden=false;$('delivery-inspection-title').textContent='Inspect delivery';$('delivery-inspection-reference').textContent=id;
  $('delivery-inspection-facts').innerHTML='';$('delivery-inspection-history').innerHTML='';
  $('delivery-inspection-finding').value='inconclusive';$('delivery-inspection-follow-up').value='required';$('delivery-inspection-reason').value='';$('delivery-inspection-observed-at').value=localTime();$('delivery-inspection-references').value='';
  await read(s,true);if(current===s)$('delivery-inspection-reason').focus();
 }
 async function submit(event){
  event.preventDefault();const s=current;if(!s?.ready||s.busy||s.stale||!s.view.canRecord)return;
  const values=Object.fromEntries(fieldNames.map(name=>[name,$('delivery-inspection-'+name).value]));
  const input={expectedFingerprint:s.view.reviewFingerprint,finding:values.finding,followUp:values['follow-up'],reason:values.reason,observedAt:new Date(values['observed-at']).getTime(),references:values.references.split('\n').map(line=>line.trim()).filter(Boolean)},key=JSON.stringify(input);
  if(!s.intent||s.intent.key!==key)s.intent={key,body:{requestId:crypto.randomUUID(),...input}};
  const intent=s.intent;s.busy=true;s.error=null;controls(s);
  try{
   const result=await save(path(s.id),intent.body);if(current!==s)return;
   s.view=result;s.intent=null;s.stale=false;render(s);void refreshStatus();
  }catch(error){if(current===s){if(error.status===409)s.stale=true;s.error=error.message;onError(error);}}
  finally{if(current===s){s.busy=false;controls(s);}}
 }
 $('delivery-inspection-form').onsubmit=submit;
 $('delivery-inspection-refresh').onclick=()=>current&&!current.busy?read(current,true):undefined;
 $('delivery-inspection-cancel').onclick=()=>{current=null;$('delivery-inspection').hidden=true;};
 return {open,observe(status){if(status.deliveryInspectionVersion!==1){current=null;$('delivery-inspection').hidden=true;}else if(current)void read(current,false);}};
}
