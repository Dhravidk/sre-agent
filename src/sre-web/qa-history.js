const epoch=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000;
const identity=value=>typeof value==='string'&&/^fix_[a-f0-9]{24}$/.test(value);
const rawStates=['proposed','approved','running','passed','failed','unknown','superseded'];
const displayStates=[...rawStates,'expired','approval-expired','lease-expired','stale-proposal','stale-approval'];
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=value=>epoch(value)?new Date(value).toLocaleString():'not returned';
const sameFence=(a,b)=>a&&b&&a.active===b.active&&a.restoreId===b.restoreId;
const sameAssessment=(a,b)=>a&&b&&a.currentRevision===b.currentRevision&&a.assessmentVersion===b.assessmentVersion;
const assessmentReasons={current:['matching-reviewed-facts'],changed:['different-reviewed-facts'],unverified:['legacy-plan','missing-assessment','unaudited-assessment','outdated-assessment','oversized-assessment']};
const assessmentValid=value=>value&&Object.keys(value).sort().join(',')==='reason,state'&&assessmentReasons[value.state]?.includes(value.reason);
const assessmentWarning=request=>request.assessment?.state==='current'?'':request.assessment?.state==='changed'?'The current assessment changed; these local artifacts are historical. Review a fresh ticket before further work.':'The current assessment match is unverified'+(request.assessment?.reason==='legacy-plan'?' for this legacy ticket':'')+'; review the current investigation before further work.';
const recoveryValid=v=>v&&typeof v.active==='boolean'&&(v.restoreId===null||typeof v.restoreId==='string'&&/^[A-Za-z0-9._:-]{1,160}$/.test(v.restoreId))&&(!v.active||v.restoreId!==null);
const invalid=()=>Error('The scoped saved QA evidence could not be verified. This read did not approve or retry it.');
function item(id,r){
 if(!identity(r?.id)||r.incidentId!==id||!/^plan_[a-f0-9]{24}$/.test(r.plan_id||'')||!rawStates.includes(r.status)||!displayStates.includes(r.displayStatus)||!epoch(r.created_at)||!epoch(r.expires_at)||!epoch(r.plan_revision)||typeof r.requested_by!=='string'||!r.requested_by||typeof r.current!=='boolean'||typeof r.approvalExpired!=='boolean'||typeof r.leaseExpired!=='boolean'||typeof r.origin?.name!=='string'||!/^[a-f0-9]{32}$/.test(r.origin?.key||'')||typeof r.origin.configuredAccess!=='boolean'||typeof r.origin.enabled!=='boolean'||!(r.origin.id===null||typeof r.origin.id==='string')||!epoch(r.unexpiredProposalsInConversation))throw invalid();
 if(r.assessment!==undefined&&(!assessmentValid(r.assessment)||r.current&&r.assessment.state!=='current'))throw invalid();
 if(r.result!==null&&(!r.result||r.result.isSummary!==true||!(r.result.branch===null||typeof r.result.branch==='string')||!(r.result.commit===null||/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.result.commit))||!(r.result.summary===null||typeof r.result.summary==='string')||typeof r.result.patchNeedsRegeneration!=='boolean'))throw invalid();return r;
}
function envelope(id,v,mode){
 if(v?.version!==1||v.incidentId!==id||v.mode!==mode||!epoch(v.observedAt)||!epoch(v.currentRevision)||!Array.isArray(v.items)||v.items.length>20||!recoveryValid(v.recovery))throw invalid();
 const c=v.coverage;if(!c||c.pageSize!==20||!epoch(c.total)||!epoch(c.shown)||c.shown!==v.items.length||!epoch(c.omitted)||c.omitted!==c.total-c.shown||!epoch(c.attentionTotal)||!epoch(c.attentionShown)||c.attentionShown>v.items.length||!epoch(c.attentionOmitted)||c.attentionOmitted!==c.attentionTotal-c.attentionShown||typeof c.hasMore!=='boolean'||c.completeHistory!==false||!(v.nextCursor===null||typeof v.nextCursor==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(v.nextCursor))||mode==='history'&&c.hasMore!==(v.nextCursor!==null))throw invalid();
 if(v.assessmentVersion!==undefined&&(typeof v.assessmentVersion!=='string'||!/^[a-f0-9]{64}$/.test(v.assessmentVersion))||v.items.some(r=>r.assessment!==undefined)&&v.assessmentVersion===undefined)throw invalid();
 v.items.forEach(r=>item(id,r));if(new Set(v.items.map(r=>r.id)).size!==v.items.length)throw invalid();return v;
}
function detail(id,requestId,v){
 if(v?.version!==1||v.incidentId!==id||v.id!==requestId||v.request?.id!==requestId||!epoch(v.observedAt)||!epoch(v.currentRevision)||typeof v.resultOmitted!=='boolean'||!Array.isArray(v.events)||v.events.length>10||!v.eventCoverage||v.eventCoverage.shown!==v.events.length||!epoch(v.eventCoverage.total)||!epoch(v.eventCoverage.omitted)||v.eventCoverage.total-v.eventCoverage.shown!==v.eventCoverage.omitted||v.eventCoverage.rawPayloadsIncluded!==false||!recoveryValid(v.recovery)||!(v.result===null||v.result&&typeof v.result==='object'&&!Array.isArray(v.result))||v.resultOmitted&&v.result!==null||JSON.stringify(v.result).length>131072||new TextEncoder().encode(JSON.stringify(v.result)).length>128000)throw invalid();
 if(v.assessmentVersion!==undefined&&(typeof v.assessmentVersion!=='string'||!/^[a-f0-9]{64}$/.test(v.assessmentVersion))||v.request.assessment!==undefined&&v.assessmentVersion===undefined)throw invalid();
 item(id,v.request);for(const event of v.events)if(!/^[a-f0-9]{64}$/.test(event.id||'')||!epoch(event.at)||typeof event.status!=='string'||event.payloadOmitted!==true)throw invalid();return v;
}

