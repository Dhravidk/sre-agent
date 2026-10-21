import { assertText,hash,redact } from './security.mjs';

const conflict=message=>Object.assign(new Error(message),{status:409});
const receipt=(row,duplicate)=>({id:row.id,incidentId:row.incident_id,originalJobId:row.job_id,replacementJobId:row.replacement_job_id,requestedAt:Number(row.created_at),duplicate});

export async function retryInvestigation(store,{serviceKey,incidentId,jobId,requestId,reason,actor,conversationKey}) {
  assertText(serviceKey,'service key',200);assertText(incidentId,'incident ID',200);
  if(!/^[a-f0-9]{64}$/.test(jobId||''))throw new Error('Invalid investigation job ID');
  if(!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId||''))throw new Error('A stable retry request ID is required');
  assertText(reason,'retry reason',1000);
  if(!['operator-api','local-operator','teams'].includes(actor?.kind))throw new Error('Authenticated operator identity required');
  assertText(actor.id,'operator identity',512);
  const id=hash(['investigation-retry',serviceKey,requestId]);
  const bodyHash=hash({incidentId,jobId,reason,actor,conversationKey:conversationKey??null});
  return store.db.transaction(async q=>{
    const [job]=await q('SELECT j.* FROM sre_jobs j JOIN sre_incidents i ON i.id=j.incident_id WHERE j.id=? AND j.incident_id=? AND i.service_key=?'+(store.db.dialect==='postgres'?' FOR UPDATE OF j':''),[jobId,incidentId,serviceKey]);
    if(!job)throw Object.assign(new Error('Investigation job not found in this incident/service'),{status:404});
    // Lock before reading the receipt so concurrent identical requests see the
    // committed first result after waiting for the original job row.
    const [prior]=await q('SELECT * FROM sre_job_retries WHERE id=?',[id]);
    if(prior) {
      if(prior.body_hash!==bodyHash)throw conflict('Retry request ID was reused with different content');
      return receipt(prior,true);
    }
    if(job.status!=='dead')throw conflict('Only an exhausted investigation can be retried; inspect its current status');
    const replacementId=hash(['investigation-replacement',id]),now=await store.coordinationNow(q);
    const original=JSON.parse(job.payload);
    const payload={...original,question:original.question||'Reinvestigate this incident using current evidence.',retryOf:job.id,retryRequestId:id,...(conversationKey!==undefined?{conversationKey}:{})};
    const cleanActor=redact(actor),cleanReason=redact(reason.trim());
    const inserted=await q('INSERT INTO sre_job_retries(id,incident_id,job_id,replacement_job_id,body_hash,requested_by,reason,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id',[id,incidentId,job.id,replacementId,bodyHash,JSON.stringify(cleanActor),cleanReason,now]);
    if(!inserted.length) {
      const [existing]=await q('SELECT * FROM sre_job_retries WHERE id=?',[id]);
      if(existing?.body_hash===bodyHash)return receipt(existing,true);
      throw conflict('Retry request conflicts with an existing recovery request');
    }
    await q("INSERT INTO sre_jobs(id,incident_id,payload,status,attempts,next_at,created_at) VALUES(?,?,?,'pending',0,?,?)",[replacementId,incidentId,JSON.stringify(payload),now,now]);
    await q("UPDATE sre_jobs SET status='retried',lease_owner=NULL,lease_until=NULL WHERE id=? AND status='dead'",[job.id]);
    const evidence={text:'Operator requested another read-only investigation: '+cleanReason,authority:'operator_request',action:'retry_investigation',originalJobId:job.id,replacementJobId:replacementId,actor:cleanActor};
    await q('INSERT INTO sre_evidence(id,incident_id,source,kind,observed_at,content) VALUES(?,?,?,?,?,?)',[id,incidentId,'operator-recovery','question',now,JSON.stringify(evidence)]);
    await q('UPDATE sre_incidents SET revision=revision+1 WHERE id=?',[incidentId]);
    return receipt({id,incident_id:incidentId,job_id:job.id,replacement_job_id:replacementId,created_at:now},false);
  });
}
