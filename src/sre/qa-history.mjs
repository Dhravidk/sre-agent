import {StorageError} from './database.mjs';
import {redact,hash} from './security.mjs';
import {assessmentHash} from './qa-assessment.mjs';
import {restoreSummary} from './restore-recovery.mjs';
import {conversationDisplayName,roomScope} from './collaboration.mjs';
import {teamsConversationAllowed} from './teams-access.mjs';

export const qaHistoryLimits=Object.freeze({pageSize:20,resultChars:131072,resultBytes:128000,events:10,assessmentChars:524288,assessmentBytes:512000});
const states=['proposed','approved','running','passed','failed','unknown','superseded'];
const epoch=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000;
const fix=value=>typeof value==='string'&&/^fix_[a-f0-9]{24}$/.test(value);
const fail=(status,message)=>Object.assign(Error(message),{status});
const corrupt=()=>new StorageError(Error('Invalid retained QA request metadata'));
const short=(value,max)=>Array.from(redact(String(value??''))).slice(0,max).join('');
const field=(store,column,path)=>store.db.dialect==='postgres'?column+"::jsonb#>>'{"+path.join(',')+"}'":"json_extract("+column+",'$."+path.join('.')+"')";
const type=(store,column,path=[])=>store.db.dialect==='postgres'?'jsonb_typeof('+(path.length?column+"::jsonb#>'{"+path.join(',')+"}'":column+'::jsonb')+')':'json_type('+column+(path.length?",'$."+path.join('.')+"'":'')+')';
const assessmentColumns=store=>type(store,'p.payload',['assessmentHash'])+' AS plan_assessment_type,SUBSTR('+field(store,'p.payload',['assessmentHash'])+',1,65) AS plan_assessment_hash';
function resultColumns(store,column,prefix,path=[]){
 const text=(name,max)=>'CASE WHEN '+type(store,column,[...path,name])+" IN ('text','string') THEN SUBSTR("+field(store,column,[...path,name])+',1,'+max+') ELSE NULL END AS '+prefix+name;
 const patch=field(store,column,[...path,'patch']),last=store.db.dialect==='postgres'?'RIGHT('+patch+',1)':'SUBSTR('+patch+',-1)',newline=store.db.dialect==='postgres'?'CHR(10)':'CHAR(10)';
 return[type(store,column,path)+' AS '+prefix+'type',text('branch',300),text('commit',100),text('summary',700),'CASE WHEN '+type(store,column,[...path,'patch'])+" IN ('text','string') AND LENGTH("+patch+')>0 AND '+last+'<>'+newline+' THEN 1 ELSE 0 END AS '+prefix+'patch_needs_regeneration'].join(',');
}
const selection="r.id,r.plan_id,r.incident_id,r.conversation_key,r.requested_by,r.approved_by,r.status,r.created_at,r.expires_at,r.lease_until,SUBSTR(r.error,1,1000) AS error,p.revision AS plan_revision,p.incident_id AS plan_incident,c.tenant_id AS room_tenant,c.service_key AS room_service,c.conversation_id,c.incident_id AS room_incident,c.enabled AS room_enabled,SUBSTR(label.value,1,2000) AS room_label,CASE WHEN r.result IS NULL THEN 0 ELSE 1 END AS result_present";
const joins=" LEFT JOIN sre_fix_plans p ON p.id=r.plan_id LEFT JOIN sre_conversations c ON c.id=r.conversation_key LEFT JOIN sre_checkpoints label ON label.id='teams-room-label:'||r.conversation_key ";
async function readOnly(store,read){
 try{return await store.db.transaction(async q=>{if(store.db.dialect==='postgres'){await q('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await q("SET LOCAL statement_timeout='10s'");await q("SET LOCAL lock_timeout='3s'");}return read(q);});}
 catch(error){if(error instanceof StorageError||[400,403,404,409].includes(error?.status))throw error;throw new StorageError(error);}
}
async function scope(store,q,id){
 if(typeof id!=='string'||!/^inc_[a-f0-9]+$/.test(id))throw fail(400,'Invalid incident identity');
 // Read at most one bounded current assessment; never load a plan body or its
 // Markdown to list QA history. Compare the exact audit body inside SQL.
 const [incident]=await q('SELECT i.id,i.service_key,i.revision,(SELECT MAX(revision) FROM sre_assessments latest WHERE latest.incident_id=i.id) AS assessment_latest_revision,LENGTH(i.analysis) AS analysis_chars,CASE WHEN LENGTH(i.analysis)<='+qaHistoryLimits.assessmentChars+' THEN i.analysis ELSE NULL END AS analysis,CASE WHEN EXISTS(SELECT 1 FROM sre_assessments a WHERE a.incident_id=i.id AND a.revision=i.revision AND a.body=i.analysis) THEN 1 ELSE 0 END AS assessment_audited FROM sre_incidents i WHERE i.id=?',[id]),service=store.services.find(s=>s.key===incident?.service_key);if(!incident||!service)throw fail(404,'The configured incident was not found');
 const [audience]=await q('SELECT scope_key FROM sre_incident_audiences WHERE incident_id=?',[id]);const now=await store.coordinationNow(q);if(!epoch(now)||!epoch(Number(incident.revision)))throw corrupt();
 const reason=Number(incident.analysis_chars)>qaHistoryLimits.assessmentChars||incident.analysis&&Buffer.byteLength(incident.analysis,'utf8')>qaHistoryLimits.assessmentBytes?'oversized-assessment':incident.analysis===null?'missing-assessment':!Number(incident.assessment_audited)?'unaudited-assessment':Number(incident.assessment_latest_revision)!==Number(incident.revision)?'outdated-assessment':null;
 let currentHash=null;if(!reason){const analysis=JSON.parse(incident.analysis);if(!analysis||typeof analysis!=='object'||Array.isArray(analysis))throw corrupt();currentHash=assessmentHash(analysis);}
 return{incident,service,audience:audience?.scope_key??null,now,assessment:{hash:currentHash,reason},assessmentVersion:hash([Number(incident.revision),currentHash,reason]),recovery:restoreSummary(await store.restoreFence(q))};
}
function summary(row,prefix='result_'){
 if(!row[prefix+'type']||row[prefix+'type']==='null')return null;
 if(row[prefix+'type']!=='object')throw corrupt();
 return{branch:row[prefix+'branch']===null?null:short(row[prefix+'branch'],300),commit:/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row[prefix+'commit']||'')?row[prefix+'commit']:null,summary:row[prefix+'summary']===null?null:short(row[prefix+'summary'],700),patchNeedsRegeneration:Number(row[prefix+'patch_needs_regeneration'])===1,isSummary:true};
}
function project(sc,row){
 if(!row||!fix(row.id)||!/^plan_[a-f0-9]{24}$/.test(row.plan_id)||row.incident_id!==sc.incident.id||row.plan_incident!==row.incident_id||!epoch(Number(row.plan_revision))||!epoch(Number(row.created_at))||!epoch(Number(row.expires_at))||!states.includes(row.status)||typeof row.requested_by!=='string'||!row.requested_by||typeof row.conversation_key!=='string'||!/^[a-f0-9]{32}$/.test(row.conversation_key)||row.status==='running'&&(row.lease_until===null||!epoch(Number(row.lease_until))))throw corrupt();
 const legacy=!row.plan_assessment_type||row.plan_assessment_type==='null';if(!legacy&&(!['string','text'].includes(row.plan_assessment_type)||!/^[a-f0-9]{64}$/.test(row.plan_assessment_hash||'')))throw corrupt();
 const assessment=legacy?{state:'unverified',reason:'legacy-plan'}:sc.assessment.reason?{state:'unverified',reason:sc.assessment.reason}:row.plan_assessment_hash===sc.assessment.hash?{state:'current',reason:'matching-reviewed-facts'}:{state:'changed',reason:'different-reviewed-facts'};
 const expired=Number(row.expires_at)<=sc.now,leaseExpired=row.status==='running'&&Number(row.lease_until)<=sc.now,planCurrent=Number(row.plan_revision)===Number(sc.incident.revision);
 const displayStatus=row.status==='proposed'&&expired?'expired':row.status==='approved'&&expired?'approval-expired':leaseExpired?'lease-expired':(!planCurrent||assessment.state==='changed')&&['proposed','approved'].includes(row.status)?'stale-'+(row.status==='proposed'?'proposal':'approval'):row.status;
 const sameService=row.room_service===sc.service.key&&row.room_tenant===sc.service.teams.tenantId,configured=sameService&&teamsConversationAllowed(sc.service.teams,row.conversation_id)&&(!sc.audience||roomScope(sc.service,row.conversation_id).key===sc.audience),enabled=Number(row.room_enabled)===1;
 const origin={key:row.conversation_key,id:sameService?row.conversation_id:null,name:sameService?short(conversationDisplayName(sc.service,{conversation_id:row.conversation_id,service_key:row.room_service,tenant_id:row.room_tenant,reference:'{}'},row.room_label),100):'Stored conversation reference',enabled:sameService&&enabled,configuredAccess:Boolean(configured),currentIncidentId:sameService?row.room_incident:null};
 const result=Number(row.result_present)?summary(row):null;if(Number(row.result_present)&&!result)throw corrupt();
 return{id:row.id,plan_id:row.plan_id,status:row.status,displayStatus,incidentId:row.incident_id,requested_by:short(row.requested_by,512),approved_by:row.approved_by===null?null:short(row.approved_by,512),created_at:Number(row.created_at),expires_at:Number(row.expires_at),plan_revision:Number(row.plan_revision),current:!sc.recovery.active&&planCurrent&&assessment.state==='current'&&!['unknown','superseded'].includes(row.status)&&!leaseExpired&&(!['proposed','approved'].includes(row.status)||!expired),planCurrent,assessment,approvalExpired:expired,leaseExpired,origin,result,resultAvailable:Boolean(Number(row.result_present)),error:row.error===null?null:short(row.error,1000),unexpiredProposalsInConversation:Number(row.pending_in_conversation||0)};
}
function cursor(sc,value){
 if(value===null||value===undefined||value==='')return null;
 try{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(value))throw Error();const p=JSON.parse(Buffer.from(value,'base64url'));if(p.version!==1||p.incidentId!==sc.incident.id||p.serviceKey!==sc.service.key||!fix(p.id)||!epoch(p.at)||Object.keys(p).sort().join(',')!=='at,id,incidentId,serviceKey,version')throw Error();return p;}catch{throw fail(400,'Invalid QA history cursor for this incident; load newest history');}
}
const encode=(sc,row)=>Buffer.from(JSON.stringify({version:1,incidentId:sc.incident.id,serviceKey:sc.service.key,at:Number(row.created_at),id:row.id})).toString('base64url');
const interpretation='Recorded QA state and local artifacts are not deployment or recovery proof. This read cannot approve, retry, reclaim a lease, execute code or release a restore hold. Missing history does not prove an action never ran.';
export async function readQaHistory(store,incidentId,{attention=false,cursor:after}={}){
 return readOnly(store,async q=>{
  const sc=await scope(store,q,incidentId),position=cursor(sc,after);if(attention&&position)throw fail(400,'Attention selection does not use a history cursor');
  if(position){const [boundary]=await q('SELECT incident_id,created_at FROM sre_fix_requests WHERE id=?',[position.id]);if(!boundary||boundary.incident_id!==incidentId||Number(boundary.created_at)!==position.at)throw fail(409,'The saved QA history boundary is missing or changed; load newest history');}
  const [counts]=await q("SELECT COUNT(*) AS total,"+states.map(state=>"SUM(CASE WHEN status='"+state+"' THEN 1 ELSE 0 END) AS "+state).join(',')+",SUM(CASE WHEN status IN ('unknown','running','approved') OR (status='proposed' AND expires_at>?) THEN 1 ELSE 0 END) AS attention_total,SUM(CASE WHEN status='proposed' AND expires_at<=? THEN 1 ELSE 0 END) AS expired_proposals FROM sre_fix_requests WHERE incident_id=?",[sc.now,sc.now,incidentId]);
  const totals=Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,Number(v||0)]));if(Object.values(totals).some(n=>!epoch(n))||states.reduce((n,k)=>n+totals[k],0)!==totals.total)throw corrupt();
  const args=[sc.now,incidentId],pending="(SELECT COUNT(*) FROM sre_fix_requests sibling WHERE sibling.conversation_key=r.conversation_key AND sibling.status='proposed' AND sibling.expires_at>?) AS pending_in_conversation",columns=selection+','+assessmentColumns(store)+','+resultColumns(store,'r.result','result_')+','+pending;
  let query;
  if(attention){
   const tier="CASE WHEN status IN ('unknown','running','approved') OR (status='proposed' AND expires_at>?) THEN 0 ELSE 1 END",priority="CASE status WHEN 'unknown' THEN 0 WHEN 'running' THEN 1 WHEN 'approved' THEN 2 WHEN 'proposed' THEN 3 ELSE 4 END",order='tier,person_rank,priority,CASE WHEN tier=0 THEN created_at END ASC,created_at DESC,id';
   query="WITH meta AS (SELECT id,conversation_key,requested_by,created_at,"+tier+' AS tier,'+priority+' AS priority FROM sre_fix_requests WHERE incident_id=?),people AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY conversation_key,requested_by ORDER BY tier,priority,CASE WHEN tier=0 THEN created_at END ASC,created_at DESC,id) AS person_rank FROM meta),rooms AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY conversation_key ORDER BY '+order+') AS room_rank FROM people),chosen AS (SELECT id FROM rooms ORDER BY tier,room_rank,priority,CASE WHEN tier=0 THEN created_at END ASC,created_at DESC,id LIMIT '+qaHistoryLimits.pageSize+') SELECT '+columns+' FROM chosen JOIN sre_fix_requests r ON r.id=chosen.id'+joins+' JOIN rooms rank ON rank.id=r.id ORDER BY rank.tier,rank.room_rank,rank.priority,CASE WHEN rank.tier=0 THEN rank.created_at END ASC,rank.created_at DESC,r.id';
   args.splice(0,args.length,sc.now,incidentId,sc.now);
  }else{
   const before=position?' AND (r.created_at<? OR (r.created_at=? AND r.id<?))':'';if(position)args.push(position.at,position.at,position.id);
   query='SELECT '+columns+' FROM sre_fix_requests r'+joins+' WHERE r.incident_id=?'+before+' ORDER BY r.created_at DESC,r.id DESC LIMIT '+(qaHistoryLimits.pageSize+1);
  }
  const selected=await q(query,args),page=selected.slice(0,qaHistoryLimits.pageSize),items=page.map(row=>project(sc,row)),attentionShown=items.filter(r=>['unknown','running','approved'].includes(r.status)||r.status==='proposed'&&!r.approvalExpired).length;
  return{version:1,incidentId,currentRevision:Number(sc.incident.revision),assessmentVersion:sc.assessmentVersion,observedAt:sc.now,mode:attention?'attention':'history',items,nextCursor:!attention&&selected.length>qaHistoryLimits.pageSize?encode(sc,page.at(-1)):null,counts:totals,coverage:{pageSize:qaHistoryLimits.pageSize,total:totals.total,shown:items.length,omitted:Math.max(0,totals.total-items.length),attentionTotal:totals.attention_total,attentionShown,attentionOmitted:Math.max(0,totals.attention_total-attentionShown),hasMore:!attention&&selected.length>qaHistoryLimits.pageSize,completeHistory:false},recovery:sc.recovery,interpretation};
 });
}
export async function readQaRequest(store,incidentId,id){
 if(!fix(id))throw fail(400,'Invalid QA request identity');
 return readOnly(store,async q=>{
  const sc=await scope(store,q,incidentId),columns=selection+','+assessmentColumns(store)+','+resultColumns(store,'r.result','result_')+",(SELECT COUNT(*) FROM sre_fix_requests sibling WHERE sibling.conversation_key=r.conversation_key AND sibling.status='proposed' AND sibling.expires_at>?) AS pending_in_conversation,CASE WHEN LENGTH(r.result)<="+qaHistoryLimits.resultChars+' THEN r.result ELSE NULL END AS saved_result',rows=await q('SELECT '+columns+' FROM sre_fix_requests r'+joins+' WHERE r.id=? AND r.incident_id=?',[sc.now,id,incidentId]);
  if(!rows.length)throw fail(404,'The QA request was not found in this incident; missing history does not prove it never ran');const row=rows[0],request=project(sc,row);let result=null,resultOmitted=false;
  if(request.resultAvailable){if(row.saved_result===null||Buffer.byteLength(row.saved_result,'utf8')>qaHistoryLimits.resultBytes)resultOmitted=true;else{result=redact(JSON.parse(row.saved_result));if(!result||typeof result!=='object'||Array.isArray(result))throw corrupt();if(Buffer.byteLength(JSON.stringify(result),'utf8')>qaHistoryLimits.resultBytes){result=null;resultOmitted=true;}}}
  const events=await q('SELECT id,status,at,'+resultColumns(store,'payload','event_result_',['result'])+','+type(store,'payload')+' AS payload_type,SUBSTR('+field(store,'payload',['actor'])+',1,512) AS actor,SUBSTR('+field(store,'payload',['reason'])+',1,1000) AS reason,SUBSTR('+field(store,'payload',['error'])+',1,1000) AS error,COUNT(*) OVER() AS event_count FROM sre_fix_events WHERE request_id=? ORDER BY at DESC,id DESC LIMIT '+qaHistoryLimits.events,[id]);
  const history=events.map(event=>{if(!/^[a-f0-9]{64}$/.test(event.id)||!epoch(Number(event.at))||event.payload_type!=='object')throw corrupt();return{id:event.id,status:short(event.status,80),at:Number(event.at),actor:event.actor===null?null:short(event.actor,512),reason:event.reason===null?null:short(event.reason,1000),error:event.error===null?null:short(event.error,1000),result:summary(event,'event_result_'),payloadOmitted:true};});
  return{version:1,incidentId,id,observedAt:sc.now,currentRevision:Number(sc.incident.revision),assessmentVersion:sc.assessmentVersion,request,result,resultOmitted,events:history,eventCoverage:{shown:history.length,total:Number(events[0]?.event_count||0),omitted:Math.max(0,Number(events[0]?.event_count||0)-history.length),rawPayloadsIncluded:false},recovery:sc.recovery,interpretation};
 });
}

