import {createIncidentView} from './incident-view.js';
import {visibleConversation} from './conversation-history.js';
import {createTeamsRequestView,createTeamsHistoryView} from './teams-request.js';
import {createQaHistoryView} from './qa-history.js';
import {createDeliveryInspectionView,deliveryRecipientLabel} from './delivery-inspection.js';

let token='',selected=null,loading=false,simulatedConversation=null,retryIntent=null,authNotice=null,agentMode='rules',coordinationView=null,simulationGuide=null;
let refreshErrorNotice=null,noticeGeneration=0,teamsGeneration=0,teamsDraftGeneration=0;
let recoveryEpoch=0,recoveryState={active:false,restoreId:null,questionsHeld:false},rollbackAvailable=false;
let quotaHold=null;
const $=id=>document.getElementById(id);
const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,body){const recoveryRead=recoveryEpoch;const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok){if(r.status===401){$('auth').hidden=false;authNotice=data.error;}throw Object.assign(Error(data.error),{status:r.status});}if(authNotice!==null){if($('notice').textContent===authNotice)notice('');authNotice=null;}if(Object.hasOwn(data,'recovery'))observeRecovery(data.recovery,recoveryRead);return data;}
const notice=text=>{$('notice').textContent=text;noticeGeneration++;};
function renderModelQuota(hold){
  const active=hold?.state==='held';$('model-quota').hidden=!active;
  if(!active){quotaHold=null;return;}
  if(quotaHold?.id!==hold.id)$('model-quota-reason').value='';
  quotaHold=hold;
  $('model-quota-description').textContent=(hold.provider==='claude-cli'?'Claude':'Codex')+' reached its account usage limit. '+(hold.resetLabel?'Provider reset label: '+hold.resetLabel+'.':'The provider supplied no reset time.');
}
function observeRecovery(value,readEpoch){
  const valid=value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.active==='boolean'&&typeof value.questionsHeld==='boolean'&&(value.restoreId===null||typeof value.restoreId==='string'&&/^[A-Za-z0-9._:-]{1,160}$/.test(value.restoreId))&&(!value.active||value.restoreId!==null)&&(!value.questionsHeld||value.active);
  const next=valid?{active:value.active,restoreId:value.restoreId,questionsHeld:value.questionsHeld}:{active:true,restoreId:null,questionsHeld:true,unavailable:true};
  // A response started before a newly observed hold cannot clear that hold.
  // A later read must confirm release; local time is not an ordering proof.
  if(valid&&readEpoch!==recoveryEpoch&&(!next.active||recoveryState.questionsHeld&&!next.questionsHeld))return;
  if(JSON.stringify(next)!==JSON.stringify(recoveryState))recoveryEpoch++;
  recoveryState=next;renderRecovery();
}
function requireRecoveryAccess(action){
  if(recoveryState.active&&(action!=='question'||recoveryState.questionsHeld))throw Error(recoveryState.unavailable?'Recovery status is unavailable. Actions are paused until a fresh read succeeds.':'Database restore hold: Teams commands, fix actions and manual retries are paused until an operator reconciles the missing history. Saved replies and tickets remain readable.');
}
function renderRecovery(){
  const state=recoveryState,held=state.active,ready=Boolean(selected&&$('detail').dataset.incident===selected);
  const text=state.unavailable?'Recovery status is unavailable. Actions are paused until the service confirms its state.':held?'Database restore hold · '+state.restoreId+'. Saved history remains available. Teams command processing, message delivery, new fix plans, QA, approvals and deployments are held.':'';
  const question=held?(state.questionsHeld?'Model investigations and new questions are paused. Saved replies and tickets remain readable.':'You can ask the rules investigator to review restored evidence. Its reply does not reconcile missing history or release the hold.'):'';
  for(const [id,value]of[['recovery-hold-message',text],['recovery-hold-note',held?'An operator must reconcile the missing interval and release the hold. Restarting or reading an old message does not release it.':''],['question-recovery-note',question],['teams-recovery-note',held?'Teams commands are paused during restore reconciliation. Your unsent draft is retained.':''],['casework-recovery-note',held?'Saved tickets and evidence remain readable. New plans, QA requests and change-link actions are held.':''],['retry-recovery-note',held?(state.questionsHeld?'Manual retries and model work are held during restore reconciliation.':'Manual retries are held during restore reconciliation. A new read-only rules question can review the retained evidence.'):'']])if($(id).textContent!==value)$(id).textContent=value;
  for(const id of ['recovery-hold','question-recovery-note','teams-recovery-note','casework-recovery-note'])$(id).hidden=!held;
  $('retry-recovery-note').hidden=!held||$('retry-work').hidden;
  $('incident-teams-controls').disabled=!ready||held;
  $('rollback-request').disabled=held||!rollbackAvailable||buttonWork.has($('rollback-request'));
  $('question').querySelector('button').disabled=state.questionsHeld||buttonWork.has($('question').querySelector('button'));
  $('retry-work').querySelector('button').disabled=held||buttonWork.has($('retry-work').querySelector('button'));
  $('casework-plan').disabled=held||caseworkHeld||!caseworkReviewCurrent||buttonWork.has($('casework-plan'));
  $('casework-track-submit').disabled=held||caseworkHeld||trackingBusy();
  $('change-correction-submit').disabled=held||caseworkHeld||correctionBusy();
  teamsRequests.render();teamsHistory.render();qaHistory.render();
}

const deliveryInspections=createDeliveryInspectionView({element:$,load:api,save:api,refreshStatus:refresh,onError:error=>notice(error.message)});
const draftFields=['question-text','retry-reason','teams-text','teams-key','teams-intent','teams-state','teams-work-state','teams-theory-state','teams-room','teams-surface','teams-user','change-provider','change-number'];
const incidentDrafts=new Map();let initialDraft;
const questionIntents=new Map();
const teamsIntents=new Map();
function teamsIntent(body){const key=JSON.stringify(body);let intent=teamsIntents.get(key);if(!intent){intent={key,requestId:crypto.randomUUID(),confirmed:false};teamsIntents.set(key,intent);}return intent;}
function retireTeamsIntent(intent){if(teamsIntents.get(intent.key)===intent)teamsIntents.delete(intent.key);}
function confirmTeamsIntent(intent,result){
  if(result.requestId!==intent.requestId||!Number.isSafeInteger(result.requestedAt)||result.requestedAt<0||typeof result.duplicate!=='boolean'||result.commandQueued!==((result.ignored===true||result.duplicate)?0:1))throw Error('The saved message request identity could not be confirmed. Your draft is retained; check the responder timeline and outbox before sending again.');
  const first=!intent.confirmed&&teamsIntents.get(intent.key)===intent;intent.confirmed=true;retireTeamsIntent(intent);return first;
}
function questionIntent(scope,text){
  let pending=questionIntents.get(scope.incidentId);if(!pending){pending=new Map();questionIntents.set(scope.incidentId,pending);}
  let intent=pending.get(text);if(!intent){intent={incidentId:scope.incidentId,text,requestId:crypto.randomUUID()};pending.set(text,intent);}return intent;
}
function questionDraftValue(id){return selected===id?$('question-text').value:incidentDrafts.get(id)?.values['question-text'];}
function removeQuestionIntent(intent){const pending=questionIntents.get(intent.incidentId);if(pending?.get(intent.text)===intent){pending.delete(intent.text);if(!pending.size)questionIntents.delete(intent.incidentId);}}
function confirmQuestion(scope,intent,receipt){
  if(receipt?.requestId!==intent.requestId||receipt.incidentId!==intent.incidentId||!/^[a-f0-9]{64}$/.test(receipt.eventId||'')||!/^[a-f0-9]{64}$/.test(receipt.jobId||'')||!Number.isSafeInteger(receipt.requestedAt)||receipt.requestedAt<0||typeof receipt.duplicate!=='boolean'||receipt.queued!==(receipt.duplicate?0:1))throw Error('The saved question identity could not be confirmed. Your draft is retained; retry with the same request.');
  if(questionIntents.get(intent.incidentId)?.get(intent.text)!==intent)return false;
  intent.confirmed=true;clearSubmitted(scope,'question-text',intent.text);
  if(questionDraftValue(intent.incidentId)!==intent.text)removeQuestionIntent(intent);
  return true;
}
$('question-text').oninput=()=>{
  const pending=questionIntents.get(selected);if(!pending)return;
  for(const intent of pending.values())if(intent.confirmed&&intent.text!==$('question-text').value)removeQuestionIntent(intent);
};

