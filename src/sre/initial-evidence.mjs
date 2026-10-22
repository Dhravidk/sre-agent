import {investigatorLeaseName} from './investigation-scheduler.mjs';
import {hash,redact,assertText} from './security.mjs';
import {StorageError} from './database.mjs';
import {logBatchArtifacts} from './log-triage.mjs';

const epoch=fence=>({restoreId:fence?.restoreId||null,active:fence?.active===true});
const startKey=id=>'initial-read-start:'+id,endKey=id=>'initial-read-end:'+id;
const kinds={github:['deployments','code_review','release_diff','linked_changes'],gitlab:['deployments','code_review','release_diff','linked_changes','source_locations'],dynatrace:['logs','problem_details'],servicenow:['incident_details','incident_context'],jira:['ticket'],system:['context_limit']};
export async function lockServiceObservations(store,q,serviceKey){
 // SQLite already serializes transaction writers. Native PostgreSQL readers
 // and inbox writers share this transaction-only service admission lock so a
 // batch cannot invert the incident locks held by an independent poll/alert.
 if(store.db.dialect==='postgres'){const key=hash(['sre-service-observations-v1',serviceKey]);await q('SELECT pg_advisory_xact_lock(?::integer,?::integer)',[Number.parseInt(key.slice(0,8),16)|0,Number.parseInt(key.slice(8,16),16)|0]);}
}
export class InitialEvidenceFenceError extends Error {
 constructor(message){super(message);this.name='InitialEvidenceFenceError';this.code='SRE_INITIAL_EVIDENCE_FENCE';}
}
const fence=message=>new InitialEvidenceFenceError(message);
const sign=body=>({...body,checksum:hash(body)});
const matchingArtifact=(saved,artifact,content)=>{try{return saved?.source===artifact.source&&saved?.kind===artifact.kind&&hash(JSON.parse(saved.content))===hash(content);}catch{return false;}};
function decode(row){
 try{if(typeof row.value!=='string'||Buffer.byteLength(row.value,'utf8')>12000)throw Error();const value=JSON.parse(row.value),{checksum,...body}=value;if(value.version!==1||checksum!==hash(body))throw Error();return value;}catch{throw new StorageError(Error('Invalid initial evidence read receipt'));}
}

export async function initialEvidenceOwner(store,q,job,serviceKey,{allowHeldReads=false,restore,signal,lockService=false}={}){
 signal?.throwIfAborted();
 if(!job||typeof job.id!=='string'||typeof job.incident_id!=='string'||typeof job.lease_owner!=='string'||!Number.isSafeInteger(job.attempts)||job.attempts<1)throw Error('Initial evidence requires its claimed job attempt');
 const lock=store.db.dialect==='postgres'?' FOR UPDATE':'';
 // Match the existing investigator's lease/job order before touching shared
 // controls. An expired worker must not hold the restore row while waiting
 // for the replacement investigator to finish under its claimed slot lease.
 const [lease]=await q('SELECT * FROM sre_locks WHERE name=?'+lock,[investigatorLeaseName(job)]),[current]=await q('SELECT incident_id,status,attempts,lease_owner,lease_until FROM sre_jobs WHERE id=?'+lock,[job.id]);
 const now=await store.coordinationNow(q);
 if(!lease||lease.owner!==job.lease_owner||Number(lease.expires_at)<=now||!current||current.incident_id!==job.incident_id||current.status!=='running'||Number(current.attempts)!==job.attempts||current.lease_owner!==job.lease_owner||Number(current.lease_until)<=now)throw fence('Initial evidence job lease or attempt was lost');
 // Relationship/reconciliation paths lock this control before an incident.
 const restoreState=epoch(await store.restoreFence(q,{lock:store.db.dialect==='postgres'}));
 if(lockService&&store.db.dialect==='postgres'){
  const [scope]=await q('SELECT service_key FROM sre_incidents WHERE id=?',[job.incident_id]);if(scope?.service_key!==serviceKey)throw fence('Initial evidence incident scope changed');
  // Deployment facts can update several cases. Match inbox row order before
  // locking the job's own case, which need not be first in that service.
  await q('SELECT id FROM sre_incidents WHERE service_key=? ORDER BY id FOR UPDATE',[serviceKey]);
 }
 const [incident]=await q('SELECT id,service_key,revision FROM sre_incidents WHERE id=?'+lock,[job.incident_id]);
 if(!incident||incident.service_key!==serviceKey)throw fence('Initial evidence incident scope changed');
 if(!Number.isSafeInteger(Number(incident.revision))||Number(incident.revision)<0)throw new StorageError(Error('Invalid initial evidence incident revision'));
 if(restoreState.active&&!allowHeldReads)throw fence('Initial evidence reads are held during restore reconciliation');
 if(restore&&JSON.stringify(restoreState)!==JSON.stringify(restore))throw fence('Initial evidence restore epoch changed during the read');
 const checkedAt=await store.coordinationNow(q);
 signal?.throwIfAborted();
 if(Math.min(Number(lease.expires_at),Number(current.lease_until))<=checkedAt)throw fence('Initial evidence lease expired while checking ownership');
 return{revision:Number(incident.revision),at:checkedAt,restore:restoreState};
}

