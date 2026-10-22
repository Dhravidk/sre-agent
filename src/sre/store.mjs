import {batchQuestions} from './question-batch.mjs';
import {requestSchedule,extendRequestFreshness,claimRequestFreshness,requeueStaleRequest,freshnessClaimSql} from './request-freshness.mjs';
import {queueModelMessages} from './model-notices.mjs';
import {investigatorLimit,investigatorSlots,investigatorLeaseName,lockInvestigationScheduler,configureInvestigationScheduler,assertInvestigationScheduler} from './investigation-scheduler.mjs';
import {ModelQuotaError,modelQuota,holdModelQuota,quotaBlocksClaim,resumeModelQuota} from './model-quota.mjs';
import {materialChangeObservations} from './change-observation-notices.mjs';
import { randomUUID } from 'node:crypto';
import { schema,StorageError } from './database.mjs';
import { assertText, hash, redact } from './security.mjs';
import { verifyRecovery } from './recovery.mjs';
import { verifyRollbackNoChange } from './rollback-result.mjs';
import { sourceStateKey, sourceState, staleSourceUpdate, restoreServiceNowStates,sameAlertObservation } from './source-state.mjs';
import { retryInvestigation } from './investigation-retry.mjs';
import { readRestoreFence } from './restore-recovery.mjs';
import { authorizedRoom,roomScope,reportedStates,collaborationSnapshot,validCoordinationItem,validConversationName,incidentConversationLimit } from './collaboration.mjs';
import {signalLimits,selectSignalEvidence,buildSignalDigest} from './signal-digest.mjs';
import {recordChangeEvent,linkedChangeIncidents} from './casework.mjs';
import {associationContext} from './change-associations.mjs';
import {bindAlertThread} from './alert-intake.mjs';
import {beginChangeRead,classifyChangeRead,finishChangeRead,bindChangeReadCI,changeReadReceipt} from './change-read.mjs';
import {ciReadState} from './ci-observations.mjs';
import {recordContactMessage} from './contact-messages.mjs';
import {handledDeliveryInspectionSql,projectDeliveryInspections,preparedDeliveryRecipient} from './delivery-inspections.mjs';
import {routeWaitReason,alertConversationId} from './teams-routing.mjs';
import {questionBatchLimits} from './question-batch-budget.mjs';

const json = (value) => JSON.stringify(value);
const parse = (value) => value ? JSON.parse(value) : null;
const requiredReplyKeys=payload=>[...new Set([payload.replyConversationKey,...(payload.replyConversationKeys||[])].filter(Boolean))];
const stableClaims=value=>Array.isArray(value)?[...new Set(value)].sort():value;
function prepareIngest(input){
  for(const key of ['id','source','serviceKey','kind'])assertText(input[key],'event.'+key,512);
  if(!['problem','deployment','log','ticket','change','question','responder_update','teams','verification','rollback_result'].includes(input.kind))throw Error('Invalid event kind');
  if(input.kind==='responder_update'&&!input.incidentId)throw Error('Responder updates require an explicit incident');
  if(['verification','rollback_result'].includes(input.kind)&&!input.incidentId)throw Error('Verification requires an explicit incident');
  if(!Number.isFinite(input.at))throw Error('Invalid event timestamp');
  const event=redact(input);return {event,id:hash([event.source,event.serviceKey,event.id]),bodyHash:hash(event)};
}
// Proposed next checks can answer a question without changing the incident's
// shared understanding. Real responder actions use the separate work ledger.
const notificationKey=a=>a?hash([a.summary,a.incidentStatus,stableClaims(a.hypotheses),a.changeAssessment,a.candidateSha,stableClaims(a.unknowns),a.rollback,a.trackedChanges,materialChangeObservations(a.observedChanges||[]),a.observedChangesLimited||false,a.contacts?.directoryId,a.contacts?.contacts.map(c=>[c.id,c.role]),a.risk?.likelihood,a.risk?.confidence,stableClaims(a.risk?.assumptions),stableClaims(a.risk?.alternatives),a.risk?.scope?.stage,a.risk?.scope?.headSha,a.risk?.scope?.mergedSha]):null;
export const conversationKey = (tenant, id) => hash([tenant, id]).slice(0, 32);

