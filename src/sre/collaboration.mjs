import {hash} from './security.mjs';
import {workHandoffs,handoffText} from './work-handoffs.mjs';
import {teamsRoot,teamsConversationAllowed,tenantAdmission} from './teams-access.mjs';
import {queueAttentionChecks} from './coordination-attention.mjs';

export const incidentConversationLimit=teams=>teams?.maxIncidentConversations??8;
export const rootConversation=teamsRoot;
export const reportedStates=Object.freeze(['investigating','mitigating','monitoring','recovered','blocked']);
export const workStates=Object.freeze(['planned','active','blocked','done','cancelled','released']);
export const theoryStates=Object.freeze(['proposed','supported','ruled-out']);
export const validConversationName=name=>typeof name==='string'&&name.trim()===name&&name.length>0&&name.length<=80&&!/[\u0000-\u001f\u007f]/.test(name);
const itemKey=/^[a-z0-9][a-z0-9-]{0,39}$/;
export const validCoordinationItem=item=>item&&typeof item.key==='string'&&itemKey.test(item.key)&&((item.kind==='work'&&workStates.includes(item.state))||(item.kind==='theory'&&theoryStates.includes(item.state)));
export function parseCoordinationItem(text) {
  const [kind,key,state,...detail]=text.split(/\s+/),item={kind:kind.toLowerCase(),key,state};
  if(!validCoordinationItem(item)||!detail.length)throw new Error('Use '+item.kind+' <shared-key> <'+(item.kind==='work'?workStates:theoryStates).join('|')+'> <scope, observation and next check>. Keys use lowercase letters, digits and hyphens, up to 40 characters. Use the same work key only for the same task and scope.');
  return {coordinationItem:item,text:detail.join(' ')};
}
const short=(value,limit=160)=>{const chars=Array.from(String(value||'').replace(/\s+/gu,' ').trim());return chars.length>limit?chars.slice(0,limit).join('')+'…':chars.join('');};
const activeWork=item=>item.currentForAuthor!==false&&['planned','active','blocked'].includes(item.state);
const activeTheory=item=>item.currentForAuthor!==false&&item.state!=='ruled-out';
const participant=(row,tenant)=>row.author_key&&row.author_key!=='unknown'?hash([tenant,row.author_key]):null;
const reconciliationCodes=new Set(['reported-state-disagreement','competing-theories','theory-disagreement','overlapping-work','work-status-disagreement','unaccepted-handoff','handoff-disagreement']);
const delivered=status=>['sent','simulated'].includes(status);

export function validateCollaboration(teams) {
  if(teams.maxIncidentConversations!==undefined&&(!Number.isInteger(teams.maxIncidentConversations)||teams.maxIncidentConversations<2||teams.maxIncidentConversations>32))throw Error('teams.maxIncidentConversations must be 2–32');
  const groups=teams.collaborationGroups||[];
  if(!Array.isArray(groups)||groups.length>8)throw new Error('teams.collaborationGroups must contain at most eight groups');
  const keys=new Set(),rooms=new Set();
  for(const group of groups) {
    if(!group||!/^[-a-z0-9_]{1,64}$/.test(group.key||'')||keys.has(group.key))throw new Error('Collaboration group keys must be unique URL-safe labels');
    keys.add(group.key);
    if(typeof group.name!=='string'||!group.name.trim()||group.name.length>80||/[\r\n\0]/.test(group.name))throw new Error('Collaboration groups need a name of at most 80 characters');
    if(!Array.isArray(group.conversations)||group.conversations.length<2||group.conversations.length>incidentConversationLimit(teams))throw new Error('A collaboration group needs two to eight configured conversations');
    for(const room of group.conversations) {
      if(!room||typeof room.id!=='string'||room.id.length>512||rootConversation(room.id)!==room.id||!teams.conversations.includes(room.id)||rooms.has(room.id))throw new Error('Collaboration rooms must be distinct allowlisted root conversations');
      if(typeof room.name!=='string'||!room.name.trim()||room.name.length>80||/[\r\n\0]/.test(room.name))throw new Error('Collaboration rooms need a name of at most 80 characters');
      rooms.add(room.id);
    }
  }
  if(teams.coordinationIntervalSeconds!==undefined&&(!Number.isFinite(teams.coordinationIntervalSeconds)||teams.coordinationIntervalSeconds<1||teams.coordinationIntervalSeconds>300))throw new Error('teams.coordinationIntervalSeconds must be 1–300');
  for(const key of ['coordinationStaleSeconds','coordinationAckSeconds'])if(teams[key]!==undefined&&(!Number.isFinite(teams[key])||teams[key]<60||teams[key]>3600))throw new Error('teams.'+key+' must be 60–3600');
  if(teams.alertConversationId&&!teams.conversations.includes(teams.alertConversationId))throw new Error('teams.alertConversationId must be allowlisted');
}

