import {hash,redact} from './security.mjs';
import {materialChangeObservations} from './change-observation-notices.mjs';

// Wording can change on every model turn. Compare structured judgments and
// host-owned observations, leaving full explanations in assessment history.
const materialKey=a=>hash({incidentStatus:a.incidentStatus,changeAssessment:a.changeAssessment,candidateSha:a.candidateSha,remediation:a.remediation?{kind:a.remediation.kind,targetSha:a.remediation.targetSha}:null,findings:(a.codeFindings||[]).map(f=>[f.provider,f.path,f.sha,f.lineStart,f.lineEnd]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),likelihood:a.risk?.likelihood,confidence:a.risk?.confidence,stage:a.risk?.scope?.stage,headSha:a.risk?.scope?.headSha,mergedSha:a.risk?.scope?.mergedSha,rollback:a.rollback,trackedChanges:a.trackedChanges,observedChanges:materialChangeObservations(a.observedChanges||[]),observedChangesLimited:a.observedChangesLimited||false,directory:a.contacts?.directoryId,contacts:a.contacts?.contacts?.map(c=>[c.id,c.role]).sort()});

// A checkpoint means queued, never delivered or acknowledged. Keep it through
// retries/restarts so another model turn cannot manufacture a repeated notice.
export async function queueModelMessages(store,q,{job,analysis,previous,changed,id,replies}){
  if(!Array.isArray(analysis.teamsMessages)||analysis.teamsMessages.length>4)throw Error('Invalid agent message requests');
  const direct=new Set([...(job.payload.question?[job.payload.conversationKey]:[]),...(job.payload.requests||[]).map(r=>r.conversationKey),...replies].filter(Boolean)),destinations=new Set();
  for(const message of analysis.teamsMessages){
    if(typeof message.text!=='string'||!message.text.trim()||message.text.length>4000||destinations.has(message.roomKey))throw Error('Invalid agent message request');
    destinations.add(message.roomKey);
    const room=await store.authorizeIncidentConversation(message.roomKey,job.incident_id,q);
    if(room.incident_id!==job.incident_id)throw Error('Agent message destination no longer follows the incident');
    const key='agent-message-last:'+job.incident_id+':'+room.id,[cached]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[key]);
    const prior=cached?JSON.parse(cached.value):null,textHash=hash(redact(message.text.trim())),assessmentHash=materialKey(analysis);
    if(prior&&(prior.version!==1||!/^[a-f0-9]{64}$/.test(prior.textHash||'')||prior.assessmentHash!==undefined&&!/^[a-f0-9]{64}$/.test(prior.assessmentHash)))throw Error('Invalid saved agent notification fingerprint');
    const legacy=previous?.teamsMessages?.find(m=>m.roomKey===room.id),previousHash=prior?.textHash||(legacy?hash(redact(legacy.text.trim())):null);
    if(!direct.has(room.id)&&previousHash&&(previousHash===textHash||prior?.assessmentHash===assessmentHash||!prior?.assessmentHash&&!changed))continue;
    await store.queueMessage(job.incident_id,message.text,room.id,id+':agent:'+room.id,q);
    await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[key,JSON.stringify({version:1,textHash,assessmentHash}),await store.coordinationNow(q)]);
  }
}
