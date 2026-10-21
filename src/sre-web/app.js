import {createIncidentView} from './incident-view.js';
import {createDeliveryInspectionView,deliveryRecipientLabel} from './delivery-inspection.js';

let token='',selected=null,loading=false,simulatedConversation=null,retryIntent=null,authNotice=null,agentMode='rules',coordinationView=null,simulationGuide=null;
let refreshErrorNotice=null,noticeGeneration=0;
const $=id=>document.getElementById(id);
const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok){if(r.status===401){$('auth').hidden=false;authNotice=data.error;}throw Object.assign(Error(data.error),{status:r.status});}if(authNotice!==null){if($('notice').textContent===authNotice)notice('');authNotice=null;}return data;}
const notice=text=>{$('notice').textContent=text;noticeGeneration++;};
const deliveryInspections=createDeliveryInspectionView({element:$,load:api,save:api,refreshStatus:refresh,onError:error=>notice(error.message)});
const draftFields=['question-text','retry-reason','teams-text','teams-key','teams-intent','teams-state','teams-work-state','teams-theory-state','teams-room','teams-surface','teams-user','change-provider','change-number'];
const incidentDrafts=new Map();let initialDraft;
const buttonWork=new WeakMap();
function beginButton(button){const work={};buttonWork.set(button,work);button.disabled=true;return work;}
function finishButton(button,work,disabled=false){if(buttonWork.get(button)===work){buttonWork.delete(button);button.disabled=disabled;}}
function selectIncident(id){
  if(id!==selected){
    initialDraft||=Object.fromEntries(draftFields.map(key=>[key,$(key).value]));
    if(selected){let scope;try{scope=incidentView.capture();}catch{}incidentDrafts.set(selected,{scope,values:Object.fromEntries(draftFields.map(key=>[key,$(key).value]))});}
    const saved=incidentDrafts.get(id)?.values,draft=saved||initialDraft;for(const key of draftFields)$(key).value=draft[key];
    if(!saved&&simulationGuide){const root=id===simulationGuide.primaryId?simulationGuide.primaryRoot:id===simulationGuide.providerId?simulationGuide.providerRoot:null;if(root){$('teams-room').value=root;$('teams-surface').value='channel';}}
    selected=id;retryIntent=null;resetChangeMutation();notice('');renderTeamsFields();
    for(const button of $('incidents').querySelectorAll('button'))button.classList.toggle('active',button.dataset.id===id);
  }
  return incidentView.select(id);
}
function unavailableIncident(id,message='Loading the selected incident. Actions are paused until its context is ready.'){
  $('detail').dataset.incident='';$('detail').setAttribute('aria-busy','true');$('detail').innerHTML='<p>'+e(message)+'</p>';
  $('detail-title').textContent='Investigation '+id;$('analysis-progress').textContent='';
  for(const key of ['conversation','question','retry-work','casework','coordination'])$(key).hidden=true;
  $('incident-teams-controls').disabled=true;buttonWork.delete($('rollback-request'));$('rollback-request').disabled=true;
  for(const form of ['question','retry-work','teams'])for(const button of $(form).querySelectorAll('button')){buttonWork.delete(button);button.disabled=false;}
  buttonWork.delete($('casework-plan'));
  $('teams-thread').textContent='Waiting for incident context: '+id;$('responder-timeline').innerHTML='';coordinationView=null;
}
const incidentView=createIncidentView({
  load:id=>api('/api/incidents/'+id),render:renderDetail,pending:id=>unavailableIncident(id),
  onError:(error,id)=>{unavailableIncident(id,'The selected incident could not be loaded. Actions are paused while it is retried.');notice(error.message);},
});
const detail=options=>incidentView.refresh(options);
const notifyCurrent=(intent,text)=>{if(incidentView.isCurrent(intent))notice(text);};
function clearSubmitted(intent,key,value){
  if(incidentView.isCurrent(intent)){if($(key).value===value)$(key).value='';return;}
  const draft=incidentDrafts.get(intent.incidentId);
  if(selected!==intent.incidentId&&draft?.scope?.generation===intent.generation&&draft.values[key]===value)draft.values[key]='';
}
function renderCoordination(view){
  coordinationView=view;
  renderTeamsFields();
  $('coordination').hidden=!view?.enabled;
  if(!view?.enabled)return;
  $('coordination-count').textContent=view.rooms.length+' linked conversations · briefing #'+(view.briefingGeneration||'none');
  $('coordination-issues').innerHTML=view.issues.map(issue=>'<p class="coordination-warning">'+e(issue.text)+'</p>').join('');
  const ledger=(items,label)=>(items||[]).map(item=>'<p><b>'+label+' · '+e(item.key)+'</b> <span class="badge">'+e(item.state)+'</span><br>'+e(item.author)+' · '+e(new Date(item.at).toLocaleTimeString())+' · reported'+(item.currentForAuthor===false?' · historical claim; updated by this responder elsewhere':'')+(item.stale?(item.kind==='work'&&['planned','active','blocked'].includes(item.state)?' · owner update overdue':' · older report'):'')+'<br>'+e(item.text)+'</p>').join('');
  const handoffs=view.handoffs||[],handoffCoverage=view.handoffCoverage;
  $('coordination-handoffs').hidden=!handoffs.length;
  $('coordination-handoff-count').textContent='Work handoffs · '+handoffs.length+(handoffCoverage?.omitted?' of '+handoffCoverage.total:'')+' retained records';
  const report=(label,r)=>r?'<p><b>'+label+' · '+e(r.author)+'</b> · '+e(r.roomName)+'<br>'+e(r.state)+' at '+e(new Date(r.at).toLocaleString())+' · source report <code>'+e(r.evidenceId)+'</code><br>'+e(r.text)+'</p>':'';
  $('coordination-handoff-items').innerHTML=handoffs.map(h=>'<article class="room-card"><h3>'+e(h.key)+' · '+e(h.state.replaceAll('-',' '))+'</h3>'+report('Released',h.release)+(h.owner?report('Reported owner',h.owner):'<p>No current owner report after this release.</p>')+report('Reported completion',h.completion)+(h.priorAssignedCount?'<p>'+e(h.priorAssignedCount)+' current assignment reports predate this release and do not accept the new handoff.</p>':'')+'<small>'+e(h.ownerCount)+' post-release owner reports. Reports do not establish agreement, task execution or incident recovery.</small></article>').join('')+(handoffCoverage?.omitted?'<p>'+e(handoffCoverage.omitted)+' further handoff records remain outside this bounded view. Request the missing work evidence.</p>':'');
  $('coordination-rooms').innerHTML=view.rooms.map(room=>'<article class="room-card"><h3>'+e(room.name)+'</h3><span class="badge">Latest state report: '+e(room.reportedStatus||'not provided')+(room.statusStale?' · old report':'')+'</span>'+(room.statusAt?'<small> · '+e(new Date(room.statusAt).toLocaleTimeString())+'</small>':'')+(room.briefing?'<p>Briefing #'+e(room.briefing.generation)+' · '+e(room.briefing.deliveryStatus)+' · '+(room.briefing.acknowledged?'receipt acknowledged':'awaiting acknowledgement')+'<br><small>Receipt does not establish agreement or approval.</small></p>':'<p>No shared briefing delivered yet.</p>')+(room.stateReports||[]).map(report=>'<p><b>State claim · '+e(report.state)+'</b><br>'+e(report.author)+' · '+e(new Date(report.at).toLocaleTimeString())+' · unverified'+(report.stale?' · old claim':'')+'<br>'+e(report.text)+'</p>').join('')+ledger(room.theories,'Theory')+ledger(room.work,'Work')+room.reports.filter(report=>![...(room.work||[]),...(room.theories||[])].some(item=>item.evidenceId===report.evidenceId)).slice(0,6).map(report=>'<p><b>'+e(report.author)+'</b> · '+e(new Date(report.at).toLocaleTimeString())+' · unverified<br>'+e(report.text)+'</p>').join('')+(room.omittedReportAuthors?'<p>'+e(room.omittedReportAuthors)+' participant reports are outside this summary. Ask for the missing context.</p>':'')+(!room.reports.length?'<p>No delivered report. Ask for this team’s owner, action and next check.</p>':'')+'</article>').join('');
  $('coordination-next').textContent=view.nextStep+(view.rooms.length<2&&(view.otherIncidentLinks||[]).length?' Another group follows a different incident; use sync to check incident identity before combining their work.':'');
}
function renderConversation(data){
  const expanded=new Set([...$('conversation-messages').querySelectorAll('details[open][data-turn-id]')].map(item=>item.dataset.turnId));
  $('conversation').hidden=false;
  const questions=new Map((data.conversation||[]).filter(turn=>turn.role==='operator').map(turn=>[turn.id,turn]));
  const questionContext=turn=>{const question=questions.get(turn.inReplyTo);if(!question)return '';const text=Array.from(String(question.text||''));return '<p class="reply-context"><small>In reply to '+e(question.name||'Operator')+': '+e(text.slice(0,320).join(''))+(text.length>320?'…':'')+'</small></p>';};
  $('conversation-messages').innerHTML=(data.conversation||[]).slice(-12).map(turn=>'<article class="chat-turn '+e(turn.role)+'"><b>'+e(turn.role==='assistant'?(turn.mode==='claude'?'Claude':turn.mode==='rules'?'Rules assessment':turn.mode||'Agent'):turn.name)+'</b> <small>'+e(new Date(turn.at).toLocaleTimeString())+(turn.role==='assistant'&&Number.isSafeInteger(turn.revision)?' · revision '+e(turn.revision)+(turn.matchesCurrentAssessment?' · current snapshot':'')+(turn.orderingUncertain?' · same revision and timestamp':''):'')+'</small>'+questionContext(turn)+'<p>'+e(turn.summary||turn.text)+'</p>'+(turn.role==='assistant'?'<details data-turn-id="'+e(turn.id)+'"'+(expanded.has(turn.id)?' open':'')+'><summary>Read full reply</summary><pre>'+e(turn.text)+'</pre></details>':'')+'</article>').join('')||'<p>Your questions and the agent’s replies will appear here.</p>';
  const jobs=data.jobs||[],active=jobs.find(job=>job.status==='running')||jobs.find(job=>job.status==='pending'),failed=jobs.find(job=>job.status==='dead');
  const progress=active?(active.status==='running'?(agentMode==='claude'?'Claude is investigating. A response can take up to two minutes.':'The worker is investigating.'):active.error?'Analysis retry queued: '+active.error:'Investigation queued.')+(data.incident.analysis?' The assessment below is the last completed reply.':''):failed?'Investigation needs attention: '+failed.error:agentMode==='claude'&&data.incident.analysis?.mode!=='claude'?'This is an earlier rules assessment. Ask a question to investigate with Claude.':'';
  const reviewNote=data.assessmentStatus?.state==='outdated'?'New evidence is waiting for review. The assessment below predates that update. Ask for a current review if no investigation is queued.':data.assessmentStatus?.state==='unverified'?'This saved assessment has no matching review record. Ask for a current review before planning a fix.':data.assessmentStatus?.state==='missing'?'No completed assessment is available yet.':'';
  const contactNote=data.casework?.assessmentContactsCurrent===false?'Contact evidence in this saved reply has changed. Use the current recommendations under Owners and fix plan.':'';
  $('analysis-progress').textContent=[progress,reviewNote,contactNote].filter(Boolean).join(' ');
  $('rollback-request').disabled=!data.rollback.eligible||Boolean(active)||Boolean(data.assessmentStatus&&data.assessmentStatus.state!=='current')||buttonWork.has($('rollback-request'));
}
function assessmentMarkup(analysis,waiting,expanded){
  if(!analysis)return '<p>'+e(waiting)+'</p>';
  const next=(analysis.nextSteps||[]).slice(0,3);
  return '<p class="assessment-summary">'+e(analysis.summary)+'</p><p>Outage outlook: '+e(analysis.risk?.likelihood||'unknown')+' · Confidence: '+e(analysis.risk?.confidence||'unknown')+'</p>'+(next.length?'<h3>Next checks</h3><ul class="assessment-next">'+next.map(step=>'<li>'+e(step)+'</li>').join('')+'</ul>':'')+'<details data-section="assessment"'+(expanded?' open':'')+'><summary>Full assessment and evidence limitations</summary><pre>'+e(analysis.text)+'</pre></details>';
}
function signalMarkup(digest){
  if(!digest)return '';
  const c=digest.coverage,limited=c.candidateWindowLimited||c.recordsNotScanned||c.partialResults||c.omittedGroups||c.missingTimestamps||c.invalidRecords;
  return '<section aria-label="Signals and change history"><h3>Signals and change history</h3><p>'+e(c.recordsScanned)+' observed log records · '+e(c.duplicateObservations)+' overlapping observations grouped · '+Math.min(4,digest.groups.length)+' of '+(digest.groups.length+(c.omittedGroups||0))+' sample groups shown'+(limited?' · limited coverage':'')+'</p>'+digest.groups.slice(0,4).map(group=>'<p><b>'+e(group.level)+' · '+e(group.code||group.errorType||(group.statusCode?'HTTP '+group.statusCode:'Unclassified'))+'</b> · '+e(group.observations)+' observed signatures<br>'+e([group.entity||'entity unknown',group.environment||'environment unknown',group.region||'region unknown',group.operation||'operation unknown',group.version||'release unknown'].join(' / '))+'<br>'+e(group.message)+'</p>').join('')+(!digest.groups.length?'<p>No log groups in this evidence window. This does not establish health.</p>':'')+digest.changes.slice(0,3).map(change=>'<p><b>'+e(change.provider)+' '+e(change.comparisonKind)+'</b> · '+e(change.baseSha?.slice(0,12)||'base unknown')+' → '+e(change.headSha?.slice(0,12)||'head unknown')+' · '+(change.complete?'provider comparison marked complete':'comparison incomplete')+'<br>'+e(change.paths.join(', ')||'Source paths unavailable')+'</p>').join('')+'<small>'+e(digest.interpretation)+'</small><details><summary>Signal coverage and commit history</summary><pre>'+e(JSON.stringify(digest,null,2))+'</pre></details></section>';
}
function messageMarkup(message,expanded,originalExpanded){
  const delivery=message.contactDelivery,attempt=message.deliveryAttempt,text=attempt?.text||delivery?.renderedText||message.text||'';
  const contactNote=delivery?'<small>Contact snapshot checked '+e(new Date(delivery.checkedAt).toLocaleString())+' for delivery attempt '+e(delivery.attempt)+'. Delivery status is shown above.</small>':attempt?.preparedAt?'<small>Teams send prepared '+e(new Date(attempt.preparedAt).toLocaleString())+' · attempt '+e(attempt.attempt)+'. Preparation does not establish delivery.</small>':'';
  const lateNote=attempt?.late?'<p class="coordination-warning">Late Teams '+e(attempt.late.kind==='receipt'?'receipt'+(attempt.late.remoteId?' '+attempt.late.remoteId.slice(0,120):''):'transport failure'+(attempt.late.httpStatus?' · HTTP '+attempt.late.httpStatus:''))+' recorded '+e(new Date(attempt.late.observedAt).toLocaleString())+'. Delivery state remains '+e(message.status)+'; inspect the conversation before retrying.</p>':'';
  const originalNote=text!==message.text?'<details data-message-id="'+e(message.id)+':original"'+(originalExpanded?' open':'')+'><summary>Original queued reply</summary><pre>'+e(message.text)+'</pre></details>':'';
  if(text.length<=900||text.includes('An authorized approver must send:'))return '<p>'+e(text)+'</p>'+contactNote+lateNote+originalNote;
  const firstLine=text.split('\n').find(line=>line.trim())||'';
  const preview=firstLine.length>600?firstLine.slice(0,600)+'…':firstLine;
  return '<p>'+e(preview)+'</p><details data-message-id="'+e(message.id)+'"'+(expanded?' open':'')+'><summary>View full message</summary><pre>'+e(text)+'</pre></details>'+contactNote+lateNote+originalNote;
}
let caseworkHeld=false,caseworkReviewCurrent=true,caseworkTrackBusy=null,changeMutationIntent=null,changeMutationBusy=null,caseworkIncident=null,caseworkPlansMarkup=null;
const trackingBusy=()=>Boolean(caseworkTrackBusy&&incidentView.isCurrent(caseworkTrackBusy));
const correctionBusy=()=>Boolean(changeMutationBusy&&incidentView.isCurrent(changeMutationBusy));
function resetChangeMutation(){changeMutationIntent=null;$('casework-correct').hidden=true;$('change-correction-reason').value='';}
function reviewChangeMutation(intent){
  let scope;try{scope=incidentView.capture(intent.incidentId);}catch(error){notice(error.message);return;}
  changeMutationIntent={...intent,scope};$('casework-correct').hidden=false;$('change-correction-reason').value='';
  $('change-correction-title').textContent=(intent.action==='withdraw'?'Withdraw ':'Reconsider ')+intent.provider+' #'+intent.number+' for this incident';
  $('change-correction-reference').textContent='Reviewed reference: '+intent.reference;
  $('change-correction-submit').textContent=intent.action==='withdraw'?'Withdraw association':'Reconsider association';
  $('change-correction-submit').disabled=caseworkHeld||correctionBusy();$('change-correction-reason').focus();
}
function ciReconciliationMarkup(ci){
  if(!ci?.consistency)return '';
  const observation=o=>e(o.status)+' · '+e(o.providerUpdatedAt===null?'source time unknown':new Date(o.providerUpdatedAt).toLocaleString())+' · '+e(o.timeKind)+' time · source event '+e(o.eventId);
  return '<br>Pipeline reconciliation: '+e(ci.consistency.state)+'<br>MR read: '+observation(ci.consistency.observed)+ci.consistency.latest.map(o=>'<br>Other saved observation: '+observation(o)).join('');
}
function changeHistoryMarkup(view){
  if(!Array.isArray(view.groups))return view.items.map(c=>'<p>'+e(c.provider)+' '+e(c.change_number||'')+' · '+e(c.stage)+'<br>'+e(c.head_sha)+'</p>').join('');
  const open=new Set([...$('casework-changes').querySelectorAll('details[data-change-history][open]')].map(d=>d.dataset.changeHistory));
  const groups=view.groups.map(g=>{
    const latest=g.latest,state=latest.state==='conflicting'?'Conflicting update versions: '+latest.statuses.join(' / '):latest.state==='observed-version'?'Latest update version: '+latest.status:latest.state==='recorded'?'Recorded status: '+latest.status:latest.state==='identity-unknown'?'Run identity unknown; reports may cover multiple runs':'No comparable update version';
    const refs=g.relevance.references.map(r=>r.provider+' #'+r.number+(r.headRole?' · '+r.headRole:'')+(r.state==='historical'?' · historical relationship':'')).join('; ');
    return '<article class="change-history" data-history-group="'+e(g.id)+'"><p><b>'+e(g.provider)+' · '+e(g.run?g.run.label:g.changeNumber?'Change #'+g.changeNumber:g.stage)+'</b> <span class="badge'+(['conflicting','unversioned','identity-unknown'].includes(latest.state)?' warn':'')+'">'+e(g.stage)+'</span><br><code>'+e(g.headSha)+'</code></p><p class="change-relevance">'+e(g.relevance.label)+(refs?'<br>'+e(refs):'')+'</p><p>'+e(state)+(latest.at!==null?' · '+e(new Date(latest.at).toISOString()):'')+'<br>'+e(g.factCount)+(g.factCount===1?' source fact · ':' source facts · ')+e(g.observationCount)+(g.observationCount===1?' status/time observation in this window':' status/time observations in this window')+(g.unversionedCount?' · '+e(g.unversionedCount)+(g.unversionedCount===1?' report without an update version':' reports without an update version'):'')+'</p><small>'+e(g.note)+(g.recordedBeforeRestore?' Some records predate database restoration.':'')+'</small><details data-change-history="'+e(g.id)+'"'+(open.has(g.id)?' open':'')+'><summary>Source references · '+g.sources.length+' of '+g.factCount+' shown</summary><ul>'+g.sources.map(r=>'<li><b>'+e(r.status)+'</b> · '+e(r.timeKind)+' time '+e(r.sourceAt===null?'unknown':new Date(r.sourceAt).toISOString())+'<br><small>Received '+e(new Date(r.receivedAt).toISOString())+' · source event <code>'+e(r.eventId)+'</code></small></li>').join('')+'</ul>'+(g.sourcesLimited?'<small>Further source references are retained in the database and the raw history window.</small>':'')+'</details></article>';
  }).join('');
  return '<h3>Change history</h3><p>'+e(view.items.length)+' source facts grouped into '+e(view.groups.length)+' cards in this window'+(view.limited?' · limited history':'')+'. '+e(view.coverage?.interpretation||'')+'</p>'+groups+(view.groupsLimited?'<p>Further groups are retained outside this display window.</p>':'');
}
function renderAssociationActions(data,view){
  const enabled=view.associationActionVersion===1,controls=view.changes.withdrawals||[],links=view.changes.links||[];
  const active=links.map(l=>'<p><b>Linked '+e(l.provider)+' #'+e(l.change_number)+'</b> '+(l.association?'by '+e(l.association.label||l.association.id):'through provider/reader evidence')+' · context association'+(l.historicalAfterRestore?' · historical after restore; automatic follow-up awaits fresh reaffirmation':'')+'<br><small>Link reference '+e(l.evidence_id)+'</small>'+(l.read?'<br><small>'+(l.read.complete?'Metadata read':'Reader needs attention: '+e(l.read.error))+' · source updated '+e(l.read.providerUpdatedAt===null?'unknown':new Date(l.read.providerUpdatedAt).toLocaleString())+' · observed '+e(new Date(l.read.readCompletedAt).toLocaleString())+' · CI '+e(l.read.ci?.status||l.read.ci?.state||'unknown')+'. This is not deployment or recovery proof.'+(l.read.ci?.eventId?'<br>CI source event '+e(l.read.ci.eventId):'')+(l.read.ci?.note?'<br>'+e(l.read.ci.note):'')+ciReconciliationMarkup(l.read.ci)+'</small>':'')+'</p>'+(enabled&&data.incident.issue_key!=='review:'+l.provider+':'+l.change_number?'<button type="button" class="secondary" data-change-action="withdraw" data-provider="'+e(l.provider)+'" data-number="'+e(l.change_number)+'" data-reference="'+e(l.evidence_id)+'"'+(view.held?' disabled':'')+'>Withdraw '+e(l.provider)+' #'+e(l.change_number)+'</button>':'')).join('');
  const withdrawn=controls.map(c=>'<p><b>Withdrawn '+e(c.provider)+' #'+e(c.number)+'</b> by '+e(c.actor.label)+(c.historicalAfterRestore?' · historical after restore':'')+'<br>'+e(c.reason)+'<br><small>Audit reference '+e(c.evidenceId)+'</small></p>'+(enabled?'<button type="button" class="secondary" data-change-action="reconsider" data-provider="'+e(c.provider)+'" data-number="'+e(c.number)+'" data-reference="'+e(c.evidenceId)+'"'+(view.held?' disabled':'')+'>Review reconsideration for '+e(c.provider)+' #'+e(c.number)+'</button>':'')).join('');
  $('casework-changes').innerHTML=active+withdrawn+changeHistoryMarkup(view.changes)+'<small>'+e(view.changes.interpretation)+(view.changes.limited?' History window is limited.':'')+'</small>';
  for(const button of $('casework-changes').querySelectorAll('[data-change-action]'))button.onclick=()=>reviewChangeMutation({incidentId:data.incident.id,action:button.dataset.changeAction,provider:button.dataset.provider,number:button.dataset.number,reference:button.dataset.reference});
  if(changeMutationIntent&&!correctionBusy()){const i=changeMutationIntent,valid=i.action==='withdraw'?links.some(l=>l.provider===i.provider&&l.change_number===i.number&&l.evidence_id===i.reference):controls.some(c=>c.provider===i.provider&&c.number===i.number&&c.evidenceId===i.reference);if(!valid){resetChangeMutation();notice('The relationship changed. Review its current state before recording another correction.');}}
  $('change-correction-submit').disabled=view.held||correctionBusy();
}
function renderCasework(data){
  const view=data.casework;$('casework').hidden=!view;if(!view)return;caseworkHeld=view.held===true;caseworkReviewCurrent=!data.assessmentStatus||data.assessmentStatus.state==='current';$('casework-plan').disabled=caseworkHeld||!caseworkReviewCurrent||buttonWork.has($('casework-plan'));$('casework-track-submit').disabled=caseworkHeld||trackingBusy();
  const sameIncident=caseworkIncident===data.incident.id;
  if(!sameIncident){resetChangeMutation();caseworkIncident=data.incident.id;}
  const contacts=view.contacts,contactWindow=[contacts.source?'Source: '+contacts.source:null,Number.isSafeInteger(contacts.observedAt)?'Observed '+new Date(contacts.observedAt).toLocaleString():null,Number.isSafeInteger(contacts.validUntil)?'Valid until '+new Date(contacts.validUntil).toLocaleString():null].filter(Boolean).join(' · ');
  $('casework-contacts').innerHTML='<h3>Who to contact</h3>'+(contactWindow?'<p><small>'+e(contactWindow)+'. Recheck before contacting an owner.</small></p>':'')+contacts.contacts.map(c=>'<p><b>'+e(c.name)+'</b> · '+e(c.team)+' · '+e(c.role)+'<br>'+e(c.contact)+' · '+e(c.reason)+(c.role==='on-call'?'<br><small>Shift ends '+e(new Date(c.endsAt).toLocaleString())+'</small>':'')+'</p>').join('')+contacts.unknowns.map(u=>'<p>'+e(u)+'</p>').join('');
  const plansMarkup=(view.plans||[]).map(p=>'<article><p><b>'+e(p.id)+'</b> · incident revision '+e(p.revision)+(p.current===false?' · historical snapshot':'')+(p.contactsCurrent===false?' · contact snapshot changed; refresh before contacting':'')+'</p>'+(p.current===false?'<p class="coordination-warning">This ticket covers revision '+e(p.revision)+'; the incident is now at revision '+e(view.currentRevision)+'. Review the current assessment and draft a fresh ticket before requesting QA.</p>':'')+'<button type="button" class="secondary" data-plan-download="'+e(p.id)+'">Download Markdown</button> <button type="button" class="secondary" data-plan-fix="'+e(p.id)+'"'+(!p.payload.patch||p.current===false||view.held?' disabled':'')+'>Request local QA</button><details data-plan-id="'+e(p.id)+'"><summary>Read fix ticket</summary><pre tabindex="0" aria-label="Markdown fix ticket '+e(p.id)+'">'+e(p.markdown)+'</pre></details></article>').join('')||'<p>Draft a ticket to capture evidence, contacts, acceptance checks and a proposed fix.</p>';
  // Leave unchanged ticket DOM alone while polling. When a revision or plan list
  // changes, retain each immutable ticket's reading position and disclosure state.
  if(!sameIncident||plansMarkup!==caseworkPlansMarkup){
    const reading=new Map(sameIncident?[...$('casework-plans').querySelectorAll('details[data-plan-id]')].map(item=>[item.dataset.planId,{open:item.open,scroll:item.querySelector('pre')?.scrollTop||0,focus:document.activeElement===item.querySelector('summary')?'summary':document.activeElement===item.querySelector('pre')?'pre':null}]):[]);
    const focused=sameIncident?document.activeElement:null,focusKey=focused?.dataset?.planDownload?['planDownload',focused.dataset.planDownload]:focused?.dataset?.planFix?['planFix',focused.dataset.planFix]:null;
    $('casework-plans').innerHTML=plansMarkup;caseworkPlansMarkup=plansMarkup;
    for(const item of $('casework-plans').querySelectorAll('details[data-plan-id]')){const saved=reading.get(item.dataset.planId);if(saved){item.open=saved.open;item.querySelector('pre').scrollTop=saved.scroll;if(saved.focus)item.querySelector(saved.focus).focus({preventScroll:true});}}
    if(focusKey)for(const button of $('casework-plans').querySelectorAll('button'))if(button.dataset[focusKey[0]]===focusKey[1]&&!button.disabled)button.focus({preventScroll:true});
  }
  for(const button of $('casework-plans').querySelectorAll('[data-plan-download]'))button.onclick=async()=>{let scope;try{scope=incidentView.capture(data.incident.id);const r=await fetch('/api/incidents/'+scope.incidentId+'/plans/'+button.dataset.planDownload+'.md',{headers:token?{authorization:'Bearer '+token}:{}});if(!r.ok)throw Error('Markdown download failed');const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download=button.dataset.planDownload+'.md';a.click();URL.revokeObjectURL(url);}catch(error){if(!scope||incidentView.isCurrent(scope))notice(error.message);}};
  for(const button of $('casework-plans').querySelectorAll('[data-plan-fix]'))button.onclick=async()=>{try{await sendTeams('fix '+button.dataset.planFix,true,incidentView.capture(data.incident.id));}catch(error){notice(error.message);}};
  $('casework-qa').innerHTML=(view.qa||[]).map(q=>'<p><b>QA '+e(q.status)+'</b> · '+e(q.id)+(q.current===false?' · historical result; review again':'')+(q.result?'<br>Local branch '+e(q.result.branch)+' · '+e(q.result.commit)+'<br>'+e(q.result.summary)+(typeof q.result.patch==='string'&&q.result.patch&&!q.result.patch.endsWith('\n')?'<br><small class="coordination-warning">This earlier patch export lacks its final newline. Regenerate the patch from the saved commit before applying it; the branch and test results remain retained.</small>':''):'')+(q.error?'<br>'+e(q.error):'')+'</p>').join('');
  renderAssociationActions(data,view);
}
function renderDetail(data){const incidentId=data.incident.id;const sameIncident=$('detail').dataset.incident===incidentId;$('incident-teams-controls').disabled=false;$('detail').setAttribute('aria-busy','false');const assessmentOpen=sameIncident&&$('detail').querySelector('details[data-section="assessment"]')?.open;const evidenceOpen=sameIncident&&$('detail').querySelector('details[data-section="evidence"]')?.open;const workOpen=sameIncident&&$('detail').querySelector('details[data-section="work"]')?.open;$('detail').dataset.incident=incidentId;$('detail-title').textContent=data.incident.title;$('detail').innerHTML='<p>Investigation · '+e(data.incident.status)+'</p>'+assessmentMarkup(data.incident.analysis,data.jobs?.some(job=>['pending','running'].includes(job.status))?'Waiting for the current investigation to finish…':data.jobs?.some(job=>job.status==='dead')?'Investigation stopped. Review the error before retrying.':'Investigation queued. Waiting for the worker…',assessmentOpen)+signalMarkup(data.signalDigest)+'<h3>Recovery eligibility</h3><p>'+e(data.rollback.eligible?'Recent compatible artifact available. Request a proposal in Teams, then explicitly approve it.':data.rollback.reasons.join(' '))+'</p><details data-section="evidence"'+(evidenceOpen?' open':'')+'><summary>'+data.evidence.length+' evidence records · '+data.deployments.length+' release records</summary><pre>'+e(JSON.stringify({evidence:data.evidence,deployments:data.deployments},null,2))+'</pre></details>';$('question').hidden=false;
renderCasework(data);
$('teams-thread').textContent='Incident thread: '+incidentId;
const reports=data.evidence.filter(x=>x.kind==='responder_update').slice(0,8).reverse();
$('responder-timeline').innerHTML=reports.map(x=>'<div class="outgoing"><b>'+e(x.content.displayName||x.content.userId)+'</b> <small>'+e(new Date(x.observed_at).toLocaleTimeString())+' · reported, unverified</small><p>'+e(x.content.text)+'</p></div>').join('')||'<p>No responder updates recorded for this incident.</p>';
renderConversation(data);renderCoordination(data.collaboration);
const jobs=data.jobs||[],dead=jobs.filter(job=>job.status==='dead');
const options=dead.map(job=>'<option value="'+e(job.id)+'">'+e(job.id.slice(0,12))+' · '+e(job.attempts)+' failed attempts</option>').join('');
if($('retry-job').innerHTML!==options){const prior=$('retry-job').value;$('retry-job').innerHTML=options;if(dead.some(job=>job.id===prior))$('retry-job').value=prior;}
$('retry-work').hidden=!dead.length;
if(jobs.length){const progress=dead.length?'Needs attention':jobs.some(job=>job.status==='running')?'Working':jobs.some(job=>job.status==='pending')?'Queued':data.assessmentStatus&&data.assessmentStatus.state!=='current'?'Review needed':'Up to date';$('detail').innerHTML+='<details data-section="work"'+(workOpen?' open':'')+'><summary>Investigation progress · '+e(progress)+'</summary><p>Support session: '+e(data.session.agent_id)+'</p>'+jobs.slice(0,6).map(job=>'<p><span class="badge '+(job.status==='dead'?'warn':'')+'">'+e(job.status)+'</span> '+e(job.id.slice(0,12))+' · '+e(job.attempts)+' attempts'+(job.error?'<br><small>'+e(job.error)+'</small>':'')+'</p>').join('')+'</details>'; }
if(data.retries?.length)$('detail').innerHTML+='<h3>Operator retries</h3>'+data.retries.slice(0,4).map(item=>'<p>'+e(item.requested_by.kind)+' · '+e(new Date(item.created_at).toLocaleString())+'<br>'+e(item.reason)+'</p>').join('');
}
function renderOperations(report){
  if(!report)return;
  const label=report.state==='healthy'?'Operating':report.state==='starting'?(report.pendingSources.some(item=>item.source==='incident assessment')?'Awaiting review':'Waiting for polling'):'Needs attention';
  if($('operations-state').textContent!==label)$('operations-state').textContent=label;
  $('operations-state').className='badge '+(report.conditions.length?'warn':'');
  $('operations-note').textContent=report.note;
  const html=report.conditions.length?'<ul>'+report.conditions.map(item=>'<li>'+e(item.serviceKey?item.serviceKey+': ':'')+e(item.message)+(item.count?' · '+e(item.count)+' affected':'')+(item.incidentId?' <button type="button" class="secondary" data-health-incident="'+e(item.incidentId)+'">Open investigation</button>':'')+'</li>').join('')+'</ul>':report.pendingSources.length?(report.pendingSources.every(item=>item.source==='incident assessment')?'<p>Waiting for current incident assessments to complete.</p>':'<p>Waiting for complete checks from '+e(report.pendingSources.map(item=>item.source).join(', '))+'.</p>'):'<p>No agent operational conditions need attention.</p>';
  if($('operations-conditions').innerHTML!==html)$('operations-conditions').innerHTML=html;
  for(const button of $('operations-conditions').querySelectorAll('[data-health-incident]'))button.onclick=()=>{void selectIncident(button.dataset.healthIncident);};
}
function renderConnection(connection,status) {
  const checkpoint=connection.checkpoint?JSON.parse(connection.checkpoint):null;
  const health=connection.health||{state:checkpoint?.error?'needs-attention':connection.enabled?'configured':'offline',detail:checkpoint?.error||connection.service};
  const labels={'needs-attention':'Needs attention',starting:'Starting',healthy:'Recent read',configured:'Configured',offline:'Offline'};
  const count=status.counts.find(item=>item.source===connection.source)?.count||0;
  if(connection.transport==='mcp-mock')return '<div class="connector"><b>ServiceNow</b><span class="badge '+(checkpoint?.error?'warn':'')+'">'+(checkpoint?.error?'Needs attention':'Mock MCP')+'</span><p>'+count+' events</p><small>'+e(checkpoint?.error||'45 read-only tools · fictional records')+'</small></div>';
  if(status.simulation&&!connection.enabled)return '<div class="connector"><b>'+e(connection.source)+'</b><span class="badge">Fixtures</span><p>'+count+' events</p><small>Fictional payloads · live reader disabled</small></div>';
  return '<div class="connector"><b>'+e(connection.source)+'</b><span class="badge '+(health.state==='needs-attention'?'warn':'')+'">'+e(labels[health.state]||health.state)+'</span><p>'+count+' events</p><small>'+e(health.detail)+'</small></div>';
}
function renderSimulationGuide(status){
  const guide=status.simulation&&status.simulationGuide;
  simulationGuide=guide&&[guide.primaryId,guide.providerId].every(id=>status.incidents.some(i=>i.id===id))&&[guide.primaryRoot,guide.providerRoot].every(root=>(status.simulationConversations||[]).some(room=>room.id===root))?guide:null;
  $('simulation-guide').hidden=!simulationGuide;if(!simulationGuide)return;
  $('simulation-guide-title').textContent=simulationGuide.title;$('simulation-guide-note').textContent=simulationGuide.note;
  $('simulation-eu').onclick=()=>{void selectIncident(simulationGuide.primaryId);};$('simulation-us').onclick=()=>{void selectIncident(simulationGuide.providerId);};
}
async function readStatus(){
  const status=await api('/api/status');
  if(refreshErrorNotice!==null&&refreshErrorNotice===noticeGeneration)notice('');
  refreshErrorNotice=null;return status;
}
async function refresh(){if(loading)return;loading=true;try{const s=await readStatus();simulatedConversation=s.simulationConversationId;agentMode=s.agentMode;const priorRoom=$('teams-room').value;const roomOptions=(s.simulationConversations||[]).map(room=>'<option value="'+e(room.id)+'">'+e(room.name)+'</option>').join('');if($('teams-room').innerHTML!==roomOptions){$('teams-room').innerHTML=roomOptions;if((s.simulationConversations||[]).some(room=>room.id===priorRoom))$('teams-room').value=priorRoom;}const roomNames=new Map((s.conversations||[]).map(room=>[room.id,room.name]));renderSimulationGuide(s);renderOperations(s.operations);$('auth').hidden=true;$('mode').textContent=s.mode==='trial'?'Claude CLI · mock connectors':s.mode+' / '+s.agentMode+' analysis';$('simulation-note').textContent=s.agentMode==='claude'?'Real Claude Code (claude -p) investigates fictional provider evidence using your CLI login. Teams and rollback execution are simulated.':'Offline rules investigate synthetic connector payloads. No vendor or model calls.';$('simulator').hidden=!s.simulation;$('local-teams').hidden=!s.simulation;$('teams-mode').textContent='Teams: '+s.teamsMode;$('connection-note').textContent=s.simulation?(s.agentMode==='claude'?'Mock data · real Claude analysis · simulated actions':'Offline fixtures · live access not validated'):'Configured access · check polling results';const stats=[['Active issues',s.incidents.filter(x=>x.status!=='resolved').length],['Database events',s.counts.reduce((n,x)=>n+Number(x.count),0)],['Queued / running',s.jobs.filter(x=>['pending','running'].includes(x.status)).length],['Concurrent workers',s.workerConcurrency]];$('stats').innerHTML=stats.map(([label,value])=>'<div class="stat"><span>'+label+'</span><strong>'+value+'</strong></div>').join('');$('connections').innerHTML=s.connections.map(x=>renderConnection(x,s)).join('');$('incidents').innerHTML=s.incidents.length?s.incidents.map(i=>'<button class="incident '+(selected===i.id?'active':'')+'" data-id="'+e(i.id)+'"><span class="badge">'+e(i.status)+'</span><strong>'+e(i.title)+'</strong><small>'+e(i.id)+'</small></button>').join(''):'<p>No incidents yet. Simulate a failure to start an investigation.</p>';$('incidents').querySelectorAll('button').forEach(b=>b.onclick=()=>{void selectIncident(b.dataset.id);});const expandedMessages=new Set([...$('outbox').querySelectorAll('details[open][data-message-id]')].map(item=>item.dataset.messageId));$('outbox').innerHTML=[...new Map([...(s.attentionOutbox||[]),...s.outbox].map(m=>[m.id,m])).values()].slice(0,12).map(m=>'<div class="outgoing"><span class="badge">'+e(m.status)+'</span> <small>'+e(m.incident_id||'Teams command')+' → '+e(deliveryRecipientLabel(m,roomNames))+'</small>'+messageMarkup(m,expandedMessages.has(String(m.id)),expandedMessages.has(String(m.id)+':original'))+(m.error?'<small>'+e(m.error)+'</small>':'')+(m.deliveryInspection?'<p class="delivery-inspection-summary">Operator reported '+e(m.deliveryInspection.finding.replaceAll('_',' '))+' · follow-up '+e(m.deliveryInspection.followUp)+(m.deliveryInspection.current?' · current snapshot':' · historical; review current facts')+'. Transport remains '+e(m.status)+'.</p>':'')+(s.deliveryInspectionVersion===1&&['unknown','failed'].includes(m.status)?'<button type="button" class="secondary" data-inspect-delivery="'+e(m.id)+'">Inspect delivery</button>':'')+'</div>').join('')||'<p>Messages will be saved here before Teams delivery.</p>';for(const button of $('outbox').querySelectorAll('[data-inspect-delivery]'))button.onclick=()=>deliveryInspections.open(button.dataset.inspectDelivery);deliveryInspections.observe(s);$('rollbacks').innerHTML=s.rollbacks.map(r=>'<div class="rollback"><strong>'+e(r.id)+'</strong> <span class="badge warn">'+e(r.status)+'</span><p>'+e(r.error||'Target '+r.proposal.target.sha)+'</p>'+(s.simulation&&r.status==='pending'?'<button type="button" class="secondary" data-approval-id="'+e(r.id)+'">Use approval command</button>':'')+'</div>').join('');$('rollbacks').querySelectorAll('[data-approval-id]').forEach(button=>button.onclick=()=>{const proposal=s.rollbacks.find(r=>r.id===button.dataset.approvalId);const command=proposal?.proposal.approvalText?.match(/^An authorized approver must send: (approve .+)$/m)?.[1];if(!command)return;void selectIncident(proposal.incident_id);const origin=proposal.proposal.conversationId||'';$('teams-room').value=origin.split(';messageid=')[0];$('teams-surface').value=origin.includes(';messageid=')?'channel':'groupChat';$('teams-intent').value='direct';renderTeamsFields();$('teams-text').value=command;$('teams-text').focus();notice('Review the proposal target and selected identity, then Send message to submit this exact approval.');refresh();});void detail();}catch(error){notice(error.message);refreshErrorNotice=noticeGeneration;}finally{loading=false;}}
const forms={
  auth:async()=>{token=$('token').value;$('token').value='';await refresh();},
  seed:async()=>{const d=await api('/api/dev/seed',{scenario:$('scenario').value});void selectIncident(d.incidentId);notice('Synthetic events saved. The worker will investigate them.');await refresh();},
  question:async scope=>{
    const text=$('question-text').value;await api('/api/incidents/'+scope.incidentId+'/questions',{text});
    clearSubmitted(scope,'question-text',text);notifyCurrent(scope,'Question saved and queued for '+(agentMode==='claude'?'Claude':'the worker')+'.');
    if(incidentView.isCurrent(scope))await detail({fresh:true});void refresh();
  },
  'retry-work':async scope=>{
    const jobId=$('retry-job').value,reason=$('retry-reason').value;
    if(!retryIntent||retryIntent.incidentId!==scope.incidentId||retryIntent.jobId!==jobId||retryIntent.reason!==reason)retryIntent={incidentId:scope.incidentId,jobId,reason,requestId:crypto.randomUUID()};
    const retry=retryIntent,result=await api('/api/incidents/'+scope.incidentId+'/jobs/'+jobId+'/retry',{requestId:retry.requestId,reason});
    if(retryIntent===retry)retryIntent=null;clearSubmitted(scope,'retry-reason',reason);
    notifyCurrent(scope,'Investigation retry accepted as '+result.replacementJobId.slice(0,12)+'. The failed attempt is preserved.');
    if(incidentView.isCurrent(scope))await detail({fresh:true});void refresh();
  },
  teams:async scope=>{
    const kind=$('teams-intent').value,text=$('teams-text').value;
    const prefix=kind==='report'?'report '+$('teams-state').value+' ':['work','theory'].includes(kind)?kind+' '+$('teams-key').value+' '+$(kind==='work'?'teams-work-state':'teams-theory-state').value+' ':'';
    await sendTeams(prefix+text,kind!=='background',scope);clearSubmitted(scope,'teams-text',text);
  },
};
for(const [id,fn] of Object.entries(forms))$(id).onsubmit=async event=>{
  event.preventDefault();const button=event.target.querySelector('button');let scope,work;
  try{if(!['auth','seed'].includes(id))scope=incidentView.capture();work=beginButton(button);await fn(scope);}
  catch(error){if(!scope||incidentView.isCurrent(scope))notice(error.message);}
  finally{if(work)finishButton(button,work);}
};
async function sendTeams(text,mentioned=true,scope=incidentView.capture()){
  if(!incidentView.isCurrent(scope)||!simulatedConversation)throw Error('Wait for the selected incident context before sending a message.');
  const userId=$('teams-user').value;
  const displayName=({alex:'Alex',sam:'Sam',avery:'Avery',noor:'Noor',robin:'Robin'})[userId]||'Local operator';
  const conversationType=$('teams-surface').value,root=$('teams-room').value||simulatedConversation;
  const conversationId=conversationType==='channel'?root+';messageid='+BigInt('0x'+scope.incidentId.slice(4)).toString():root;
  const result=await api('/api/dev/teams',{text,mentioned,userId,displayName,conversationType,conversationId,expectedIncidentId:scope.incidentId});
  notifyCurrent(scope,result.ignored?'Message ignored. Link this incident and wait for its confirmation before sending responder updates.':'Simulated message saved. Check the responder timeline and outbox after processing.');
  return result;
}
$('teams-join').onclick=async()=>{try{const scope=incidentView.capture();await sendTeams('join '+scope.incidentId,true,scope);}catch(error){notice(error.message);}};
$('rollback-request').onclick=async()=>{
  const button=$('rollback-request');let scope,work;
  try{scope=incidentView.capture();work=beginButton(button);await sendTeams('rollback '+scope.incidentId,true,scope);}
  catch(error){if(!scope||incidentView.isCurrent(scope))notice(error.message);}
  finally{if(work)finishButton(button,work,true);if(scope&&incidentView.isCurrent(scope))await detail({fresh:true});void refresh();}
};
$('teams-sync').onclick=async()=>{try{await sendTeams('sync');}catch(error){notice(error.message);}};
$('teams-leave').onclick=async()=>{try{await sendTeams('leave');}catch(error){notice(error.message);}};
function renderTeamsFields(){const kind=$('teams-intent').value;$('teams-report-fields').hidden=kind!=='report';$('teams-ledger-fields').hidden=!['work','theory'].includes(kind);$('teams-work-fields').hidden=kind!=='work';$('teams-theory-fields').hidden=kind!=='theory';$('teams-key').required=['work','theory'].includes(kind);}
$('teams-intent').onchange=renderTeamsFields;
$('teams-ack').onclick=async()=>{
  try {
    const scope=incidentView.capture();
    if(coordinationView?.incidentId!==scope.incidentId)throw Error('Select an incident and wait for its coordination view before acknowledging.');
    const root=$('teams-room').value||simulatedConversation,type=$('teams-surface').value;
    const conversationId=type==='channel'?root+';messageid='+BigInt('0x'+scope.incidentId.slice(4)).toString():root;
    const briefing=coordinationView.rooms.find(room=>room.conversationId===conversationId)?.briefing;
    if(!briefing)throw Error('Link this group to the selected incident and sync before acknowledging its briefing.');
    await sendTeams('ack '+briefing.generation,true,scope);
  } catch(error){notice(error.message);}
};
$('casework-plan').onclick=async()=>{
  const button=$('casework-plan');let scope,work;
  try{scope=incidentView.capture();work=beginButton(button);const plan=await api('/api/incidents/'+scope.incidentId+'/plans',{});notifyCurrent(scope,'Fix ticket '+plan.id+' saved. Review it before requesting local QA.');if(incidentView.isCurrent(scope))await detail({fresh:true});}
  catch(error){if(!scope||incidentView.isCurrent(scope))notice(error.message);}
  finally{if(work)finishButton(button,work,caseworkHeld||!caseworkReviewCurrent);}
};
$('casework-track').onsubmit=async event=>{
  event.preventDefault();let scope;
  try{
    scope=incidentView.capture();caseworkTrackBusy=scope;$('casework-track-submit').disabled=true;
    const result=await api('/api/incidents/'+scope.incidentId+'/changes',{provider:$('change-provider').value,number:$('change-number').value});
    notifyCurrent(scope,(result.duplicate?'Already tracking ':'Tracking ')+result.provider+' #'+result.number+' for '+scope.incidentId+'. Linking is context, not a causal finding or action approval.');
    if(incidentView.isCurrent(scope))await detail({fresh:true});
  }catch(error){if(!scope||incidentView.isCurrent(scope))notice(error.message);}
  finally{if(caseworkTrackBusy===scope)caseworkTrackBusy=null;$('casework-track-submit').disabled=caseworkHeld||trackingBusy();}
};
$('change-correction-cancel').onclick=resetChangeMutation;
$('casework-correct').onsubmit=async event=>{
  event.preventDefault();const intent=changeMutationIntent;
  if(!intent||!incidentView.isCurrent(intent.scope)){notice('Review the current relationship before recording a correction.');return;}
  changeMutationBusy=intent.scope;$('change-correction-submit').disabled=true;
  try{
    const result=await api('/api/incidents/'+intent.incidentId+'/changes/'+intent.action,{provider:intent.provider,number:intent.number,reason:$('change-correction-reason').value,...(intent.action==='withdraw'?{expectedEvidenceId:intent.reference}:{reconsiderEvidenceId:intent.reference})});
    if(changeMutationIntent===intent)resetChangeMutation();
    notifyCurrent(intent.scope,(result.duplicate?'Already recorded: ':'Recorded: ')+result.provider+' #'+result.number+' association '+result.status+' for '+intent.incidentId+'. Its audit and provider facts remain retained.');
    if(incidentView.isCurrent(intent.scope))await detail({fresh:true});
  }catch(error){notifyCurrent(intent.scope,error.message);}
  finally{if(changeMutationBusy===intent.scope)changeMutationBusy=null;$('change-correction-submit').disabled=caseworkHeld||correctionBusy();}
};
await refresh();setInterval(refresh,3000);
