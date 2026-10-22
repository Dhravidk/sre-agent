import {QaExecution} from './qa-execution.mjs';
import {assessmentHash,planAssessmentCurrent} from './qa-assessment.mjs';
import {sourceInventoryText} from './source-inventory.mjs';
import {discoveryProject} from './source-discovery-config.mjs';
import {discoverySummaryText} from './source-discovery.mjs';
import {handoffText} from './work-handoffs.mjs';
import {randomBytes} from 'node:crypto';
import {hash,assertText,redact,equalSecret} from './security.mjs';
import {StorageError} from './database.mjs';
import {trackAssociation,withdrawAssociation,automaticAssociationAllowed,associationContext} from './change-associations.mjs';
import {ciObservationOrigin,ciConsistencyText} from './ci-observations.mjs';
import {changeTimelineLimits,projectChangeTimeline,changeTimelineText,parseChangeTimelineFact} from './change-timeline.mjs';
import {reserveCiHistory} from './ci-history-window.mjs';
import {contactsText,contactMessageText,contactWindowText,contactNoticeVersion,boundTeamsText,readContactMessage} from './contact-messages.mjs';
import {qaApprovalCommand,assertQaCommandClaim,qaApprovalReceipt,recordQaApprovalReceipt,deliveredQaProposal} from './qa-approval.mjs';
import {planCollaborationSnapshot,planCollaborationMarkdown} from './plan-collaboration.mjs';
import {readQaHistory,readQaRequest} from './qa-history.mjs';
import {unverifiedLogFields} from './log-field-consistency.mjs';
import {validateSourceFindings,sourceFindingInput} from './source-references.mjs';
import {boundedContext} from './model-context.mjs';
import {sourceScopeForService,sourcePath} from './source-evidence.mjs';
import {readSourceIdentityHistory} from './source-identity-history.mjs';
import {evidenceReadText} from './evidence-request.mjs';
import {evidenceReadHistoryWarning} from './evidence-read-history.mjs';
export {contactsText} from './contact-messages.mjs';