const buttonWork=new WeakMap();
function beginButton(button){const work={};buttonWork.set(button,work);button.disabled=true;return work;}
function finishButton(button,work,disabled=false){if(buttonWork.get(button)===work){buttonWork.delete(button);button.disabled=disabled;renderRecovery();}}
function selectIncident(id){
  if(id!==selected){
    initialDraft||=Object.fromEntries(draftFields.map(key=>[key,$(key).value]));
    if(selected){let scope;try{scope=incidentView.capture();}catch{}incidentDrafts.set(selected,{scope,values:Object.fromEntries(draftFields.map(key=>[key,$(key).value]))});}
    const saved=incidentDrafts.get(id)?.values,draft=saved||initialDraft;for(const key of draftFields)$(key).value=draft[key];
    if(!saved&&simulationGuide){const root=id===simulationGuide.primaryId?simulationGuide.primaryRoot:id===simulationGuide.providerId?simulationGuide.providerRoot:null;if(root){$('teams-room').value=root;$('teams-surface').value='channel';}}
    selected=id;retryIntent=null;resetChangeMutation();touchTeamsTarget();notice('');renderTeamsFields();
    for(const button of $('incidents').querySelectorAll('button'))button.classList.toggle('active',button.dataset.id===id);
  }
  return incidentView.select(id);
}
function unavailableIncident(id,message='Loading the selected incident. Actions are paused until its context is ready.'){
  $('detail').dataset.incident='';$('detail').setAttribute('aria-busy','true');$('detail').innerHTML='<p>'+e(message)+'</p>';
  $('detail-title').textContent='Investigation '+id;$('analysis-progress').textContent='';
  for(const key of ['conversation','question','retry-work','casework','coordination'])$(key).hidden=true;
  rollbackAvailable=false;$('incident-teams-controls').disabled=true;buttonWork.delete($('rollback-request'));$('rollback-request').disabled=true;
  for(const form of ['question','retry-work','teams'])for(const button of $(form).querySelectorAll('button')){buttonWork.delete(button);button.disabled=false;}
  buttonWork.delete($('casework-plan'));
  $('teams-thread').textContent='Waiting for incident context: '+id;$('responder-timeline').innerHTML='';coordinationView=null;teamsRequests.render();teamsHistory.render();qaHistory.render();
}
const incidentView=createIncidentView({
  load:id=>api('/api/incidents/'+id),render:renderDetail,pending:id=>unavailableIncident(id),
  onError:(error,id)=>{unavailableIncident(id,'The selected incident could not be loaded. Actions are paused while it is retried.');notice(error.message);},
});
const detail=options=>incidentView.refresh(options);
const teamsSelection=()=>({incidentId:selected,ready:Boolean(selected&&$('detail').dataset.incident===selected),recovery:recoveryState});
const teamsRequests=createTeamsRequestView({element:$,read:api,selection:teamsSelection});
const teamsHistory=createTeamsHistoryView({element:$,read:api,selection:teamsSelection,onOpen:(id,item)=>teamsRequests.openRecorded(id,item)});
const qaHistory=createQaHistoryView({element:$,read:api,selection:teamsSelection});
const notifyCurrent=(intent,text)=>{if(incidentView.isCurrent(intent))notice(text);};
const teamsTargetFields=['teams-room','teams-surface','teams-user','teams-intent','teams-state','teams-key','teams-work-state','teams-theory-state'];
const captureTeamsTarget=()=>({generation:teamsGeneration,draftGeneration:teamsDraftGeneration,values:teamsTargetFields.map(id=>$(id).value)});
const currentTeamsTarget=target=>target.generation===teamsGeneration&&target.values.every((value,n)=>value===$(teamsTargetFields[n]).value);
function clearTeamsFeedback(){const feedback=$('teams-feedback');if(feedback.textContent&&$('notice').textContent===feedback.textContent)notice('');feedback.textContent='';feedback.hidden=true;}
function touchTeamsTarget(){teamsGeneration++;clearTeamsFeedback();}
function notifyTeams(scope,target,text){if(incidentView.isCurrent(scope)&&currentTeamsTarget(target)){const feedback=$('teams-feedback');feedback.textContent=text;feedback.hidden=!text;notice(text);}}
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
  $('coordination-rooms').innerHTML=view.rooms.map(room=>'<article class="room-card"><h3>'+e(room.name)+'</h3><span class="badge">Latest state report: '+e(room.reportedStatus||'not provided')+(room.statusCurrentForAuthor===false?' · historical; responder updated elsewhere':'')+(room.statusStale?' · old report':'')+'</span>'+(room.statusAt?'<small> · '+e(new Date(room.statusAt).toLocaleTimeString())+'</small>':'')+(room.briefing?'<p>Briefing #'+e(room.briefing.generation)+' · '+e(room.briefing.deliveryStatus)+' · '+(room.briefing.acknowledged?'receipt acknowledged':'awaiting acknowledgement')+'<br><small>Receipt does not establish agreement or approval.</small></p>':'<p>No shared briefing delivered yet.</p>')+(room.stateReports||[]).map(report=>'<p><b>State claim · '+e(report.state)+'</b><br>'+e(report.author)+' · '+e(new Date(report.at).toLocaleTimeString())+' · unverified'+(report.currentForAuthor===false?' · historical; responder updated elsewhere':'')+(report.stale?' · old claim':'')+'<br>'+e(report.text)+'</p>').join('')+ledger(room.theories,'Theory')+ledger(room.work,'Work')+room.reports.filter(report=>![...(room.work||[]),...(room.theories||[])].some(item=>item.evidenceId===report.evidenceId)).slice(0,6).map(report=>'<p><b>'+e(report.author)+'</b> · '+e(new Date(report.at).toLocaleTimeString())+' · unverified<br>'+e(report.text)+'</p>').join('')+(room.omittedReportAuthors?'<p>'+e(room.omittedReportAuthors)+' participant reports are outside this summary. Ask for the missing context.</p>':'')+(!room.reports.length?'<p>No delivered report. Ask for this team’s owner, action and next check.</p>':'')+'</article>').join('');
  $('coordination-next').textContent=view.nextStep+(view.rooms.length<2&&(view.otherIncidentLinks||[]).length?' Another group follows a different incident; use sync to check incident identity before combining their work.':'');
}
function renderConversation(data){
  const expanded=new Set([...$('conversation-messages').querySelectorAll('details[open][data-turn-id]')].map(item=>item.dataset.turnId));
  $('conversation').hidden=false;
  const questions=new Map((data.conversation||[]).filter(turn=>turn.role==='operator').map(turn=>[turn.id,turn]));
  const historyView=visibleConversation(data);
  const questionContext=turn=>{const question=questions.get(turn.inReplyTo);if(!question)return '';const text=Array.from(String(question.text||''));return '<p class="reply-context"><small>In reply to '+e(question.name||'Operator')+': '+e(text.slice(0,320).join(''))+(text.length>320?'…':'')+'</small></p>';};
  $('conversation-messages').innerHTML=historyView.turns.map(turn=>'<article class="chat-turn '+e(turn.role)+'"><b>'+e(turn.role==='assistant'?(turn.mode==='claude'?'Claude':turn.mode==='rules'?'Rules assessment':turn.mode||'Agent'):turn.name)+'</b> <small>'+e(new Date(turn.at).toLocaleTimeString())+(turn.role==='assistant'&&Number.isSafeInteger(turn.revision)?' · revision '+e(turn.revision)+(turn.matchesCurrentAssessment?' · current snapshot':'')+(turn.orderingUncertain?' · same revision and timestamp':''):'')+'</small>'+(turn.id===historyView.pinnedCurrentId?'<p class="snapshot-order-note"><small>Current assessment retained here despite its earlier recorded time.</small></p>':'')+questionContext(turn)+'<p>'+e(turn.summary||turn.text)+'</p>'+(turn.role==='assistant'?'<details data-turn-id="'+e(turn.id)+'"'+(expanded.has(turn.id)?' open':'')+'><summary>Read full reply</summary><pre>'+e(turn.text)+'</pre></details>':'')+'</article>').join('')||'<p>Your questions and the agent’s replies will appear here.</p>';
  const jobs=data.jobs||[],active=jobs.find(job=>job.status==='running')||jobs.find(job=>job.status==='pending'),failed=jobs.find(job=>job.status==='dead');
  const progress=recoveryState.questionsHeld?'Model investigations are paused by the database restore hold. Saved replies remain readable.':active?(active.status==='running'?(agentMode==='claude'?'Claude is investigating. A response can take up to two minutes.':'The worker is investigating.'):active.error?'Analysis retry queued: '+active.error:'Investigation queued.')+(data.incident.analysis?' The assessment below is the last completed reply.':''):failed?'Investigation needs attention: '+failed.error:agentMode==='claude'&&data.incident.analysis?.mode!=='claude'?'This is an earlier rules assessment. Ask a question to investigate with Claude.':'';
  const reviewNote=data.assessmentStatus?.state==='outdated'?'New evidence is waiting for review. The assessment below predates that update. Ask for a current review if no investigation is queued.':data.assessmentStatus?.state==='unverified'?'This saved assessment has no matching review record. Ask for a current review before planning a fix.':data.assessmentStatus?.state==='missing'?'No completed assessment is available yet.':'';
  const contactNote=data.casework?.assessmentContactsCurrent===false?'Contact evidence in this saved reply has changed. Use the current recommendations under Owners and fix plan.':'';
  const live=active?.status==='running'&&data.session?.remote_state?.progress;
  const liveNote=live?.preview?'Claude progress (provisional): '+live.preview:live?'Claude is examining the evidence.':'';
  $('analysis-progress').textContent=[progress,liveNote,recoveryState.questionsHeld?'The current evidence still requires review after reconciliation.':reviewNote,contactNote].filter(Boolean).join(' ');
  rollbackAvailable=data.rollback.eligible&&!active&&(!data.assessmentStatus||data.assessmentStatus.state==='current');$('rollback-request').disabled=recoveryState.active||!rollbackAvailable||buttonWork.has($('rollback-request'));
}
function assessmentMarkup(analysis,waiting,expanded){
  if(!analysis)return '<p>'+e(waiting)+'</p>';
  const next=(analysis.nextSteps||[]).slice(0,3);
  const locations=(analysis.codeFindings||[]).slice(0,4).map(f=>'<li><code>'+e(f.path)+':'+e(f.lineStart)+(f.lineEnd!==f.lineStart?'–'+e(f.lineEnd):'')+'</code> · '+e(f.sha.slice(0,12))+'<br>'+e(f.explanation)+'</li>').join('');
  return '<p class="assessment-summary">'+e(analysis.summary)+'</p>'+(locations?'<h3>Candidate source locations</h3><ul>'+locations+'</ul>':'')+'<p>Outage outlook: '+e(analysis.risk?.likelihood||'unknown')+' · Confidence: '+e(analysis.risk?.confidence||'unknown')+'</p>'+(next.length?'<h3>Next checks</h3><ul class="assessment-next">'+next.map(step=>'<li>'+e(step)+'</li>').join('')+'</ul>':'')+'<details data-section="assessment"'+(expanded?' open':'')+'><summary>Full assessment and evidence limitations</summary><pre>'+e(analysis.text)+'</pre></details>';
}
function signalMarkup(digest){
  if(!digest)return '';
  const scope=digest.incidentScope,scopeNote=scope?.state==='reported'?'Reported monitor impact scope: '+scope.environment+' / '+scope.region+' / '+scope.version+(Number.isSafeInteger(scope.observedAt)?' · observed '+new Date(scope.observedAt).toLocaleString():'')+'. Other regions/releases remain dependency alternatives; scope is not cause or recovery proof.':scope?'Monitor impact scope is unverified. Service-level samples may describe several incidents.':'',c=digest.coverage,limited=c.candidateWindowLimited||c.recordsNotScanned||c.partialResults||c.omittedGroups||c.missingTimestamps||c.invalidRecords||c.inconsistentMetadataRecords||c.omittedChanges||digest.changes.length>4;
  return '<section aria-label="Signals and change history"><h3>Signals and change history</h3><p>'+e(c.recordsScanned)+' observed log records · '+e(c.duplicateObservations)+' overlapping observations grouped · '+Math.min(4,digest.groups.length)+' of '+(digest.groups.length+(c.omittedGroups||0))+' sample groups shown'+(limited?' · limited coverage':'')+'</p>'+(scopeNote?'<p>'+e(scopeNote)+'</p>':'')+(c.inconsistentMetadataRecords?'<p>'+e(c.inconsistentMetadataRecords)+' records have unverified log fields. Inspect the original source aliases before selecting a cause or automatic patch.</p>':'')+digest.groups.slice(0,4).map(group=>'<p><b>'+e(group.level)+' · '+e(group.code||group.errorType||(group.statusCode?'HTTP '+group.statusCode:'Unclassified'))+'</b> · '+e(group.observations)+' observed signatures'+(scope?.state==='reported'?' · '+e(group.scopeRelation==='matching'?'matches reported scope':group.scopeRelation==='different'?'different reported scope':'scope unknown'):'')+(group.metadataIssues?.length?'<br><strong>Unverified log fields: '+e(group.metadataIssues.join(', '))+'</strong>':'')+'<br>'+e([group.entity||'entity unknown',group.environment||'environment unknown',group.region||'region unknown',group.operation||'operation unknown',group.version||'release unknown'].join(' / '))+'<br>'+e(group.message)+'</p>').join('')+(!digest.groups.length?'<p>No log groups in this evidence window. This does not establish health.</p>':'')+digest.changes.slice(0,4).map(change=>'<p><b>'+e(change.provider)+' '+e(change.comparisonKind)+(change.mergeRequest?.number?' · '+e(change.provider==='gitlab'?'MR !':'PR #')+e(change.mergeRequest.number):'')+'</b> · '+e(change.baseSha?.slice(0,12)||'base unknown')+' → '+e(change.headSha?.slice(0,12)||'head unknown')+' · '+(change.complete?'provider comparison marked complete':'comparison incomplete')+'<br>'+e(change.paths.join(', ')||'Source paths unavailable')+'</p>').join('')+'<p><small>Showing '+Math.min(4,digest.changes.length)+' of '+(digest.changes.length+(c.omittedChanges||0))+' comparisons in this candidate window.</small></p><small>'+e(digest.interpretation)+'</small><details><summary>Signal coverage and commit history</summary><pre>'+e(JSON.stringify(digest,null,2))+'</pre></details></section>';
}
const sourceLocationId=file=>'source-file-'+[file.project,file.sha,file.path,file.contentHash].join('|');
function reportedLocationsMarkup(locations=[]){return locations.length?'<p>Reported log locations (runtime and cause unverified): '+locations.map(location=>'evidence '+e(location.evidenceId)+' · record '+e(location.recordIndex+1)+' · line '+e(location.line)).join('; ')+'</p>':'';}
function reportedLogCoverageMarkup(data){
  if(!data.sourceScope?.logLocations)return '';
  const packages=data.evidence.filter(row=>row.source==='gitlab'&&row.kind==='source_locations'&&row.content?.logSource?.project===data.sourceScope.project).map(row=>row.content.logSource.coverage||{});
  const sum=key=>packages.reduce((n,c)=>n+(Number.isSafeInteger(c[key])&&c[key]>=0?c[key]:0),0),available=sum('recordsAvailable'),scanned=sum('recordsScanned');
  return '<p>Reported-location collection: '+e(scanned)+'/'+e(available)+' retained log records examined across '+e(packages.length)+' packages; '+e(sum('locationsOmitted'))+' locations outside selection and '+e(sum('unavailableLocations'))+' outside retrieved line bounds. Packages may overlap; these are not failure counts or complete history. Unverified or unmapped fields do not supply a source location.</p>';
}
function evidenceReadsMarkup(data,opened=false){
  const events=data.evidence.filter(row=>row.source==='system'&&row.kind==='evidence_read'&&row.content?.version===1),groups=new Map();
  for(const row of events){const c=row.content,key=c.requestId||row.id,prior=groups.get(key),terminal=!['started','derived-source-started','discovery-started'].includes(c.phase);if(!prior||terminal)groups.set(key,{...c,at:row.observed_at,terminal});}
  const rows=[...groups.values()].sort((a,b)=>b.at-a.at).slice(0,10);if(!rows.length)return '';const time=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000?new Date(value).toISOString():'unverified time';
  return '<details data-section="followup-reads"'+(opened?' open':'')+'><summary>Host follow-up evidence · '+e(rows.length)+'/'+e(groups.size)+' retained groups shown</summary><p>Read proposals and outcomes in this bounded snapshot. Missing outcomes are unknown, not proof that a read never happened or is still running. These records do not grant action approval or verify recovery.</p><ol>'+rows.map(row=>{const r=row.request,target=r?.kind==='gitlab_file'?(r.project?r.project+' / ':'')+String(r.path||'unverified path')+' @ '+String(r.sha||'').slice(0,12)+' · lines '+r.startLine+'–'+r.endLine:r?.kind==='gitlab_tree'?(r.project?r.project+' / ':'')+(r.path||'[repository root]')+' @ '+String(r.sha||'').slice(0,12)+' · directory inventory':r?.kind==='dynatrace_logs'?'Service logs '+time(r.from)+' → '+time(r.to):row.phase?.startsWith('discovery-')?'Explore approved source candidates; runtime mapping unverified':'Apply configured error-location mapping';return '<li><strong>'+e(row.phase)+'</strong> · '+e(target)+'<p>'+e(String(r?.reason||row.reason||'').slice(0,220))+'</p>'+(row.error?'<p>'+e(row.error)+'</p>':'')+(row.coverage?.complete===false?'<p>Source coverage is partial or unavailable.</p>':'')+(!row.terminal?'<p>No retained outcome in this snapshot.</p>':'')+'</li>';}).join('')+'</ol></details>';
}
function sourceDiscoveryMarkup(summary){
 if(!summary)return '';const coverage=summary.coverage||{};
 return '<div aria-label="Candidate repository discovery"><h4>Candidate repository discovery · runtime mapping unverified</h4><p>Approved projects are a search boundary. Matches do not establish the running repository, deployment or cause.</p>'+summary.probes.map(probe=>'<p><b>'+e(probe.project)+'</b> · reported '+e(probe.reportedRef)+' → '+e(probe.sha?.slice(0,12)||'unknown revision')+' · '+e(probe.state)+'<br>'+e(probe.reportedPath)+' · '+(probe.inventoryObserved?e(probe.matchingPaths)+' filename matches'+(!probe.inventoryComplete?' · incomplete inventory':''):'inventory not observed; filename matches unknown')+'</p>').join('')+((coverage.unavailable||coverage.unavailableProbes||coverage.incompleteInventories||coverage.omittedMatches||coverage.hintsOmitted||coverage.unavailableFiles)?'<p>Discovery coverage is incomplete; denied, omitted or unavailable candidates remain unknown.</p>':'')+'</div>';
}
function sourceHistoryMarkup(summary,positions=new Map()){
 const histories=summary?.retainedHistories||[];if(!histories.length)return summary?.historyEnabled?'<p>Candidate file history is unavailable. Inspect missing metadata and read limits; missing history does not show that code is unchanged.</p>':'';
 const side=(label,view)=>view?'<p>'+e(label)+' · '+e(view.sha)+' · '+e(view.path)+'</p><pre>'+e(view.lines.map(line=>line.line+': '+line.text).join('\n'))+'</pre>'+(view.omittedLines?'<p>Further changed-span lines are outside this excerpt.</p>':''):'';
 return '<div aria-label="Candidate file history"><h4>Candidate file history · mapping and cause unverified</h4>'+histories.map(h=>{const key=[h.project,h.path,h.candidateSha,h.lastCommitSha].join('|');return '<details data-source-history="'+e(key)+'"'+(positions.has(key)?' open':'')+'><summary>'+e(h.project)+' · '+e(h.path)+' · '+e(h.state)+'</summary><p>Provider-reported last modifying candidate commit '+e(h.lastCommitSha)+(h.historical?' · prior retained observation':'')+'. This does not establish the running repository or cause.</p>'+(h.title?'<p>Commit title (untrusted metadata): '+e(h.title)+'</p>':'')+(h.error?'<p>'+e(h.error)+'</p>':'')+(h.parents||[]).map(parent=>'<p>Parent '+e(parent.parentSha)+' · '+e(parent.state)+(parent.delta?' · '+e(parent.delta):'')+'</p>'+side('Before',parent.before)+side('After',parent.after)).join('')+(h.parentsOmitted?'<p>Some parent versions are unavailable or outside the selection bound.</p>':'')+'<small>Host history evidence '+e(h.evidenceId)+'</small></details>';}).join('')+'</div>';
}
function sourceInventoryMarkup(window,positions=new Map()){
 if(!window?.inventories?.length)return '';const c=window.coverage||{};
 return '<section aria-label="Source directory observations"><h4>Retained source directory observations</h4><p>'+e(window.interpretation)+'</p>'+(window.historicalAfterRestore?'<p>Historical observations after database restoration; current provider access is unverified.</p>':'')+window.inventories.map(value=>{const key=[value.project,value.sha,value.path].join('|');return '<details data-source-inventory="'+e(key)+'"'+(positions.has(key)?' open':'')+'><summary>'+e(value.project)+' · '+e(value.path||'[repository root]')+' @ '+e(value.sha.slice(0,12))+'</summary><p>'+(value.conflicting?'Conflicting immutable directory observations; entries are withheld.':value.complete?'A retained complete witness covers this bounded inventory.':'Partial observations; a missing filename remains unknown.')+' '+e(value.entries.length)+'/'+e(value.entriesAvailable)+' retained entries shown'+(value.entriesOmitted?' · '+e(value.entriesOmitted)+' omitted':'')+'.</p>'+(value.observationsIncluded>1?'<p>'+e(value.observationsIncluded)+' retained observations considered. Every displayed path retains its supporting evidence references.</p>':'')+(value.latestObservationPartial&&value.complete?'<p>The latest observation is partial; the earlier complete witness is retained. This does not verify current provider access.</p>':'')+(value.conflictEvidenceOmitted||value.completenessEvidenceOmitted?'<p>Some supporting or conflicting evidence is outside this transport window; missing context remains unknown.</p>':'')+(value.mappingCandidate?'<p>Candidate project only; runtime mapping remains unverified.</p>':'')+'<pre>'+e(value.entries.map(entry=>entry.type+' '+entry.path+' · '+entry.id.slice(0,12)).join('\n'))+'</pre><small>Host inventory evidence '+e(value.evidenceId)+'</small>'+(value.observationsIncluded>1?'<details data-inventory-refs="'+e(key)+'"'+(positions.get(key)?.refsOpen?' open':'')+'><summary>Path evidence references</summary><ul>'+value.entries.map(entry=>'<li>'+e(entry.path)+' · '+e((entry.evidenceIds||[]).join(', '))+'</li>').join('')+'</ul></details>':'')+'</details>';}).join('')+(c.directoriesOmitted||c.entriesOmitted||c.unverified?'<p>Directory selection is bounded or contains unverified observations; omitted entries remain unknown.</p>':'')+'</section>';
}
function sourceMarkup(data,opened=new Set(),historyPositions=new Map(),inventoryPositions=new Map()){
  const source=data.sourceCode,findings=data.incident.analysis?.sourceFindings||[];
  if(!source&&!findings.length)return '';
  return '<section id="source-code" aria-label="Retrieved GitLab source"><h3>Retrieved GitLab source</h3><p>Read-only excerpts from configured or approved candidate projects and exact revisions. A verified location does not establish cause, deployment or action approval.</p>'+sourceDiscoveryMarkup(data.sourceDiscovery||data.incident.analysis?.sourceDiscovery)+sourceHistoryMarkup(data.sourceDiscovery||data.incident.analysis?.sourceDiscovery,historyPositions)+sourceInventoryMarkup(data.sourceInventories||data.incident.analysis?.sourceInventories,inventoryPositions)+reportedLogCoverageMarkup(data)+(source?'<p>'+e(source.coverage.filesIncluded)+' of '+e(source.coverage.filesAvailable)+' retained file versions shown · '+e(source.coverage.omittedLines)+' lines omitted'+(source.coverage.sourceWindowLimited?' · source window limited':'')+'</p>'+(source.historicalAfterRestore?'<p>These retained sources are historical after database restoration; they do not establish current runtime or mapping.</p>':'')+(source.coverage.sourceReadsUnavailable||source.coverage.sourceInventoryOmitted?'<p>Source collection is incomplete: '+e(source.coverage.sourceReadsUnavailable)+' unavailable sides and '+e(source.coverage.sourceInventoryOmitted)+' omitted inventory entries across retained packages. Inspect their source evidence before drawing conclusions.</p>':'')+(source.coverage.conflictingFiles?'<p><strong>Source identity conflict: retained responses disagree about the same file and revision. Location findings are withheld.</strong></p>':'')+(source.coverage.identityHistory?.unverifiedIdentities?'<p><strong>Stored source identity history is unverified; affected excerpts cannot support current verified citations.</strong></p>':'')+source.files.map(file=>{const key=[file.project,file.sha,file.path,file.contentHash].join('|');return '<details id="'+e(sourceLocationId(file))+'" data-source-file="'+e(key)+'"'+(opened.has(key)?' open':'')+'><summary>'+e(file.project)+' · '+e(file.path)+' @ '+e(file.sha.slice(0,12))+' · '+e(file.side==='history-parent'?'Parent source':file.side==='history-last-change'?'Last modifying source':file.side)+(file.conflicting?' · conflicting source identity':file.identityHistoryUnverified?' · source identity history unverified':'')+'</summary><p>Evidence '+e(file.evidenceId)+' · '+e(file.lines.length)+'/'+e(file.sourceLineCount)+' lines shown'+(file.redacted?' · redacted':'')+'</p>'+(file.mappingCandidate?'<p>Candidate repository/path only. Runtime mapping, deployment and cause remain unverified.</p>':'')+(file.historyRelation?'<p>Historical source for candidate '+e(file.historyRelation.candidatePath)+' @ '+e(file.historyRelation.candidateSha)+'. This is not a log-reported runtime location.</p>':'')+reportedLocationsMarkup(file.reportedLocations)+'<pre>'+e(file.lines.map(line=>line.line+': '+line.text).join('\n'))+'</pre></details>';}).join(''):'')+findings.map(f=>{const current=source?.files.some(file=>file.project===f.project&&file.sha===f.sha&&file.path===f.path&&file.contentHash===f.contentHash&&!file.conflicting&&!file.identityHistoryUnverified);return '<article><h4>'+ (current?'Source hypothesis · location verified':'Saved source hypothesis · current verification unavailable')+'</h4>'+(!current?'<p>The retained quote is historical: its source identity is conflicting, unverified or outside the current source window. Request a fresh source review before reusing the location.</p>':'')+'<p>'+e(f.project)+' · '+e(f.path)+':L'+e(f.startLine)+'-L'+e(f.endLine)+' @ '+e(f.sha)+'</p><p><a href="#'+e(encodeURIComponent(sourceLocationId(f)))+'" data-source-open="'+e(sourceLocationId(f))+'">Review retrieved source excerpt</a></p><pre>'+e(f.quote)+'</pre><p>'+e(f.explanation)+'</p><small>'+e(f.interpretation)+' Evidence '+e(f.evidenceId)+'.</small>'+reportedLocationsMarkup(f.reportedLogLocations)+'</article>';}).join('')+'</section>';
}
function deploymentMarkup(data){
  const window=data.deploymentWindow;if(!window)return '';
  const witnesses=data.signalDigest?.deployments||[],labels={current:'Latest stored success','incident-start':'At incident start',health:'Health witness',unsettled:'Unsettled observation','latest-observation':'Latest observation for this identity'};
  const warning=[window.identityWindowLimited?'Some deployment identities are outside this window.':'',window.incompleteIdentities?'Selected identity history is incomplete.':'',window.conflictingIdentities?'SHA or artifact records conflict.':'',window.statusConflictingIdentities?'Latest status observations conflict.':'',window.attestationConflictingIdentities?'Health or compatibility attestations conflict; request newer explicit evidence for the named fields.':'',window.currentBoundaryLimited?'Some tied latest releases could not be retained.':'',window.simulationScopeAmbiguous?'The simulation run cannot be selected reliably.':''].filter(Boolean).join(' ');
  return '<section aria-label="Stored release history"><h3>Stored release history</h3><p>'+e(window.factsSelected)+' facts selected from '+e(window.scopedRecords)+' scoped records · '+e(window.identitiesSelected)+' of '+e(window.identitiesAvailable)+' identities</p>'+(warning?'<p class="coordination-warning">'+e(warning)+'</p>':'')+witnesses.slice(0,6).map(row=>'<p><b>'+e((row.historyRoles||[]).map(role=>labels[role]).filter(Boolean).join(' · ')||'Stored observation')+'</b><br>'+e(row.provider)+' · '+e(row.environment)+' · '+e(row.sha?.slice(0,12)||'SHA unknown')+' · '+e(new Date(row.at).toLocaleString())+'<br>Observed status: '+e(row.status||'unknown')+' · latest retained status for this identity: '+e(row.latestStoredStatus||'unknown')+(row.identityConflict?' · SHA/artifact conflict':'')+(row.statusConflict?' · conflicting status':'')+(row.attestationConflicts?.length?' · attestation conflict: '+e(row.attestationConflicts.map(item=>item.field).join(', ')):'')+(row.historyIncomplete?' · incomplete identity history':'')+'</p>').join('')+'<p><small>'+Math.min(6,witnesses.length)+' witnesses shown. These are stored source observations. Live running state and provider completeness need separate verification; a health witness does not authorize recovery.</small></p></section>';
}
function messageMarkup(message,expanded,originalExpanded){
  const delivery=message.contactDelivery,attempt=message.deliveryAttempt,text=attempt?.text||delivery?.renderedText||message.text||'';
  const contactNote=delivery?'<small>Contact snapshot checked '+e(new Date(delivery.checkedAt).toLocaleString())+' for delivery attempt '+e(delivery.attempt)+'. Delivery status is shown above.</small>':attempt?.preparedAt?'<small>Teams send prepared '+e(new Date(attempt.preparedAt).toLocaleString())+' · attempt '+e(attempt.attempt)+'. Preparation does not establish delivery.</small>':'';
  const lateNote=attempt?.late?'<p class="coordination-warning">Late Teams '+e(attempt.late.kind==='receipt'?'receipt'+(attempt.late.remoteId?' '+attempt.late.remoteId.slice(0,120):''):'transport failure'+(attempt.late.httpStatus?' · HTTP '+attempt.late.httpStatus:''))+' recorded '+e(new Date(attempt.late.observedAt).toLocaleString())+'. Delivery state remains '+e(message.status)+'; inspect the conversation before retrying.</p>':'';
  const originalNote=text!==message.text?'<details data-message-id="'+e(message.id)+':original"'+(originalExpanded?' open':'')+'><summary>Original queued reply</summary><pre tabindex="0">'+e(message.text)+'</pre></details>':'';
  if(text.length<=900||text.includes('An authorized approver must send:'))return '<p>'+e(text)+'</p>'+contactNote+lateNote+originalNote;
  const firstLine=text.split('\n').find(line=>line.trim())||'';
  const preview=firstLine.length>600?firstLine.slice(0,600)+'…':firstLine;
  return '<p>'+e(preview)+'</p><details data-message-id="'+e(message.id)+'"'+(expanded?' open':'')+'><summary>View full message</summary><pre tabindex="0">'+e(text)+'</pre></details>'+contactNote+lateNote+originalNote;
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
    const latest=g.latest,state=latest.state==='status-unknown'?'Provider status unknown':latest.state==='conflicting'?'Conflicting update versions: '+latest.statuses.join(' / '):latest.state==='observed-version'?'Latest update version: '+latest.status:latest.state==='recorded'?'Recorded status: '+latest.status:latest.state==='identity-unknown'?'Run identity unknown; reports may cover multiple runs':'No comparable update version';
    const refs=g.relevance.references.map(r=>r.provider+' #'+r.number+(r.headRole?' · '+r.headRole:'')+(r.state==='historical'?' · historical relationship':'')).join('; ');
    return '<article class="change-history" data-history-group="'+e(g.id)+'"><p><b>'+e(g.provider)+' · '+e(g.run?g.run.label:g.changeNumber?'Change #'+g.changeNumber:g.stage)+'</b> <span class="badge'+(['conflicting','unversioned','identity-unknown','status-unknown'].includes(latest.state)?' warn':'')+'">'+e(g.stage)+'</span><br><code>'+e(g.headSha)+'</code></p><p class="change-relevance">'+e(g.relevance.label)+(refs?'<br>'+e(refs):'')+'</p><p>'+e(state)+(latest.at!==null?' · '+e(new Date(latest.at).toISOString()):'')+'<br>'+e(g.factCount)+(g.factCount===1?' source fact · ':' source facts · ')+e(g.observationCount)+(g.observationCount===1?' status/time observation in this window':' status/time observations in this window')+(g.unversionedCount?' · '+e(g.unversionedCount)+(g.unversionedCount===1?' report without an update version':' reports without an update version'):'')+'</p><small>'+e(g.note)+(g.ciVersionChecked?' Saved update versions were compared for this scoped run; live CI visibility remains unverified.':'')+(g.recordedBeforeRestore?' Some records predate database restoration.':'')+'</small><details data-change-history="'+e(g.id)+'"'+(open.has(g.id)?' open':'')+'><summary>Source references · '+g.sources.length+' of '+g.factCount+' shown</summary><ul>'+g.sources.map(r=>'<li><b>'+e(r.status)+'</b> · '+e(r.timeKind)+' time '+e(r.sourceAt===null?'unknown':new Date(r.sourceAt).toISOString())+'<br><small>Received '+e(new Date(r.receivedAt).toISOString())+' · source event <code>'+e(r.eventId)+'</code></small></li>').join('')+'</ul>'+(g.sourcesLimited?'<small>Further source references are retained in the database and the raw history window.</small>':'')+'</details></article>';
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
  const plansMarkup=(view.plans||[]).map(p=>'<article><p><b>'+e(p.id)+'</b> · incident revision '+e(p.revision)+(p.current===false?' · historical snapshot':'')+(p.contactsCurrent===false?' · contact snapshot changed; refresh before contacting':'')+'</p>'+(p.current===false?'<p class="coordination-warning">This ticket covers revision '+e(p.revision)+'; the incident is now at revision '+e(view.currentRevision)+'. Review the current assessment and draft a fresh ticket before requesting QA.</p>':p.assessmentCurrent===false?'<p class="coordination-warning">The current assessment changed after this ticket was drafted. Review it and draft a fresh ticket before requesting QA.</p>':'')+'<button type="button" class="secondary" data-plan-download="'+e(p.id)+'">Download Markdown</button> <button type="button" class="secondary" data-plan-fix="'+e(p.id)+'"'+(!p.payload.patch||p.current===false||p.assessmentCurrent===false||view.held?' disabled':'')+'>Request local QA</button><details data-plan-id="'+e(p.id)+'"><summary>Read fix ticket</summary><pre tabindex="0" aria-label="Markdown fix ticket '+e(p.id)+'">'+e(p.markdown)+'</pre></details></article>').join('')||'<p>Draft a ticket to capture evidence, contacts, acceptance checks and a proposed fix.</p>';
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
  qaHistory.observe(data.incident.id,{...view.qaHistory,items:view.qa||[]});
  renderAssociationActions(data,view);
}
function renderDetail(data){const incidentId=data.incident.id;const sameIncident=$('detail').dataset.incident===incidentId;$('incident-teams-controls').disabled=false;$('detail').setAttribute('aria-busy','false');const assessmentOpen=sameIncident&&$('detail').querySelector('details[data-section="assessment"]')?.open;const evidenceOpen=sameIncident&&$('detail').querySelector('details[data-section="evidence"]')?.open;const workOpen=sameIncident&&$('detail').querySelector('details[data-section="work"]')?.open;const sourcePositions=new Map(sameIncident?Array.from($('detail').querySelectorAll('details[data-source-file][open]')).map(node=>[node.dataset.sourceFile,node.querySelector('pre')?.scrollTop||0]):[]);const sourceOpen=new Set(sourcePositions.keys());const historyPositions=new Map(sameIncident?Array.from($('detail').querySelectorAll('details[data-source-history][open]')).map(node=>[node.dataset.sourceHistory,Array.from(node.querySelectorAll('pre')).map(pre=>pre.scrollTop)]):[]);const inventoryPositions=new Map(sameIncident?Array.from($('detail').querySelectorAll('details[data-source-inventory][open]')).map(node=>[node.dataset.sourceInventory,{scrollTop:node.querySelector('pre')?.scrollTop||0,refsOpen:Boolean(node.querySelector('details[data-inventory-refs]')?.open)}]):[]);const evidenceReadsOpen=sameIncident&&$('detail').querySelector('details[data-section="followup-reads"]')?.open;$('detail').dataset.incident=incidentId;$('detail-title').textContent=data.incident.title;$('detail').innerHTML='<p>Investigation · '+e(data.incident.status)+'</p>'+assessmentMarkup(data.incident.analysis,recoveryState.questionsHeld?'Model investigation is paused by the database restore hold. Saved history remains available.':data.jobs?.some(job=>['pending','running'].includes(job.status))?'Waiting for the current investigation to finish…':data.jobs?.some(job=>job.status==='dead')?'Investigation stopped. Review the error before retrying.':'Investigation queued. Waiting for the worker…',assessmentOpen)+signalMarkup(data.signalDigest)+sourceMarkup(data,sourceOpen,historyPositions,inventoryPositions)+evidenceReadsMarkup(data,evidenceReadsOpen)+deploymentMarkup(data)+'<h3>Recovery eligibility</h3><p>'+e(data.rollback.eligible?'Recent compatible artifact available. Request a proposal in Teams, then explicitly approve it.':data.rollback.reasons.join(' '))+'</p><details data-section="evidence"'+(evidenceOpen?' open':'')+'><summary>'+data.evidence.length+' evidence records · '+data.deployments.length+' release records</summary><pre>'+e(JSON.stringify({evidence:data.evidence,deployments:data.deployments},null,2))+'</pre></details>';$('question').hidden=false;
renderCasework(data);
$('teams-thread').textContent='Incident thread: '+incidentId;
const reports=data.evidence.filter(x=>x.kind==='responder_update').slice(0,8).reverse();
$('responder-timeline').innerHTML=reports.map(x=>'<div class="outgoing"><b>'+e(x.content.displayName||x.content.userId)+'</b> <small>'+e(new Date(x.observed_at).toLocaleTimeString())+' · reported, unverified</small><p>'+e(x.content.text)+'</p></div>').join('')||'<p>No responder updates recorded for this incident.</p>';
renderConversation(data);renderCoordination(data.collaboration);
const jobs=data.jobs||[],dead=jobs.filter(job=>job.status==='dead');
const options=dead.map(job=>'<option value="'+e(job.id)+'">'+e(job.id.slice(0,12))+' · '+e(job.attempts)+' failed attempts</option>').join('');
if($('retry-job').innerHTML!==options){const prior=$('retry-job').value;$('retry-job').innerHTML=options;if(dead.some(job=>job.id===prior))$('retry-job').value=prior;}
$('retry-work').hidden=!dead.length;
if(jobs.length){const progress=recoveryState.questionsHeld?'Paused by restore hold':dead.length?'Needs attention':jobs.some(job=>job.status==='running')?'Working':jobs.some(job=>job.status==='pending')?'Queued':data.assessmentStatus&&data.assessmentStatus.state!=='current'?'Review needed':'Up to date';$('detail').innerHTML+='<details data-section="work"'+(workOpen?' open':'')+'><summary>Investigation progress · '+e(progress)+'</summary><p>Support session: '+e(data.session.agent_id)+'</p>'+jobs.slice(0,6).map(job=>'<p><span class="badge '+(job.status==='dead'?'warn':'')+'">'+e(job.status)+'</span> '+e(job.id.slice(0,12))+' · '+e(job.attempts)+' attempts'+(job.error?'<br><small>'+e(job.error)+'</small>':'')+'</p>').join('')+'</details>'; }
if(data.retries?.length)$('detail').innerHTML+='<h3>Operator retries</h3>'+data.retries.slice(0,4).map(item=>'<p>'+e(item.requested_by.kind)+' · '+e(new Date(item.created_at).toLocaleString())+'<br>'+e(item.reason)+'</p>').join('');
for(const node of $('detail').querySelectorAll('details[data-source-file]'))if(sourcePositions.has(node.dataset.sourceFile)&&node.querySelector('pre'))node.querySelector('pre').scrollTop=sourcePositions.get(node.dataset.sourceFile);
for(const node of $('detail').querySelectorAll('details[data-source-inventory][open]'))if(inventoryPositions.has(node.dataset.sourceInventory))node.querySelector('pre').scrollTop=inventoryPositions.get(node.dataset.sourceInventory)?.scrollTop||0;
for(const node of $('detail').querySelectorAll('details[data-source-history][open]'))if(historyPositions.has(node.dataset.sourceHistory))Array.from(node.querySelectorAll('pre')).forEach((pre,index)=>pre.scrollTop=historyPositions.get(node.dataset.sourceHistory)[index]||0);
for(const link of $('detail').querySelectorAll('[data-source-open]'))link.onclick=()=>{const target=document.getElementById(link.dataset.sourceOpen);if(target instanceof HTMLDetailsElement){target.open=true;target.scrollIntoView({block:'center'});}};
renderRecovery();
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
  const count=connection.eventCount,validCount=typeof count==='number'?Number.isSafeInteger(count)&&count>=0:typeof count==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(count),countText=validCount?e(count)+' retained event'+(String(count)==='1'?'':'s'):'Retained event count unavailable';
  const title={dynatrace:'Dynatrace',dynatraceLogs:'Dynatrace logs',github:'GitHub',gitlab:'GitLab',jira:'Jira',servicenow:'ServiceNow'}[connection.source]||connection.source;
  if(connection.transport==='mcp-mock')return '<div class="connector"><b>ServiceNow</b><span class="badge '+(checkpoint?.error?'warn':'')+'">'+(checkpoint?.error?'Needs attention':'Mock MCP')+'</span><p>'+countText+'</p><small>'+e(checkpoint?.error||'45 read-only tools · fictional records')+'</small></div>';
  if(status.simulation&&!connection.enabled)return '<div class="connector"><b>'+e(title)+'</b><span class="badge">Fixtures</span><p>'+countText+'</p><small>Fictional payloads · live reader disabled</small></div>';
  return '<div class="connector"><b>'+e(title)+'</b><span class="badge '+(health.state==='needs-attention'?'warn':'')+'">'+e(labels[health.state]||health.state)+'</span><p>'+countText+'</p><small>'+e(health.detail)+'</small></div>';
}
function renderConnections(status){
  const groups=new Map();for(const connection of status.connections){let group=groups.get(connection.service);if(!group){group={service:(status.services||[]).find(service=>service.key===connection.service)||{key:connection.service,name:connection.service},connections:[]};groups.set(connection.service,group);}group.connections.push(connection);}
  return [...groups.values()].map(({service,connections},index)=>'<section class="connection-service" aria-labelledby="integration-service-'+index+'"><h3 id="integration-service-'+index+'">'+e(service.name||service.key)+'</h3><p class="connection-scope">'+e(service.key)+(service.environment?' · '+e(service.environment):'')+'</p><div class="connection-grid">'+connections.map(connection=>renderConnection(connection,status)).join('')+'</div></section>').join('');
}
function renderSimulationGuide(status){
  const guide=status.simulation&&status.simulationGuide;
  const available=(id,root)=>status.incidents.some(i=>i.id===id)&&(status.simulationConversations||[]).some(room=>room.id===root);
  simulationGuide=guide&&available(guide.primaryId,guide.primaryRoot)&&(!guide.providerId||available(guide.providerId,guide.providerRoot))?guide:null;
  $('simulation-guide').hidden=!simulationGuide;if(!simulationGuide)return;
  $('simulation-guide-title').textContent=simulationGuide.title;$('simulation-guide-note').textContent=simulationGuide.note;
  $('simulation-eu').textContent=simulationGuide.primaryLabel||'Open EU bidding incident';$('simulation-us').hidden=!simulationGuide.providerId;$('simulation-us').textContent=simulationGuide.providerLabel||'Open separate US provider incident';
  $('simulation-eu').onclick=()=>{void selectIncident(simulationGuide.primaryId);};$('simulation-us').onclick=()=>{void selectIncident(simulationGuide.providerId);};
}
async function readStatus(){
  const status=await api('/api/status');
  if(refreshErrorNotice!==null&&refreshErrorNotice===noticeGeneration)notice('');
  refreshErrorNotice=null;return status;
}
let outboxMarkup=null;
function renderOutbox(status,roomNames){
  const s=status,root=$('outbox'),html=[...new Map([...(s.attentionOutbox||[]),...s.outbox].map(m=>[m.id,m])).values()].slice(0,12).map(m=>'<div class="outgoing"><span class="badge">'+e(m.status)+'</span> <small>'+e(m.incident_id||'Teams command')+' → '+e(deliveryRecipientLabel(m,roomNames))+'</small>'+messageMarkup(m,false,false)+(m.error?'<small>'+e(m.error)+'</small>':'')+(m.deliveryInspection?'<p class="delivery-inspection-summary">Operator reported '+e(m.deliveryInspection.finding.replaceAll('_',' '))+' · follow-up '+e(m.deliveryInspection.followUp)+(m.deliveryInspection.current?' · current snapshot':' · historical; review current facts')+'. Transport remains '+e(m.status)+'.</p>':'')+(s.deliveryInspectionVersion===1&&['unknown','failed'].includes(m.status)?'<button type="button" class="secondary" data-inspect-delivery="'+e(m.id)+'">Inspect delivery</button>':'')+'</div>').join('')||'<p>Messages will be saved here before Teams delivery.</p>';
  if(html===outboxMarkup)return;
  const reading=new Map([...root.querySelectorAll('details[data-message-id]')].map(item=>{const pre=item.querySelector('pre');return [item.dataset.messageId,{open:item.open,text:pre.textContent,top:pre.scrollTop,left:pre.scrollLeft,focus:document.activeElement===item.querySelector('summary')?'summary':document.activeElement===pre?'pre':null}];}));
  const inspectionFocus=document.activeElement?.dataset?.inspectDelivery;
  root.innerHTML=html;outboxMarkup=html;
  for(const item of root.querySelectorAll('details[data-message-id]')){const saved=reading.get(item.dataset.messageId);if(!saved)continue;item.open=saved.open;const pre=item.querySelector('pre');if(pre.textContent===saved.text){pre.scrollTop=saved.top;pre.scrollLeft=saved.left;}if(saved.focus)item.querySelector(saved.focus).focus({preventScroll:true});}
  for(const button of root.querySelectorAll('[data-inspect-delivery]')){button.onclick=()=>deliveryInspections.open(button.dataset.inspectDelivery);if(button.dataset.inspectDelivery===inspectionFocus)button.focus({preventScroll:true});}
}
async function refresh(){if(loading)return;loading=true;try{const s=await readStatus();renderModelQuota(s.modelQuota);simulatedConversation=s.simulationConversationId;agentMode=s.agentMode;const priorRoom=$('teams-room').value;const roomOptions=(s.simulationConversations||[]).map(room=>'<option value="'+e(room.id)+'">'+e(room.name)+'</option>').join('');if($('teams-room').innerHTML!==roomOptions){$('teams-room').innerHTML=roomOptions;if((s.simulationConversations||[]).some(room=>room.id===priorRoom))$('teams-room').value=priorRoom;}const roomNames=new Map((s.conversations||[]).map(room=>[room.id,room.name]));renderSimulationGuide(s);renderOperations(s.operations);$('auth').hidden=true;$('mode').textContent=s.mode==='trial'?'Claude CLI · mock connectors':s.mode+' / '+s.agentMode+' analysis';$('simulation-note').textContent=s.agentMode==='claude'?'Real Claude Code (claude -p) investigates fictional provider evidence using your CLI login. Teams and rollback execution are simulated.':'Offline rules investigate synthetic connector payloads. No vendor or model calls.';$('simulator').hidden=!s.simulation||s.agentDevelopment;$('local-teams').hidden=!s.simulation||s.agentDevelopment;if(s.agentDevelopment){$('mode').textContent='Claude agent / supplied context';$('lab-link').hidden=true;$('integration-status').hidden=true;$('runtime-footer').textContent='Claude agent development · Supplied evidence · Deployments disabled';$('casework-plan').textContent='Draft issue spec (Markdown)';}$('teams-mode').textContent='Teams: '+s.teamsMode;$('connection-note').textContent=s.simulation?(s.agentMode==='claude'?'Mock data · real Claude analysis · simulated actions':'Offline fixtures · live access not validated'):'Configured access · check polling results';const stats=[['Active issues',s.incidents.filter(x=>x.status!=='resolved').length],['Database events',s.counts.reduce((n,x)=>n+Number(x.count),0)],['Queued / running',s.jobs.filter(x=>['pending','running'].includes(x.status)).length],['Concurrent workers',s.workerConcurrency]];$('stats').innerHTML=stats.map(([label,value])=>'<div class="stat"><span>'+label+'</span><strong>'+value+'</strong></div>').join('');$('connections').innerHTML=renderConnections(s);$('incidents').innerHTML=s.incidents.length?s.incidents.map(i=>'<button class="incident '+(selected===i.id?'active':'')+'" data-id="'+e(i.id)+'"><span class="badge">'+e(i.status)+'</span><strong>'+e(i.title)+'</strong><small>'+e(i.id)+'</small></button>').join(''):(s.agentDevelopment?'<p>No incidents yet. Supply scoped evidence through an approved profile, or explicitly load an evaluation case from the development command.</p>':'<p>No incidents yet. Simulate a failure to start an investigation.</p>');$('incidents').querySelectorAll('button').forEach(b=>b.onclick=()=>{void selectIncident(b.dataset.id);});renderOutbox(s,roomNames);deliveryInspections.observe(s);$('rollbacks').innerHTML=s.rollbacks.map(r=>'<div class="rollback"><strong>'+e(r.id)+'</strong> <span class="badge warn">'+e(r.status)+'</span><p>'+e(r.error||'Target '+r.proposal.target.sha)+'</p>'+(s.simulation&&r.status==='pending'?'<button type="button" class="secondary" data-approval-id="'+e(r.id)+'">Use approval command</button>':'')+'</div>').join('');$('rollbacks').querySelectorAll('[data-approval-id]').forEach(button=>button.onclick=()=>{const proposal=s.rollbacks.find(r=>r.id===button.dataset.approvalId);const command=proposal?.proposal.approvalText?.match(/^An authorized approver must send: (approve .+)$/m)?.[1];if(!command)return;void selectIncident(proposal.incident_id);const origin=proposal.proposal.conversationId||'';$('teams-room').value=origin.split(';messageid=')[0];$('teams-surface').value=origin.includes(';messageid=')?'channel':'groupChat';$('teams-intent').value='direct';renderTeamsFields();$('teams-text').value=command;$('teams-text').focus();notice('Review the proposal target and selected identity, then Send message to submit this exact approval.');refresh();});void detail();}catch(error){notice(error.message);refreshErrorNotice=noticeGeneration;}finally{loading=false;}}
const forms={
  auth:async()=>{token=$('token').value;$('token').value='';await refresh();},
  'model-quota-resume':async()=>{
    const hold=quotaHold,reason=$('model-quota-reason').value;
    if(!hold)throw Error('No current model quota hold; refresh its status.');
    await api('/api/agent/quota/resume',{holdId:hold.id,reason});
    if(quotaHold?.id===hold.id){quotaHold=null;$('model-quota').hidden=true;$('model-quota-reason').value='';}
    notice('Quota hold released. Refreshing the current queue status.');await refresh();
  },
  seed:async()=>{const d=await api('/api/dev/seed',{scenario:$('scenario').value});void selectIncident(d.incidentId);notice('Synthetic events saved. The worker will investigate them.');await refresh();},
  question:async scope=>{
    const text=$('question-text').value,intent=questionIntent(scope,text);
    const result=await api('/api/incidents/'+scope.incidentId+'/question-requests',{text,requestId:intent.requestId}).catch(error=>{throw Error(error.message+' Question saving could not be confirmed. The retry ID stays in this open tab. Retry the original question text to confirm the same request.');});
    if(confirmQuestion(scope,intent,result)){
      const message=result.duplicate?'Question already saved; this retry did not queue another investigation.':result.recovery?.questionsHeld?'Question saved. Model work is paused by the database restore hold.':result.recovery?.active?'Question saved for read-only rules review. The database restore hold remains active.':'Question saved and queued for '+(agentMode==='claude'?'Claude':'the worker')+'.';
      const suffix=result.duplicate&&result.recovery?.active?' The database restore hold remains active.':'';
      notifyCurrent(scope,message+suffix+(questionDraftValue(scope.incidentId)?' Your newer draft remains unsent.':''));
    }
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
    const result=await sendTeams(prefix+text,kind!=='background',scope);if(!result.retainDraft)clearSubmitted(scope,'teams-text',text);
  },
};
for(const [id,fn] of Object.entries(forms))$(id).onsubmit=async event=>{
  event.preventDefault();const button=event.target.querySelector('button');let scope,work;
  try{if(!['auth','seed','model-quota-resume'].includes(id)){scope=incidentView.capture();requireRecoveryAccess(id==='question'?'question':'action');}work=beginButton(button);await fn(scope);}
  catch(error){if(!scope||incidentView.isCurrent(scope))notice(error.message);}
  finally{if(work)finishButton(button,work);}
};
async function sendTeams(text,mentioned=true,scope=incidentView.capture()){
  const target=captureTeamsTarget();
  let intent;
  try{
  if(!incidentView.isCurrent(scope)||!simulatedConversation)throw Error('Wait for the selected incident context before sending a message.');
  requireRecoveryAccess('teams');
  const userId=$('teams-user').value;
  const displayName=({alex:'Alex',sam:'Sam',avery:'Avery',noor:'Noor',robin:'Robin'})[userId]||'Local operator';
  const conversationType=$('teams-surface').value,root=$('teams-room').value||simulatedConversation;
  const conversationId=conversationType==='channel'?root+';messageid='+BigInt('0x'+scope.incidentId.slice(4)).toString():root;
  const body={text,mentioned,userId,displayName,conversationType,conversationId,expectedIncidentId:scope.incidentId};intent=teamsIntent(body);teamsRequests.remember(scope.incidentId,body,intent);
  const result=await api('/api/dev/teams/requests',{...body,requestId:intent.requestId});
  if(result.ignored===true){const first=confirmTeamsIntent(intent,result);teamsRequests.acknowledge(scope.incidentId,intent,result);if(first)notifyTeams(scope,target,result.duplicate?'The earlier message was ignored. This retry did not record it. Your draft is retained. If this group is now linked and its confirmation has arrived, send again to record a new message.':'Message ignored. Your draft is retained. Link this incident and wait for its confirmation before sending responder updates.');return {...result,retainDraft:true};}
  const receipt=result.commandReceipt;
  if(!receipt||receipt.version!==1||receipt.id!==result.eventId||!/^[a-f0-9]{64}$/.test(receipt.id||'')||receipt.conversationId!==conversationId||!(receipt.incidentId===null||receipt.incidentId===scope.incidentId))throw Error('The message incident binding could not be confirmed. Your draft is retained; check the responder timeline and outbox before sending again.');
  const first=confirmTeamsIntent(intent,result);teamsRequests.acknowledge(scope.incidentId,intent,result);
  const unbound=receipt.incidentId===null,joining=text.trim().split(/\s+/).join(' ').toLowerCase()==='join '+scope.incidentId;
  const held=result.recovery?.active?' Command processing and replies remain paused by the database restore hold.':'';
  const draftChanged=target.draftGeneration!==teamsDraftGeneration;
  if(first)notifyTeams(scope,target,(unbound&&!joining?'Message '+(result.duplicate?'already saved':'saved')+' without an incident link. It was not recorded as an incident update. Your draft is retained. Link this incident, wait for confirmation, then send it again.'+held:joining?'Join request '+(result.duplicate?'already saved':'saved')+'. Wait for the linked confirmation before sending incident updates.'+held:result.recovery?.active?'Simulated message saved while the database restore hold is active. Command processing and replies remain paused until reconciliation.':'Simulated message '+(result.duplicate?'already saved':'saved')+' for '+scope.incidentId+'. '+(result.duplicate?'This retry did not add another command. ':'')+'Check the responder timeline and outbox after processing.')+(draftChanged?' Your newer draft remains unsent.':''));
  return {...result,retainDraft:!first||unbound&&!joining||!currentTeamsTarget(target)||draftChanged};
  }catch(error){const rejected=Number.isInteger(error.status)&&error.status>=400&&error.status<500&&error.status!==429;if(intent&&rejected)retireTeamsIntent(intent);notifyTeams(scope,target,error.message+(intent&&!rejected?' The response could not be confirmed. Your draft is retained. Keep this page open and retry the same message to check whether it was saved; changing it sends a new message.':''));return {retainDraft:true,error};}
}
$('teams-join').onclick=async()=>{try{const scope=incidentView.capture();await sendTeams('join '+scope.incidentId,true,scope);}catch(error){notice(error.message);}};
$('rollback-request').onclick=async()=>{
  const button=$('rollback-request');let scope,work;
  try{scope=incidentView.capture();requireRecoveryAccess('teams');work=beginButton(button);await sendTeams('rollback '+scope.incidentId,true,scope);}
  catch(error){if(!scope||incidentView.isCurrent(scope))notice(error.message);}
  finally{if(work)finishButton(button,work,true);if(scope&&incidentView.isCurrent(scope))await detail({fresh:true});void refresh();}
};
$('teams-sync').onclick=async()=>{try{await sendTeams('sync');}catch(error){notice(error.message);}};
$('teams-leave').onclick=async()=>{try{await sendTeams('leave');}catch(error){notice(error.message);}};
function renderTeamsFields(){const kind=$('teams-intent').value;$('teams-report-fields').hidden=kind!=='report';$('teams-ledger-fields').hidden=!['work','theory'].includes(kind);$('teams-work-fields').hidden=kind!=='work';$('teams-theory-fields').hidden=kind!=='theory';$('teams-key').required=['work','theory'].includes(kind);}
for(const id of teamsTargetFields)$(id).onchange=()=>{touchTeamsTarget();if(id==='teams-intent')renderTeamsFields();};
$('teams-key').oninput=touchTeamsTarget;
$('teams-text').oninput=()=>{teamsDraftGeneration++;};
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
  try{scope=incidentView.capture();requireRecoveryAccess('casework');work=beginButton(button);const plan=await api('/api/incidents/'+scope.incidentId+'/plans',{});notifyCurrent(scope,'Fix ticket '+plan.id+' saved. Review it before requesting local QA.');if(incidentView.isCurrent(scope))await detail({fresh:true});}
  catch(error){if(!scope||incidentView.isCurrent(scope))notice(error.message);}
  finally{if(work)finishButton(button,work,caseworkHeld||!caseworkReviewCurrent);}
};
$('casework-track').onsubmit=async event=>{
  event.preventDefault();let scope;
  try{
    scope=incidentView.capture();requireRecoveryAccess('casework');caseworkTrackBusy=scope;$('casework-track-submit').disabled=true;
    const result=await api('/api/incidents/'+scope.incidentId+'/changes',{provider:$('change-provider').value,number:$('change-number').value});
    notifyCurrent(scope,(result.duplicate?'Already tracking ':'Tracking ')+result.provider+' #'+result.number+' for '+scope.incidentId+'. Linking is context, not a causal finding or action approval.');
    if(incidentView.isCurrent(scope))await detail({fresh:true});
  }catch(error){if(!scope||incidentView.isCurrent(scope))notice(error.message);}
  finally{if(caseworkTrackBusy===scope)caseworkTrackBusy=null;renderRecovery();}
};
$('change-correction-cancel').onclick=resetChangeMutation;
$('casework-correct').onsubmit=async event=>{
  event.preventDefault();const intent=changeMutationIntent;
  if(!intent||!incidentView.isCurrent(intent.scope)){notice('Review the current relationship before recording a correction.');return;}
  changeMutationBusy=intent.scope;$('change-correction-submit').disabled=true;
  try{
    requireRecoveryAccess('casework');
    const result=await api('/api/incidents/'+intent.incidentId+'/changes/'+intent.action,{provider:intent.provider,number:intent.number,reason:$('change-correction-reason').value,...(intent.action==='withdraw'?{expectedEvidenceId:intent.reference}:{reconsiderEvidenceId:intent.reference})});
    if(changeMutationIntent===intent)resetChangeMutation();
    notifyCurrent(intent.scope,(result.duplicate?'Already recorded: ':'Recorded: ')+result.provider+' #'+result.number+' association '+result.status+' for '+intent.incidentId+'. Its audit and provider facts remain retained.');
    if(incidentView.isCurrent(intent.scope))await detail({fresh:true});
  }catch(error){notifyCurrent(intent.scope,error.message);}
  finally{if(changeMutationBusy===intent.scope)changeMutationBusy=null;renderRecovery();}
};
await refresh();setInterval(refresh,3000);