export function beginInitialEvidence(store,job,serviceKey,{source,kind,index,allowHeldReads=false,signal}){
 assertText(serviceKey,'initial evidence service',512);
 if(!kinds[source]?.includes(kind)||!Number.isSafeInteger(index)||index<1)throw Error('Invalid initial evidence read selector');
 return store.db.transaction(async q=>{
  const owned=await initialEvidenceOwner(store,q,job,serviceKey,{allowHeldReads,signal}),id=hash([job.id,job.attempts,index]);
  const [saved]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[startKey(id)]);
  if(saved){const prior=decode(saved);if(prior.id!==id||prior.jobId!==job.id||prior.attempt!==job.attempts||prior.incidentId!==job.incident_id||prior.serviceKey!==serviceKey||prior.source!==source||prior.kind!==kind||prior.index!==index||prior.allowHeldReads!==allowHeldReads||!Number.isSafeInteger(prior.startedAt)||prior.startedAt<0||!Number.isSafeInteger(prior.startedRevision)||prior.startedRevision<0||JSON.stringify(prior.restore)!==JSON.stringify(owned.restore))throw new StorageError(Error('Initial evidence read index was reused with different scope'));await initialEvidenceOwner(store,q,job,serviceKey,{allowHeldReads,restore:owned.restore,signal});return prior;}
  const record=sign({version:1,id,jobId:job.id,attempt:job.attempts,incidentId:job.incident_id,serviceKey,source,kind,index,allowHeldReads,startedAt:owned.at,startedRevision:owned.revision,restore:owned.restore});
  await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?)',[startKey(id),JSON.stringify(record),owned.at]);
  await initialEvidenceOwner(store,q,job,serviceKey,{allowHeldReads,restore:owned.restore,signal});return record;
 });
}

export function completeInitialEvidence(store,job,start,artifact,{afterSave,signal}={}){
 if(!start||start.jobId!==job.id||start.attempt!==job.attempts||start.incidentId!==job.incident_id||artifact.source!==start.source||![start.kind,'connector_error'].includes(artifact.kind)||artifact.content===undefined)throw Error('Initial evidence result differs from its read scope');
 const ownership={allowHeldReads:start.allowHeldReads,restore:start.restore,signal,lockService:artifact.kind==='deployments'&&['github','gitlab'].includes(artifact.source)};
 return store.db.transaction(async q=>{
  await lockServiceObservations(store,q,start.serviceKey);
  const opened=await initialEvidenceOwner(store,q,job,start.serviceKey,ownership);if(opened.revision<start.startedRevision)throw fence('Initial evidence incident revision moved backwards');
  const [row]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[startKey(start.id)]);if(!row||JSON.stringify(decode(row))!==JSON.stringify(start))throw new StorageError(Error('Initial evidence start receipt is missing or inconsistent'));
  const batch=artifact.source==='dynatrace'&&artifact.kind==='logs'?logBatchArtifacts(job.incident_id,artifact.content):null;
  const retainedContent=batch?batch.content:artifact.content,content=redact(retainedContent),evidenceId=hash([job.incident_id,artifact.source,artifact.kind,content]),[prior]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[endKey(start.id)]);
  if(prior){const result=decode(prior);if(result.readId!==start.id||result.jobId!==job.id||result.attempt!==job.attempts||result.incidentId!==job.incident_id||result.serviceKey!==start.serviceKey||result.startedRevision!==start.startedRevision||result.evidenceId!==evidenceId||result.source!==artifact.source||result.kind!==artifact.kind||result.phase!==(artifact.kind==='connector_error'?'unavailable':'collected')||!Number.isSafeInteger(result.completedAt)||result.completedAt<0||!Number.isSafeInteger(result.acceptedRevision)||result.acceptedRevision<start.startedRevision||JSON.stringify(result.restore)!==JSON.stringify(start.restore))throw new StorageError(Error('Initial evidence completion was reused with different content'));const [saved]=await q('SELECT source,kind,content FROM sre_evidence WHERE id=? AND incident_id=?',[evidenceId,job.incident_id]);if(!matchingArtifact(saved,artifact,content))throw new StorageError(Error('Initial evidence completion has no matching retained artifact'));await initialEvidenceOwner(store,q,job,start.serviceKey,ownership);return result;}
  const at=await store.coordinationNow(q);
  for(const page of batch?.pages||[])await store.addEvidence(job.incident_id,'dynatrace','log_page',page,at,q);
  await store.addEvidence(job.incident_id,artifact.source,artifact.kind,retainedContent,at,q);
  const [saved]=await q('SELECT source,kind,content FROM sre_evidence WHERE id=? AND incident_id=?',[evidenceId,job.incident_id]);if(!matchingArtifact(saved,artifact,content))throw new StorageError(Error('Initial evidence identity conflicts with retained content'));
  if(afterSave)await afterSave(q,evidenceId);
  const owned=await initialEvidenceOwner(store,q,job,start.serviceKey,ownership);
  if(owned.revision<start.startedRevision)throw fence('Initial evidence incident revision moved backwards');
  const result=sign({version:1,readId:start.id,jobId:job.id,attempt:job.attempts,incidentId:job.incident_id,serviceKey:start.serviceKey,source:artifact.source,kind:artifact.kind,evidenceId,phase:artifact.kind==='connector_error'?'unavailable':'collected',startedRevision:start.startedRevision,acceptedRevision:owned.revision,completedAt:owned.at,restore:start.restore});
  await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?)',[endKey(start.id),JSON.stringify(result),owned.at]);
  await initialEvidenceOwner(store,q,job,start.serviceKey,ownership);return result;
 });
}