const date=value=>new Date(value).toISOString();
const assessmentNote=request=>request.assessment?.state==='current'?'':request.assessment?.state==='changed'?' Current assessment changed; these local artifacts are historical. Review a fresh ticket before further work.':' Current assessment match is unverified'+(request.assessment?.reason==='legacy-plan'?' for this legacy ticket':'')+'; review the current investigation before further work.';
export function qaHistoryText(view){
 const selected=view.items.slice(0,6),c=view.coverage;
 return ['Saved local QA requests · '+view.incidentId+' · '+c.attentionTotal+' need review; '+c.total+' retained.',...(view.recovery.active?['Database restore reconciliation is active; work remains held.']:[]),...selected.map(r=>'- '+r.id+' · '+r.displayStatus+' (stored '+r.status+') · ticket '+r.plan_id+' revision '+r.plan_revision+'\n  Requested by '+short(r.requested_by,80)+' in '+short(r.origin.name,80)+'; expires '+date(r.expires_at)+'.'+(r.unexpiredProposalsInConversation>1?' '+r.unexpiredProposalsInConversation+' unexpired proposals share this conversation; yes is ambiguous.':'')+(r.status==='unknown'||r.leaseExpired?' Inspect interrupted work before another request.':'')+(r.result?.commit?' Local commit '+r.result.commit+'.':'')+assessmentNote(r)),Math.max(0,c.total-selected.length)+' retained requests are outside this message. The console can browse saved history; use qa <request-id> to inspect a known request.','Approval remains bound to the original requester/conversation and a fresh policy check. '+view.interpretation].join('\n');
}
export function qaRequestText(view){
 const r=view.request,lines=['Saved QA request · '+r.id+' · '+view.incidentId,'Observed '+date(view.observedAt)+'. '+r.displayStatus+' (stored '+r.status+').','Ticket '+r.plan_id+' · evidence revision '+r.plan_revision+'; current incident revision '+view.currentRevision+'.',...(assessmentNote(r)?[assessmentNote(r).trim()]:[]),'Requested by '+short(r.requested_by,100)+' in '+short(r.origin.name,100)+' ('+(r.origin.id||r.origin.key)+').','Approval expires '+date(r.expires_at)+'.'+(r.approved_by?' Recorded approver '+short(r.approved_by,100)+'.':''),...(r.unexpiredProposalsInConversation>1?[r.unexpiredProposalsInConversation+' unexpired proposals share that conversation; use the exact command from the reviewed proposal.']:[]),...(r.status==='unknown'||r.leaseExpired?['The execution outcome needs reconciliation; this read did not resume it.']:[]),...(r.error?['Saved reason: '+r.error]:[]),...(r.result?['Local result: '+(r.result.branch||'branch unknown')+' · '+(r.result.commit||'commit unknown')+'\nSaved executor summary: '+short(r.result.summary,500)]:[]),...view.events.slice(0,4).map(e=>'- Recorded '+e.status+' at '+date(e.at)+(e.actor?' by '+short(e.actor,80):'')+(e.result?.commit?'; local commit '+e.result.commit:'')+'.'),view.eventCoverage.omitted+' older transitions are outside this read. Full transition payloads are not included.','The console exposes bounded saved evidence. '+view.interpretation];return lines.join('\n');
}
