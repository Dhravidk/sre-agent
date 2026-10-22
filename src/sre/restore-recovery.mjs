import { hash,redact,assertText } from './security.mjs';
import { StorageError } from './database.mjs';

const key='recovery:database-restore',history=id=>key+':'+hash(id);
const conflict=message=>Object.assign(new Error(message),{status:409});
const actorId=actor=>{
  if(actor?.kind!=='local-operator')throw new Error('Database restore recovery requires a local operator');
  return assertText(actor.id,'local operator identity',512);
};
function identity(id){if(!/^[A-Za-z0-9._:-]{1,160}$/.test(id||''))throw new Error('A stable restore ID is required');}
function decode(value) {
  try {
    const record=JSON.parse(value);
    if(record.version!==1||typeof record.active!=='boolean'||typeof record.restoreId!=='string'||!/^[a-f0-9]{64}$/.test(record.backupSha256)||!Number.isSafeInteger(record.preparedAt))throw new Error();
    return record;
  } catch {throw new StorageError(new Error('Invalid database restore fence'));}
}
export async function readRestoreFence(query,lock=false) {
  const [row]=await query('SELECT value FROM sre_checkpoints WHERE id=?'+(lock?' FOR UPDATE':''),[key]);
  return row?decode(row.value):null;
}
// Descriptive receipt only. This does not release a hold or authorize work.
export const restoreSummary=fence=>({active:fence?.active===true,restoreId:fence?.restoreId||null});
const save=async(q,id,value,now)=>q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[id,JSON.stringify(value),now]);

// Offline preparation requires stopped old agents and revoked write access.
// A restored database cannot detect its lost commits or fence an older binary.
export async function prepareRestore(store,{restoreId,backupSha256,backupAt,reason,actor,offline},{query}={}) {
  identity(restoreId);assertText(reason,'restore reason',1000);const operator=actorId(actor);
  if(offline!==true)throw new Error('Stop all old agents and explicitly select offline restored-database preparation');
  if(!/^[a-f0-9]{64}$/.test(backupSha256||''))throw new Error('The restored backup archive SHA256 is required');
  if(!Number.isSafeInteger(backupAt)||backupAt<0)throw new Error('Backup time must be epoch milliseconds');
  const body={restoreId,backupSha256,backupAt,reason:redact(reason.trim()),operator},bodyHash=hash(body);
  const prepare=async q=>{
    if(store.db.dialect==='postgres')await q('LOCK TABLE sre_checkpoints,sre_provider_retries,sre_locks,sre_jobs,sre_commands,sre_outbox,sre_delivery_inspections,sre_rollbacks,sre_sessions,sre_incidents,sre_evidence,sre_responder_rooms,sre_responder_people,sre_incident_audiences,sre_coordination,sre_coordination_items,sre_coordination_receipts,sre_directory_snapshots,sre_fix_plans,sre_fix_requests,sre_fix_events,sre_change_events,sre_incident_change_links,sre_alert_threads,sre_log_samples IN ACCESS EXCLUSIVE MODE NOWAIT');
    const [prior]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[history(restoreId)]);
    if(prior){const record=decode(prior.value);if(record.bodyHash!==bodyHash)throw conflict('Restore ID was reused with different preparation');return {...record,duplicate:true};}
    if((await readRestoreFence(q))?.active)throw conflict('Another database restore is still held for reconciliation');
    const now=await store.coordinationNow(q);if(backupAt>now)throw new Error('Backup time is in the future');
    const counts={};
    for(const [name,table,where] of [['deliveries','sre_outbox',"status IN ('pending','sending')"],['rollbacks','sre_rollbacks',"status IN ('pending','approved','checking','dispatching','dispatched')"],['commands','sre_commands',"status IN ('pending','running')"],['runningInvestigations','sre_jobs',"status='running'"]])counts[name]=Number((await q('SELECT COUNT(*) AS count FROM '+table+' WHERE '+where))[0].count);
    const explanation='Database restore '+restoreId+': external effects after the backup are unknown; reconcile before any retry';
    const qa=await q("SELECT id,status FROM sre_fix_requests WHERE status IN ('proposed','approved','running')");
    if(qa.length)counts.qaRequests=qa.length;
    const [samples]=await q('SELECT COUNT(*) AS count FROM sre_log_samples');if(Number(samples.count))counts.logSamples=Number(samples.count);
    await q("UPDATE sre_fix_requests SET status='unknown',error=?,lease_owner=NULL,lease_until=NULL WHERE status IN ('proposed','approved','running')",[explanation+'; request a freshly reviewed plan and approval']);
    for(const request of qa){const payload={restoreId,previousStatus:request.status,reason:explanation};await q('INSERT INTO sre_fix_events(id,request_id,status,at,payload) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',[hash(['restore-qa',restoreId,request.id]),request.id,'unknown',now,JSON.stringify(payload)]);}
    // Matching samples are a derived detection cache. Keep the source events,
    // evidence, tickets and completed QA artifacts, but rebuild counters from
    // fresh admitted observations after the restore hold is released.
    await q('DELETE FROM sre_log_samples');
    await q("UPDATE sre_outbox SET status='unknown',error=?,lease_owner=NULL,lease_until=NULL WHERE status IN ('pending','sending')",[explanation]);
    await q("UPDATE sre_rollbacks SET status='unknown',error=?,lease_until=NULL WHERE status IN ('pending','approved','checking','dispatching','dispatched')",[explanation]);
    await q("UPDATE sre_commands SET status='discarded',error=?,lease_until=NULL WHERE status IN ('pending','running')",[explanation+'; a fresh instruction is required']);
    await q("UPDATE sre_jobs SET status='pending',next_at=?,lease_owner=NULL,lease_until=NULL WHERE status='running'",[now]);
    await q('DELETE FROM sre_locks');
    await q('UPDATE sre_coordination SET last_hash=NULL,published_at=0');
    // The model may have advanced beyond this backup. Preserve the local agent
    // identity, while discarding the stale external-session cursor.
    await q("UPDATE sre_sessions SET remote_state='{}'");
    // Generated contact provenance and prepared send bodies are historical
    // evidence. Publication receipts are positive certainty and must reset.
    // Responder aliases describe restored conversations; they do not grant
    // membership, incident sharing, acknowledgement or action authority.
    // The exact rehearsal checkpoint identifies its existing fictional dataset.
    // It does not certify freshness or authorize resuming an incomplete setup.
    // Queue service positions and bounded settling gates retain scheduling
    // history; they provide no health, publication or action authority.
    await q("DELETE FROM sre_checkpoints WHERE id NOT LIKE 'recovery:database-restore%' AND id NOT LIKE 'change-association:%' AND id NOT LIKE 'outbox-contact:%' AND id NOT LIKE 'contact-delivery:%' AND id NOT LIKE 'teams-delivery:%' AND id NOT LIKE 'coordination-attention-covered:%' AND id NOT LIKE 'teams-room-label:%' AND id NOT LIKE 'agent-message-last:%' AND id NOT LIKE 'agent-freshness-ready:%' AND id NOT LIKE 'agent-request-schedule:%' AND id NOT LIKE 'agent-scheduled:%' AND id NOT LIKE 'agent-room-scheduled:%' AND id NOT LIKE 'agent-model-quota:%' AND id NOT IN ('agent-scheduler-policy','agent-model-quota') AND id NOT LIKE 'operator-question-request:%' AND id NOT LIKE 'simulation-teams-request:%' AND id NOT LIKE 'initial-read-start:%' AND id NOT LIKE 'initial-read-end:%' AND id<>?",['rehearsal:multi-team:v1']);
    for(const incident of await q('SELECT id,updated_at,source_states FROM sre_incidents')) {
      const status=Object.values(JSON.parse(incident.source_states)).some(item=>item.status==='OPEN')?'open':'verifying';
      await q('UPDATE sre_incidents SET status=?,analysis=NULL,revision=revision+1,updated_at=? WHERE id=?',[status,Math.max(now,Number(incident.updated_at)),incident.id]);
      const id=hash(['database-restore',restoreId,incident.id]);
      const evidence={restoreId,backupSha256,backupAt,preparedAt:now,message:'History stops at the backup. Later source changes, commands, deliveries, approvals, deployments and model history require reconciliation. This is not recovery verification.'};
      await q('INSERT INTO sre_evidence(id,incident_id,source,kind,observed_at,content) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',[id,incident.id,'system','database_restore',now,JSON.stringify(evidence)]);
      await q("INSERT INTO sre_jobs(id,incident_id,payload,status,attempts,next_at,created_at) VALUES(?,?,?,'pending',0,?,?) ON CONFLICT DO NOTHING",[id,incident.id,JSON.stringify({eventId:id,question:'Reinvestigate after database restore '+restoreId+'. Identify missing post-backup facts and collect fresh source evidence. Outbound actions remain held.',conversationKey:null}),now,now]);
    }
    const record={version:1,...body,bodyHash,preparedAt:now,active:true,counts};
    await save(q,key,record,now);await save(q,history(restoreId),record,now);return {...record,duplicate:false};
  };
  return query?prepare(query):store.db.transaction(prepare);
}