const sha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const epoch=value=>Number.isSafeInteger(value)&&value>=0;
const lock=store=>store.db.dialect==='postgres'?' FOR UPDATE':'';
const parse=row=>row?{...row,payload:JSON.parse(row.payload)}:null;
const md=value=>String(redact(String(value??''))).replace(/[\r\n]+/g,' ').replace(/[\\`*_{}\[\]<>|#]/g,'\\$&');
const contactFacts=view=>({directoryId:view?.directoryId??null,contacts:(view?.contacts||[]).map(contact=>Object.fromEntries(['id','name','team','role','contact','paths','projects','startsAt','endsAt','reason','directoryId','source','observedAt','expiresAt'].filter(key=>contact[key]!==undefined).map(key=>[key,['paths','projects'].includes(key)?[...contact[key]].sort():contact[key]]))).sort((a,b)=>a.id.localeCompare(b.id)),unknowns:[...(view?.unknowns||[])].sort()});
const contactView=view=>({...view,version:hash([contactFacts(view),view.state,view.observedAt,view.expiresAt,view.validFrom,view.validUntil,view.conflictingDirectoryIds])});
const contactsCurrent=(saved,current)=>saved?saved.version?saved.version===current.version:hash(contactFacts(saved))===hash(contactFacts(current)):null;
async function directoryContext(incident,q){
 const [review]=incident.analysis?await q('SELECT id FROM sre_assessments WHERE incident_id=? AND revision=? AND body=? LIMIT 1',[incident.id,Number(incident.revision),incident.analysis]):[];
 return {incident:{...incident,analysis:incident.analysis?JSON.parse(incident.analysis):null},assessmentStatus:{state:review?'current':incident.analysis?'outdated':'missing'}};
}
const supportedFixes={WINNING_BID_REGRESSED:['checkVersion',true],BID_ACCEPTED_AFTER_CLOSE:['enforceCloseTime',true],CREDIT_TIMEOUT:['creditTimeoutMs',50],CATALOG_LATENCY:['catalogDelayMs',0]};
export {supportedFixes};
export function ticketIndexText(index){
 if(!index.total)return 'No saved fix tickets for '+index.incidentId+'. Use plan after a current assessment is available.';
 return ['Saved fix tickets · '+index.incidentId+' · showing '+index.plans.length+' of '+index.total+'.',...(index.held?['Database restore reconciliation is active; retained tickets are historical.']:[]),...index.plans.map(plan=>'- ticket '+plan.id+' · revision '+plan.revision+' · '+(plan.current?'evidence matches the current audited revision':'historical snapshot; evidence or its review has changed')+(plan.qaAmbiguous?'\n  Multiple QA requests share the latest record time; inspect the console before further work. '+plan.qaCount+' request(s) retained.':plan.qa?'\n  Latest local QA '+plan.qa.status+' · '+plan.qa.id+(plan.qa.commit?' · commit '+plan.qa.commit:'')+' · '+plan.qaCount+' request(s) retained.'+(plan.qa.status==='unknown'?' Inspect the interrupted run before another request.':''): '\n  No local QA request is recorded for this ticket.')),'Use ticket <plan-id> to read its saved Markdown; the console retains the full history. Recheck contacts and the exact source before further work. A listing grants no action approval; local QA does not establish deployment or recovery.'].join('\n');
}

// Append provider observations rather than overwriting a moving MR head. The
// event inbox and this projection commit together on both database adapters.
export async function recordChangeEvent(q,event,id,incidentIds,dialect,service) {
  if(!['github','gitlab'].includes(event.source)||!sha(event.payload?.sha))return;
  const p=event.payload,number=p.number===undefined?null:String(p.number);
  if(number!==null&&!/^[1-9]\d*$/.test(number))throw Error('Invalid change number');
  const origin=ciObservationOrigin(event,id,service),projection=origin?{...p,observationOrigin:origin}:p;
  await q('INSERT INTO sre_change_events(id,service_key,provider,change_number,head_sha,stage,observed_at,payload) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',[id,event.serviceKey,event.source,number,p.sha,p.stage||event.kind,event.at,JSON.stringify(projection)]);
  if(number)for(const incidentId of [...new Set(incidentIds)].sort()){
    const [incident]=await q('SELECT id,issue_key FROM sre_incidents WHERE id=?'+(dialect==='postgres'?' FOR UPDATE':''),[incidentId]);
    if(incident&&await automaticAssociationAllowed(q,incident,event.source,number))await q('INSERT INTO sre_incident_change_links(incident_id,provider,change_number,linked_at,evidence_id) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',[incidentId,event.source,number,event.at,id]);
  }
}

// A review is its own investigation. Only an explicit, evidence-backed change
// link lets its later observations refresh another incident. CI for an
// unrelated commit is retained in the change ledger without waking every case.
export async function linkedChangeIncidents(q,event,dialect) {
  if(!['github','gitlab'].includes(event.source)||!sha(event.payload?.sha))return [];
  const p=event.payload,parameters=[event.serviceKey,event.source];
  let predicate;
  if(p.number!==undefined){predicate='l.change_number=?';parameters.push(String(p.number));}
  else if(p.stage==='ci-update'){
    const merged=dialect==='postgres'?"c.payload::jsonb->>'mergedSha'":"json_extract(c.payload,'$.mergedSha')";
    const readHead=dialect==='postgres'?"COALESCE(e.content::jsonb->>'headSha',e.content::jsonb->>'sha')":"COALESCE(json_extract(e.content,'$.headSha'),json_extract(e.content,'$.sha'))";
    predicate='(EXISTS(SELECT 1 FROM sre_change_events c WHERE c.service_key=i.service_key AND c.provider=l.provider AND c.change_number=l.change_number AND (c.head_sha=? OR '+merged+'=?)) OR EXISTS(SELECT 1 FROM sre_evidence e WHERE e.id=l.evidence_id AND e.incident_id=i.id AND e.source=l.provider AND e.kind IN (\'code_review\',\'change\') AND '+readHead+'=?))';parameters.push(p.sha,p.sha,p.sha);
  }else return [];
  const rows=await q("SELECT i.*,l.provider AS association_provider,l.change_number AS association_number FROM sre_incidents i JOIN sre_incident_change_links l ON l.incident_id=i.id WHERE i.service_key=? AND l.provider=? AND i.status<>'resolved' AND "+predicate+' ORDER BY i.id,l.change_number',parameters),selected=[],seen=new Set();
  for(const candidate of rows){
    if(seen.has(candidate.id))continue;
    const [incident]=await q('SELECT * FROM sre_incidents WHERE id=?'+(dialect==='postgres'?' FOR UPDATE':''),[candidate.id]);
    const [active]=await q('SELECT evidence_id FROM sre_incident_change_links WHERE incident_id=? AND provider=? AND change_number=?',[candidate.id,candidate.association_provider,candidate.association_number]);
    if(active&&incident.status!=='resolved'&&await automaticAssociationAllowed(q,incident,candidate.association_provider,candidate.association_number)){selected.push(incident);seen.add(incident.id);}
  }
  return selected;
}

export class Casework {
  constructor({store,services,qaAdapter,qaOptions}){
    Object.assign(this,{store,services,qaAdapter});this.contactsAfter='';
    this.qaExecution=new QaExecution({adapter:qaAdapter,timeoutMs:qaOptions?.timeoutMs,onLate:(id,outcome,execution)=>this.store.db.transaction(q=>this.event(q,id,'late-result',{result:outcome.kind==='result'?redact(outcome.result):null,error:outcome.kind==='error'?redact(String(outcome.error.message||outcome.error)):null,execution,note:'Late executor evidence only; the interrupted request remains unknown and is not replayed.'}))});
  }
  qaState(){return this.qaExecution.state();}
  close(){return this.qaExecution.close();}
  service(key){const service=this.services.find(s=>s.key===key);if(!service)throw Error('Unknown service');return service;}
  async importDirectory(serviceKey,input) {
    this.service(serviceKey);const now=await this.store.coordinationNow();
    if(!input||!epoch(input.observedAt)||input.observedAt>now||!epoch(input.expiresAt)||input.expiresAt<=input.observedAt||input.expiresAt-input.observedAt>31*86400000)throw Error('Directory requires bounded observation and expiry times');
    assertText(input.source,'directory source',300);
    if(!Array.isArray(input.entries)||input.entries.length>100)throw Error('Directory supports up to 100 scoped entries');
    const ids=new Set();
    for(const e of input.entries){
      for(const key of ['id','name','team','contact'])assertText(e[key],'directory '+key,200);
      if(ids.has(e.id))throw Error('Duplicate directory identity');ids.add(e.id);
      if(!['service-owner','component-owner','on-call','escalation'].includes(e.role))throw Error('Unknown ownership role');
      if(!Array.isArray(e.paths)||e.paths.length>20||e.paths.some(p=>typeof p!=='string'||!p||p.startsWith('/')||p.split('/').includes('..')||p.length>150))throw Error('Use repository-relative ownership paths');
      if(e.projects!==undefined&&(!Array.isArray(e.projects)||!e.projects.length||e.projects.length>4||e.projects.some(project=>!discoveryProject(project))||new Set(e.projects).size!==e.projects.length))throw Error('Ownership projects must name one to four distinct GitLab selectors');
      if(e.role==='on-call'&&(!epoch(e.startsAt)||!epoch(e.endsAt)||e.endsAt<=e.startsAt))throw Error('On-call entry needs an explicit shift window');
    }
    const content=redact({source:input.source,observedAt:input.observedAt,expiresAt:input.expiresAt,entries:input.entries});
    return this.store.db.transaction(async q=>{
      const fence=await this.store.restoreFence(q,{lock:true});if(fence?.active)throw Error('Directory import is held during restore reconciliation');
      const payload={...content,...(fence?{restoreId:fence.restoreId}:{})},id='dir_'+hash([serviceKey,payload]);
      await q('INSERT INTO sre_directory_snapshots(id,service_key,source,observed_at,expires_at,payload) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',[id,serviceKey,payload.source,payload.observedAt,payload.expiresAt,JSON.stringify(payload)]);
      return {id,entries:payload.entries.length};
    });
  }
  async contacts(incidentId,context,query=this.store.db.query) {
    context||=await this.store.context(incidentId);const now=await this.store.coordinationNow(query);
    const rows=await query('SELECT * FROM sre_directory_snapshots WHERE service_key=? ORDER BY observed_at DESC,id DESC LIMIT 2',[context.incident.service_key]);
    if(!rows.length)return contactView({state:'missing',directoryId:null,observedAt:null,expiresAt:null,validFrom:null,validUntil:null,contacts:[],unknowns:['No ownership directory is configured. Ask the incident lead for the service owner; commit authors are not assumed to be on call.']});
    if(rows.length>1&&Number(rows[0].observed_at)===Number(rows[1].observed_at)&&rows[0].id!==rows[1].id)return contactView({state:'conflicting',directoryId:null,observedAt:Number(rows[0].observed_at),expiresAt:null,validFrom:null,validUntil:null,conflictingDirectoryIds:rows.map(row=>row.id).sort(),contacts:[],unknowns:['Conflicting directory snapshots have the same timestamp. Reconcile ownership before selecting a contact.']});
    const row=rows[0],snapshot=JSON.parse(row.payload),policyPaths=(context.incident.analysis?.codeReview?.findings||[]).map(f=>f.path),sourceScope=sourceScopeForService(this.service(context.incident.service_key));
    const savedSources=(context.incident.analysis?.sourceFindings||[]).filter(f=>f.verifiedLocation===true&&f.provider==='gitlab'&&(f.project===sourceScope?.project||f.mappingCandidate===true&&sourceScope?.discovery?.projects.includes(f.project))&&sha(f.sha)&&sourcePath(f.path));
    const identityHistory=savedSources.length?await readSourceIdentityHistory(this.store,{...context,sourceScope},savedSources,query):null;
    const sourceFindings=savedSources.filter(f=>identityHistory.identities.some(identity=>identity.project===f.project&&identity.sha===f.sha&&identity.path===f.path&&identity.state==='consistent'&&identity.sourceContentHashes.includes(f.sourceContentHash)));
    const citedPaths=sourceFindings.filter(f=>f.project===sourceScope?.project).map(f=>f.path),paths=[...new Set([...policyPaths,...citedPaths])],candidatePaths=sourceFindings.filter(f=>f.mappingCandidate===true&&sourceScope?.discovery?.projects.includes(f.project)).map(f=>({project:f.project,path:f.path}));
    const metadata={directoryId:row.id,source:row.source,observedAt:Number(row.observed_at),expiresAt:Number(row.expires_at)};
    const fence=await this.store.restoreFence(query);
    if(fence&&(snapshot.restoreId!==fence.restoreId||Number(row.observed_at)<fence.preparedAt))return contactView({...metadata,state:'restore-historical',validFrom:null,validUntil:null,contacts:[],unknowns:['Database restoration may have lost ownership or roster changes. Import a fresh directory observation after reconciliation; the restored snapshot is historical.']});
    if(Number(row.expires_at)<=now)return contactView({...metadata,state:'expired',validFrom:null,validUntil:Number(row.expires_at),contacts:[],unknowns:['The latest ownership directory is expired. Do not assume its old on-call assignment is current.']});
    const match=(prefix,path)=>path===prefix||path.startsWith(prefix.endsWith('/')?prefix:prefix+'/');
    const matchesFixed=(e,path)=>(!e.projects||e.projects.includes(String(this.service(context.incident.service_key).gitlab?.project||'')))&&e.paths.some(prefix=>match(prefix,path));
    const matchesCandidate=(e,item)=>Array.isArray(e.projects)&&e.projects.includes(item.project)&&e.paths.some(prefix=>match(prefix,item.path));
    const candidates=snapshot.entries.filter(e=>e.role!=='on-call'||e.startsAt<=now&&e.endsAt>now).filter(e=>e.role!=='component-owner'||paths.some(p=>matchesFixed(e,p))||candidatePaths.some(item=>matchesCandidate(e,item)));
    const historical=context.assessmentStatus&&context.assessmentStatus.state!=='current';
    const contacts=candidates.map(e=>({...e,...metadata,reason:e.role==='component-owner'?(candidatePaths.some(item=>matchesCandidate(e,item))?'Runtime mapping is unverified; recorded owner of candidate project/path '+candidatePaths.filter(item=>matchesCandidate(e,item)).map(item=>item.project+'/'+item.path).join(', '):historical?'Owns a path implicated by a saved assessment; the current review is pending':policyPaths.some(path=>e.paths.some(prefix=>match(prefix,path)))?'Owns an implicated source path':'Owns a cited source path; its location is verified, cause remains a hypothesis'):e.role==='on-call'?'Named in the active shift window':e.role==='service-owner'?'Named accountable service owner':'Named escalation contact; contact if the primary owner is unavailable'}));
    const unknowns=contacts.length?[]:['No applicable owner or active on-call shift is present. Ask the incident lead; do not infer ownership from participation.'];
    if(sourceFindings.length!==savedSources.length)unknowns.push('Saved source locations have conflicting or unverified retained bytes. Their component-owner recommendations are withheld pending a current source review; service ownership and roster evidence remain independent.');
    const roster=snapshot.entries.filter(e=>e.role==='on-call'),active=contacts.filter(e=>e.role==='on-call');
    if(roster.length&&!active.length)unknowns.push('No active on-call shift is listed. Verify the roster with the named service owner or escalation contact.');
    if(active.length>1)unknowns.push('More than one on-call shift is active. Confirm primary coverage; this directory provides no priority.');
    if(paths.some(path=>contacts.filter(e=>e.role==='component-owner'&&matchesFixed(e,path)).length>1))unknowns.push('Multiple component owners match an implicated path. Confirm the lead with the listed teams; no ownership priority is provided.');
    if(candidatePaths.some(item=>contacts.filter(e=>e.role==='component-owner'&&matchesCandidate(e,item)).length>1))unknowns.push('Multiple component owners match a candidate project/path; confirm its runtime mapping and lead.');
    if(candidatePaths.length)unknowns.push('Candidate project/path ownership does not establish the running repository. Verify the runtime mapping before selecting a repair or deployment owner.');
    const boundaries=roster.flatMap(e=>[e.startsAt,e.endsAt]);
    return contactView({...metadata,state:'current',validFrom:Math.max(metadata.observedAt,...boundaries.filter(at=>at<=now)),validUntil:Math.min(metadata.expiresAt,...boundaries.filter(at=>at>now)),contacts,unknowns});
  }
  async publishContacts(incidentId){
    return this.store.db.transaction(async q=>{
      const fence=await this.store.restoreFence(q);if(fence?.active)return false;
      const [incident]=await q('SELECT * FROM sre_incidents WHERE id=?'+lock(this.store),[incidentId]);
      if(!incident||incident.status==='resolved'||!this.services.some(s=>s.key===incident.service_key))return false;
      const targets=(await this.store.messageTargets(incidentId,null,q)).filter(room=>room.incident_id===incidentId);
      if(!targets.length)return false;
      const contacts=await this.contacts(incidentId,await directoryContext(incident,q),q),version=contactNoticeVersion(contacts),now=await this.store.coordinationNow(q);let published=false;
      for(const room of targets){
        const key='contact-publication:'+incidentId+':'+room.id,[row]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[key]);let prior;
        if(row)try{prior=JSON.parse(row.value);if(prior.version!==1||!Number.isSafeInteger(prior.generation)||prior.generation<1||!/^[a-f0-9]{64}$/.test(prior.contactVersion)||typeof prior.outboxId!=='string'||!prior.outboxId.startsWith('contact-update:'))throw Error();}catch{throw new StorageError(Error('Invalid contact-publication receipt'));}
        const [previous]=prior?await q('SELECT status FROM sre_outbox WHERE id=? AND incident_id=? AND conversation_key=?',[prior.outboxId,incidentId,room.id]):[];
        if(prior&&!previous)throw new StorageError(Error('Contact-publication delivery record is missing'));
        const shorterWindow=Number.isSafeInteger(prior?.validUntil)&&Number.isSafeInteger(contacts.validUntil)&&contacts.validUntil<prior.validUntil;
        if(prior?.contactVersion===version&&!shorterWindow&&previous.status!=='discarded')continue;
        if(prior)await q("UPDATE sre_outbox SET status='discarded',error='Superseded by a newer contact snapshot' WHERE id=? AND status='pending'",[prior.outboxId]);
        const generation=(prior?.generation||0)+1,id='contact-update:'+hash([incidentId,room.id,fence?.restoreId||null,generation]);
        const text='Incident contacts · '+incidentId+'\nThis is directory evidence for this incident, not an automatic page or a change in action authority.\n\n'+contactsText(contacts);
        await this.store.queueMessage(incidentId,text,room.id,id,q,{contacts});
        await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[key,JSON.stringify({version:1,generation,contactVersion:version,validUntil:contacts.validUntil,outboxId:id}),now]);published=true;
      }
      return published;
    });
  }
  async runContactUpdates(){
    const find=after=>this.store.db.query("SELECT i.id FROM sre_incidents i WHERE i.status<>'resolved' AND i.id>? AND EXISTS(SELECT 1 FROM sre_conversations c WHERE c.incident_id=i.id AND c.enabled=1) ORDER BY i.id LIMIT 1",[after]);
    let [incident]=await find(this.contactsAfter);if(!incident&&this.contactsAfter)[incident]=await find('');
    if(!incident){this.contactsAfter='';return false;}
    this.contactsAfter=incident.id;return this.publishContacts(incident.id);
  }
  async contactDelivery(message,owner,conversation){
    if(!await readContactMessage(this.store.db.query,message))return boundTeamsText(message.text);
    return this.store.db.transaction(async q=>{
      if((await this.store.restoreFence(q))?.active)return null;
      const [incident]=await q('SELECT * FROM sre_incidents WHERE id=?'+lock(this.store),[message.incident_id]);
      const [owned]=await q('SELECT * FROM sre_outbox WHERE id=?'+lock(this.store),[message.id]);
      if(!incident||owned?.status!=='sending'||owned.lease_owner!==owner||Number(owned.lease_until)<=await this.store.coordinationNow(q))return null;
      if(incident.status==='resolved'&&message.id.startsWith('contact-update:')){await q("UPDATE sre_outbox SET status='discarded',error='Incident resolved before contact update delivery',lease_owner=NULL WHERE id=? AND lease_owner=?",[message.id,owner]);return null;}
      const room=await this.store.authorizeIncidentConversation(conversation?.id,incident.id,q);
      if(message.conversation_key&&room.incident_id!==incident.id){await q("UPDATE sre_outbox SET status='discarded',error='Conversation no longer follows this incident',lease_owner=NULL WHERE id=? AND lease_owner=?",[message.id,owner]);return null;}
      const provenance=await readContactMessage(q,owned),contacts=await this.contacts(incident.id,await directoryContext(incident,q),q);
      if(!provenance)throw new StorageError(Error('Generated contact-message provenance disappeared'));
      const changed=provenance.contacts.version!==contacts.version;
      const renderedText=boundTeamsText((changed?'Contact evidence changed while this reply was queued. The contact section was refreshed; saved assessment and ticket history remain unchanged.\n\n':'')+owned.text.slice(0,provenance.sectionStart)+contactMessageText(contacts,provenance.format??'full')+owned.text.slice(provenance.sectionStart+provenance.sectionText.length));
      const record={version:1,incidentId:incident.id,outboxId:owned.id,attempt:Number(owned.attempts),checkedAt:await this.store.coordinationNow(q),originalHash:provenance.originalHash,contactVersion:contacts.version,contacts,renderedText,renderedHash:hash(renderedText)};
      await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',['contact-delivery:'+owned.id+':'+owned.attempts,JSON.stringify(record),record.checkedAt]);
      if(Number(owned.lease_until)<=await this.store.coordinationNow(q))throw Error('Delivery lease expired before contact preflight completed');
      return renderedText;
    });
  }
  async linkChange(incidentId,provider,number,evidenceId,query) {
    if(!['github','gitlab'].includes(provider)||!/^\d+$/.test(String(number)))throw Error('Invalid change link');
    const apply=async q=>{
      const [incident]=await q('SELECT id,issue_key FROM sre_incidents WHERE id=?'+lock(this.store),[incidentId]);if(!incident)throw Error('Unknown incident');
      const [evidence]=await q('SELECT id FROM sre_evidence WHERE id=? AND incident_id=? AND source=?',[evidenceId,incidentId,provider]);if(!evidence)throw Error('Change link requires evidence from this incident');
      if(!await automaticAssociationAllowed(q,incident,provider,String(number)))return {suppressed:true};
      const now=await this.store.coordinationNow(q),inserted=await q('INSERT INTO sre_incident_change_links(incident_id,provider,change_number,linked_at,evidence_id) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING incident_id',[incidentId,provider,String(number),now,evidenceId]);
      if(inserted.length){
        await q('UPDATE sre_incidents SET revision=revision+1 WHERE id=?',[incidentId]);
        await q("INSERT INTO sre_jobs(id,incident_id,payload,status,attempts,next_at,created_at) VALUES(?,?,?,'pending',0,?,?) ON CONFLICT DO NOTHING",[hash(['track-change',incidentId,provider,String(number)]),incidentId,JSON.stringify({changeLink:provider+':'+number}),now,now]);
      }
    };return query?apply(query):this.store.db.transaction(apply);
  }
  trackChange(incidentId,provider,number,actor,options){return trackAssociation(this.store,this.services,incidentId,provider,number,actor,options);}
  withdrawChange(incidentId,provider,number,actor,options){return withdrawAssociation(this.store,this.services,incidentId,provider,number,actor,options);}
  async timeline(incidentId,context) {
    context||=await this.store.context(incidentId);
    const limits=changeTimelineLimits,service=this.service(context.incident.service_key);
    const linkRows=await this.store.db.query('SELECT l.*,e.content AS evidence_content FROM sre_incident_change_links l LEFT JOIN sre_evidence e ON e.id=l.evidence_id AND e.incident_id=l.incident_id WHERE l.incident_id=? ORDER BY l.provider,l.change_number LIMIT '+(limits.links+1),[incidentId]);
    const decisions=context.changeAssociations||await associationContext(this.store,incidentId),withdrawals=decisions.controls.filter(c=>c.state==='withdrawn');
    const links=linkRows.slice(0,limits.links).map(({evidence_content,...link})=>{const content=evidence_content?JSON.parse(evidence_content):{};const control=decisions.controls.find(c=>c.provider===link.provider&&c.number===link.change_number),historicalAfterRestore=Boolean(context.recoveryFence&&context.incident.issue_key!=='review:'+link.provider+':'+link.change_number&&control?.restoreId!==context.recoveryFence.restoreId);const read=decisions.reads?.find(r=>r.provider===link.provider&&r.number===link.change_number);return {...link,evidenceHead:content.headSha||content.sha||content.providerObservation?.headSha||null,...(content.association?{association:content.association,providerObservation:content.providerObservation}:{}),...(read?{read}:{}),...(historicalAfterRestore?{historicalAfterRestore:true}:{})};}).filter(link=>!withdrawals.some(c=>c.provider===link.provider&&c.number===link.change_number));
    const columns='c.*,e.payload AS source_event,e.body_hash,e.received_at',join=' FROM sre_change_events c LEFT JOIN sre_events e ON e.id=c.id';
    const recent=await this.store.db.query('SELECT '+columns+join+' WHERE c.service_key=? ORDER BY c.observed_at DESC,c.id DESC LIMIT '+(limits.facts+1),[context.incident.service_key]);
    const references=[...new Map([...links.map(l=>[l.provider,l.change_number]),...withdrawals.map(c=>[c.provider,c.number])].map(pair=>[pair.join(':'),pair])).values()];
    const reserved=references.length?await this.store.db.query('SELECT * FROM (SELECT '+columns+',ROW_NUMBER() OVER(PARTITION BY c.provider,c.change_number ORDER BY c.observed_at DESC,c.id DESC) AS ref_rank'+join+" WHERE c.service_key=? AND c.stage IN ('pre-merge','merge') AND ("+references.map(()=>'(c.provider=? AND c.change_number=?)').join(' OR ')+')) reserved WHERE ref_rank<='+ (limits.perReference+1)+' ORDER BY ref_rank,observed_at DESC,id DESC LIMIT '+(limits.referenceFacts+1),[context.incident.service_key,...references.flat()]):[];
    const referenceRows=reserved.filter(r=>Number(r.ref_rank)<=limits.perReference).slice(0,limits.referenceFacts),native=referenceRows.map(parseChangeTimelineFact),ciHeads=[];
    for(const link of links.filter(link=>link.provider==='gitlab'&&!link.historicalAfterRestore)){
      const observations=native.filter(row=>row.provider===link.provider&&row.change_number===link.change_number),latest=Math.max(-1,...observations.map(row=>row.observed_at));
      ciHeads.push(...(observations.length?observations.filter(row=>row.observed_at===latest).map(row=>row.head_sha):[link.read?.headSha,link.evidenceHead]));
    }
    const ciWindow=await reserveCiHistory(this.store,service,ciHeads,context);
    const candidates=[...new Map([...referenceRows.filter(row=>Number(row.ref_rank)===1),...ciWindow.rows,...referenceRows,...recent.slice(0,limits.facts)].map(row=>[row.id,row])).values()],rows=candidates.slice(0,limits.facts);
    const evidenceIds=rows.map(row=>hash([row.id,incidentId]));
    const deliveredRows=evidenceIds.length?await this.store.db.query('SELECT id FROM sre_evidence WHERE incident_id=? AND id IN ('+evidenceIds.map(()=>'?').join(',')+')',[incidentId,...evidenceIds]):[],deliveredIds=new Set(deliveredRows.map(r=>r.id)),delivered=new Set(rows.filter(row=>deliveredIds.has(hash([row.id,incidentId]))).map(row=>row.id));
    const projection=projectChangeTimeline({rows,links,withdrawals,context,service,delivered,ciWindow});
    projection.items.sort((a,b)=>b.observed_at-a.observed_at||b.id.localeCompare(a.id));
    const coverage={providerWindowLimited:recent.length>limits.facts,referenceWindowLimited:reserved.length>limits.referenceFacts||reserved.some(r=>Number(r.ref_rank)>limits.perReference),linksLimited:linkRows.length>limits.links,factWindowLimited:candidates.length>limits.facts,ciRunWindowLimited:ciWindow.limited,ciSourceVersionsLimited:ciWindow.versionsLimited,ciReservedFacts:ciWindow.rows.length,ciSelectedRuns:ciWindow.runs.length,ciStoredRunsAvailable:ciWindow.availableRuns??0,providerRowsRead:recent.length,referenceRowsRead:reserved.length,factsInWindow:rows.length,displayedFacts:projection.items.length,groupsInWindow:projection.totalGroupsInWindow,groupsDisplayed:projection.groups.length,interpretation:'Counts describe this bounded history window, not all provider deliveries. Raw source facts remain in the database. Linked MR/PR observations and scoped current-head CI state representatives have reserved space before the noisy recent-source window. A checked CI version compares saved scoped observations, not current provider visibility or recovery.'};
    const fence=context.recoveryFence,restoreNote=fence?' Database restoration '+fence.restoreId+' may have lost later change events. Historical rows do not establish the current MR head or deployment.':'';
    return {...projection,projectionVersion:1,links,withdrawals,associationControls:decisions,ciCoverage:{scopeHash:ciWindow.scopeHash,project:ciWindow.project,heads:ciWindow.heads},coverage,limited:coverage.providerWindowLimited||coverage.referenceWindowLimited||coverage.linksLimited||coverage.factWindowLimited||coverage.ciRunWindowLimited||coverage.ciSourceVersionsLimited||projection.groupsLimited||decisions.limited,interpretation:'Provider observations are immutable. Relationship labels distinguish linked changes, matching commits, retained evidence and shared commit history. Shared commits do not establish incident association or common cause. A withdrawn relationship retains its facts without following later updates into this case. CI summaries compare update versions only; finish/create times remain separate. MR head, merge commit, CI success and deployment success are distinct states; none alone verifies recovery.'+restoreNote};
  }
  async createPlan(incidentId,{originConversationKey=null}={}) {
    const context=await this.store.context(incidentId),analysis=context.incident.analysis;
    if(context.recoveryFence?.active)throw Error('Fix planning is held during restore reconciliation');
    if(!analysis)throw Error('Wait for an assessment before drafting a fix plan');
    const draftingAnalysisHash=hash(analysis);
    if(context.assessmentStatus?.state!=='current')throw Error('Assessment is stale or unaudited; wait for a current review before drafting a fix plan');
    if(unverifiedLogFields(context)&&analysis.changeAssessment!=='unknown')throw Error('Current log fields are contradictory or malformed; request a fresh investigation before drafting a fix plan');
    const sourceFindings=analysis.sourceFindings?.length?validateSourceFindings(sourceFindingInput(analysis.sourceFindings),context,boundedContext(context)):[];
    const contacts=await this.contacts(incidentId,context),timeline=await this.timeline(incidentId,context);
    const [assessment]=await this.store.db.query('SELECT revision FROM sre_assessments WHERE incident_id=? ORDER BY revision DESC,evaluated_at DESC,id DESC LIMIT 1',[incidentId]);
    if(Number(assessment?.revision)!==Number(context.incident.revision))throw Error('Assessment is stale; wait for the current investigation before drafting');
    const findings=analysis.codeReview?.findings||[],fixes=findings.filter(f=>supportedFixes[f.signal]&&f.headSha===analysis.candidateSha);
    const patch=analysis.changeAssessment==='likely'&&fixes.length===1?{signal:fixes[0].signal,path:fixes[0].path,baseSha:fixes[0].baseSha,headSha:fixes[0].headSha,evidenceId:fixes[0].evidenceId,field:supportedFixes[fixes[0].signal][0],value:supportedFixes[fixes[0].signal][1]}:null;
    const reportedContext=planCollaborationSnapshot(context.collaboration),{rooms:collaboration,...collaborationContext}=reportedContext;
    const signalGroups=(context.signalDigest?.groups||[]).slice(0,6);
    const payload={incidentId,serviceKey:context.incident.service_key,revision:Number(context.incident.revision),summary:analysis.summary,...(sourceFindings.length?{sourceFindings}:{}),...(analysis.sourceDiscovery?{sourceDiscovery:analysis.sourceDiscovery}:{}),...(analysis.sourceInventories?{sourceInventories:analysis.sourceInventories}:{}),...(analysis.evidenceAcquisition?{evidenceAcquisition:analysis.evidenceAcquisition}:{}),assessment:analysis.changeAssessment,candidateSha:analysis.candidateSha,findings,patch,contacts,timeline,collaboration,collaborationContext,handoffs:context.collaboration.handoffs||[],handoffCoverage:context.collaboration.handoffCoverage||null,signalGroups,incidentScope:context.signalDigest?.incidentScope||null,evidenceIds:analysis.evidenceIds,unknowns:analysis.unknowns,coverage:context.signalDigest?.coverage,rollback:analysis.rollback};
    payload.assessmentHash=assessmentHash(analysis);
    const contextHash=hash(payload),id='plan_'+hash([incidentId,contextHash]).slice(0,24);
    const markdown=['# Fix ticket: '+md(context.incident.title),'','Ticket: `'+id+'`','Incident: `'+incidentId+'` · revision '+payload.revision,'Status: proposed; human review required. This is a Markdown ticket, not a created Jira/ServiceNow record.','','## Problem and evidence',md(analysis.summary),'Assessment: '+md(analysis.changeAssessment)+'; candidate: `'+(analysis.candidateSha||'unknown')+'`.',...findings.map(f=>'- '+md(f.signal)+': '+md(f.issue)+' (`'+md(f.path)+'`, `'+md(f.baseSha)+'` → `'+md(f.headSha)+'`; evidence `'+md(f.evidenceId)+'`).'),...(sourceFindings.length?['','## Source hypotheses (verified locations; cause unverified)',...sourceFindings.flatMap(f=>['- '+md(f.provider)+' '+md(f.project)+' at `'+md(f.sha)+'` · `'+md(f.path)+'`:L'+f.startLine+'-L'+f.endLine+'; evidence `'+md(f.evidenceId)+'`. '+md(f.explanation),...f.quote.split('\n').map(line=>'> '+md(line)),...(f.mappingCandidate?['  Candidate mapping only: the quote matches this project, but the runtime repository, revision mapping and cause remain unverified.']:[]),...(f.reportedLogLocations||[]).map(location=>'  Reported log location: evidence `'+md(location.evidenceId)+'`, record '+(location.recordIndex+1)+', line '+location.line+'. Runtime/source identity and cause remain unverified.')])]:[]),...(analysis.sourceInventories?['','## Source directory observations',...sourceInventoryText(analysis.sourceInventories).split('\n').map(md)]:[]),...(analysis.sourceDiscovery?['','## Candidate repository discovery',...discoverySummaryText(analysis.sourceDiscovery).split('\n').map(md)]:[]),'','## Observed log samples',...(payload.incidentScope?.state==='reported'?['Reported monitor impact scope: '+md(payload.incidentScope.environment)+' / '+md(payload.incidentScope.region)+' / `'+md(payload.incidentScope.version)+'`; observed '+new Date(payload.incidentScope.observedAt).toISOString()+'; scope evidence `'+md(payload.incidentScope.evidenceId)+'`.','Different or unknown scopes remain dependency/request alternatives; compare relationships before connecting or excluding them. Scope does not establish cause, completeness or recovery.']:payload.incidentScope?['Monitor impact scope is unverified. Service-level observations may describe several incidents.']:[]),...signalGroups.map(g=>'- '+md(g.level)+' '+md(g.code||g.errorType||'unclassified')+' · '+md(g.region||'region unknown')+' · `'+md(g.version||'release unknown')+'`'+(payload.incidentScope?.state==='reported'?' · '+md(g.scopeRelation||'unknown')+' reported scope':'')+(g.metadataIssues?.length?' · Unverified log fields: '+md(g.metadataIssues.join(', ')):'')+': '+md(g.message)+'; evidence '+g.evidenceIds.map(id=>'`'+md(id)+'`').join(', ')),signalGroups.length?'These are bounded observations, not total failures or unique affected users.':'No log sample in this snapshot; request the relevant source window.','','## Who to contact',...contactWindowText(contacts).map(md),...contacts.contacts.map(c=>'- '+md(c.name)+' · '+md(c.team)+' · '+md(c.role)+' · '+md(c.contact)+'. '+md(c.reason)+'; directory `'+c.directoryId+'`.'),...contacts.unknowns.map(u=>'- Unknown: '+md(u)),'','## Proposed implementation',patch?'Restore `'+patch.field+'` to `'+patch.value+'` in `'+patch.path+'` on exact head `'+patch.headSha+'`. The local QA adapter supports this one known policy correction; review the diff and business tests.':'No automatic patch is supported by the current evidence. Collect discriminating traces and exact source/rollout identity; prepare a reviewed forward fix.','','## Acceptance checks','- Reproduce the affected business invariant on the exact faulty revision.','- Run the same invariant against the proposed fix; retain test output and immutable commit identity.','- Check unaffected behavior, deployment compatibility and data repair separately.','- Do not infer recovery from health probes, MR merge or a successful CI job.','','## Collaboration and change tracking',...(context.collaboration.handoffs||[]).map(h=>'- '+md(handoffText(h))+' Retained release report `'+md(h.release.evidenceId)+'`'+(h.owner?'; owner report `'+md(h.owner.evidenceId)+'`':'')+(h.completion?'; completion report `'+md(h.completion.evidenceId)+'`':'')+'.'),...(context.collaboration.handoffCoverage?.omitted?['- '+context.collaboration.handoffCoverage.omitted+' additional handoff records are outside this bounded snapshot; request missing work evidence.']:[]),...planCollaborationMarkdown(reportedContext),...timeline.links.filter(l=>l.association).map(l=>'- Context association: '+md(l.provider)+' #'+md(l.change_number)+' linked by '+md(l.association.label||l.association.id)+(l.historicalAfterRestore?'; historical after restore, awaiting fresh reaffirmation':'')+(l.association.reason?'; reported reason: '+md(l.association.reason):'')+'; evidence `'+l.evidence_id+'`'+(l.association.previousEvidenceId?'; prior correction `'+l.association.previousEvidenceId+'`':'')+'. This is not a causal finding or action approval.'),...timeline.links.filter(l=>l.read).map(l=>'- Provider read: '+md(l.provider)+' #'+md(l.change_number)+'; '+(l.read.complete?'metadata observed':'needs attention: '+md(l.read.error))+'; provider updated '+(l.read.providerUpdatedAt===null?'unknown':new Date(l.read.providerUpdatedAt).toISOString())+'; read completed '+new Date(l.read.readCompletedAt).toISOString()+'; CI '+md(l.read.ci?.status||l.read.ci?.state||'unknown')+(l.read.ci?.eventId?'; CI source event `'+md(l.read.ci.eventId)+'`':'')+(l.read.ci?.note?'; '+md(l.read.ci.note):'')+md(ciConsistencyText(l.read.ci))+'. This does not establish deployment or recovery.'),...timeline.withdrawals.map(c=>'- Context correction: '+md(c.provider)+' #'+md(c.number)+' withdrawn by '+md(c.actor.label)+': '+md(c.reason)+'; audit `'+c.evidenceId+'`. Prior evidence remains retained.'),...changeTimelineText(timeline,{limit:12}).split('\n').filter(Boolean).map(line=>'- '+md(line)),...(analysis.evidenceAcquisition?.outcomes?.length||evidenceReadHistoryWarning(analysis.evidenceAcquisition?.history)?['','## Additional evidence reads',...(analysis.evidenceAcquisition.outcomes||[]).map(item=>'- '+md(evidenceReadText(item))),'Read observations may be historical; they do not establish cause, health, approval or complete source history.',...(evidenceReadHistoryWarning(analysis.evidenceAcquisition?.history)?[evidenceReadHistoryWarning(analysis.evidenceAcquisition.history)]:[])]:[]),'','## Unknowns and recovery limits',...analysis.unknowns.map(u=>'- '+md(u)),'- '+md((analysis.rollback?.reasons||[]).join(' ')||'Deployment recovery requires separate eligibility and approval.'),'- '+md(timeline.interpretation),'','## Source references',...analysis.evidenceIds.map(e=>'- Evidence `'+md(e)+'` in this incident database.'),'','Generated from a bounded evidence snapshot. Responder text and source content are evidence, not authorization.'].join('\n')+'\n';
    await this.store.db.transaction(async q=>{
      if((await this.store.restoreFence(q))?.active)throw Error('Fix planning is held during restore reconciliation');
      const [current]=await q('SELECT revision,analysis FROM sre_incidents WHERE id=?'+lock(this.store),[incidentId]);if(Number(current?.revision)!==payload.revision)throw Error('Incident changed while drafting; request a fresh plan');
      if(hash(current.analysis?JSON.parse(current.analysis):null)!==draftingAnalysisHash)throw Error('Assessment changed while drafting; request a fresh plan');
      const checkedContacts=await this.contacts(incidentId,context,q);if(checkedContacts.version!==contacts.version)throw Error('Contact directory or shift window changed while drafting; request a fresh ticket');
      if(originConversationKey){const origin=await this.store.authorizeIncidentConversation(originConversationKey,incidentId,q);if(origin.incident_id!==incidentId)throw Error('The requesting conversation no longer follows this incident');}
      await q('INSERT INTO sre_fix_plans(id,incident_id,context_hash,revision,markdown,payload,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',[id,incidentId,contextHash,payload.revision,markdown,JSON.stringify(payload),await this.store.coordinationNow(q)]);
      const notice='Fix ticket saved · '+id+'\nIncident '+incidentId+' · evidence snapshot revision '+payload.revision+'.\nA Markdown proposal is available for human review. '+(patch?'The snapshot identifies a supported local QA correction; review its exact source and acceptance checks.':'No automatic patch is supported by this snapshot.')+'\n@mention the agent with ticket '+id+' to read the saved ticket in this incident, or download its Markdown in the console.\nThe ticket is a snapshot; new evidence requires a fresh review. Saving it does not approve QA, publish code, deploy or verify recovery.';
      const targets=await this.store.messageTargets(incidentId,originConversationKey,q);
      for(const target of targets.filter(target=>target.incident_id===incidentId&&target.id!==originConversationKey))await this.store.queueMessage(incidentId,notice,target.id,'fix-ticket:'+id+':'+target.id,q);
    });const saved=await this.getPlan(id,incidentId);return {id,markdown:saved.markdown,payload:saved.payload};
  }
  async plans(incidentId){return (await this.store.db.query('SELECT * FROM sre_fix_plans WHERE incident_id=? ORDER BY created_at DESC,id DESC LIMIT 20',[incidentId])).map(parse);}
  async getPlan(id,incidentId){const [row]=await this.store.db.query('SELECT * FROM sre_fix_plans WHERE id=? AND incident_id=?',[id,incidentId]);if(!row)throw Error('Plan not found in this incident');return parse(row);}
  qaRequests(incidentId,options){return readQaHistory(this.store,incidentId,options);}
  qaRequest(incidentId,id){return readQaRequest(this.store,incidentId,id);}
  async ticketIndex(incidentId,{conversationKey=null}={}){
    return this.store.db.transaction(async q=>{
      const [incident]=await q('SELECT id,revision,analysis FROM sre_incidents WHERE id=?'+lock(this.store),[incidentId]);if(!incident)throw Error('Incident not found');
      if(conversationKey){const room=await this.store.authorizeIncidentConversation(conversationKey,incidentId,q);if(room.incident_id!==incidentId)throw Error('This conversation does not follow the incident');}
      const revision=Number(incident.revision),fence=await this.store.restoreFence(q),[audit]=await q('SELECT MAX(revision) AS latest_revision,MAX(CASE WHEN revision=? AND body=? THEN 1 ELSE 0 END) AS matches FROM sre_assessments WHERE incident_id=?',[revision,incident.analysis,incidentId]),[count]=await q('SELECT COUNT(*) AS count FROM sre_fix_plans WHERE incident_id=?',[incidentId]);
      const total=Number(count.count),held=fence?.active===true,currentReview=Number(audit.matches)===1&&Number(audit.latest_revision)===revision;
      // Reserve current evidence before the historical window. Do not load
      // Markdown, full plan payloads, QA logs, credentials or approval nonces.
      const savedAssessmentHash=this.store.db.dialect==='postgres'?"p.payload::jsonb->>'assessmentHash'":"json_extract(p.payload,'$.assessmentHash')";
      const rows=await q('SELECT p.id,p.revision,p.created_at,'+savedAssessmentHash+' AS assessment_hash,(SELECT COUNT(*) FROM sre_fix_requests r WHERE r.plan_id=p.id AND r.incident_id=p.incident_id) AS qa_count FROM sre_fix_plans p WHERE p.incident_id=? ORDER BY CASE WHEN p.revision=? THEN 0 ELSE 1 END,p.created_at DESC,p.id DESC LIMIT 3',[incidentId,revision]),plans=[],now=await this.store.coordinationNow(q);
      const commit=this.store.db.dialect==='postgres'?"result::jsonb->>'commit'":"json_extract(result,'$.commit')";
      for(const row of rows){
        const latest=await q('SELECT id,status,created_at,expires_at,'+commit+' AS commit_sha FROM sre_fix_requests WHERE plan_id=? AND incident_id=? ORDER BY created_at DESC,id DESC LIMIT 2',[row.id,incidentId]),[qa,peer]=latest,qaAmbiguous=Boolean(peer&&Number(peer.created_at)===Number(qa.created_at));
        if(!/^plan_[a-f0-9]{24}$/.test(row.id)||!epoch(Number(row.revision))||!epoch(Number(row.created_at))||!epoch(Number(row.qa_count))||latest.some(record=>!/^fix_[a-f0-9]{24}$/.test(record.id)||!epoch(Number(record.created_at))||!epoch(Number(record.expires_at))||!['proposed','approved','running','passed','failed','unknown','superseded'].includes(record.status)))throw new StorageError(Error('Invalid saved ticket index metadata'));
        const assessmentCurrent=row.assessment_hash?row.assessment_hash===assessmentHash(incident.analysis?JSON.parse(incident.analysis):null):null;
        plans.push({id:row.id,revision:Number(row.revision),createdAt:Number(row.created_at),current:!held&&currentReview&&Number(row.revision)===revision&&assessmentCurrent!==false,assessmentCurrent,qaCount:Number(row.qa_count),qaAmbiguous,qa:qa&&!qaAmbiguous?{id:qa.id,status:qa.status==='proposed'&&Number(qa.expires_at)<=now?'expired':qa.status,commit:sha(qa.commit_sha)?qa.commit_sha:null}:null});
      }
      return {incidentId,currentRevision:revision,held,total,limited:total>plans.length,plans};
    });
  }
  authorize(principal,service,conversationKey) {
    if(!principal?.verified||principal.tenant!==service.teams.tenantId||!service.teams.approvers.includes(principal.userId))throw Error('Only a configured developer may authorize local QA');
    if(hash([principal.tenant,principal.conversationId]).slice(0,32)!==conversationKey)throw Error('QA authorization must come from its original conversation');
  }
  async proposeFix(incidentId,planId,principal,conversationKey,requestId) {
    const context=await this.store.context(incidentId),service=this.service(context.incident.service_key);
    this.authorize(principal,service,conversationKey);await this.store.authorizeIncidentConversation(conversationKey,incidentId);
    if(unverifiedLogFields(context))throw Error('Current log fields are contradictory or malformed; reconcile them before proposing automatic QA');
    if(!this.qaAdapter||!this.qaAdapter.localOnly)throw Error('Local QA execution is not configured. The Markdown plan remains available for review.');
    const plan=await this.getPlan(planId,incidentId);if(!plan.payload.patch)throw Error('This plan has no supported automatic patch');
    const nonce=randomBytes(18).toString('hex'),id='fix_'+hash([incidentId,requestId]).slice(0,24),now=await this.store.coordinationNow();
    return this.store.db.transaction(async q=>{
      const room=await this.store.authorizeIncidentConversation(conversationKey,incidentId,q);if(room.incident_id!==incidentId)throw Error('Join this incident before requesting local QA');
      const [current]=await q('SELECT revision,analysis FROM sre_incidents WHERE id=?'+lock(this.store),[incidentId]);if(Number(current.revision)!==Number(plan.revision))throw Error('Fix plan is stale; draft a fresh one');
      if(!planAssessmentCurrent(plan.payload,current.analysis?JSON.parse(current.analysis):null))throw Error('Fix plan assessment is stale; draft a fresh one');
      const [prior]=await q('SELECT * FROM sre_fix_requests WHERE id=?',[id]);if(prior){if(prior.plan_id!==planId||prior.conversation_key!==conversationKey||prior.requested_by!==principal.userId)throw Object.assign(Error('QA request identity was reused for a different plan, developer or conversation'),{status:409});return {id,status:prior.status,text:'QA request '+id+' already exists as '+prior.status+'. Request a new proposal if a new approval is needed.'};}
      if((await this.store.restoreFence(q))?.active)throw Error('QA is held during restore reconciliation');
      await q('INSERT INTO sre_fix_requests(id,plan_id,incident_id,conversation_key,requested_by,nonce_hash,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,\'proposed\',?)',[id,planId,incidentId,conversationKey,principal.userId,hash(nonce),now+600000,now]);
      await this.event(q,id,'proposed',{actor:principal.userId,planId,requestId});
      return {id,nonce,text:'Review '+planId+'. QA will create a local branch, apply the one known policy fix and run the sandbox business checks. It will not push, open an MR, merge or deploy. Within ten minutes send approve-fix '+id+' '+nonce+', or reply yes here after receiving this proposal while it is the only pending action.'};
    });
  }
  async event(q,id,status,payload){const at=await this.store.coordinationNow(q);await q('INSERT INTO sre_fix_events(id,request_id,status,at,payload) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',[hash([id,status,payload]),id,status,at,JSON.stringify(payload)]);}
  async approveFix(id,nonce,principal,conversationKey,{bareYes=false,command}={}) {
    return this.store.db.transaction(async q=>{
      // Match the router's command -> incident lock order. Fence the state
      // change itself, not just the later acknowledgement transaction.
      const claim=await qaApprovalCommand(this.store,q,command,principal,conversationKey,{bareYes,id,nonce});
      if((await this.store.restoreFence(q))?.active)throw Error('QA is held during restore reconciliation');
      const receipt=await qaApprovalReceipt(q,claim);
      let rows;
      if(receipt)id=receipt.requestId;
      else if(bareYes){
        const [room]=await q('SELECT incident_id FROM sre_conversations WHERE id=? AND enabled=1',[conversationKey]);if(!room?.incident_id)throw Error('Join the incident before approving local QA');
        await q('SELECT id FROM sre_incidents WHERE id=?'+lock(this.store),[room.incident_id]);
        // A chat can contain proposals from several developers. Do not choose
        // an older personal proposal merely because its author said yes.
        rows=await q("SELECT * FROM sre_fix_requests WHERE conversation_key=? AND status='proposed' AND expires_at>? ORDER BY created_at",[conversationKey,await this.store.coordinationNow(q)]);
        const [rollbacks]=await q("SELECT COUNT(*) AS count FROM sre_rollbacks WHERE incident_id=? AND status IN ('pending','approved','checking','dispatching','dispatched','unknown')",[room.incident_id]);
        if(rows.length!==1||Number(rollbacks.count))throw Error('Yes is ambiguous. Use the exact approve-fix command for the reviewed request.');
        id=rows[0].id;
      }
      const [lookup]=await q('SELECT incident_id FROM sre_fix_requests WHERE id=?',[id]);if(!lookup)throw Error('Unknown QA request');
      const [incident]=await q('SELECT * FROM sre_incidents WHERE id=?'+lock(this.store),[lookup.incident_id]);const service=this.service(incident.service_key);
      const [row]=await q('SELECT * FROM sre_fix_requests WHERE id=?'+lock(this.store),[id]);
      this.authorize(principal,service,conversationKey);await this.store.authorizeIncidentConversation(conversationKey,row.incident_id,q);
      if(row.conversation_key!==conversationKey||row.requested_by!==principal.userId)throw Error('Approve QA in the original request conversation as the requesting developer');
      const [room]=await q('SELECT incident_id FROM sre_conversations WHERE id=?',[conversationKey]);if(room.incident_id!==row.incident_id)throw Error('Conversation no longer follows the requested incident');
      if(!bareYes&&!equalSecret(hash(nonce||''),row.nonce_hash))throw Error('Invalid QA approval nonce');
      if(receipt){await assertQaCommandClaim(this.store,q,claim);return {id,status:row.status,duplicate:true,text:'This approval message was already recorded for '+id+'. Its current status is '+row.status+'. No duplicate run or approval of another request was queued.'};}
      if(row.status!=='proposed'){await recordQaApprovalReceipt(this.store,q,claim,row,{applied:false});await assertQaCommandClaim(this.store,q,claim);return {id,status:row.status,text:'QA request '+id+' is already '+row.status+'. No duplicate run was queued.'};}
      if(Number(row.expires_at)<=await this.store.coordinationNow(q))throw Error('QA approval expired; request a fresh proposal');
      const [plan]=await q('SELECT revision,payload FROM sre_fix_plans WHERE id=?',[row.plan_id]);if(Number(plan.revision)!==Number(incident.revision))throw Error('Fix plan is stale; draft a fresh one before approval');
      if(!planAssessmentCurrent(JSON.parse(plan.payload),incident.analysis?JSON.parse(incident.analysis):null))throw Error('Fix plan assessment is stale; draft a fresh one before approval');
      const delivery=bareYes?await deliveredQaProposal(this.store,q,row,claim):null;
      await q("UPDATE sre_fix_requests SET status='approved',approved_by=? WHERE id=?",[principal.userId,id]);await this.event(q,id,'approved',{actor:principal.userId});
      await recordQaApprovalReceipt(this.store,q,claim,row,{applied:true,delivery});await assertQaCommandClaim(this.store,q,claim);
      return {id,status:'approved',text:'Local QA approved as '+id+'. Results and branch identity will be retained in the database. This does not approve a push, merge, rollback or deployment.'};
    });
  }
  async runOnce() {
    const adapter=this.qaAdapter;
    if(!adapter?.localOnly||this.qaExecution.closed)return false;
    const call=this.qaExecution.reserve();
    try {
    const owner=randomBytes(18).toString('hex');
    const request=await this.store.db.transaction(async q=>{
      if((await this.store.restoreFence(q))?.active)return null;
      const now=await this.store.coordinationNow(q);
      const expired=await q("UPDATE sre_fix_requests SET status='unknown',error='Local QA worker was interrupted; inspect its workspace and audit before another request',lease_owner=NULL,lease_until=NULL WHERE status='running' AND lease_until<=? RETURNING id,incident_id,conversation_key",[now]);
      for(const row of expired){await this.event(q,row.id,'unknown',{reason:'Expired local QA lease; no automatic rerun'});await this.store.queueMessage(row.incident_id,'QA '+row.id+' · outcome unknown after an interrupted local run. Inspect the saved workspace and audit before another request. The action will not be replayed automatically.',null,'qa-unknown:'+row.id,q,{broadcast:true});}
      if(!call)return null;
      const [row]=await q("SELECT * FROM sre_fix_requests WHERE status='approved' ORDER BY created_at LIMIT 1"+(this.store.db.dialect==='postgres'?' FOR UPDATE SKIP LOCKED':''));if(!row)return null;
      // A local filesystem action is never silently resumed after a crash. Its
      // durable running marker makes reconciliation explicit on the next start.
      await q("UPDATE sre_fix_requests SET status='running',lease_owner=?,lease_until=? WHERE id=?",[owner,now+120000,row.id]);await this.event(q,row.id,'running',{owner});return row;
    });if(!request)return false;
    let result,error,status,reviewedAnalysisHash;
    try {
      const context=await this.store.context(request.incident_id),plan=await this.getPlan(request.plan_id,request.incident_id),service=this.service(context.incident.service_key);
      if(Number(context.incident.revision)!==Number(plan.revision)||!service.teams.approvers.includes(request.approved_by))throw Error('QA scope or approval changed before execution');
      if(context.assessmentStatus?.state!=='current'||!planAssessmentCurrent(plan.payload,context.incident.analysis))throw Error('QA assessment changed before execution; draft a fresh plan');
      reviewedAnalysisHash=hash(context.incident.analysis);
      if(unverifiedLogFields(context))throw Error('Current log fields are contradictory or malformed; automatic QA cannot execute this saved patch');
      if(Number(request.expires_at)<=await this.store.coordinationNow())throw Error('QA approval expired before execution');
      const room=await this.store.authorizeIncidentConversation(request.conversation_key,request.incident_id);if(room.incident_id!==request.incident_id)throw Error('QA conversation no longer follows this incident');
      const outcome=await this.qaExecution.run(call,{requestId:request.id,plan:plan.payload,markdown:plan.markdown},adapter);
      if(outcome.kind==='interrupted'){status='unknown';error=outcome.reason==='timeout'?'Local QA execution exceeded its host deadline; cancellation was requested but the workspace outcome may be uncertain. Inspect the workspace and audit before another request; this action will not be replayed automatically.':'The agent stopped while local QA was in progress; cancellation was requested. Inspect its workspace and audit before another request; this action will not be replayed automatically.';}
      else if(outcome.kind==='error')throw outcome.error;
      else {result=redact(outcome.result);status=result.status==='passed'?'passed':'failed';}
    }catch(cause){error=redact(cause.message);status='failed';}
    await this.store.db.transaction(async q=>{
      const [incident]=await q('SELECT id,revision,service_key,analysis FROM sre_incidents WHERE id=?'+lock(this.store),[request.incident_id]);
      const [plan]=await q('SELECT revision,payload FROM sre_fix_plans WHERE id=?',[request.plan_id]);
      const service=this.service(incident.service_key),reasons=[];
      if(Number(incident.revision)!==Number(plan.revision))reasons.push('Incident evidence changed during QA');
      const review=await directoryContext(incident,q);
      if(review.assessmentStatus.state!=='current'||!planAssessmentCurrent(JSON.parse(plan.payload),review.incident.analysis)||(reviewedAnalysisHash&&reviewedAnalysisHash!==hash(review.incident.analysis)))reasons.push('The incident assessment changed before or during QA');
      if(!service.teams.approvers.includes(request.approved_by))reasons.push('The approving developer no longer has QA authority');
      try{const room=await this.store.authorizeIncidentConversation(request.conversation_key,request.incident_id,q);if(room.incident_id!==request.incident_id)reasons.push('The requesting conversation no longer follows this incident');}
      catch(cause){if(cause instanceof StorageError)throw cause;reasons.push('The requesting conversation lost access to this incident');}
      if(reasons.length){if(status!=='unknown')status='superseded';error=(error?error+' ':'')+reasons.join('. ')+'. Retain these historical artifacts; request a fresh plan and approval before further work.';}
      if(result)result={...result,review:{approvedRevision:Number(plan.revision),completedRevision:Number(incident.revision),current:!reasons.length,reason:error||null}};
      const updated=await q("UPDATE sre_fix_requests SET status=?,result=?,error=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_owner=? AND lease_until>? RETURNING id",[status,result?JSON.stringify(result):null,error||null,request.id,owner,await this.store.coordinationNow(q)]);
      if(!updated.length){await this.event(q,request.id,'late-result',{result:result||null,error:error||null});return;}
      await this.event(q,request.id,status,{result:result||null,error:error||null});
      await this.store.queueMessage(request.incident_id,'QA '+request.id+' · '+status+(result?'\nLocal branch: '+result.branch+'\nCommit: '+result.commit+'\n'+result.summary:'')+(error?'\n'+error:'')+'\nNo push, MR, deployment or verified production recovery.',null,'qa-result:'+request.id,q,{broadcast:true});
    });return true;
    } finally {this.qaExecution.finish(call);}
  }
  async snapshot(incidentId,context){
    context||=await this.store.context(incidentId);const revision=Number(context.incident.revision),held=context.recoveryFence?.active===true;
    const contacts=await this.contacts(incidentId,context);
    const {items:qa,...qaHistory}=await this.qaRequests(incidentId,{attention:true});
    return {associationActionVersion:1,held,currentRevision:revision,contacts,assessmentContactsCurrent:contactsCurrent(context.incident.analysis?.contacts,contacts),plans:(await this.plans(incidentId)).map(plan=>({...plan,current:Number(plan.revision)===revision,assessmentCurrent:context.assessmentStatus?.state==='current'&&planAssessmentCurrent(plan.payload,context.incident.analysis),contactsCurrent:contactsCurrent(plan.payload.contacts,contacts)})),changes:await this.timeline(incidentId,context),qa,qaHistory};
  }
}