export function roomScope(service,conversationId) {
  const root=rootConversation(conversationId);
  const group=service.teams.collaborationGroups?.find(group=>group.conversations.some(room=>room.id===root));
  const room=group?.conversations.find(room=>room.id===root);
  if(tenantAdmission(service.teams))return {key:'group:'+service.teams.tenantSharing.key,groupName:service.teams.tenantSharing.name,name:room?.name||root,root};
  return {key:group?'group:'+group.key:'room:'+root,groupName:group?.name||null,name:room?.name||root,root};
}

export function authorizedRoom(service,conversation) {
  return conversation&&Number(conversation.enabled)===1&&conversation.service_key===service.key&&conversation.tenant_id===service.teams.tenantId&&teamsConversationAllowed(service.teams,conversation.conversation_id);
}

// Names describe an exact admitted conversation, including its historical
// disabled record. They do not enable it or grant incident sharing authority.
export function conversationDisplayName(service,conversation,labelValue){
  const root=rootConversation(conversation.conversation_id);
  if(!service||conversation.service_key!==service.key||conversation.tenant_id!==service.teams.tenantId||!teamsConversationAllowed(service.teams,conversation.conversation_id))return root;
  const scope=roomScope(service,conversation.conversation_id);let name=scope.name;
  if(name===root){try{const candidate=JSON.parse(conversation.reference).sreRoomName;if(validConversationName(candidate))name=candidate;}catch{}}
  if(labelValue!==null&&labelValue!==undefined){try{const candidate=JSON.parse(labelValue).name;if(validConversationName(candidate))name=candidate;}catch{}}
  return name;
}

