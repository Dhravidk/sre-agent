import{redact}from'./security.mjs';
import{readOnlyTeams,validateRecordedTeamsCommand,observeTeamsCommand}from'./teams-requests.mjs';
import{teamsConversationAllowed}from'./teams-access.mjs';
import{roomScope}from'./collaboration.mjs';
import{restoreSummary}from'./restore-recovery.mjs';
const fail=(status,text)=>Object.assign(Error(text),{status}),epoch=n=>Number.isSafeInteger(n)&&n>=0,digest=n=>typeof n==='string'&&/^[a-f0-9]{64}$/.test(n),pageSize=20,sourceLimit=131072;
const field=(store,path,column='e.payload')=>store.db.dialect==='postgres'?column+"::jsonb#>>'{"+path.join(',')+"}'":"json_extract("+column+",'$."+path.join('.')+"')";
const columns=`e.id,e.source,e.service_key,e.external_id,e.kind,e.incident_id,e.occurred_at,e.received_at,e.body_hash,CASE WHEN LENGTH(e.payload)<=${sourceLimit} THEN e.payload ELSE NULL END AS payload,c.id AS command_id,c.status AS command_status,c.error AS command_error,c.lease_until AS command_lease_until,c.created_at AS command_created_at,CASE WHEN LENGTH(c.payload)<=${sourceLimit} THEN c.payload ELSE NULL END AS command_payload`;
const base=' FROM sre_events e LEFT JOIN sre_commands c ON c.id=e.id ';
const decode=row=>validateRecordedTeamsCommand(row,row?.command_id?{id:row.command_id,payload:row.command_payload,status:row.command_status,error:row.command_error,lease_until:row.command_lease_until,created_at:row.command_created_at}:null);
const clip=(text,max)=>{let s=redact(text).slice(0,max);if(/[\uD800-\uDBFF]$/.test(s))s=s.slice(0,-1);return s;};
async function scope(store,q,id){
 if(typeof id!=='string'||!/^inc_[a-f0-9]+$/.test(id))throw fail(400,'Invalid incident identity');
 const [row]=await q('SELECT service_key FROM sre_incidents WHERE id=?',[id]),service=store.services.find(s=>s.key===row?.service_key);if(!row||!service)throw fail(404,'The configured incident was not found');
 const [audience]=await q('SELECT scope_key FROM sre_incident_audiences WHERE incident_id=?',[id]);return{service,incidentId:id,audience:audience?.scope_key??null};
}
function accessible(sc,record){const p=record.message.principal;return p.tenant===sc.service.teams.tenantId&&teamsConversationAllowed(sc.service.teams,p.conversationId)&&(!sc.audience||roomScope(sc.service,p.conversationId).key===sc.audience);}
function validateScope(sc,record){if(record.row.service_key!==sc.service.key||record.message.incidentId!==sc.incidentId)throw fail(404,'This instruction does not belong to the selected incident');}
function cursor(sc,value){
 if(value===undefined||value===null||value==='')return null;
 try{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(value))throw Error();const c=JSON.parse(Buffer.from(value,'base64url'));if(c.version!==1||c.incidentId!==sc.incidentId||c.serviceKey!==sc.service.key||!epoch(c.at)||!digest(c.id)||Object.keys(c).sort().join(',')!=='at,id,incidentId,serviceKey,version')throw Error();return c;}catch{throw fail(400,'Invalid saved-instruction cursor for this incident; reload its history');}
}
function encodedCursor(sc,r){return Buffer.from(JSON.stringify({version:1,incidentId:sc.incidentId,serviceKey:sc.service.key,at:Number(r.row.received_at),id:r.row.id})).toString('base64url');}
async function source(q,id){const[row]=await q('SELECT '+columns+base+'WHERE e.id=? AND e.source=\'teams\' AND e.kind=\'teams\'',[id]);return row;}
export async function listTeamsInstructions(store,incidentId,{cursor:after}={}){
 return readOnlyTeams(store,async q=>{
  const sc=await scope(store,q,incidentId),position=cursor(sc,after);
  if(position){const row=await source(q,position.id);if(!row)throw fail(409,'The history cursor source is missing; reload its history');const boundary=decode(row);validateScope(sc,boundary);if(Number(row.received_at)!==position.at)throw fail(409,'The history cursor changed; reload its history');}
  const args=[sc.service.key,incidentId,incidentId],before=position?' AND (e.received_at<? OR (e.received_at=? AND e.id<?))':'';if(position)args.push(position.at,position.at,position.id);
  const rows=await q("SELECT "+columns+base+"WHERE e.source='teams' AND e.kind='teams' AND e.service_key=? AND "+'('+field(store,['payload','incidentId'])+'=? OR '+field(store,['incidentId'],'c.payload')+'=?)'+before+' ORDER BY e.received_at DESC,e.id DESC LIMIT '+(pageSize+1),args),page=rows.slice(0,pageSize),items=[];let inaccessible=0,last;
  for(const row of page){const r=decode(row);validateScope(sc,r);last=r;if(!accessible(sc,r)){inaccessible++;continue;}const m=r.message,p=m.principal,approval=/^approve(?:-fix)?(?:\s|$)/i.test(m.text);items.push({id:row.id,incidentId,sourceAt:Number(row.occurred_at),admittedAt:Number(row.received_at),conversationId:p.conversationId,actor:{id:p.userId,name:m.displayName},preview:approval?'Approval instruction · arguments hidden':clip(m.text,180),processingState:r.command.status});}
  return{version:1,incidentId,observedAt:await store.coordinationNow(q),items,nextCursor:rows.length>pageSize?encodedCursor(sc,last):null,coverage:{selection:'original-command-binding',pageSize,scanned:page.length,inaccessible,hasMore:rows.length>pageSize,completeHistory:false},recovery:restoreSummary(await store.restoreFence(q))};
 });
}
export async function recordedTeamsInstruction(store,incidentId,id){
 if(!digest(id))throw fail(400,'Invalid saved instruction identity');
 return readOnlyTeams(store,async q=>{const sc=await scope(store,q,incidentId),row=await source(q,id);if(!row)throw fail(404,'The saved instruction was not found; missing history does not prove it never ran');const r=decode(row);validateScope(sc,r);if(!accessible(sc,r))throw fail(403,'This recorded conversation is outside current simulator sharing access');const m=r.message,p=m.principal,v=await observeTeamsCommand(store,q,{scope:{tenant:p.tenant,serviceKey:sc.service.key},request:{text:m.text,addressed:m.addressed},conversationId:p.conversationId,eventId:id,record:{eventId:id,incidentId,requestedAt:Number(row.occurred_at),ignored:false,reason:null},command:r.command});return{...v,commandId:id,admittedAt:Number(row.received_at)};});
}
