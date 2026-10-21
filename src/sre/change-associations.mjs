import {ciConsistencyText} from './ci-observations.mjs';
import {hash,assertText,redact} from './security.mjs';
import {StorageError} from './database.mjs';
import {readRestoreFence} from './restore-recovery.mjs';
import {freshReadObservation,changeReadReceipt,latestChangeState} from './change-read.mjs';

const prefix='change-association:',sha=value=>/^[a-f0-9]{64}$/.test(value||''),commit=value=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value||'');
const conflict=message=>Object.assign(new Error(message),{status:409});
export function changeNumber(provider,number){number=String(number);if(!['github','gitlab'].includes(provider)||!Number.isSafeInteger(Number(number))||Number(number)<=0||String(Number(number))!==number)throw Error('Use a GitHub/GitLab positive change number');return number;}
const key=(incidentId,provider,number)=>prefix+incidentId+':'+provider+':'+number;
function decode(row){
  try{
    if(typeof row.value!=='string'||Buffer.byteLength(row.value)>10000)throw Error();
    const value=JSON.parse(row.value),{checksum,...body}=value;
    if(value.version!==1||!/^inc_[a-f0-9]+$/.test(value.incidentId)||typeof value.number!=='string'||!['tracked','withdrawn'].includes(value.state)||!Number.isSafeInteger(value.generation)||value.generation<1||!sha(value.evidenceId)||value.previousEvidenceId!==null&&!sha(value.previousEvidenceId)||!Number.isSafeInteger(value.changedAt)||value.changedAt<0||!['teams','local-operator','operator-api'].includes(value.actor?.kind)||typeof value.actor.id!=='string'||!value.actor.id||typeof value.actor.label!=='string'||value.actor.label.length>160||typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>1000||value.restoreId!==null&&(typeof value.restoreId!=='string'||value.restoreId.length>160)||value.headSha!==null&&!commit(value.headSha)||!sha(checksum)||hash(body)!==checksum||key(value.incidentId,value.provider,changeNumber(value.provider,value.number))!==row.id)throw Error();
    return value;
  }catch{throw new StorageError(new Error('Invalid change-association control'));}
}
export async function readAssociationControl(q,incidentId,provider,number){const [row]=await q('SELECT id,value FROM sre_checkpoints WHERE id=?',[key(incidentId,provider,number)]);return row?decode(row):null;}
export async function associationContext(store,incidentId){
  const rows=await store.db.query('SELECT id,value FROM sre_checkpoints WHERE id LIKE ? ORDER BY updated_at DESC,id DESC LIMIT 101',[prefix+incidentId+':%']),fence=await store.restoreFence();
  const [incident]=await store.db.query('SELECT service_key FROM sre_incidents WHERE id=?',[incidentId]),service=store.services.find(s=>s.key===incident?.service_key),links=await store.db.query('SELECT provider,change_number FROM sre_incident_change_links WHERE incident_id=? ORDER BY provider,change_number LIMIT 21',[incidentId]),reads=[];
  if(service)for(const link of links.slice(0,20)){const read=await changeReadReceipt(store.db.query,service,link.provider,link.change_number,store.db.dialect);if(read)reads.push({...read,historicalAfterRestore:Boolean(fence&&read.restoreId!==fence.restoreId)});}
  return {controls:rows.slice(0,100).map(row=>{const control=decode(row);if(control.incidentId!==incidentId)throw new StorageError(new Error('Change association crossed an incident boundary'));return {...control,historicalAfterRestore:Boolean(fence&&control.restoreId!==fence.restoreId)};}),limited:rows.length>100,reads,readsLimited:links.length>20,note:'Relationship decisions are attributed context, not causal findings, code-health evidence or action approvals. Provider update and local read times are distinct. Historical decisions may omit changes after the backup.'};
}
export async function automaticAssociationAllowed(q,incident,provider,number){
  const control=await readAssociationControl(q,incident.id,provider,number);if(control?.state==='withdrawn')return false;
  // The change's own provider review keeps its natural identity. Operational
  // relationships require review after a potentially incomplete restoration.
  if(incident.issue_key==='review:'+provider+':'+number)return true;
  const fence=await readRestoreFence(q);
  return !fence||!fence.active&&control?.state==='tracked'&&control.restoreId===fence.restoreId;
}
async function scope(store,services,q,incidentId,actor){
  if(!['teams','local-operator','operator-api'].includes(actor?.kind))throw Error('Change tracking requires an authenticated participant or operator');
  const fence=await store.restoreFence(q,{lock:true});if(fence?.active)throw Error('Change tracking is held during restore reconciliation');
  const [incident]=await q('SELECT * FROM sre_incidents WHERE id=?'+(store.db.dialect==='postgres'?' FOR UPDATE':''),[incidentId]);if(!incident)throw Error('Unknown incident');
  const service=services.find(s=>s.key===incident.service_key);if(!service)throw Error('Unknown service');let attribution;
  if(actor.kind==='teams'){
    const p=actor.principal;
    if(!p?.verified||p.tenant!==service.teams.tenantId||hash([p.tenant,p.conversationId]).slice(0,32)!==actor.conversationKey)throw Error('Change tracking requires the verified originating conversation');
    assertText(p.userId,'participant identity',512);const room=await store.authorizeIncidentConversation(actor.conversationKey,incidentId,q);if(room.incident_id!==incidentId)throw Error('Join this incident before tracking a change');
    attribution={kind:'teams',id:p.userId,label:assertText(redact(actor.displayName||p.userId),'participant label',160),tenant:p.tenant,conversationId:p.conversationId};
  }else attribution={kind:actor.kind,id:assertText(actor.id,'operator identity',512),label:'Operator console'};
  return {incident,service,fence,actor:attribution};
}
async function observation(q,incidentId,provider,number,service,fence,proofId,dialect){
  const serviceKey=service.key;
  const state=await latestChangeState(q,serviceKey,provider,number,dialect);let latest=state.latest;
  if(latest){
    if(state.conflicting)throw Error('Conflicting latest change observations require reconciliation before linking');
    latest={id:latest.id,headSha:latest.head_sha,stage:latest.stage,observedAt:Number(latest.observed_at),receivedAt:Number(latest.received_at),payload:JSON.parse(latest.payload)};
  }else if(proofId){
    let [evidence]=await q("SELECT id,kind,content,observed_at FROM sre_evidence WHERE id=? AND incident_id=? AND source=? AND kind IN ('code_review','change')",[proofId,incidentId,provider]);let content=evidence?JSON.parse(evidence.content):{};
    if(evidence?.kind==='change'&&content.association?.authority==='context_association'&&sha(content.providerObservation?.eventId)){
      [evidence]=await q("SELECT id,kind,content,observed_at FROM sre_evidence WHERE id=? AND incident_id=? AND source=? AND kind='code_review'",[content.providerObservation.eventId,incidentId,provider]);content=evidence?JSON.parse(evidence.content):{};
    }
    if(evidence?.kind==='code_review'&&commit(content.headSha))latest={id:evidence.id,headSha:content.headSha,stage:'code-review-snapshot',observedAt:Number(evidence.observed_at),receivedAt:Number(evidence.observed_at),payload:{provider,number:Number(number),sha:content.headSha,headSha:content.headSha,stage:'code-review-snapshot'}};
  }
  if(!latest)throw Error('No observed MR/PR record exists in this service. Collect its authenticated MR/PR update through the configured integration first; a pasted number or URL is not provider evidence.');
  latest.readObservation=await freshReadObservation(q,service,provider,number,latest,fence,dialect);
  if(fence&&!latest.readObservation&&(latest.observedAt<fence.preparedAt||latest.receivedAt<fence.preparedAt))throw Error('The change observation is historical after restore; collect a fresh current provider observation before linking');
  return latest;
}
const receipt=(record,duplicate=false)=>({incidentId:record.incidentId,provider:record.provider,number:record.number,status:record.state,evidenceId:record.evidenceId,reference:record.evidenceId,previousEvidenceId:record.previousEvidenceId,headSha:record.headSha||null,stage:record.stage||null,generation:record.generation,duplicate});
async function saveMutation(store,q,context,provider,number,priorControl,previousEvidenceId,state,reason,observed){
  const generation=(priorControl?.generation||0)+1;if(!Number.isSafeInteger(generation))throw Error('Change-association generation exhausted; inspect its audit');
  const now=await store.coordinationNow(q),incidentId=context.incident.id,evidenceId=hash(['change-association',incidentId,provider,number,generation]);
  const body={version:1,incidentId,provider,number,generation,state,evidenceId,previousEvidenceId:previousEvidenceId||null,changedAt:now,actor:context.actor,reason,restoreId:context.fence?.restoreId||null,headSha:observed?.headSha||priorControl?.headSha||null,stage:observed?.stage||priorControl?.stage||null};
  const record={...body,checksum:hash(body)},association={...context.actor,at:now,generation,reason,authority:'context_association',previousEvidenceId:previousEvidenceId||null,note:'Relationship decision; not a causal finding, QA authorization, provider deletion or recovery proof'};
  const content=state==='tracked'?{...observed.payload,reviewOnly:false,linkedReview:true,providerObservation:{eventId:observed.id,observedAt:observed.observedAt,receivedAt:observed.receivedAt,...(observed.readObservation?{readObservation:observed.readObservation}:{})},association}:{provider,number,state,association,originalEvidenceId:previousEvidenceId};
  await q('INSERT INTO sre_evidence(id,incident_id,source,kind,observed_at,content) VALUES(?,?,?,?,?,?)',[evidenceId,incidentId,state==='tracked'?provider:'change-association',state==='tracked'?'change':'change_association',now,JSON.stringify(content)]);
  await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[key(incidentId,provider,number),JSON.stringify(record),now]);
  if(state==='tracked')await q('INSERT INTO sre_incident_change_links(incident_id,provider,change_number,linked_at,evidence_id) VALUES(?,?,?,?,?) ON CONFLICT(incident_id,provider,change_number) DO UPDATE SET linked_at=excluded.linked_at,evidence_id=excluded.evidence_id',[incidentId,provider,number,now,evidenceId]);
  else await q('DELETE FROM sre_incident_change_links WHERE incident_id=? AND provider=? AND change_number=?',[incidentId,provider,number]);
  await q('UPDATE sre_incidents SET revision=revision+1 WHERE id=?',[incidentId]);
  await q("INSERT INTO sre_jobs(id,incident_id,payload,status,attempts,next_at,created_at) VALUES(?,?,?,'pending',0,?,?)",[hash(['association-reassessment',evidenceId]),incidentId,JSON.stringify({associationEvidenceId:evidenceId,question:'Reassess the incident after an attributed change-association correction. A relationship decision is not causal or recovery proof.'}),now,now]);
  await store.queueMessage(incidentId,'Change context · '+provider+' #'+number+' '+(state==='withdrawn'?'withdrawn from':'associated with')+' '+incidentId+' by '+context.actor.label+'. '+reason+'\nReference: '+evidenceId+'. Provider facts and prior tickets remain retained. This changes context, not cause, approval, code health or recovery.',null,'association:'+evidenceId,q,{broadcast:true});
  return record;
}
export async function trackAssociation(store,services,incidentId,provider,number,actor,options={}){
  const {reconsiderEvidenceId,reason}=options;if(Object.hasOwn(options,'reconsiderEvidenceId')&&!sha(reconsiderEvidenceId))throw Error('Review the current withdrawal reference before reconsidering a relationship');
  number=changeNumber(provider,number);
  return store.db.transaction(async q=>{
    const context=await scope(store,services,q,incidentId,actor),control=await readAssociationControl(q,incidentId,provider,number),[prior]=await q('SELECT * FROM sre_incident_change_links WHERE incident_id=? AND provider=? AND change_number=?',[incidentId,provider,number]);
    let explanation='Explicitly associated this observed change with the incident.';
    if(reconsiderEvidenceId){
      explanation=assertText(redact(reason||''),'reconsideration reason',1000).trim();
      if(control?.state==='tracked'&&control.previousEvidenceId===reconsiderEvidenceId&&control.reason===explanation&&hash(control.actor)===hash(context.actor))return receipt(control,true);
      if(!sha(reconsiderEvidenceId)||control?.state!=='withdrawn'||control.evidenceId!==reconsiderEvidenceId)throw conflict('The withdrawal reference changed; review the current correction before reconsidering');
    }else if(control?.state==='withdrawn')throw conflict('This association was withdrawn. Review its reason and use retrack-change '+provider+' '+number+' '+control.evidenceId+' <reason> to reconsider explicitly.');
    const observed=await observation(q,incidentId,provider,number,context.service,context.fence,prior?.evidence_id||control?.previousEvidenceId,store.db.dialect);
    if(prior&&!reconsiderEvidenceId&&(!context.fence||control?.restoreId===context.fence.restoreId))return {incidentId,provider,number,headSha:observed.headSha,stage:observed.stage,evidenceId:prior.evidence_id,duplicate:true};
    if(context.fence&&!reconsiderEvidenceId)explanation='Reaffirmed the relationship from a fresh provider observation after restore reconciliation.';
    const record=await saveMutation(store,q,context,provider,number,control,reconsiderEvidenceId||prior?.evidence_id,'tracked',explanation,observed);return receipt(record);
  });
}
export async function withdrawAssociation(store,services,incidentId,provider,number,actor,{expectedEvidenceId,reason}={}){
  number=changeNumber(provider,number);if(!sha(expectedEvidenceId))throw Error('Review the current link reference before withdrawing it');const explanation=assertText(redact(reason||''),'withdrawal reason',1000).trim();
  return store.db.transaction(async q=>{
    const context=await scope(store,services,q,incidentId,actor);if(context.incident.issue_key==='review:'+provider+':'+number)throw Error('This is the change’s own provider-review incident. Correct its relationship in the operational incident instead.');
    const control=await readAssociationControl(q,incidentId,provider,number);
    if(control?.state==='withdrawn'){
      if(control.previousEvidenceId===expectedEvidenceId&&control.reason===explanation&&hash(control.actor)===hash(context.actor))return receipt(control,true);
      throw conflict('This association is already withdrawn; review its retained correction before another request');
    }
    const [prior]=await q('SELECT * FROM sre_incident_change_links WHERE incident_id=? AND provider=? AND change_number=?',[incidentId,provider,number]);
    if(!prior||prior.evidence_id!==expectedEvidenceId)throw conflict('The active link changed; review its current reference before withdrawing');
    const record=await saveMutation(store,q,context,provider,number,control,expectedEvidenceId,'withdrawn',explanation);return receipt(record);
  });
}
export function associationDecision(context,row){
  const c=row.content||{},number=c.number??c.comparison?.mergeRequest?.iid??c.comparison?.review?.pull?.number;
  if(!number||!['github','gitlab'].includes(row.source))return null;
  const control=context.changeAssociations?.controls?.find(v=>v.provider===row.source&&v.number===String(number));
  if(control?.state==='withdrawn')return 'withdrawn';
  if(control?.historicalAfterRestore||context.recoveryFence&&control?.restoreId!==context.recoveryFence.restoreId&&context.incident.issue_key!=='review:'+row.source+':'+number)return 'historical';
  if(context.changeAssociations?.limited&&!control)return 'unknown';return control?.state||null;
}
export function associationText(view){return ['Change-association decisions (context, not cause or approval):',...view.controls.slice(0,12).map(c=>c.provider+' #'+c.number+' · '+c.state+(c.historicalAfterRestore?' · historical after restore':'')+' by '+c.actor.label+': '+c.reason+' · reference '+c.evidenceId),...(view.limited||view.controls.length>12?['Further decisions are omitted from this window; inspect the retained audit.']:[]),...(view.reads||[]).slice(0,6).map(r=>'Provider read '+r.provider+' #'+r.number+' · '+(r.complete?'metadata observed':'needs attention: '+r.error)+(r.historicalAfterRestore?' · historical after restore':'')+' · provider updated '+(r.providerUpdatedAt===null?'unknown':new Date(r.providerUpdatedAt).toISOString())+' · read completed '+new Date(r.readCompletedAt).toISOString()+' · CI '+(r.ci?.status||r.ci?.state||'unknown')+(r.ci?.eventId?' · CI source event '+r.ci.eventId:'')+(r.ci?.note?' · '+r.ci.note:'')+ciConsistencyText(r.ci)+'. A read is not cause or recovery proof.'),...(view.readsLimited||(view.reads||[]).length>6?['Further tracked-change read observations are omitted.']:[])].join('\n');}