export async function collaborationSnapshot(store,service,incidentId,q=store.db.query) {
  if(!service?.teams.collaborationGroups?.length&&!tenantAdmission(service?.teams))return {enabled:false,rooms:[],issues:[]};
  const [incident]=await q('SELECT status FROM sre_incidents WHERE id=?',[incidentId]);
  const [audience]=await q('SELECT scope_key FROM sre_incident_audiences WHERE incident_id=?',[incidentId]);
  const conversations=await q('SELECT * FROM sre_conversations WHERE incident_id=? AND enabled=1 ORDER BY id',[incidentId]);
  // A later position can supersede the same person's earlier report only
  // within the incident's currently authorized conversation audience.
  const allowed=conversations.filter(room=>authorizedRoom(service,room)&&(!audience||audience.scope_key===roomScope(service,room.conversation_id).key));
  const allowedKeys=allowed.map(room=>room.id);
  const now=await store.coordinationNow(q),staleMs=(service.teams.coordinationStaleSeconds??300)*1000,ackMs=(service.teams.coordinationAckSeconds??300)*1000;
  const [coordination]=await q('SELECT generation FROM sre_coordination WHERE incident_id=?',[incidentId]);
  const rooms=[];
  for(const conversation of allowed) {
    const scope=roomScope(service,conversation.conversation_id);
    if(!authorizedRoom(service,conversation)||(audience&&audience.scope_key!==scope.key))continue;
    const [label]=await q('SELECT value FROM sre_checkpoints WHERE id=?',['teams-room-label:'+conversation.id]);
    scope.name=conversationDisplayName(service,conversation,label?.value);
    const recent=await q("SELECT * FROM (SELECT r.evidence_id,r.reported_status,r.ordinal,e.observed_at,e.content,ROW_NUMBER() OVER(PARTITION BY COALESCE(p.author_key,'unknown') ORDER BY e.observed_at DESC,r.ordinal DESC,e.id DESC) AS author_rank FROM sre_responder_rooms r JOIN sre_evidence e ON e.id=r.evidence_id LEFT JOIN sre_responder_people p ON p.evidence_id=e.id WHERE r.incident_id=? AND r.conversation_key=? AND r.kind='responder_update') ranked WHERE author_rank=1 ORDER BY observed_at DESC,ordinal DESC,evidence_id DESC LIMIT 6",[incidentId,conversation.id]);
    const [authors]=await q("SELECT COUNT(DISTINCT p.author_key) AS count FROM sre_responder_people p JOIN sre_responder_rooms r ON r.evidence_id=p.evidence_id WHERE p.incident_id=? AND p.conversation_key=? AND r.kind='responder_update'",[incidentId,conversation.id]);
    const [state]=await q('SELECT r.evidence_id,r.reported_status,e.observed_at,e.content FROM sre_responder_rooms r JOIN sre_evidence e ON e.id=r.evidence_id WHERE r.incident_id=? AND r.conversation_key=? AND r.reported_status IS NOT NULL ORDER BY e.observed_at DESC,r.ordinal DESC,e.id DESC LIMIT 1',[incidentId,conversation.id]);
    const stateRows=await q("SELECT * FROM (SELECT latest.*,COUNT(*) OVER() AS state_count FROM (SELECT r.evidence_id,r.reported_status,r.ordinal,e.observed_at,e.content,COALESCE(p.author_key,'unknown') AS author_key,ROW_NUMBER() OVER(PARTITION BY COALESCE(p.author_key,'unknown') ORDER BY e.observed_at DESC,r.ordinal DESC,e.id DESC) AS author_rank FROM sre_responder_rooms r JOIN sre_evidence e ON e.id=r.evidence_id LEFT JOIN sre_responder_people p ON p.evidence_id=e.id WHERE r.incident_id=? AND r.conversation_key=? AND r.reported_status IS NOT NULL) latest WHERE author_rank=1) bounded ORDER BY observed_at DESC,ordinal DESC LIMIT 8",[incidentId,conversation.id]);
    const stateReports=stateRows.map(row=>{const content=JSON.parse(row.content);return {state:row.reported_status,evidenceId:row.evidence_id,at:Number(row.observed_at),author:short(content.displayName||content.userId||'Responder',60),participantKey:participant(row,service.teams.tenantId),text:short(content.text,260),stale:now-Number(row.observed_at)>staleMs,verified:false};});
    const active="author_global_rank=1 AND ((kind='work' AND item_state IN ('planned','active','blocked')) OR (kind='theory' AND item_state<>'ruled-out'))";
    const priority='CASE WHEN '+active+' THEN 0 WHEN author_global_rank=1 THEN 1 ELSE 2 END';
    const ledger=await q("SELECT * FROM (SELECT fair.*,COUNT(*) OVER(PARTITION BY kind) AS kind_count,ROW_NUMBER() OVER(PARTITION BY kind ORDER BY "+priority+",author_rank,observed_at DESC,ordinal DESC) AS kind_rank FROM (SELECT latest.*,ROW_NUMBER() OVER(PARTITION BY kind,author_key ORDER BY "+priority+",observed_at DESC,ordinal DESC) AS author_rank FROM (SELECT c.*,e.observed_at,e.content,r.ordinal,COALESCE(p.author_key,'unknown') AS author_key,ROW_NUMBER() OVER(PARTITION BY c.kind,c.item_key,c.conversation_key,COALESCE(p.author_key,'unknown') ORDER BY e.observed_at DESC,r.ordinal DESC,e.id DESC) AS item_rank,ROW_NUMBER() OVER(PARTITION BY c.kind,c.item_key,CASE WHEN p.author_key IS NOT NULL AND p.author_key<>'' AND p.author_key<>'unknown' THEN 'person:'||p.author_key ELSE 'room:'||c.conversation_key END ORDER BY e.observed_at DESC,r.ordinal DESC,e.id DESC) AS author_global_rank FROM sre_coordination_items c JOIN sre_evidence e ON e.id=c.evidence_id JOIN sre_responder_rooms r ON r.evidence_id=c.evidence_id LEFT JOIN sre_responder_people p ON p.evidence_id=c.evidence_id WHERE c.incident_id=? AND c.conversation_key IN ("+allowedKeys.map(()=>'?').join(',')+")) latest WHERE item_rank=1 AND conversation_key=?) fair) bounded WHERE kind_rank<=8 ORDER BY observed_at DESC,ordinal DESC",[incidentId,...allowedKeys,conversation.id]);
    const items=ledger.map(row=>{const content=JSON.parse(row.content);return {key:row.item_key,state:row.item_state,kind:row.kind,evidenceId:row.evidence_id,at:Number(row.observed_at),receiptOrder:Number(row.ordinal),author:short(content.displayName||content.userId||'Responder',60),participantKey:participant(row,service.teams.tenantId),currentForAuthor:Number(row.author_global_rank)===1,text:short(content.text,260),stale:now-Number(row.observed_at)>staleMs,verified:false};});
    const omittedItems=['work','theory'].reduce((n,kind)=>n+Number(ledger.find(row=>row.kind===kind)?.kind_count||0)-items.filter(item=>item.kind===kind).length,0);
    const selected=kind=>{const all=items.filter(item=>item.kind===kind),isActive=kind==='work'?activeWork:activeTheory;return [...all.filter(isActive),...all.filter(item=>!isActive(item))].slice(0,8);};
    const [receipt]=await q('SELECT r.*,o.status FROM sre_coordination_receipts r JOIN sre_outbox o ON o.id=r.outbox_id WHERE r.incident_id=? AND r.conversation_key=? ORDER BY r.generation DESC LIMIT 1',[incidentId,conversation.id]);
    const [unread]=await q('SELECT generation,created_at FROM sre_coordination_receipts WHERE incident_id=? AND conversation_key=? AND generation>COALESCE((SELECT MAX(generation) FROM sre_coordination_receipts WHERE incident_id=? AND conversation_key=? AND acknowledged_at IS NOT NULL),0) ORDER BY generation LIMIT 1',[incidentId,conversation.id,incidentId,conversation.id]);
    const [lastDelivered]=await q("SELECT r.generation FROM sre_coordination_receipts r JOIN sre_outbox o ON o.id=r.outbox_id WHERE r.incident_id=? AND r.conversation_key=? AND o.status IN ('sent','simulated') AND r.generation>COALESCE((SELECT MAX(generation) FROM sre_coordination_receipts WHERE incident_id=? AND conversation_key=? AND acknowledged_at IS NOT NULL),0) ORDER BY r.generation DESC LIMIT 1",[incidentId,conversation.id,incidentId,conversation.id]);
    const briefing=receipt?{generation:Number(receipt.generation),deliveryStatus:receipt.status,createdAt:Number(receipt.created_at),unacknowledgedSince:unread?Number(unread.created_at):null,attentionGeneration:unread?Number(unread.generation):Number(receipt.generation),lastDeliveredUnacknowledged:lastDelivered?Number(lastDelivered.generation):null,acknowledged:receipt.acknowledged_at!==null,acknowledgedBy:receipt.acknowledged_by,acknowledgedAt:receipt.acknowledged_at===null?null:Number(receipt.acknowledged_at)}:null;
    rooms.push({key:conversation.id,conversationId:conversation.conversation_id,name:scope.name,groupName:scope.groupName,reportedStatus:state?.reported_status||null,statusAt:state?Number(state.observed_at):null,statusEvidenceId:state?.evidence_id||null,statusStale:!!state&&now-Number(state.observed_at)>staleMs,stateReports,omittedStateReports:Math.max(0,Number(stateRows[0]?.state_count||0)-stateReports.length),work:selected('work'),theories:selected('theory'),omittedItems,briefing,reportAuthorsAvailable:Number(authors.count),omittedReportAuthors:Math.max(0,Number(authors.count)-recent.length),reports:recent.map(row=>{const content=JSON.parse(row.content);return {evidenceId:row.evidence_id,at:Number(row.observed_at),author:short(content.displayName||content.userId||'Responder',60),text:short(content.text,500),verified:false};})});
  }
  // Read-only views can straddle a commit between room queries. Reconcile
  // visible positions again so one native participant cannot become two owners.
  const visiblePositions=rooms.flatMap(room=>[...room.work,...room.theories]),latestPositions=new Map();
  for(const item of visiblePositions.filter(item=>item.currentForAuthor&&item.participantKey)){
    const key=JSON.stringify([item.kind,item.key,item.participantKey]),prior=latestPositions.get(key);
    if(!prior||item.at>prior.at||item.at===prior.at&&item.receiptOrder>prior.receiptOrder)latestPositions.set(key,item);
  }
  for(const item of visiblePositions)if(item.currentForAuthor&&item.participantKey&&latestPositions.get(JSON.stringify([item.kind,item.key,item.participantKey]))!==item)item.currentForAuthor=false;
  const states=new Set(rooms.flatMap(room=>room.stateReports.map(report=>report.state))),issues=[];
  if(states.has('recovered')&&[...states].some(state=>['investigating','mitigating','blocked'].includes(state)))issues.push({code:'reported-state-disagreement',text:'Participants report different service states: one reports recovery while another is still investigating, mitigating or blocked. Confirm whether they mean the same service, time window and user impact.'});
  if(states.has('recovered')&&incident?.status!=='resolved')issues.push({code:'recovery-unverified',text:'Reported recovery is not independently verified. The incident remains '+incident.status+'.'});
  const theories=rooms.flatMap(room=>room.theories.filter(item=>item.currentForAuthor).map(item=>({...item,roomKey:room.key,roomName:room.name}))),work=rooms.flatMap(room=>room.work.filter(item=>item.currentForAuthor).map(item=>({...item,roomKey:room.key,roomName:room.name})));
  const activeTheories=theories.filter(activeTheory);
  if(new Set(activeTheories.map(item=>item.key)).size>1&&new Set(activeTheories.map(item=>item.participantKey||item.roomKey)).size>1)issues.push({code:'competing-theories',text:'Responders have different active theories. Keep them as hypotheses; agree on a discriminating check using the same affected users, deployment and time window.'});
  for(const key of new Set(theories.map(item=>item.key))) {
    const matching=theories.filter(item=>item.key===key);
    if(matching.some(item=>item.state==='supported')&&matching.some(item=>item.state==='ruled-out'))issues.push({code:'theory-disagreement',itemKey:key,text:'Conflicting reports about theory '+key+': one responder supports it and another rules it out. Compare test scope and source evidence with the lead before choosing a cause.'});
  }
  for(const key of new Set(work.map(item=>item.key))) {
    const matching=work.filter(item=>item.key===key),active=matching.filter(activeWork);
    if(active.length>1)issues.push({code:'overlapping-work',itemKey:key,text:'Possible duplicate work on '+key+' in '+active.map(item=>item.roomName+' ('+item.author+')').join(' and ')+'. Agree on one owner or split distinct scopes before repeating a mitigation. No action has been cancelled automatically.'});
    if(active.length&&matching.some(item=>item.state==='done'))issues.push({code:'work-status-disagreement',itemKey:key,text:'Work '+key+' is reported done by one responder and still assigned to another. Confirm whether the result and scope match before repeating the task or treating it as complete.'});
  }
  const {handoffs,handoffCoverage}=await workHandoffs(q,{incidentId,service,rooms});
  const handoffIssues=[];
  for(const h of handoffs){
    if(h.state==='awaiting-owner')handoffIssues.push({code:'unaccepted-handoff',itemKey:h.key,text:handoffText(h)});
    else if(h.state==='conflicting-reports')handoffIssues.push({code:'handoff-disagreement',itemKey:h.key,text:handoffText(h)});
    if(h.ownerCount>1&&!issues.some(issue=>issue.code==='overlapping-work'&&issue.itemKey===h.key))handoffIssues.push({code:'overlapping-work',itemKey:h.key,text:'Possible duplicate work on '+h.key+': '+h.ownerCount+' responders reported ownership after its release. Review the retained handoff reports with the lead and choose one owner or separate scopes. No action has been cancelled automatically.'});
  }
  // Lost ownership is actionable even when many visible work items are noisy.
  issues.unshift(...handoffIssues);
  if(handoffCoverage.omitted)issues.push({code:'handoff-window',text:handoffCoverage.omitted+' additional handoff records are outside this bounded view. Unresolved handoffs are prioritized; review retained work evidence before assuming ownership or completion.'});
  for(const room of rooms) {
    if(room.statusStale)issues.push({code:'stale-team-state',roomKey:room.key,text:room.name+' has an old reported service state. Ask for a fresh impact report; newer chatter does not refresh that state.'});
    if(room.work.some(item=>activeWork(item)&&item.stale))issues.push({code:'stale-work',roomKey:room.key,text:room.name+' has work without a fresh owner update. Confirm ownership, result and next check before assuming it is progressing.'});
    if(room.omittedItems)issues.push({code:'ledger-window',roomKey:room.key,text:room.name+' has '+room.omittedItems+' additional ledger items outside this bounded briefing. Review the incident evidence before assigning more work.'});
    if(room.omittedStateReports)issues.push({code:'state-report-window',roomKey:room.key,text:room.name+' has '+room.omittedStateReports+' additional participant state reports outside this bounded view. The latest displayed claim is not a team consensus.'});
    const receipt=room.briefing;
    if(receipt&&!receipt.acknowledged) {
      const base={roomKey:room.key,generation:receipt.generation,attentionGeneration:receipt.attentionGeneration,delivery:true};
      if(['unknown','failed','discarded'].includes(receipt.deliveryStatus))issues.push({...base,code:'briefing-delivery-'+receipt.deliveryStatus,text:room.name+' briefing #'+receipt.generation+' delivery is '+receipt.deliveryStatus+'. Do not assume this team saw the shared update. Check its conversation or contact the lead; an uncertain send will not be replayed automatically.'});
      else if(now-(receipt.unacknowledgedSince??receipt.createdAt)>ackMs) {
        // A just-queued replacement is not a delivery delay. Keep the existing
        // unread reminder tied to what actually reached the team, so a new
        // round cannot reset its deadline or emit a second false alarm.
        const freshPending=!delivered(receipt.deliveryStatus)&&now-receipt.createdAt<=ackMs;
        const unreadDelivered=delivered(receipt.deliveryStatus)||freshPending&&receipt.lastDeliveredUnacknowledged!==null;
        const generation=unreadDelivered?(receipt.lastDeliveredUnacknowledged??receipt.generation):receipt.generation;
        issues.push({...base,generation,code:unreadDelivered?'briefing-unacknowledged':'briefing-delayed',text:room.name+' has '+(unreadDelivered?'not acknowledged':'not completed delivery of')+' briefing #'+generation+'; updates have been outstanding since briefing #'+receipt.attentionGeneration+'. A successful send is not a read receipt or agreement. '+(unreadDelivered?'Ask this team to read its latest delivered briefing and use the ack command shown there.':'Check delivery; when a briefing arrives, ask this team to read it and use its ack command.')});
      }
    }
  }
  const actions=await q('SELECT id,status,approved_by FROM sre_rollbacks WHERE incident_id=? ORDER BY created_at DESC LIMIT 3',[incidentId]);
  const others=await q("SELECT c.* FROM sre_conversations c JOIN sre_incidents i ON i.id=c.incident_id WHERE c.service_key=? AND c.incident_id<>? AND c.enabled=1 AND i.status<>'resolved' ORDER BY c.id",[service.key,incidentId]);
  const otherIncidentLinks=others.filter(room=>authorizedRoom(service,room)&&audience?.scope_key===roomScope(service,room.conversation_id).key&&!rooms.some(current=>rootConversation(current.conversationId)===rootConversation(room.conversation_id))).slice(0,8).map(room=>({name:roomScope(service,room.conversation_id).name,incidentId:room.incident_id}));
  return {enabled:true,incidentId,incidentStatus:incident?.status,scopeKey:audience?.scope_key||null,briefingGeneration:Number(coordination?.generation||0),rooms,handoffs,handoffCoverage,issues,actions,otherIncidentLinks,interpretation:'Explicit reports, work and theories are attributed claims, not verified facts, agreement or approval. Unstructured text is quoted without inferring task completion or causality.',nextStep:issues.some(issue=>reconciliationCodes.has(issue.code))?'Use one shared incident thread or bridge and name a coordination lead. Reconcile impact, deployment identity, owners and next check with the participants before another recovery action.':'Keep each group’s current owner, action and next check in its reports. Use sync for a shared briefing; no earlier chat history is fetched.'};
}

