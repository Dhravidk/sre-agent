import {hash} from './security.mjs';
const assigned="('planned','active','blocked')";
const short=(value,limit)=>Array.from(String(value||'').replace(/\s+/gu,' ').trim()).slice(0,limit).join('');
export const handoffLimit=32;

// Derive handoffs from retained reports, before applying the per-room display
// windows. Source time, then durable receipt order, defines each new handoff.
// A cancellation withdraws only that participant's assignment, not the request
// for a receiver. This is a projection of claims and never grants an action.
export async function workHandoffs(q,{incidentId,service,rooms}){
 const coverage={total:0,retained:0,omitted:0,limit:handoffLimit,source:'retained authorized work reports'};
 if(!rooms.length)return {handoffs:[],handoffCoverage:coverage};
 const ordering='observed_at DESC,ordinal DESC,evidence_id DESC';
 const fields=prefix=>['evidence_id','conversation_key','author_key','item_state','observed_at','ordinal','content'].map(name=>prefix+'.'+name+' AS '+({r:'release',o:'owner',d:'completion'}[prefix])+'_'+name).join(',');
 const rows=await q(`WITH handoff_raw AS (
  SELECT c.item_key,c.item_state,c.evidence_id,c.conversation_key,e.observed_at,e.content,r.ordinal,COALESCE(p.author_key,'unknown') AS author_key,
   ROW_NUMBER() OVER(PARTITION BY c.item_key,CASE WHEN p.author_key IS NOT NULL AND p.author_key<>'' AND p.author_key<>'unknown' THEN 'person:'||p.author_key ELSE 'room:'||c.conversation_key END ORDER BY e.observed_at DESC,r.ordinal DESC,e.id DESC) AS position_rank,
   ROW_NUMBER() OVER(PARTITION BY c.item_key,c.item_state ORDER BY e.observed_at DESC,r.ordinal DESC,e.id DESC) AS state_rank
  FROM sre_coordination_items c JOIN sre_evidence e ON e.id=c.evidence_id JOIN sre_responder_rooms r ON r.evidence_id=c.evidence_id LEFT JOIN sre_responder_people p ON p.evidence_id=c.evidence_id
  JOIN sre_conversations route ON route.id=c.conversation_key AND route.incident_id=c.incident_id AND route.enabled=1
  WHERE c.incident_id=? AND route.tenant_id=? AND route.service_key=? AND c.kind='work' AND c.conversation_key IN (${rooms.map(()=>'?').join(',')})
 ), handoff_releases AS (SELECT * FROM handoff_raw WHERE item_state='released' AND state_rank=1),
 handoff_positions AS (SELECT * FROM handoff_raw WHERE position_rank=1),
 handoff_related AS (
  SELECT p.*,CASE WHEN p.observed_at>r.observed_at OR (p.observed_at=r.observed_at AND p.ordinal>r.ordinal) THEN 1 ELSE 0 END AS after_release
  FROM handoff_positions p JOIN handoff_releases r ON r.item_key=p.item_key
 ), handoff_counts AS (
  SELECT item_key,SUM(CASE WHEN after_release=1 AND item_state IN ${assigned} THEN 1 ELSE 0 END) AS owner_count,
   SUM(CASE WHEN after_release=0 AND item_state IN ${assigned} THEN 1 ELSE 0 END) AS prior_assigned_count,
   SUM(CASE WHEN after_release=1 AND item_state='done' THEN 1 ELSE 0 END) AS completion_count
  FROM handoff_related GROUP BY item_key
 ), handoff_receivers AS (
  SELECT *,ROW_NUMBER() OVER(PARTITION BY item_key ORDER BY ${ordering}) AS receiver_rank FROM handoff_related WHERE after_release=1 AND item_state IN ${assigned}
 ), handoff_completions AS (
  SELECT *,ROW_NUMBER() OVER(PARTITION BY item_key ORDER BY ${ordering}) AS completion_rank FROM handoff_related WHERE after_release=1 AND item_state='done'
 ) SELECT r.item_key,${fields('r')},${fields('o')},${fields('d')},n.owner_count,n.prior_assigned_count,n.completion_count,COUNT(*) OVER() AS handoff_count
 FROM handoff_releases r JOIN handoff_counts n ON n.item_key=r.item_key LEFT JOIN handoff_receivers o ON o.item_key=r.item_key AND o.receiver_rank=1 LEFT JOIN handoff_completions d ON d.item_key=r.item_key AND d.completion_rank=1
 ORDER BY CASE WHEN n.owner_count=0 AND n.completion_count=0 THEN 0 WHEN n.owner_count>0 AND n.completion_count>0 THEN 1 ELSE 2 END,r.observed_at DESC,r.ordinal DESC,r.item_key LIMIT ${handoffLimit}`,[incidentId,service.teams.tenantId,service.key,...rooms.map(room=>room.key)]);
 const report=(row,prefix)=>{
  if(!row[prefix+'_evidence_id'])return null;
  const content=JSON.parse(row[prefix+'_content']),author=row[prefix+'_author_key'];
  return {evidenceId:row[prefix+'_evidence_id'],roomKey:row[prefix+'_conversation_key'],roomName:rooms.find(room=>room.key===row[prefix+'_conversation_key'])?.name||'Linked conversation',author:short(content.displayName||content.userId||'Responder',60),participantKey:author&&author!=='unknown'?hash([service.teams.tenantId,author]):null,state:row[prefix+'_item_state'],at:Number(row[prefix+'_observed_at']),receiptOrder:Number(row[prefix+'_ordinal']),text:short(content.text,200),verified:false};
 };
 const handoffs=rows.map(row=>({key:row.item_key,state:Number(row.owner_count)&&Number(row.completion_count)?'conflicting-reports':Number(row.owner_count)?'owner-reported':Number(row.completion_count)?'completion-reported':'awaiting-owner',release:report(row,'release'),owner:report(row,'owner'),completion:report(row,'completion'),ownerCount:Number(row.owner_count),priorAssignedCount:Number(row.prior_assigned_count),completionCount:Number(row.completion_count),verified:false}));
 const total=Number(rows[0]?.handoff_count||0);return {handoffs,handoffCoverage:{...coverage,total,retained:handoffs.length,omitted:Math.max(0,total-handoffs.length)}};
}

export function handoffText(handoff){
 const h=handoff,r=h.release,origin='released by '+r.author+' in '+r.roomName+' at '+new Date(r.at).toISOString();
 if(h.state==='awaiting-owner')return 'Handoff gap on '+h.key+': '+origin+'. No current ownership or completion report follows this release. '+(h.priorAssignedCount?'Older ownership reports do not accept this new handoff. ':'')+'Name a receiver and report work '+h.key+' active <scope and next check>.';
 if(h.state==='conflicting-reports')return 'Handoff '+h.key+': '+origin+'. Current post-release ownership and completion reports conflict. Compare the result, scope and next check with a named lead.';
 if(h.state==='owner-reported')return 'Handoff '+h.key+': '+origin+'; '+h.owner.author+' in '+h.owner.roomName+' reports '+h.owner.state+' ownership after the release. '+(h.ownerCount>1?h.ownerCount+' responders claim ownership; reconcile duplicate work. ':'')+'Ownership is reported, not independently verified.';
 return 'Handoff '+h.key+': '+origin+'; '+h.completion.author+' in '+h.completion.roomName+' reports completion after the release. This is not independent task or incident recovery proof.';
}