// All controls read retained state. They never send Teams approval commands.
export function createQaHistoryView({element:$,read,selection}){
 const cases=new Map();
 const state=id=>{let value=cases.get(id);if(!value){value={attention:null,attentionError:null,legacy:[],mode:'attention',history:null,historyError:null,reading:false,serial:0,lookup:'',inspection:null};cases.set(id,value);}return value;};
 function render(){
  const {incidentId,ready,recovery}=selection(),s=incidentId?state(incidentId):null;
  for(const id of ['qa-show-attention','qa-history-load','qa-inspect-submit'])$(id).disabled=!ready||!s;
  $('qa-history-older').disabled=!ready||!s||s.reading||s.mode!=='history'||!s.history?.nextCursor;$('qa-history-load').disabled=!ready||!s||s.reading;
  $('qa-request-id').disabled=!ready;if(!ready||!s){$('casework-qa').innerHTML='';$('qa-history-status').textContent='Select an incident to review saved QA requests.';$('qa-inspection').hidden=true;return;}
  if($('qa-request-id').value!==s.lookup)$('qa-request-id').value=s.lookup;
  const view=s.mode==='history'?s.history:s.attention,rows=view?.items||s.legacy,earlier=view&&(!sameFence(view.recovery,recovery)||s.attention&&!sameAssessment(view,s.attention));
  const viewError=s.mode==='history'?s.historyError:s.attentionError;
  let status=s.reading?'Reading saved QA history… ':'';if(viewError)status+='History unavailable: '+viewError+' ';if(view){if(earlier||viewError)status+='This is an earlier history observation. ';status+='Observed '+time(view.observedAt)+'. '+(s.mode==='attention'?'Requests needing review are reserved across conversations and people. ':'Saved history is ordered by creation time. ')+view.coverage.shown+'/'+view.coverage.total+' retained requests shown; '+view.coverage.omitted+' are outside this page. '+view.coverage.attentionShown+'/'+view.coverage.attentionTotal+' requests needing review are shown. '+(view.coverage.hasMore?'Older retained requests are available. ':'')+'This is not a complete action inventory; missing history does not prove an action never ran.';}
  else status+='This backend has not returned verified QA coverage. Saved summaries below may be incomplete. Load history or inspect a known request.';
  $('qa-history-status').textContent=status;
  const html=rows.map(q=>'<article><p><b>QA '+escape(q.displayStatus||q.status)+'</b> · '+escape(q.id)+(q.current===false?' · prior evidence or approval window; review before further work':'')+(assessmentWarning(q)?'<br><small class="coordination-warning">'+escape(assessmentWarning(q))+'</small>':'')+(q.displayStatus&&q.displayStatus!==q.status?'<br>Stored state: '+escape(q.status):'')+(q.requested_by?'<br>Requested by '+escape(q.requested_by)+' in '+escape(q.origin?.name||'stored conversation')+' · expires '+escape(time(q.expires_at)):'')+(q.origin&&(!q.origin.enabled||!q.origin.configuredAccess||q.origin.currentIncidentId!==q.incidentId)?'<br>Original conversation is no longer following with the same access.':'')+(q.unexpiredProposalsInConversation>1?'<br>'+escape(q.unexpiredProposalsInConversation)+' unexpired proposals share this conversation; use the exact command from the reviewed proposal.':'')+(q.leaseExpired?'<br>The processing lease expired; the outcome needs inspection. This read did not resume it.':'')+(q.result?'<br>Local branch '+escape(q.result.branch||'unknown')+' · '+escape(q.result.commit||'unknown')+'<br>'+escape(q.result.summary||'Saved result summary unavailable')+(q.result.patchNeedsRegeneration||typeof q.result.patch==='string'&&q.result.patch&&!q.result.patch.endsWith('\n')?'<br><small class="coordination-warning">This earlier patch export lacks its final newline. Regenerate the patch from the saved commit before applying it; the branch and test results remain retained.</small>':''):'')+(q.error?'<br>'+escape(q.error):'')+'</p><button type="button" class="secondary" data-qa-inspect="'+escape(q.id)+'">Inspect saved QA request</button></article>').join('')||'<p>No retained QA request is shown in this view.</p>';
  if($('casework-qa').innerHTML!==html){$('casework-qa').innerHTML=html;for(const button of $('casework-qa').querySelectorAll('[data-qa-inspect]'))button.onclick=()=>{const current=s.mode==='history'?s.history?.items:s.attention?.items||s.legacy;if(selection().incidentId===incidentId&&selection().ready&&current?.some(q=>q.id===button.dataset.qaInspect))void inspect(button.dataset.qaInspect);};}
  const inspected=s.inspection;$('qa-inspection').hidden=!inspected;if(!inspected)return;
  $('qa-inspection-reference').textContent='Saved QA request '+inspected.id+' · '+incidentId;$('qa-inspection-refresh').disabled=inspected.reading;
  let text=inspected.reading?'Reading saved QA evidence… ':'';const v=inspected.view;
  if(inspected.error)text+='Inspection unavailable: '+inspected.error+' ';
  if(v){const newest=s.attention?.items.find(q=>q.id===v.id),changed=!sameFence(v.recovery,recovery)||s.attention&&!sameAssessment(s.attention,v)||newest&&(newest.status!==v.request.status||newest.displayStatus!==v.request.displayStatus);if(changed||inspected.error)text+='This is an earlier inspection; current incident or request state changed. Refresh the saved evidence. ';text+='Observed '+time(v.observedAt)+'. '+v.request.displayStatus+' (stored '+v.request.status+'). '+assessmentWarning(v.request)+' '+(v.resultOmitted?'The saved result exceeds this reader budget and remains in the database. ':'')+'Showing '+v.eventCoverage.shown+'/'+v.eventCoverage.total+' transition summaries. Full transition payloads are omitted. Reading does not approve, retry or verify recovery.';}
  $('qa-inspection-status').textContent=text;$('qa-inspection-evidence').hidden=!v;$('qa-inspection-evidence').textContent=v?JSON.stringify({request:v.request,result:v.result,resultOmitted:v.resultOmitted,events:v.events,eventCoverage:v.eventCoverage,recovery:v.recovery},null,2):'';
 }
 function observe(incidentId,value){
  const s=state(incidentId);try{s.attention=envelope(incidentId,value,'attention');s.attentionError=null;s.legacy=[];}catch{s.attention=null;const legacy=value?.version===undefined&&value?.mode===undefined;s.legacy=legacy&&Array.isArray(value?.items)?value.items.filter(r=>!r.incidentId||r.incidentId===incidentId):[];s.attentionError=legacy?null:'The QA coverage could not be verified for this incident.';}render();
 }
 async function load(older=false){
  const {incidentId,ready}=selection();if(!incidentId||!ready)return;const s=state(incidentId),cursor=older?s.history?.nextCursor:null;if(older&&!cursor)return;const serial=++s.serial;s.mode='history';s.reading=true;s.historyError=null;render();
  try{const result=await read('/api/incidents/'+incidentId+'/qa-requests'+(cursor?'?cursor='+encodeURIComponent(cursor):''));if(s.serial!==serial)return;const v=envelope(incidentId,result,'history');if(selection().incidentId===incidentId&&!sameFence(v.recovery,selection().recovery))throw Error('Restore state changed while QA history was read. Load it again.');s.history=v;}
  catch(error){if(s.serial===serial)s.historyError=error.message;}finally{if(s.serial===serial){s.reading=false;render();}}
 }
 async function inspect(id){
  const {incidentId,ready}=selection();if(!incidentId||!ready)return;const s=state(incidentId);if(!identity(id)){s.historyError='Enter a saved fix_ request ID.';render();return;}
  s.lookup=id;const inspected={id,reading:true,view:s.inspection?.id===id?s.inspection.view:null,error:null};s.inspection=inspected;render();
  try{const value=detail(incidentId,id,await read('/api/incidents/'+incidentId+'/qa-requests/'+id));if(s.inspection!==inspected)return;if(selection().incidentId===incidentId&&!sameFence(value.recovery,selection().recovery))throw Error('Restore state changed while QA evidence was read. Inspect it again.');inspected.view=value;}
  catch(error){if(s.inspection===inspected)inspected.error=error.message;}finally{if(s.inspection===inspected){inspected.reading=false;render();}}
 }
 $('qa-show-attention').onclick=()=>{const {incidentId,ready}=selection();if(!incidentId||!ready)return;const s=state(incidentId);s.serial++;s.reading=false;s.mode='attention';s.historyError=null;render();};
 $('qa-history-load').onclick=()=>load(false);$('qa-history-older').onclick=()=>load(true);
 $('qa-request-id').oninput=()=>{const {incidentId,ready}=selection();if(incidentId&&ready)state(incidentId).lookup=$('qa-request-id').value;};
 $('qa-inspect-form').onsubmit=event=>{event.preventDefault();void inspect($('qa-request-id').value.trim());};
 $('qa-inspection-refresh').onclick=()=>{const {incidentId,ready}=selection();if(incidentId&&ready){const s=state(incidentId);if(s.inspection)void inspect(s.inspection.id);}};
 $('qa-inspection-close').onclick=()=>{const {incidentId,ready}=selection();if(incidentId&&ready){state(incidentId).inspection=null;render();}};
 return{render,observe,load,inspect};
}