export function collaborationText(view,{generation}={}) {
  if(!view?.enabled)return 'Cross-group coordination is not configured for this service.';
  const render=(detail,items,issueLimit)=>{
    const lines=['Shared incident coordination · '+view.incidentId+(generation?' · briefing #'+generation:''),'Linked conversations: '+view.rooms.length+'. Reports below are unverified; silence does not mean agreement or recovery.'];
    // Warnings and every group's identity survive before optional excerpts.
    for(const issue of view.issues.slice(0,issueLimit))lines.push('\nCoordination check: '+short(issue.text,240));
    if(view.issues.length>issueLimit)lines.push((view.issues.length-issueLimit)+' more coordination checks are in the incident console.');
    for(const handoff of (view.handoffs||[]).slice(0,Math.min(items,4)))if(handoff.state!=='awaiting-owner')lines.push('\n'+short(handoffText(handoff),320));
    if(view.handoffCoverage?.omitted)lines.push(view.handoffCoverage.omitted+' more handoff records are retained outside this view; request missing ownership evidence.');
    for(const room of view.rooms) {
      lines.push('\n'+room.name+' — latest state claim: '+(room.reportedStatus||'not provided')+(room.statusAt?' at '+new Date(room.statusAt).toISOString():''));
      const reportLimit=detail>=80?6:detail>0?3:1;
      if(!room.reports.length)lines.push('No delivered report yet. Ask this team for its owner, action and next check.');
      for(const report of (room.stateReports||[]).slice(0,reportLimit))lines.push('State claim '+report.state+' by '+short(report.author,24)+' at '+new Date(report.at).toISOString()+(report.stale?' · old report':'')+'.');
      const omittedStates=(room.omittedStateReports||0)+Math.max(0,(room.stateReports||[]).length-reportLimit);if(omittedStates)lines.push(omittedStates+' participant state claims are outside this briefing; the latest claim is not team consensus.');
      for(const report of room.reports.slice(0,reportLimit))lines.push(short(report.author,24)+' at '+new Date(report.at).toISOString()+': '+(detail?'“'+short(report.text,detail)+'”':'report retained in the incident console.'));
      const omitted=(room.omittedReportAuthors||0)+Math.max(0,room.reports.length-reportLimit);
      if(omitted)lines.push(omitted+' participant reports are outside this briefing; review the incident console and ask for the missing context.');
      for(const [entries,label] of [[room.theories||[],'Theory'],[room.work||[],'Work']]) {
        for(const item of entries.slice(0,items))lines.push(label+' '+item.key+' ['+item.state+(item.currentForAuthor===false?', historical; responder updated elsewhere':'')+(item.stale?(item.kind==='work'&&activeWork(item)?', owner update overdue':', older report'):'')+'] · '+short(item.author,24)+' at '+new Date(item.at).toISOString()+(detail?': “'+short(item.text,detail)+'”':''));
        if(entries.length>items)lines.push((entries.length-items)+' more '+label.toLowerCase()+' items are in the incident console.');
      }
    }
    for(const action of view.actions)lines.push('Recovery action '+action.id+': '+action.status+'. Approval is valid only in the conversation where its exact proposal was requested.');
    if(view.rooms.length<2)for(const other of view.otherIncidentLinks||[])lines.push('Connection check: '+other.name+' follows a different incident, '+other.incidentId+'. If both groups mean the same issue, confirm the incident identity with the lead and join one common incident. These incidents have not been merged or their reports shared.');
    lines.push('\n'+view.nextStep,'The coordinator compares explicit reports and shared work/theory keys; free-text differences still need investigation. Reports, work marked done and model text cannot approve or verify recovery.');
    if(detail<160)lines.push('Compact briefing: excerpts or ledger items are shortened; review the incident console for full context.');
    if(generation)lines.push('After reading this briefing, reply ack '+generation+' in this conversation (@mention the agent in Teams). This acknowledges receipt, not agreement, task completion or rollback approval.');
    return lines.join('\n');
  };
  let result;
  for(const [detail,items,issues] of [[160,8,8],[80,4,6],[40,2,4],[0,1,3]]) {
    result=render(detail,items,issues);
    if(Buffer.byteLength(result,'utf8')<=13000)return result;
  }
  // Preserve every room's identity when a larger configured audience cannot
  // fit detailed reports. Explicitly mark those details as omitted.
  return ['Shared incident coordination · '+view.incidentId,'Detailed reports omitted from this message; inspect the incident console.',...view.rooms.map(room=>short(room.name,32)+' — '+(room.reportedStatus||'no reported state'))].join('\n');
}