// An audited operator attestation releases only the global hold. It is not
// provider/health proof and never clears uncertain deliveries or deployments.
export async function releaseRestore(store,{restoreId,requestId,reason,actor,observedAt,evidenceUrls}) {
  identity(restoreId);identity(requestId);assertText(reason,'reconciliation reason',1000);const operator=actorId(actor);
  if(!Array.isArray(evidenceUrls)||!evidenceUrls.length||evidenceUrls.length>10)throw new Error('Link the external reconciliation evidence');
  for(const value of evidenceUrls){assertText(value,'reconciliation URL',4000);const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw new Error('HTTPS reconciliation evidence without embedded credentials is required');}
  const attestation={requestId,reason:redact(reason.trim()),operator,observedAt,evidenceUrls},bodyHash=hash(attestation);
  return store.db.transaction(async q=>{
    const [row]=await q('SELECT value FROM sre_checkpoints WHERE id=?'+(store.db.dialect==='postgres'?' FOR UPDATE':''),[key]);
    if(!row)throw conflict('No restored database fence exists');const record=decode(row.value);
    if(record.restoreId!==restoreId)throw conflict('This is not the current restore ID');
    if(record.release){if(record.release.bodyHash!==bodyHash)throw conflict('This restore already has a different release attestation');return {...record,duplicate:true};}
    const now=await store.coordinationNow(q);
    if(!Number.isSafeInteger(observedAt)||observedAt>now||now-observedAt>600000||observedAt<record.preparedAt)throw new Error('Reconciliation attestation must be fresh and follow restore preparation');
    await q("UPDATE sre_outbox SET status='discarded',error='Recovery-only notice was held and is not replayed after release' WHERE status='held_restore'");
    record.active=false;record.release={...attestation,bodyHash,releasedAt:now,authority:'local_operator_attestation',healthVerified:false};
    await save(q,key,record,now);await save(q,history(restoreId),record,now);return {...record,duplicate:false};
  });
}