export class SreStore {
  constructor(db, { clock = Date.now, simulation = false, services = [], questionBatchLimit = 1, investigationConcurrency = 1, freshnessRetries = questionBatchLimit>1 } = {}) { this.db = db; this.clock = clock; this.simulation=simulation; this.services=services;if(!Number.isInteger(questionBatchLimit)||questionBatchLimit<1||questionBatchLimit>questionBatchLimits.requests)throw Error('Invalid question batch limit');if(typeof freshnessRetries!=='boolean')throw Error('Invalid request freshness policy');this.questionBatchLimit=questionBatchLimit;this.freshnessRetries=freshnessRetries&&questionBatchLimit>1;this.investigationConcurrency=investigatorLimit(investigationConcurrency); }
  async coordinationNow(query=this.db.query) {
    // PostgreSQL coordinates independent hosts. Its transaction-start timestamp
    // would remain stale across a lock wait, so read the live server clock.
    const now=this.db.dialect==='postgres'?Number((await query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now'))[0]?.now):this.clock();
    if(!Number.isSafeInteger(now)||now<0)throw new StorageError(new Error('Invalid coordination clock'));
    return now;
  }
  restoreFence(query=this.db.query,{lock=false}={}) {return readRestoreFence(query,lock&&this.db.dialect==='postgres');}
  async providerRetry(scopeHash,query=this.db.query) {
    if(typeof scopeHash!=='string'||!/^[a-f0-9]{64}$/.test(scopeHash))throw new Error('Invalid retry scope hash');
    const [row]=await query('SELECT retry_until,http_status FROM sre_provider_retries WHERE scope_hash=?',[scopeHash]);
    if(!row)return null;
    const until=Number(row.retry_until),status=Number(row.http_status);
    if(!Number.isSafeInteger(until)||until<0||!Number.isInteger(status)||status<100||status>599)throw new Error('Invalid stored provider retry deadline');
    const now=await this.coordinationNow(query);
    return until>now?{until,status,retryAfterMs:until-now}:null;
  }
  async deferProviderRetry(scopeHash,until,status,query) {
    if(typeof scopeHash!=='string'||!/^[a-f0-9]{64}$/.test(scopeHash)||!Number.isSafeInteger(until)||until<0||!Number.isInteger(status)||status<100||status>599)throw new Error('Invalid provider retry deadline');
    const save=async q=>{
      const now=await this.coordinationNow(q);
      // A delayed response from another process may only extend the hold.
      await q(`INSERT INTO sre_provider_retries(scope_hash,retry_until,http_status,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope_hash) DO UPDATE SET http_status=CASE WHEN excluded.retry_until>sre_provider_retries.retry_until THEN excluded.http_status ELSE sre_provider_retries.http_status END,retry_until=CASE WHEN excluded.retry_until>sre_provider_retries.retry_until THEN excluded.retry_until ELSE sre_provider_retries.retry_until END,updated_at=CASE WHEN excluded.updated_at>sre_provider_retries.updated_at THEN excluded.updated_at ELSE sre_provider_retries.updated_at END`,[scopeHash,until,status,now]);
    };
    if(query)await save(query);else await this.db.transaction(save);
  }
  async initialize() {
    if(this.db.dialect==='postgres')await this.db.transaction(async q=>{
      // Concurrent CREATE IF NOT EXISTS can still race in PostgreSQL's catalog.
      // Hold one database-local transaction lock for the complete schema batch.
      await q('SELECT pg_advisory_xact_lock(?::integer,?::integer)',[0x535245,1]);
      for(const sql of schema)await q(sql);
    });
    else for(const sql of schema)await this.db.query(sql);
    await configureInvestigationScheduler(this);
    await this.upgradeServiceNowStates();
    // Add a relational room projection for old report history without changing
    // its evidence IDs or rewriting the original messages.
    for(;;) {
      const rows=await this.db.query("SELECT e.* FROM sre_evidence e LEFT JOIN sre_responder_rooms r ON r.evidence_id=e.id LEFT JOIN sre_responder_people p ON p.evidence_id=e.id WHERE e.kind IN ('question','responder_update') AND (r.evidence_id IS NULL OR p.evidence_id IS NULL) ORDER BY e.id LIMIT 200");
      if(!rows.length)break;
      for(const row of rows)await this.projectResponder(row);
    }
    return this;
  }
  async projectResponder(row,query,key) {
    if(!['question','responder_update'].includes(row.kind))return;
    if(!query)return this.db.transaction(async q=>{if(this.db.dialect==='postgres')await q('SELECT id FROM sre_incidents WHERE id=? FOR UPDATE',[row.incident_id]);return this.projectResponder(row,q,key);});
    const q=query;
    const content=typeof row.content==='string'?parse(row.content):row.content;
    if(!key&&['teams-context','teams-question'].includes(row.source)&&content?.conversationId) {
      const [incident]=await q('SELECT service_key FROM sre_incidents WHERE id=?',[row.incident_id]);
      const service=this.services.find(service=>service.key===incident?.service_key);
      if(service)key=conversationKey(service.teams.tenantId,content.conversationId);
    }
    await q('INSERT INTO sre_responder_rooms(evidence_id,incident_id,conversation_key,kind,ordinal,reported_status) SELECT ?,?,?,?,COALESCE(MAX(ordinal),0)+1,? FROM sre_responder_rooms WHERE incident_id=? ON CONFLICT DO NOTHING',[row.id,row.incident_id,key||'',row.kind,reportedStates.includes(content?.reportedStatus)?content.reportedStatus:null,row.incident_id]);
    const [room]=await q('SELECT conversation_key FROM sre_responder_rooms WHERE evidence_id=?',[row.id]);
    await q('INSERT INTO sre_responder_people(evidence_id,incident_id,conversation_key,author_key) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',[row.id,row.incident_id,room.conversation_key,typeof content?.userId==='string'?content.userId:'unknown']);
    // Only explicit, addressed Teams commands can update the shared work ledger.
    // Ordinary chat is retained as quotation even when it resembles a command.
    const item=content?.coordinationItem;
    if(key&&row.source==='teams-context'&&row.kind==='responder_update'&&content.addressed===true&&validCoordinationItem(item))await q('INSERT INTO sre_coordination_items(evidence_id,incident_id,conversation_key,kind,item_key,item_state) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',[row.id,row.incident_id,key,item.kind,item.key,item.state]);
  }
  async upgradeServiceNowStates() {
    // Old versions kept only one state per provider. Reconstruct ticket identities
    // from the durable audit, including delayed events the aggregate once ignored.
    for(;;) {
      const batch=await this.db.query('SELECT id FROM sre_incidents WHERE source_states LIKE ? ORDER BY id LIMIT 100',['%"servicenow":%']);
      if(!batch.length)return;
      for(const item of batch)await this.db.transaction(async q=>{
        const [incident]=await q('SELECT * FROM sre_incidents WHERE id=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[item.id]);
        const states=parse(incident.source_states);
        if(!states.servicenow)return;
        const rows=await q("SELECT payload FROM sre_events WHERE source='servicenow' AND service_key=? AND kind='problem' AND (incident_id=? OR incident_id IS NULL) ORDER BY occurred_at,id LIMIT 10001",[incident.service_key,incident.id]);
        if(rows.length>10000)throw new Error('Legacy ServiceNow source audit exceeds the startup migration budget; use a reviewed offline migration');
        const events=rows.map(row=>parse(row.payload)).filter(event=>event.issueKey===incident.issue_key);
        const restored=restoreServiceNowStates(states.servicenow,events);
        delete states.servicenow;Object.assign(states,restored);
        const startedAt=Math.min(Number(incident.started_at),...events.map(event=>event.startedAt??event.at));
        const status=Object.values(states).some(state=>state.status==='OPEN')?'open':incident.status==='resolved'?'resolved':'verifying';
        const stateChanged=status!==incident.status||startedAt!==Number(incident.started_at);
        await q('UPDATE sre_incidents SET source_states=?,status=?,started_at=?,analysis=?,revision=revision+1 WHERE id=?',[json(states),status,startedAt,stateChanged?null:incident.analysis,incident.id]);
        // Identity-only changes also advance the incident revision. Review that
        // revision so ticket generation can become current again after startup.
        // Keep the audit and job atomic with the upgrade; no approval is replayed.
        const now=await this.coordinationNow(q);
        const id=hash(['source-identity-upgrade',incident.id,states]);
        const evidence={message:stateChanged?'ServiceNow ticket identities and original start restored from the durable event audit. The corrected incident state requires investigation.':'ServiceNow ticket identities restored from the durable event audit. Review the new revision before proposing a current fix ticket.',sourceStates:restored,startedAt};
        await q('INSERT INTO sre_evidence(id,incident_id,source,kind,observed_at,content) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',[id,incident.id,'system','source_identity_upgrade',now,json(evidence)]);
        await q("INSERT INTO sre_jobs(id,incident_id,payload,status,attempts,next_at,created_at) VALUES(?,?,?,'pending',0,?,?) ON CONFLICT DO NOTHING",[id,incident.id,json({eventId:id,question:null,conversationKey:null}),now,now]);
      });
    }
  }
  async ingest(input,{changeRead}={}) {
    const prepared=prepareIngest(input);
    if(changeRead?.ci?.state==='observed')throw Error('Observed CI requires atomic change-read ingestion with its matching event');
    return this.db.transaction(q=>this.#applyIngest(q,prepared,changeRead));
  }
  async ingestChangeRead(input,read,ciInput){
    const prepared=prepareIngest(input),ci=ciInput?prepareIngest(ciInput):null,bound=bindChangeReadCI(prepared.event,read,ci);
    return this.db.transaction(async q=>{
      const service=this.services.find(s=>s.key===prepared.event.serviceKey),provider=prepared.event.source,n=prepared.event.payload.number;
      // Lock before comparing visibility. Two readers reporting the same loss
      // must not each enqueue another reassessment of that transition.
      await this.restoreFence(q,{lock:true});
      if(this.db.dialect==='postgres')await q('SELECT id FROM sre_checkpoints WHERE id=? FOR UPDATE',['change-read:'+service.key+':'+provider+':'+n]);
      const before=await changeReadReceipt(q,service,provider,n,this.db.dialect);
      const result=await this.#applyIngest(q,prepared,bound);
      const accepted=!result.readError&&ci?await this.#applyIngest(q,ci):null;
      // Validate the stored reference before commit, while the sibling CI event
      // is visible in this transaction but still invisible to other readers.
      const after=await changeReadReceipt(q,service,provider,n,this.db.dialect);
      if(before&&!before.ci?.legacyUnverified&&after&&(result.duplicate||result.unchanged||result.stale)&&(!accepted||accepted.duplicate)&&hash(ciReadState(before))!==hash(ciReadState(after))){
        const incidents=await linkedChangeIncidents(q,prepared.event,this.db.dialect);
        for(const incident of incidents){
          const update=prepareIngest({id:'change-read-visibility:'+hash([after.scopeHash,after.number,after.readStartedAt,after.readCompletedAt,incident.id,ciReadState(before),ciReadState(after)]),source:'system',serviceKey:service.key,kind:'change',incidentId:incident.id,at:await this.coordinationNow(q),payload:{stage:'ci-visibility',provider,number:String(n),before:ciReadState(before),current:ciReadState(after),sourceRead:{snapshotEventId:after.snapshotEventId,readStartedAt:after.readStartedAt,readCompletedAt:after.readCompletedAt},message:'CI visibility changed during a provider read. This is a host observation, not a CI outcome, deployment or recovery proof.'}});
          await this.#applyIngest(q,update);
        }
      }
      return {...result,...(accepted?{ciEventId:accepted.eventId,ciDuplicate:accepted.duplicate===true}:{})};
    });
  }
  async #applyIngest(q,{event,id,bodyHash},changeRead){
      const receivedAt=await this.coordinationNow(q);
      if(event.at>receivedAt+300000)throw new Error('Invalid event timestamp');
      const readBoundary=await beginChangeRead(this,q,event,changeRead,receivedAt);
      // This insert is the idempotency boundary in both SQLite and Postgres.
      const inserted = await q(`INSERT INTO sre_events(id,source,service_key,external_id,kind,occurred_at,received_at,body_hash,payload) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id`, [id,event.source,event.serviceKey,event.id,event.kind,event.at,receivedAt,bodyHash,json(event)]);
      if (!inserted.length) {
        const [prior] = await q('SELECT body_hash,incident_id FROM sre_events WHERE id=?', [id]);
        if (prior?.body_hash !== bodyHash) throw new Error('Delivery ID was reused with different content');
        const state=readBoundary?await classifyChangeRead(q,event,this.db.dialect):null,readError=state&&state!=='unchanged'?state:null;
        await finishChangeRead(this,q,readBoundary,event,id,readError);
        return { duplicate: true, incidentId: prior.incident_id, eventId: id,...(readError?{readError}:{}) };
      }
      let incidents = [];const revised=new Set();
      if(event.kind==='teams') {
        await q(`INSERT INTO sre_commands(id,payload,status,created_at) VALUES(?,?,'pending',?) ON CONFLICT DO NOTHING`,[id,json(event.payload),receivedAt]);
      }
      if (event.kind === 'problem') {
        assertText(event.issueKey, 'issueKey', 512);
        if (!['OPEN', 'CLOSED'].includes(event.status)) throw new Error('Invalid problem status');
        const incidentId = 'inc_' + hash([event.serviceKey,event.issueKey]).slice(0,20);
        const startedAt = event.startedAt ?? event.at;
        if (!Number.isFinite(startedAt) || startedAt > event.at) throw new Error('Invalid incident start');
        await q(`INSERT INTO sre_incidents(id,service_key,issue_key,title,status,started_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,0) ON CONFLICT DO NOTHING`, [incidentId,event.serviceKey,event.issueKey,event.title || event.issueKey,event.status === 'CLOSED' ? 'verifying' : 'open',startedAt,event.at]);
        const [prior] = await q('SELECT * FROM sre_incidents WHERE id=?' + (this.db.dialect === 'postgres' ? ' FOR UPDATE' : ''), [incidentId]);
        const states=parse(prior.source_states)||{};
        const key=sourceStateKey(event),previous=states[key];
        await q('UPDATE sre_events SET incident_id=? WHERE id=?', [incidentId,id]);
        const readState=readBoundary?await classifyChangeRead(q,event,this.db.dialect):null;
        if(readState&&readState!=='unchanged'||readState==='unchanged'&&Number(prior.revision)>0){
          await recordChangeEvent(q,event,id,[incidentId],this.db.dialect,this.services.find(s=>s.key===event.serviceKey));const readError=readState==='unchanged'?null:readState;
          await finishChangeRead(this,q,readBoundary,event,id,readError);return {eventId:id,incidentId,unchanged:!readError,...(readError?{readError,stale:true}:{})};
        }
        const stale=staleSourceUpdate(previous,event),unchanged=sameAlertObservation(previous,event);
        if(stale||unchanged){
          await recordChangeEvent(q,event,id,[incidentId],this.db.dialect,this.services.find(s=>s.key===event.serviceKey));
          // Lifecycle age does not erase the signed workflow's addressed reply
          // destination. Bind it without admitting old metrics as current facts.
          const binding=event.alertThread?await bindAlertThread(this,q,event,id,incidentId,receivedAt):null;
          if(binding?.joined){
            await this.queueMessage(incidentId,(stale?'A delayed workflow alert was received; it does not reopen or replace the newer source state.':'This workflow observation was already recorded; another investigation was not created for its metrics.')+' This thread now follows '+incidentId+'. A reply using the current incident context is queued. Recovery still needs independent verification.',binding.conversationKey,'alert-thread:'+id,q);
            await q("INSERT INTO sre_jobs(id,incident_id,payload,status,attempts,next_at,created_at) VALUES(?,?,?,'pending',0,?,?) ON CONFLICT DO NOTHING",[hash(['investigate',id,incidentId]),incidentId,json({eventId:id,question:null,conversationKey:binding.conversationKey,replyConversationKey:binding.conversationKey}),receivedAt,receivedAt]);
          }
          const readError=readBoundary?'The provider read is older than the current review state':null;await finishChangeRead(this,q,readBoundary,event,id,readError);
          return {eventId:id,incidentId,...(stale?{stale:true}:{unchanged:true}),...(readError?{readError}:{})};
        }
        states[key]=sourceState(event);
        const status = Object.values(states).some(x=>x.status==='OPEN') ? 'open' : prior.status === 'resolved' ? 'resolved' : 'verifying';
        const start = prior.status === 'resolved' && status === 'open' ? startedAt : Math.min(Number(prior.started_at),startedAt);
        await q('UPDATE sre_incidents SET title=?,status=?,started_at=?,updated_at=?,source_states=?,revision=revision+1 WHERE id=?', [event.title || prior.title,status,start,Math.max(event.at,Number(prior.updated_at)),json(states),incidentId]);
        await q(`INSERT INTO sre_sessions(incident_id,agent_id,remote_state,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING`, [incidentId,'agent_' + randomUUID(),'{}',receivedAt]);
        incidents = [{ ...prior, id:incidentId, revision:Number(prior.revision)+1 }];
        revised.add(incidentId);
      } else if (event.kind === 'deployment') {
        await q(`INSERT INTO sre_deployments(id,service_key,occurred_at,payload) VALUES(?,?,?,?) ON CONFLICT DO NOTHING`, [id,event.serviceKey,event.at,json({ ...event.payload, at:event.at, source:event.source })]);
        incidents = await q("SELECT * FROM sre_incidents WHERE service_key=? AND status<>'resolved'", [event.serviceKey]);
      } else if (event.incidentId) {
        incidents = await q('SELECT * FROM sre_incidents WHERE id=? AND service_key=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''), [event.incidentId,event.serviceKey]);
        if (!incidents.length) throw new Error('Unknown incident in this service');
        await q('UPDATE sre_events SET incident_id=? WHERE id=?', [event.incidentId,id]);
        if(event.kind==='rollback_result') {
          if(event.source!=='verification'||event.at!==event.payload?.observedAt)throw new Error('Rollback reconciliation requires an independent, time-bound verification');
          const [rollback]=await q('SELECT * FROM sre_rollbacks WHERE id=? AND incident_id=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[event.payload.rollbackRequestId,event.incidentId]);
          const service=this.services.find(s=>s.key===event.serviceKey);if(!service)throw new Error('Rollback service is no longer configured');
          const rows=await q('SELECT payload FROM sre_deployments WHERE service_key=? ORDER BY occurred_at DESC LIMIT 200',[event.serviceKey]);
          const receipt=verifyRollbackNoChange({incident:incidents[0],deployments:rows.map(row=>parse(row.payload)),rollback},event.payload,service,await this.coordinationNow(q));
          await q("UPDATE sre_rollbacks SET status='not_executed',external_ref=?,error=?,lease_until=NULL WHERE id=?",[json(receipt),'Independently verified no deployment: '+event.payload.reason,rollback.id]);
          await this.queueMessage(event.incidentId,'Workflow request '+rollback.id+' was rejected before deployment: '+event.payload.reason+'. Independent no-change verification reconciled this request. The incident remains '+incidents[0].status+'. A new action requires a fresh eligible proposal and explicit operator approval.',null,'rollback:'+rollback.id+':not_executed',q);
        }
        if (event.kind === 'verification') {
          if((await this.restoreFence(q))?.active)throw new Error('Database restore reconciliation is still holding recovery verification');
          const incident = incidents[0];
          if(event.source!=='verification')throw new Error('Recovery requires an independent verification source');
          if(event.at!==event.payload?.observedAt)throw new Error('Verification time must match the proof observation');
          const rows=await q('SELECT payload FROM sre_deployments WHERE service_key=? ORDER BY occurred_at DESC LIMIT 200',[event.serviceKey]);
          const deployments=rows.map(row=>parse(row.payload));
          const service=this.services.find(s=>s.key===event.serviceKey)||{environment:deployments[0]?.environment};
          const current=verifyRecovery({incident,deployments},event.payload,service,await this.coordinationNow(q));
          if(event.payload.rollbackRequestId) {
            const [rollback]=await q('SELECT * FROM sre_rollbacks WHERE id=? AND incident_id=?',[event.payload.rollbackRequestId,incident.id]);
            const proposal=parse(rollback?.proposal);
            if(!rollback||!['dispatched','unknown'].includes(rollback.status)||current.rollbackRequestId!==rollback.id||proposal.target.sha!==current.sha||proposal.target.artifact!==current.artifact||current.at<Number(rollback.approved_at))throw new Error('Recovery proof does not match the dispatched rollback');
            await q("UPDATE sre_rollbacks SET status='verified',error=NULL WHERE id=?",[rollback.id]);
          }
          await q("UPDATE sre_incidents SET status='resolved',updated_at=?,revision=revision+1 WHERE id=?", [event.at,incident.id]);
        }
      } else if (['log','ticket','change'].includes(event.kind)) {
        incidents = event.kind==='change'&&event.payload?.stage==='ci-update'&&['github','gitlab'].includes(event.source)?await linkedChangeIncidents(q,event,this.db.dialect):await q("SELECT * FROM sre_incidents WHERE service_key=? AND status<>'resolved' AND started_at<=?", [event.serviceKey,event.at+900000]);
      }
      if(event.payload?.reviewOnly&&event.payload.number!==undefined){const known=new Set(incidents.map(i=>i.id));for(const related of await linkedChangeIncidents(q,event,this.db.dialect))if(!known.has(related.id))incidents.push(related);}
      await recordChangeEvent(q,event,id,event.payload?.reviewOnly?incidents.map(i=>i.id):event.incidentId?[event.incidentId]:[],this.db.dialect,this.services.find(s=>s.key===event.serviceKey));
      const alertBinding=event.alertThread&&incidents[0]?await bindAlertThread(this,q,event,id,incidents[0].id,receivedAt):null;
      for (const incident of incidents) {
        if(!revised.has(incident.id))await q('UPDATE sre_incidents SET revision=revision+1 WHERE id=?',[incident.id]);
        const linkedReview=event.kind==='problem'&&event.payload?.reviewOnly&&!revised.has(incident.id),kind=linkedReview?'change':event.kind,content=linkedReview?{...event.payload,reviewOnly:false,linkedReview:true}:event.payload||event;
        await q(`INSERT INTO sre_evidence(id,incident_id,source,kind,observed_at,content) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`, [hash([id,incident.id]),incident.id,event.source,kind,event.at,json(content)]);
        await this.projectResponder({id:hash([id,incident.id]),incident_id:incident.id,source:event.source,kind:event.kind,content:event.payload||event},q,event.conversationKey);
        await q(`INSERT INTO sre_jobs(id,incident_id,payload,status,attempts,next_at,created_at) VALUES(?,?,?,'pending',0,?,?) ON CONFLICT DO NOTHING`, [hash(['investigate',id,incident.id]),incident.id,json({ eventId:id, question:event.kind === 'question' ? event.payload?.text : null, conversationKey:event.conversationKey || null,...(alertBinding?.joined?{replyConversationKey:alertBinding.conversationKey}:{}) }),receivedAt,receivedAt]);
        if(this.freshnessRetries)await extendRequestFreshness(q,incident.id,receivedAt);
      }
      await finishChangeRead(this,q,readBoundary,event,id);
      return { eventId:id, incidentId:incidents[0]?.id || null, queued:incidents.length, duplicate:false };
  }
  async context(id) {
    const [incident] = await this.db.query('SELECT * FROM sre_incidents WHERE id=?', [id]);
    if (!incident) throw new Error('Incident not found');
    const [session] = await this.db.query('SELECT * FROM sre_sessions WHERE incident_id=?', [id]);
    // Reserve a separate window for people, even during a telemetry storm.
    const responderEvidence=await this.db.query("SELECT * FROM (SELECT people.*,ROW_NUMBER() OVER (PARTITION BY room_key ORDER BY author_rank,observed_at DESC,room_order DESC,id DESC) AS room_rank FROM (SELECT e.*,COALESCE(r.conversation_key,'') AS room_key,COALESCE(r.ordinal,0) AS room_order,COALESCE(p.author_key,'unknown') AS author_key,ROW_NUMBER() OVER (PARTITION BY COALESCE(r.conversation_key,''),COALESCE(p.author_key,'unknown') ORDER BY e.observed_at DESC,r.ordinal DESC,e.id DESC) AS author_rank FROM sre_evidence e LEFT JOIN sre_responder_rooms r ON r.evidence_id=e.id LEFT JOIN sre_responder_people p ON p.evidence_id=e.id WHERE e.incident_id=? AND e.kind IN ('responder_update','question')) people) ranked ORDER BY room_rank,author_rank,observed_at DESC,room_order DESC,id DESC LIMIT 40",[id]);
    responderEvidence.sort((a,b)=>Number(b.observed_at)-Number(a.observed_at)||Number(b.room_order)-Number(a.room_order)||b.id.localeCompare(a.id));
    const [responderCount]=await this.db.query("SELECT COUNT(*) AS count FROM sre_evidence WHERE incident_id=? AND kind IN ('responder_update','question')",[id]);
    const candidates=(await this.db.query("SELECT * FROM (SELECT e.*,ROW_NUMBER() OVER (PARTITION BY source,kind ORDER BY observed_at DESC,id DESC) AS source_rank FROM sre_evidence e WHERE incident_id=? AND kind NOT IN ('responder_update','question','log_page')) ranked ORDER BY source_rank,observed_at DESC,id DESC LIMIT ?",[id,signalLimits.candidates])).map(({source_rank,...row})=>({...row,observed_at:Number(row.observed_at),content:parse(row.content)}));
    const [telemetryCount]=await this.db.query("SELECT COUNT(*) AS count FROM sre_evidence WHERE incident_id=? AND kind NOT IN ('responder_update','question','log_page')",[id]);
    const [rawLogPages]=await this.db.query("SELECT COUNT(*) AS count FROM sre_evidence WHERE incident_id=? AND kind='log_page'",[id]);
    const selection=selectSignalEvidence(candidates),telemetry=selection.selected.map(row=>({...row,content:json(row.content)}));
    const evidenceWindow={totalAvailable:Number(telemetryCount.count)+Number(responderCount.count),rawLogPagesRetained:Number(rawLogPages.count),candidatesRead:candidates.length,candidatesLimited:Number(telemetryCount.count)>candidates.length,redundantSnapshots:selection.redundant,telemetrySelected:telemetry.length,problemSnapshotConflicts:selection.problemSnapshotConflicts};
    const evidence=[...responderEvidence,...telemetry];
    const deployments = await this.db.query('SELECT * FROM sre_deployments WHERE service_key=? ORDER BY occurred_at DESC LIMIT 200', [incident.service_key]);
    const run=this.simulation?evidence.map(x=>parse(x.content)?.simulationRunId).find(Boolean):null;
    const scopedDeployments=deployments.map(x=>({...parse(x.payload),recordId:x.id})).filter(x=>!run||x.simulationRunId===run).slice(0,50);
    const signalDigest=buildSignalDigest({evidence:candidates,deployments:scopedDeployments,incident,evidenceWindow});
    const history=await this.db.query('SELECT revision,evaluated_at,body FROM sre_assessments WHERE incident_id=? ORDER BY revision DESC,evaluated_at DESC,id DESC LIMIT 5',[id]);
    const [reviewed]=incident.analysis?await this.db.query('SELECT a.revision,a.evaluated_at,(SELECT MAX(revision) FROM sre_assessments WHERE incident_id=?) AS latest_revision FROM sre_assessments a WHERE a.incident_id=? AND a.body=? ORDER BY a.revision DESC,a.evaluated_at DESC,a.id DESC LIMIT 1',[id,id,incident.analysis]):[];
    const latestRevision=reviewed?Number(reviewed.latest_revision):history.length?Number(history[0].revision):null;
    // Bind freshness to the actual displayed body, not just a job's status.
    // A later review observed during this non-transactional read must not
    // certify the older incident snapshot as current. The matching audit can
    // be outside the console's bounded five-row history, including time ties.
    const assessmentStatus={state:!incident.analysis?'missing':!reviewed?'unverified':Number(reviewed.revision)===Number(incident.revision)&&latestRevision===Number(incident.revision)?'current':'outdated',revision:reviewed?Number(reviewed.revision):null,latestRevision,incidentRevision:Number(incident.revision),evaluatedAt:reviewed?Number(reviewed.evaluated_at):null};
    const jobs=await this.db.query("SELECT id,status,attempts,error,created_at FROM sre_jobs WHERE incident_id=? ORDER BY CASE WHEN status='dead' THEN 0 ELSE 1 END,created_at DESC,id LIMIT 40",[id]);
    const retries=await this.db.query('SELECT id,job_id,replacement_job_id,requested_by,reason,created_at FROM sre_job_retries WHERE incident_id=? ORDER BY created_at DESC,id LIMIT 40',[id]);
    const collaboration=await collaborationSnapshot(this,this.services.find(service=>service.key===incident.service_key),id);
    const [simulatedRollback]=this.simulation?await this.db.query("SELECT id FROM sre_rollbacks WHERE incident_id=? AND status='simulated' LIMIT 1",[id]):[];
    return { assessmentStatus,changeAssociations:await associationContext(this,id),signalDigest,evidenceWindow,simulatedRollback:simulatedRollback?.id||null,recoveryFence:await this.restoreFence(),incident:{...incident,started_at:Number(incident.started_at),updated_at:Number(incident.updated_at),analysis:parse(incident.analysis)}, session:{...session,remote_state:parse(session?.remote_state)}, evidence:evidence.map(x=>({...x,observed_at:Number(x.observed_at),content:parse(x.content)})), responderContext:{evidenceIds:responderEvidence.map(x=>x.id).reverse(),totalAvailable:Number(responderCount.count),note:'Chronological IDs with a fair window for each delivered conversation. Earlier Teams history, attachments, edits, and deletions are not synchronized. Reports are not verified recovery or authorization.'}, collaboration,jobs,retries:retries.map(row=>({...row,requested_by:parse(row.requested_by),created_at:Number(row.created_at)})),deployments:scopedDeployments,assessmentHistory:history.map(x=>({revision:x.revision,evaluatedAt:Number(x.evaluated_at),risk:parse(x.body).risk})) };
  }
  retryInvestigation(input) {return retryInvestigation(this,input);}
  modelQuota() {return modelQuota(this);}
  resumeModelQuota(input) {return resumeModelQuota(this,input);}
  async conversation(incidentId) {
    // UI history is separate from the model's bounded evidence snapshot.
    const questions=await this.db.query("SELECT e.id,e.observed_at,e.content,COALESCE(r.ordinal,0) AS receipt_order FROM sre_evidence e LEFT JOIN sre_responder_rooms r ON r.evidence_id=e.id WHERE e.incident_id=? AND e.kind='question' ORDER BY e.observed_at DESC,COALESCE(r.ordinal,0) DESC,e.id DESC LIMIT 40",[incidentId]);
    const replies=await this.db.query('SELECT a.id,a.revision,a.evaluated_at,a.body,j.payload AS job_payload,COUNT(*) OVER(PARTITION BY a.revision,a.evaluated_at) AS cohort_count,CASE WHEN a.revision=i.revision AND a.body=i.analysis AND NOT EXISTS(SELECT 1 FROM sre_assessments newer WHERE newer.incident_id=i.id AND newer.revision>i.revision) THEN 1 ELSE 0 END AS matches_current FROM sre_assessments a JOIN sre_incidents i ON i.id=a.incident_id LEFT JOIN sre_jobs j ON j.id=a.id AND j.incident_id=a.incident_id WHERE a.incident_id=? ORDER BY a.revision DESC,matches_current DESC,a.evaluated_at DESC,a.id DESC LIMIT 20',[incidentId]);
    const questionContent=new Map(questions.map(row=>[row.id,parse(row.content)]));
    const replyTo=row=>{try{const job=parse(row.job_payload);if(!/^[a-f0-9]{64}$/.test(job?.eventId||'')||typeof job.question!=='string')return null;const id=hash([job.eventId,incidentId]);return questionContent.get(id)?.text===job.question?id:null;}catch{return null;}};
    return [
      ...questions.map(row=>({id:row.id,role:'operator',at:Number(row.observed_at),receiptOrder:Number(row.receipt_order),name:parse(row.content).displayName||'Operator',text:parse(row.content).text})),
      ...replies.map(row=>{const body=parse(row.body);return {id:row.id,role:'assistant',at:Number(row.evaluated_at),revision:Number(row.revision),matchesCurrentAssessment:Number(row.matches_current)===1,orderingUncertain:Number(row.cohort_count)>1,inReplyTo:replyTo(row),mode:body.mode,summary:body.summary,text:body.text};}),
    // Equal-time questions use their retained receipt ordinal; assessments use
    // evidence revision, reserving the current snapshot within a tied group.
    // The role grouping is display order, not a question/answer causal link.
    ].sort((a,b)=>a.at-b.at||Number(a.role==='assistant')-Number(b.role==='assistant')||(a.role==='operator'?a.receiptOrder-b.receiptOrder:a.revision-b.revision||Number(a.matchesCurrentAssessment)-Number(b.matchesCurrentAssessment))||a.id.localeCompare(b.id));
  }
  async addEvidence(incidentId, source, kind, content, observedAt) {
    observedAt??=await this.coordinationNow();
    const clean = redact(content); const id = hash([incidentId,source,kind,clean]);
    await this.db.query(`INSERT INTO sre_evidence(id,incident_id,source,kind,observed_at,content) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`, [id,incidentId,source,kind,observedAt,json(clean)]);
    await this.projectResponder({id,incident_id:incidentId,source,kind,content:clean});
    return id;
  }
  async claim(owner, leaseMs = 60000) {
    if(!Number.isSafeInteger(leaseMs)||leaseMs<=0)throw new Error('Invalid investigation lease duration');
    return this.db.transaction(async (q) => {
      await lockInvestigationScheduler(this,q);
      await assertInvestigationScheduler(this,q);
      const now=await this.coordinationNow(q);
      if(await quotaBlocksClaim(this,q,now))return null;
      const [owned]=await q("SELECT id FROM sre_jobs WHERE status='running' AND lease_owner=? AND lease_until>? LIMIT 1",[owner,now]);
      if(owned)return null;
      let lease,leaseName;
      for(const name of investigatorSlots.slice(0,this.investigationConcurrency)){
        const rows=await q(`INSERT INTO sre_locks(name,owner,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE sre_locks.expires_at<=? OR sre_locks.owner=? RETURNING owner,expires_at`,[name,owner,now+leaseMs,now,owner]);
        if(rows.length){lease=rows;leaseName=name;break;}
      }
      if(!lease)return null;
      const readyAt=await this.coordinationNow(q);
      if(Number(lease[0].expires_at)<=readyAt)throw new Error('Agent lease expired while claiming work');
      // Requeued work joins at its new eligibility time. Keeping its original
      // age here would let one changing incident monopolize the sole worker.
      const questionField=this.db.dialect==='postgres'?"(j.payload::jsonb->>'question')":"json_extract(j.payload,'$.question')";
      // Preserve incident fairness before preferring an explicit request over
      // another update-only turn for that incident. The current evidence is
      // collected either way; eligible updates can share the question's turn.
      const eligible="((j.status='pending' AND j.next_at<=?) OR (j.status='running' AND j.lease_until<=?)) AND NOT EXISTS(SELECT 1 FROM sre_jobs active WHERE active.incident_id=j.incident_id AND active.status='running' AND active.lease_until>?)";
      const freshness=this.freshnessRetries?freshnessClaimSql(this.db.dialect):{join:'',eligible:'',parentOrder:''};
      const fairSql="SELECT j.*,f.updated_at AS last_scheduled_at FROM sre_jobs j LEFT JOIN sre_checkpoints f ON f.id='agent-scheduled:'||j.incident_id"+freshness.join+" WHERE "+eligible+freshness.eligible+" ORDER BY CASE WHEN j.status='running' THEN 0 ELSE 1 END,COALESCE(f.updated_at,0),"+freshness.parentOrder+"CASE WHEN COALESCE("+questionField+",'')<>'' THEN 0 ELSE 1 END,CASE WHEN j.status='running' THEN j.lease_until ELSE j.next_at END,j.created_at,j.id LIMIT 1"+(this.db.dialect==='postgres'?' FOR UPDATE OF j SKIP LOCKED':'');
      const [job] = await q(this.questionBatchLimit>1?fairSql:`SELECT j.* FROM sre_jobs j WHERE ${eligible} ORDER BY CASE WHEN j.status='running' THEN j.lease_until ELSE j.next_at END,j.created_at,j.id LIMIT 1` + (this.db.dialect === 'postgres' ? ' FOR UPDATE OF j SKIP LOCKED' : ''), [readyAt,readyAt,readyAt,...(this.freshnessRetries?[readyAt]:[])]);
      if (!job) {if(this.investigationConcurrency>1)await q('DELETE FROM sre_locks WHERE name=? AND owner=?',[leaseName,owner]);return null;}
      if(this.freshnessRetries&&!await claimRequestFreshness(q,job.incident_id,await this.coordinationNow(q),this.db.dialect)){
        if(this.investigationConcurrency>1)await q('DELETE FROM sre_locks WHERE name=? AND owner=?',[leaseName,owner]);return null;
      }
      if(this.questionBatchLimit>1)await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',['agent-scheduled:'+job.incident_id,json({jobId:job.id}),readyAt]);
      let payload=await batchQuestions(q,job,parse(job.payload),this.questionBatchLimit,{dialect:this.db.dialect,now:readyAt});
      if(!payload.question||this.questionBatchLimit>1) {
        const pending=await q("SELECT id,payload FROM sre_jobs WHERE incident_id=? AND status='pending' AND id<>? AND next_at<=?",[job.incident_id,job.id,readyAt]);
        const replies=new Set(requiredReplyKeys(payload));
        for(const older of pending){
          const other=parse(older.payload);if(other.question)continue;
          for(const key of requiredReplyKeys(other))replies.add(key);
          await q("UPDATE sre_jobs SET status='superseded' WHERE id=?",[older.id]);
        }
        if(replies.size){
          // Coalesce inference, retaining each newly joined thread's obligation
          // in the claimed job so a crash or retry cannot lose its destination.
          const targets=await this.messageTargets(job.incident_id,null,q);
          payload={...payload,replyConversationKeys:targets.filter(room=>room.incident_id===job.incident_id&&replies.has(room.id)).map(room=>room.id)};
          delete payload.replyConversationKey;
        }
      }
      const scheduling=this.freshnessRetries&&(payload.question||requiredReplyKeys(payload).length)?await requestSchedule(q,job,job.last_scheduled_at,readyAt):null;
      await q("UPDATE sre_jobs SET status='running',payload=?,attempts=attempts+1,lease_owner=?,lease_until=? WHERE id=?", [json(payload),owner,now+leaseMs,job.id]);
      if(Number(lease[0].expires_at)<=await this.coordinationNow(q))throw new Error('Agent lease expired before committing the claim');
      return {...job,attempts:Number(job.attempts)+1,payload,scheduling,lease_owner:owner,lease_until:now+leaseMs,lease_name:leaseName};
    });
  }
  async heartbeat(owner, jobId, leaseMs = 60000, leaseName = 'single-agent') {
    investigatorLeaseName({lease_name:leaseName});
    if(!Number.isSafeInteger(leaseMs)||leaseMs<=0)throw new Error('Invalid investigation lease duration');
    return this.db.transaction(async(q) => {
      const [lease]=await q('SELECT * FROM sre_locks WHERE name=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[leaseName]);
      const [job]=await q('SELECT status,lease_owner,lease_until FROM sre_jobs WHERE id=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[jobId]);
      const now=await this.coordinationNow(q);
      if(!lease||lease.owner!==owner||Number(lease.expires_at)<=now)throw new Error('Agent lease lost');
      if(!job||job.status!=='running'||job.lease_owner!==owner||Number(job.lease_until)<=now)throw new Error('Job lease lost');
      await q('UPDATE sre_locks SET expires_at=? WHERE name=? AND owner=?',[now+leaseMs,leaseName,owner]);
      await q("UPDATE sre_jobs SET lease_until=? WHERE id=? AND lease_owner=? AND status='running'",[now+leaseMs,jobId,owner]);
      if(now+leaseMs<=await this.coordinationNow(q))throw new Error('Agent lease expired during heartbeat');
    });
  }
  async setRemoteState(incidentId, remoteState, job) {
    // Direct store setup remains useful for imports/tests. An active investigator
    // must supply its job so a delayed model callback cannot overwrite a newer
    // owner's remote session after failover.
    if(!job)return this.db.query('UPDATE sre_sessions SET remote_state=? WHERE incident_id=?',[json(remoteState),incidentId]);
    if(job.incident_id!==incidentId)throw new Error('Investigation checkpoint is outside the job incident');
    return this.db.transaction(async q=>{
      const [lease]=await q('SELECT * FROM sre_locks WHERE name=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[investigatorLeaseName(job)]);
      if(!lease||lease.owner!==job.lease_owner||Number(lease.expires_at)<=await this.coordinationNow(q))throw new Error('Agent lease lost');
      const [current]=await q('SELECT status,lease_owner,lease_until FROM sre_jobs WHERE id=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[job.id]);
      if(!current||current.status!=='running'||current.lease_owner!==job.lease_owner||Number(current.lease_until)<=await this.coordinationNow(q))throw new Error('Job lease lost');
      await q('UPDATE sre_sessions SET remote_state=? WHERE incident_id=?',[json(remoteState),incidentId]);
      const now=await this.coordinationNow(q);
      if(Number(lease.expires_at)<=now||Number(current.lease_until)<=now)throw new Error('Agent lease expired during session checkpoint');
    });
  }
  async finish(job, analysis, remoteState, expectedRevision, notification={}) {
    return this.db.transaction(async(q) => {
      const [lease] = await q('SELECT * FROM sre_locks WHERE name=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''), [investigatorLeaseName(job)]);
      if (!lease || lease.owner !== job.lease_owner || Number(lease.expires_at) <= await this.coordinationNow(q)) throw new Error('Agent lease lost');
      const [current]=await q('SELECT lease_until FROM sre_jobs WHERE id=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[job.id]);
      const deadline=Math.min(Number(lease.expires_at),Number(current?.lease_until));
      const rows = await q("UPDATE sre_jobs SET status='done',lease_owner=NULL,lease_until=NULL,error=NULL WHERE id=? AND lease_owner=? AND status='running' AND lease_until>? RETURNING id", [job.id,job.lease_owner,await this.coordinationNow(q)]);
      if (!rows.length) throw new Error('Job lease lost');
      const [prior] = await q('SELECT analysis,revision FROM sre_incidents WHERE id=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''), [job.incident_id]);
      if(deadline<=await this.coordinationNow(q))throw new Error('Agent lease expired while waiting to publish');
      if(expectedRevision!==undefined && Number(prior.revision)!==expectedRevision) {
        await q("UPDATE sre_jobs SET status='superseded' WHERE id=?",[job.id]);
        // Questions and all coalesced reply destinations survive fresh telemetry.
        if(job.payload.question||requiredReplyKeys(job.payload).length){
          const now=await this.coordinationNow(q);
          if(this.freshnessRetries)await requeueStaleRequest(q,job,now);
          else await q("UPDATE sre_jobs SET status='pending',next_at=? WHERE id=?",[now,job.id]);
        }
        if(remoteState)await q('UPDATE sre_sessions SET remote_state=? WHERE incident_id=?',[json(remoteState),job.incident_id]);
        if(deadline<=await this.coordinationNow(q))throw new Error('Agent lease expired before committing the superseded result');
        if(this.investigationConcurrency>1){await q('DELETE FROM sre_locks WHERE name=? AND owner=?',[investigatorLeaseName(job),job.lease_owner]);if(deadline<=await this.coordinationNow(q))throw new Error('Agent lease expired before committing the superseded result');}
        return null;
      }
      const previous=parse(prior.analysis),changed = notificationKey(previous) !== notificationKey(analysis);
      await q('UPDATE sre_incidents SET analysis=? WHERE id=?', [json(analysis),job.incident_id]);
      await q('INSERT INTO sre_assessments(id,incident_id,revision,evaluated_at,body) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',[job.id,job.incident_id,Number(prior.revision),await this.coordinationNow(q),json(analysis)]);
      if (remoteState) await q('UPDATE sre_sessions SET remote_state=? WHERE incident_id=?', [json(remoteState),job.incident_id]);
      const id=hash(['analysis',job.id]);
      const origin=job.payload.question?job.payload.conversationKey:null,replies=new Set(requiredReplyKeys(job.payload)),notice=notification.text??analysis.text,contactFormat=notification.contactFormat??'full';
      if(['claude','codex'].includes(analysis.mode)&&analysis.teamsMessages!==undefined){
        await queueModelMessages(this,q,{job,analysis,previous,changed,id,replies,notice,contactFormat});
      }else if(changed&&!origin)await this.queueMessage(job.incident_id,notice,null,id,q,{broadcast:true,contacts:analysis.contacts,contactFormat});
      else {
        // Questions get a full answer only in their original conversation.
        // A changed judgment still informs peers. Coalesced alert replies are
        // independent obligations, including when the judgment is unchanged.
        const targets=await this.messageTargets(job.incident_id,null,q);
        for(const room of targets)if((changed||room.id===origin||replies.has(room.id))&&room.incident_id===job.incident_id){const full=room.id===origin;await this.queueMessage(job.incident_id,full?analysis.text:notice,room.id,targets.length===1?id:id+':'+room.id,q,{contacts:analysis.contacts,contactFormat:full?'full':contactFormat});}
      }
      if(deadline<=await this.coordinationNow(q))throw new Error('Agent lease expired before committing the investigation result');
      if(this.investigationConcurrency>1){await q('DELETE FROM sre_locks WHERE name=? AND owner=?',[investigatorLeaseName(job),job.lease_owner]);if(deadline<=await this.coordinationNow(q))throw new Error('Agent lease expired before committing the investigation result');}
      return analysis;
    });
  }
  async fail(job, error, maxAttempts = 3) {
    await this.db.transaction(async q=>{
      await lockInvestigationScheduler(this,q);
      const [lease]=await q('SELECT * FROM sre_locks WHERE name=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[investigatorLeaseName(job)]);
      const [current]=await q('SELECT status,lease_owner,lease_until FROM sre_jobs WHERE id=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[job.id]);
      const now=await this.coordinationNow(q);
      if(!lease||lease.owner!==job.lease_owner||Number(lease.expires_at)<=now||!current||current.status!=='running'||current.lease_owner!==job.lease_owner||Number(current.lease_until)<=now)return;
      if(error instanceof ModelQuotaError){
        await holdModelQuota(this,q,job,error,now);
        if(Math.min(Number(lease.expires_at),Number(current.lease_until))<=await this.coordinationNow(q))throw new Error('Job lease expired while recording model quota');
        if(this.investigationConcurrency>1){await q('DELETE FROM sre_locks WHERE name=? AND owner=?',[investigatorLeaseName(job),job.lease_owner]);if(Math.min(Number(lease.expires_at),Number(current.lease_until))<=await this.coordinationNow(q))throw new Error('Job lease expired while recording model quota');}
        return;
      }
      await q("UPDATE sre_jobs SET status=?,error=?,next_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND status='running'",[job.attempts>=maxAttempts?'dead':'pending',redact(String(error.message || error)),now+Math.min(60000,1000*2**job.attempts),job.id,job.lease_owner]);
      if(Math.min(Number(lease.expires_at),Number(current.lease_until))<=await this.coordinationNow(q))throw new Error('Job lease expired while recording failure');
      if(this.investigationConcurrency>1){await q('DELETE FROM sre_locks WHERE name=? AND owner=?',[investigatorLeaseName(job),job.lease_owner]);if(Math.min(Number(lease.expires_at),Number(current.lease_until))<=await this.coordinationNow(q))throw new Error('Job lease expired while recording failure');}
    });
  }
  async release(owner) { await this.db.query('DELETE FROM sre_locks WHERE owner=?', [owner]); }
  async checkpoint(id, value) {
    if (value === undefined) { const [row] = await this.db.query('SELECT value FROM sre_checkpoints WHERE id=?',[id]); return parse(row?.value); }
    await this.db.query(`INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, [id,json(value),await this.coordinationNow()]);
  }
  async recordPollResult(id,value) {
    if(!value||typeof value!=='object')throw new Error('Invalid scoped poll result');
    const failure=Object.hasOwn(value,'error'),stamp=failure?value.failedAt:value.successAt;
    if(typeof id!=='string'||!id||id.length>512||!/^[a-f0-9]{64}$/.test(value.scopeHash||'')||!Number.isSafeInteger(stamp)||stamp<0||(failure&&(typeof value.error!=='string'||!value.error||value.error.length>1000))||(!failure&&(value.complete!==true||!Number.isSafeInteger(value.until)||value.until<0)))throw new Error('Invalid scoped poll result');
    return this.db.transaction(async q=>{
      const now=await this.coordinationNow(q);
      if(stamp>now||(!failure&&value.until>now))throw new Error('Poll result time is in the future');
      await q("INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,'{}',?) ON CONFLICT DO NOTHING",[id,now]);
      const [row]=await q('SELECT value FROM sre_checkpoints WHERE id=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[id]);
      const saved=parse(row.value),prior=saved.scopeHash===value.scopeHash?saved:{};
      let next;
      if(Object.hasOwn(value,'error')) {
        // A failed reader cannot erase a successful peer's cursor or evidence.
        next=Number(prior.failedAt)>value.failedAt?prior:{...prior,scopeHash:value.scopeHash,error:value.error,failedAt:value.failedAt};
      } else {
        next=prior.complete===true&&Number(prior.until)>value.until?{...prior}:{...value};
        for(const field of ['activeReconciledAt','sampleAt'])if(Number.isFinite(prior[field])&&(!Number.isFinite(next[field])||prior[field]>next[field]))next[field]=prior[field];
      }
      await q('UPDATE sre_checkpoints SET value=?,updated_at=? WHERE id=?',[json(next),now,id]);return next;
    });
  }
  async rememberConversation({tenant,reference,serviceKey,incidentId=null},query=this.db.query) {
    const id = conversationKey(tenant,reference.conversation.id);
    const [room]=await query(`INSERT INTO sre_conversations(id,tenant_id,conversation_id,service_key,incident_id,reference,enabled,updated_at) VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET reference=excluded.reference,enabled=1,updated_at=excluded.updated_at RETURNING *`, [id,tenant,reference.conversation.id,serviceKey,incidentId,json(reference),await this.coordinationNow(query)]);
    const service=this.services.find(service=>service.key===serviceKey);
    if(service&&room?.incident_id===null&&authorizedRoom(service,room)&&room.conversation_id===alertConversationId(service.teams))await query("UPDATE sre_outbox SET next_at=?,error=NULL WHERE status='pending' AND conversation_key IS NULL AND error=? AND incident_id IN (SELECT id FROM sre_incidents WHERE service_key=?)",[await this.coordinationNow(query),routeWaitReason,serviceKey]);
    return id;
  }
  async setConversationName({id,tenant,serviceKey,name}) {
    if(!validConversationName(name))throw new Error('Use name <room name>: 1–80 characters without line breaks or control characters.');
    return this.db.transaction(async q=>{
      const [room]=await q('SELECT id FROM sre_conversations WHERE id=? AND tenant_id=? AND service_key=? AND enabled=1'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[id,tenant,serviceKey]);
      if(!room)throw new Error('This conversation cannot be named outside its authorized service and tenant.');
      await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',['teams-room-label:'+id,json({name}),await this.coordinationNow(q)]);
    });
  }
  async bindConversation(id, incidentId, query) {
    const bind=async q=>{
      const conversation=await this.authorizeIncidentConversation(id,incidentId,q);
      if(conversation.incident_id&&conversation.incident_id!==incidentId)throw new Error('Use a separate thread/chat for each incident');
      const [count]=await q('SELECT COUNT(*) AS count FROM sre_conversations WHERE incident_id=? AND enabled=1',[incidentId]);
      if(conversation.incident_id!==incidentId&&Number(count.count)>=incidentConversationLimit(this.services.find(s=>s.key===conversation.service_key)?.teams))throw new Error(incidentConversationLimit(this.services.find(s=>s.key===conversation.service_key)?.teams)===8?'Eight conversations already follow this incident. Use a shared incident thread to unify further teams.':'The configured incident conversation limit has been reached. Use a shared incident thread.');
      const bound=await q('UPDATE sre_conversations SET incident_id=? WHERE id=? AND (incident_id IS NULL OR incident_id=?) RETURNING id',[incidentId,id,incidentId]);
      if(!bound.length)throw new Error('Use a separate thread/chat for each incident');
      await q("UPDATE sre_outbox SET next_at=?,error=NULL WHERE incident_id=? AND conversation_key IS NULL AND status='pending' AND error=?",[await this.coordinationNow(q),incidentId,routeWaitReason]);
    };
    return query?bind(query):this.db.transaction(bind);
  }
  async authorizeIncidentConversation(id,incidentId,query) {
    if(!query)return this.db.transaction(q=>this.authorizeIncidentConversation(id,incidentId,q));
    const q=query;
    const [incident]=await q('SELECT * FROM sre_incidents WHERE id=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),[incidentId]);
    const [conversation]=await q('SELECT * FROM sre_conversations WHERE id=?',[id]);
    const service=this.services.find(service=>service.key===incident?.service_key);
    if(!incident||!conversation||conversation.service_key!==incident.service_key||!service||!authorizedRoom(service,conversation))throw new Error('Conversation cannot access this incident');
    const scope=roomScope(service,conversation.conversation_id);
    const [audience]=await q('SELECT * FROM sre_incident_audiences WHERE incident_id=?',[incidentId]);
    if(audience&&(audience.scope_key!==scope.key||audience.tenant_id!==service.teams.tenantId))throw new Error('This incident belongs to a different sharing group. Ask the incident lead to configure a common collaboration group before sharing its context.');
    if(!audience) {
      const prior=await q('SELECT * FROM sre_conversations WHERE incident_id=? AND enabled=1',[incidentId]);
      if(prior.some(room=>!authorizedRoom(service,room)||roomScope(service,room.conversation_id).key!==scope.key))throw new Error('Existing incident conversations have different sharing scopes. Unify their access configuration first.');
      await q('INSERT INTO sre_incident_audiences(incident_id,service_key,tenant_id,scope_key) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',[incidentId,service.key,service.teams.tenantId,scope.key]);
    }
    return conversation;
  }
  async unbindConversation(id,incidentId) {
    return this.db.transaction(async q=>{
      await this.authorizeIncidentConversation(id,incidentId,q);
      await q('UPDATE sre_conversations SET incident_id=NULL WHERE id=? AND incident_id=?',[id,incidentId]);
      await q("UPDATE sre_outbox SET status='discarded',error='Conversation stopped following this incident' WHERE conversation_key=? AND incident_id=? AND status='pending'",[id,incidentId]);
    });
  }
  async messageTargets(incidentId,origin,q=this.db.query) {
    const [incident]=await q('SELECT service_key FROM sre_incidents WHERE id=?',[incidentId]);
    const service=this.services.find(service=>service.key===incident?.service_key);if(!service)return [];
    const [audience]=await q('SELECT scope_key FROM sre_incident_audiences WHERE incident_id=?',[incidentId]);
    const rooms=await q('SELECT * FROM sre_conversations WHERE service_key=? AND enabled=1 ORDER BY id',[service.key]);
    const valid=rooms.filter(room=>authorizedRoom(service,room)&&(!audience||roomScope(service,room.conversation_id).key===audience.scope_key));
    const [source]=origin?valid.filter(room=>room.id===origin):[];
    if(origin&&!source)throw new Error('The originating conversation is no longer authorized for this incident');
    let targets=valid.filter(room=>room.incident_id===incidentId&&(!source||roomScope(service,room.conversation_id).key===roomScope(service,source.conversation_id).key));
    if(!audience&&new Set(targets.map(room=>roomScope(service,room.conversation_id).key)).size>1)return [];
    if(!targets.length&&!origin) {
      const fallback=alertConversationId(service.teams);
      targets=valid.filter(room=>!room.incident_id&&room.conversation_id===fallback);
    }
    return targets;
  }
  async queueMessage(incidentId, text, conversation = null, key = randomUUID(), query,{broadcast=false,contacts,contactFormat='full'}={}) {
    if(!query)return this.db.transaction(q=>this.queueMessage(incidentId,text,conversation,key,q,{broadcast,contacts,contactFormat}));
    const now=await this.coordinationNow(query);
    // Hold the fence row until insertion commits. Release must see and discard
    // every held notice, including one still being published by a reader.
    const status=(await this.restoreFence(query,{lock:true}))?.active?'held_restore':'pending';
    const targets=incidentId&&(!conversation||broadcast)?await this.messageTargets(incidentId,conversation,query):[];
    if(targets.length) {
      for(const target of targets){const id=targets.length===1?key:key+':'+target.id;await query(`INSERT INTO sre_outbox(id,incident_id,conversation_key,text,status,attempts,next_at,created_at) VALUES(?,?,?,?,?,0,?,?) ON CONFLICT DO NOTHING`,[id,incidentId,target.incident_id?target.id:null,text,status,now,now]);if(contacts)await recordContactMessage(query,id,incidentId,text,contacts,now,contactFormat);}
    } else if(!(broadcast&&conversation)){await query(`INSERT INTO sre_outbox(id,incident_id,conversation_key,text,status,attempts,next_at,created_at) VALUES(?,?,?,?,?,0,?,?) ON CONFLICT DO NOTHING`, [key,incidentId,conversation,text,status,now,now]);if(contacts)await recordContactMessage(query,key,incidentId,text,contacts,now,contactFormat);}
  }
  async snapshot() {
    const restoreId=(await this.restoreFence())?.restoreId??null;
    const [incidents,jobs,outbox,rollbacks,sessions,counts,attentionOutbox] = await Promise.all([
      this.db.query('SELECT * FROM sre_incidents ORDER BY updated_at DESC LIMIT 100'),
      this.db.query('SELECT id,incident_id,status,attempts,error FROM sre_jobs ORDER BY created_at DESC LIMIT 100'),
      this.db.query('SELECT * FROM sre_outbox ORDER BY created_at DESC LIMIT 100'),
      this.db.query('SELECT id,incident_id,proposal,status,approved_by,external_ref,error,expires_at FROM sre_rollbacks ORDER BY created_at DESC LIMIT 50'),
      this.db.query('SELECT incident_id,agent_id FROM sre_sessions'),
      this.db.query('SELECT source,COUNT(*) AS count FROM sre_events GROUP BY source'),
      this.db.query("SELECT o.* FROM sre_outbox o WHERE o.status IN ('unknown','failed') AND NOT "+handledDeliveryInspectionSql('o')+' ORDER BY o.created_at DESC,o.id DESC LIMIT 12',[restoreId]),
    ]);
    const deliveryRows=[...new Map([...outbox,...attentionOutbox].map(row=>[row.id,row])).values()];
    const contactDeliveries=deliveryRows.length?await this.db.query('SELECT id,value FROM sre_checkpoints WHERE id IN ('+deliveryRows.map(()=>'?').join(',')+')',deliveryRows.map(row=>'contact-delivery:'+row.id+':'+row.attempts)):[];
    for(const delivery of contactDeliveries){
      try{const record=JSON.parse(delivery.value),row=deliveryRows.find(row=>row.id===record.outboxId);if(!row||record.version!==1||record.incidentId!==row.incident_id||record.attempt!==Number(row.attempts)||record.originalHash!==hash(row.text)||typeof record.renderedText!=='string'||record.renderedHash!==hash(record.renderedText)||!Number.isSafeInteger(record.checkedAt))throw Error();row.contactDelivery={checkedAt:record.checkedAt,contactVersion:record.contactVersion,attempt:record.attempt,renderedText:record.renderedText};}
      catch{throw new StorageError(Error('Invalid contact-delivery audit'));}
    }
    const deliveryKinds=['prepared','outcome','late'],deliveryIds=deliveryRows.flatMap(row=>deliveryKinds.map(kind=>'teams-delivery:'+kind+':'+row.id+':'+row.attempts));
    const deliveryRecords=deliveryIds.length?await this.db.query('SELECT id,value FROM sre_checkpoints WHERE id IN ('+deliveryIds.map(()=>'?').join(',')+')',deliveryIds):[];
    for(const saved of deliveryRecords){
      try{
        const record=JSON.parse(saved.value),row=deliveryRows.find(row=>row.id===record.outboxId),kind=deliveryKinds.find(kind=>saved.id==='teams-delivery:'+kind+':'+record.outboxId+':'+record.attempt);
        if(!row||!kind||record.version!==1||record.incidentId!==row.incident_id||record.attempt!==Number(row.attempts)||record.originalHash!==hash(row.text))throw Error();
        row.deliveryAttempt||={attempt:record.attempt};
        if(kind==='prepared'){if(typeof record.text!=='string'||record.textHash!==hash(record.text)||!Number.isSafeInteger(record.preparedAt))throw Error();const key=preparedDeliveryRecipient(row,record);Object.assign(row.deliveryAttempt,{preparedAt:record.preparedAt,timeoutMs:record.timeoutMs,text:record.text,...(key?{conversationKey:key}:{})});}
        else{if(!Number.isSafeInteger(record.observedAt)||!['receipt','error'].includes(record.kind))throw Error();row.deliveryAttempt[kind]={kind:record.kind,observedAt:record.observedAt,remoteId:record.remoteId,httpStatus:record.httpStatus,...(record.status?{status:record.status}:{})};}
      }catch{throw new StorageError(Error('Invalid Teams delivery audit'));}
    }
    await projectDeliveryInspections(this,deliveryRows,deliveryRecords,restoreId);
    const enriched=new Map(deliveryRows.map(row=>[row.id,row]));
    return {incidents:incidents.map(x=>({...x,analysis:parse(x.analysis)})),jobs,outbox:outbox.map(row=>enriched.get(row.id)),attentionOutbox:attentionOutbox.map(row=>enriched.get(row.id)),rollbacks:rollbacks.map(x=>({...x,proposal:parse(x.proposal)})),sessions,counts,workerConcurrency:this.investigationConcurrency,modelQuota:await this.modelQuota(),deliveryInspectionVersion:1};
  }
}