export class IncidentCollaboration {
  constructor({store,services}) {Object.assign(this,{store,services});this.after='';}
  async snapshot(incidentId,q=this.store.db.query) {
    const [incident]=await q('SELECT service_key FROM sre_incidents WHERE id=?',[incidentId]);
    return collaborationSnapshot(this.store,this.services.find(service=>service.key===incident?.service_key),incidentId,q);
  }
  async publish(incidentId,{requestId}={}) {
    return this.store.db.transaction(async q=>{
      if((await this.store.restoreFence(q))?.active)return false;
      const [incident]=await q('SELECT service_key FROM sre_incidents WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[incidentId]);
      const service=this.services.find(service=>service.key===incident?.service_key);if(!service?.teams.collaborationGroups?.length&&!tenantAdmission(service?.teams))return false;
      await q('INSERT INTO sre_coordination(incident_id,last_hash,published_at,generation) VALUES(?,NULL,0,0) ON CONFLICT DO NOTHING',[incidentId]);
      const [state]=await q('SELECT * FROM sre_coordination WHERE incident_id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[incidentId]);
      const view=await collaborationSnapshot(this.store,service,incidentId,q),now=await this.store.coordinationNow(q);
      // Publication/acknowledgement changes cannot publish themselves recursively.
      // A rejoined recipient whose old copy was discarded needs a new briefing.
      const {briefingGeneration,...content}=view;
      // Preserve historical age in the view, but do not create a new unread
      // round merely because a ruled-out theory or inactive task becomes old.
      // Active work/theories and service-state freshness still change the hash.
      const digestRooms=view.rooms.map(({briefing,...room})=>({...room,work:room.work.map(item=>activeWork(item)?item:{...item,stale:false}),theories:room.theories.map(item=>activeTheory(item)?item:{...item,stale:false})}));
      const digest=hash({...content,rooms:digestRooms,issues:view.issues.filter(issue=>!issue.delivery)});
      if(!view.rooms.length||view.rooms.length===1&&!Number(state.generation)&&!view.issues.some(issue=>reconciliationCodes.has(issue.code))){await q('UPDATE sre_coordination SET last_hash=? WHERE incident_id=?',[digest,incidentId]);return false;}
      if(requestId) {
        const [prior]=await q('SELECT id FROM sre_outbox WHERE id LIKE ? LIMIT 1',['coordination:'+incidentId+':request:'+requestId+':%']);if(prior)return false;
      } else if(state.last_hash===digest&&!view.rooms.some(room=>room.briefing?.deliveryStatus==='discarded')||(state.published_at&&now-Number(state.published_at)<(service.teams.coordinationIntervalSeconds??15)*1000))return false;
      const generation=Number(state.generation)+1,prefix='coordination:'+incidentId+':'+(requestId?'request:'+requestId:'round:'+generation);
      for(const room of view.rooms) {
        const outboxId=prefix+':'+room.key;
        await this.store.queueMessage(incidentId,collaborationText(view,{generation}),room.key,outboxId,q);
        await q('INSERT INTO sre_coordination_receipts(incident_id,generation,conversation_key,outbox_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',[incidentId,generation,room.key,outboxId,now]);
      }
      await q('UPDATE sre_coordination SET last_hash=?,published_at=?,generation=? WHERE incident_id=?',[digest,now,generation,incidentId]);
      return true;
    });
  }
  async acknowledge(incidentId,conversationKey,generation,{userId,displayName}={}) {
    if(!Number.isSafeInteger(generation)||generation<1||!userId)throw new Error('Use ack <briefing-number> after reading a briefing delivered to this conversation.');
    return this.store.db.transaction(async q=>{
      if((await this.store.restoreFence(q))?.active)throw new Error('Database restore reconciliation is holding acknowledgements');
      await q('SELECT id FROM sre_incidents WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[incidentId]);
      await this.store.authorizeIncidentConversation(conversationKey,incidentId,q);
      const [room]=await q('SELECT incident_id FROM sre_conversations WHERE id=? AND enabled=1',[conversationKey]);
      if(room?.incident_id!==incidentId)throw new Error('Join this incident before acknowledging its briefing');
      const [receipt]=await q('SELECT r.*,o.status FROM sre_coordination_receipts r JOIN sre_outbox o ON o.id=r.outbox_id WHERE r.incident_id=? AND r.conversation_key=? AND r.generation=?',[incidentId,conversationKey,generation]);
      if(!receipt)throw new Error('Briefing #'+generation+' was not addressed to this conversation. Use sync for its current briefing.');
      if(!delivered(receipt.status)&&receipt.status!=='unknown')throw new Error('Briefing #'+generation+' has not been delivered to this conversation. Check delivery before acknowledging it.');
      const now=await this.store.coordinationNow(q),author=short(displayName||userId,60);
      if(receipt.acknowledged_at===null) {
        await q('UPDATE sre_coordination_receipts SET acknowledged_by=?,acknowledged_at=? WHERE incident_id=? AND generation=? AND conversation_key=?',[userId,now,incidentId,generation,conversationKey]);
        const view=await this.snapshot(incidentId,q),name=view.rooms.find(room=>room.key===conversationKey)?.name||'Responder group';
        for(const peer of view.rooms.filter(room=>room.key!==conversationKey))await this.store.queueMessage(incidentId,name+' · '+author+' acknowledged reading shared briefing #'+generation+'. This is receipt only; it does not establish agreement, task completion or approval.',peer.key,'coordination-ack:'+incidentId+':'+generation+':'+conversationKey+':'+peer.key,q);
      }
      const [latest]=await q('SELECT MAX(generation) AS generation FROM sre_coordination_receipts WHERE incident_id=? AND conversation_key=?',[incidentId,conversationKey]);
      return 'Recorded receipt of briefing #'+generation+'.'+(Number(latest.generation)>generation?' A newer briefing #'+latest.generation+' still needs its own acknowledgement.':'')+' Receipt does not mean agreement, task completion or rollback approval.';
    });
  }
  async checkAttention(incidentId) {
    return this.store.db.transaction(async q=>{
      if((await this.store.restoreFence(q))?.active)return;
      await q('SELECT id FROM sre_incidents WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[incidentId]);
      const view=await this.snapshot(incidentId,q);
      return queueAttentionChecks(this.store,view,q);
    });
  }
  async runOnce() {
    const scan="SELECT DISTINCT c.incident_id FROM sre_conversations c JOIN sre_incidents i ON i.id=c.incident_id WHERE c.enabled=1 AND i.status<>'resolved' AND c.incident_id";
    let rows=await this.store.db.query(scan+'>? ORDER BY c.incident_id LIMIT 100',[this.after]);
    if(rows.length<100&&this.after)rows=rows.concat(await this.store.db.query(scan+'<=? ORDER BY c.incident_id LIMIT ?',[this.after,100-rows.length]));
    // Check the prior recipients before queuing a new round. Otherwise a busy
    // incident can continually replace a sent-but-unread round with pending
    // deliveries and hide the silent team's deadline from its reachable peers.
    for(const row of rows){await this.checkAttention(row.incident_id);await this.publish(row.incident_id);}
    this.after=rows.at(-1)?.incident_id||'';
  }
}
