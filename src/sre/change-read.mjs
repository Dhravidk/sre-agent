import {hash,redact} from './security.mjs';
import {StorageError} from './database.mjs';
import {normalize} from './normalize.mjs';
import {pollScopeHash} from './poll-scope.mjs';
import {reconcileReadCI} from './ci-observations.mjs';

const sha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const epoch=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function number(value){const text=String(value);if(!/^[1-9]\d*$/.test(text)||!Number.isSafeInteger(Number(text)))throw Error('Invalid tracked change number');return text;}
const timestamp=value=>{const parsed=typeof value==='string'?Date.parse(value):NaN;if(!epoch(parsed))throw Error('A change read requires its provider update timestamp');return parsed;};
const optionalSha=value=>value===null||value===undefined?null:sha(value)?value:(()=>{throw Error('Invalid change commit identity');})();
const key=(serviceKey,provider,n)=>'change-read:'+serviceKey+':'+provider+':'+number(n);
const text=(value,limit)=>value===null||value===undefined?'':typeof value==='string'?value.slice(0,limit):(()=>{throw Error('Invalid change metadata text');})();

// Canonical metadata excludes counters, avatars and read time. Repeated reads of
// one provider version must not invalidate a developer's reviewed plan.
export function providerChangeSnapshot(provider,raw,config,requested){
  const n=number(requested);let head,base,state,merged,projectId=null;
  if(provider==='github'){
    if(String(raw.number)!==n||raw.base?.repo?.full_name?.toLowerCase()!==config.repository.toLowerCase()||!['open','closed'].includes(raw.state)||typeof raw.merged!=='boolean')throw Error('GitHub returned an invalid or out-of-scope pull request');
    head=raw.head?.sha;base=raw.base?.sha;state=raw.merged?'merged':raw.state;merged=raw.merged?optionalSha(raw.merge_commit_sha):null;
  }else if(provider==='gitlab'){
    if(String(raw.iid)!==n||!Number.isSafeInteger(raw.project_id)||raw.project_id<=0||/^\d+$/.test(String(config.project))&&String(raw.project_id)!==String(config.project)||!['opened','closed','merged','locked'].includes(raw.state))throw Error('GitLab returned an invalid or out-of-scope merge request');
    if(raw.sha&&raw.diff_refs?.head_sha&&raw.sha!==raw.diff_refs.head_sha)throw Error('Merge request diff references are not ready for the current head');
    head=raw.diff_refs?.head_sha||raw.sha;base=raw.diff_refs?.base_sha;state=raw.state;merged=raw.state==='merged'?optionalSha(raw.merge_commit_sha||raw.squash_commit_sha):null;projectId=raw.project_id;
  }else throw Error('Unsupported tracked change provider');
  if(!sha(head))throw Error('A tracked change requires its exact current head');
  return {version:1,provider,number:n,headSha:head,baseSha:optionalSha(base),mergedSha:merged,state,providerUpdatedAt:timestamp(raw.updated_at),title:text(raw.title,1000),body:text(provider==='github'?raw.body:raw.description,32000),url:text(provider==='github'?raw.html_url:raw.web_url,4096),projectId};
}
export function providerChangeEvent(snapshot,service){
  const s=snapshot;let event;
  if(s.provider==='github')event=normalize('github',{repository:{full_name:service.github.repository},action:s.state==='closed'?'closed':'synchronize',pull_request:{number:Number(s.number),head:{sha:s.headSha},base:{sha:s.baseSha},merged:s.state==='merged',merge_commit_sha:s.mergedSha,updated_at:new Date(s.providerUpdatedAt).toISOString(),title:s.title,body:s.body,html_url:s.url}},service,{eventType:'pull_request',deliveryId:'change-read:'+hash(s)});
  else event=normalize('gitlab',{project:{id:service.gitlab.project},object_kind:'merge_request',object_attributes:{iid:Number(s.number),state:s.state,last_commit:{id:s.headSha},merge_commit_sha:s.mergedSha,updated_at:new Date(s.providerUpdatedAt).toISOString(),title:s.title,description:s.body,url:s.url}},service,{deliveryId:'change-read:'+hash(s)});
  event.payload={...event.payload,baseSha:s.baseSha,providerState:s.state,providerUpdatedAt:s.providerUpdatedAt,providerRead:1,...(s.projectId?{projectId:s.projectId}:{})};return event;
}
export function providerPipelineObservation(snapshot,raw){
  if(snapshot.provider!=='gitlab')return {state:'unknown',note:'This metadata read does not collect GitHub head checks. CI events and on-demand review checks remain separate.'};
  if(!raw)return {state:'unknown',note:'No head pipeline record was supplied. Pipeline access or current state is unknown.'};
  try{
    if(!Number.isSafeInteger(raw.id)||raw.id<=0||raw.project_id!==snapshot.projectId||!sha(raw.sha)||typeof raw.status!=='string'||!/^[a-z_]{1,64}$/.test(raw.status))throw Error('Invalid pipeline identity');
    const providerUpdatedAt=timestamp(raw.updated_at),pipeline={id:raw.id,project_id:raw.project_id,sha:raw.sha,status:raw.status,updated_at:new Date(providerUpdatedAt).toISOString(),web_url:text(raw.web_url,4096)};
    if(raw.sha!==snapshot.headSha&&raw.sha!==snapshot.mergedSha)return {state:'unknown',sha:raw.sha,pipelineId:raw.id,note:'The observed pipeline targets a different or synthetic commit. It does not establish CI for the current MR head.'};
    return {state:'observed',sha:raw.sha,status:raw.status,pipelineId:raw.id,providerUpdatedAt,pipeline,note:'One exact-SHA head pipeline observation; this does not establish all checks, deployment or recovery.'};
  }catch{return {state:'unknown',note:'The head pipeline lacks a valid scoped identity or provider timestamp. CI remains unknown.'};}
}
export function bindChangeReadCI(event,read,ci){
  if(!read||event.kind!=='problem'||event.payload?.providerRead!==1)throw Error('A change-read bundle requires its provider MR/PR observation');
  if(!ci){if(read.ci?.state==='observed')throw Error('An observed CI receipt requires its matching pipeline event');return read;}
  const child=ci.event,p=child.payload||{},pipeline=p.pipeline||{},summary=read.ci;
  if(event.source!=='gitlab'||child.source!==event.source||child.serviceKey!==event.serviceKey||child.kind!=='change'||child.incidentId!==undefined||child.conversationKey!==undefined||child.alertThread!==undefined||p.stage!=='ci-update'||p.number!==undefined||!summary||summary.state!=='observed'||!sha(p.sha)||![event.payload.sha,event.payload.mergedSha].includes(p.sha)||pipeline.sha!==p.sha||!Number.isSafeInteger(pipeline.id)||pipeline.id<=0||!Number.isSafeInteger(event.payload.projectId)||pipeline.project_id!==event.payload.projectId||typeof pipeline.status!=='string'||!/^[a-z_]{1,64}$/.test(pipeline.status)||Date.parse(pipeline.updated_at)!==child.at||summary.sha!==p.sha||summary.status!==pipeline.status||summary.pipelineId!==pipeline.id||summary.providerUpdatedAt!==child.at)throw Error('The CI event does not match the scoped MR read, pipeline identity and source time');
  return {...read,ci:{...summary,eventId:ci.id,projectId:pipeline.project_id}};
}
function decode(row){
  try{
    if(typeof row.value!=='string'||Buffer.byteLength(row.value)>10000)throw Error();
    const value=JSON.parse(row.value),{checksum,...body}=value;
    if(![1,2].includes(value.version)||!['github','gitlab'].includes(value.provider)||key(value.serviceKey,value.provider,value.number)!==row.id||!digest(value.scopeHash)||!epoch(value.readStartedAt)||!epoch(value.readCompletedAt)||value.readStartedAt>value.readCompletedAt||typeof value.complete!=='boolean'||value.restoreId!==null&&typeof value.restoreId!=='string'||value.snapshotEventId!==null&&!digest(value.snapshotEventId)||value.headSha!==null&&!sha(value.headSha)||value.providerUpdatedAt!==null&&!epoch(value.providerUpdatedAt)||!digest(checksum)||hash(body)!==checksum)throw Error();
    if(value.error!==null&&(typeof value.error!=='string'||!value.error||value.error.length>1000)||value.complete&&(!digest(value.snapshotEventId)||!sha(value.headSha)||!epoch(value.providerUpdatedAt)||!['pre-merge','merge'].includes(value.stage)||value.error!==null)||!value.complete&&!value.error)throw Error();
    const ci=value.ci;
    if(value.version===2&&ci){
      if(!['observed','unknown'].includes(ci.state)||ci.state==='observed'&&(!value.complete||!digest(ci.eventId)||!sha(ci.sha)||!Number.isSafeInteger(ci.pipelineId)||ci.pipelineId<=0||!Number.isSafeInteger(ci.projectId)||ci.projectId<=0||typeof ci.status!=='string'||!/^[a-z_]{1,64}$/.test(ci.status)||!epoch(ci.providerUpdatedAt))||ci.state==='unknown'&&(ci.status!==null||ci.eventId!==null))throw Error();
    }
    return value;
  }catch{throw new StorageError(new Error('Invalid tracked-change read receipt'));}
}
export async function changeReadReceipt(q,service,provider,n,dialect){
  const [row]=await q('SELECT id,value FROM sre_checkpoints WHERE id=?',[key(service.key,provider,n)]);if(!row)return null;
  const receipt=decode(row);if(receipt.scopeHash!==pollScopeHash(service,provider))return null;
  if(receipt.complete){
    const ids=[receipt.snapshotEventId,...(receipt.version===2&&receipt.ci?.state==='observed'?[receipt.ci.eventId]:[])];
    const facts=await q('SELECT id,body_hash,payload FROM sre_events WHERE id IN ('+ids.map(()=>'?').join(',')+') AND service_key=? AND source=?',[...ids,service.key,provider]),events=new Map();
    try{
      for(const fact of facts){const event=JSON.parse(fact.payload);if(hash(event)!==fact.body_hash||hash([event.source,event.serviceKey,event.id])!==fact.id)throw Error();events.set(fact.id,event);}
      const parent=events.get(receipt.snapshotEventId);
      if(!parent||parent.kind!=='problem'||parent.payload?.providerRead!==1||String(parent.payload.number)!==String(n)||parent.payload.sha!==receipt.headSha||parent.payload.stage!==receipt.stage||parent.at!==receipt.providerUpdatedAt)throw Error();
      if(receipt.version===2&&receipt.ci?.state==='observed'){
        const ci=events.get(receipt.ci.eventId);if(!ci)throw Error();
        const bound=bindChangeReadCI(parent,{ci:receipt.ci},{event:ci,id:receipt.ci.eventId});if(bound.ci.projectId!==receipt.ci.projectId)throw Error();
      }
    }catch{throw new StorageError(new Error('Tracked-change read receipt is missing or does not match its immutable MR/CI facts'));}
  }
  if(receipt.version===1&&receipt.ci?.state==='observed')return {...receipt,ci:{state:'unknown',status:null,eventId:null,note:'This earlier CI snapshot has no verified saved source record. Collect a fresh provider read before relying on it.',legacyUnverified:true}};
  return receipt.ci?.state==='observed'?{...receipt,ci:await reconcileReadCI(q,service,receipt,dialect)}:receipt;
}
export async function freshReadObservation(q,service,provider,n,observation,fence,dialect){
  const read=await changeReadReceipt(q,service,provider,n,dialect);
  if(!read?.complete||read.headSha!==observation.headSha||read.stage!==observation.stage||read.providerUpdatedAt!==observation.observedAt||fence&&(read.restoreId!==fence.restoreId||read.readStartedAt<fence.preparedAt||read.readCompletedAt<fence.preparedAt))return null;
  const [fact]=await q('SELECT payload FROM sre_events WHERE id=? AND service_key=? AND source=?',[read.snapshotEventId,service.key,provider]);
  if(!fact)throw new StorageError(new Error('Tracked-change read receipt is missing its immutable source fact'));
  const event=JSON.parse(fact.payload);
  if(event.payload?.providerRead!==1||String(event.payload.number)!==String(n)||event.payload.sha!==read.headSha||event.at!==read.providerUpdatedAt||event.payload.stage!==read.stage)throw new StorageError(new Error('Tracked-change read receipt does not match its source fact'));
  return {eventId:read.snapshotEventId,startedAt:read.readStartedAt,completedAt:read.readCompletedAt,providerUpdatedAt:read.providerUpdatedAt};
}
export async function beginChangeRead(store,q,event,read,now){
  if(!read)return null;
  const service=store.services.find(s=>s.key===event.serviceKey),provider=event.source,n=number(event.payload?.number);
  if(!service||!['github','gitlab'].includes(provider)||event.kind!=='problem'||event.issueKey!=='review:'+provider+':'+n||event.payload?.providerRead!==1||read.scopeHash!==pollScopeHash(service,provider)||!epoch(read.startedAt)||!epoch(read.completedAt)||read.startedAt>read.completedAt||read.completedAt>now||read.completedAt-read.startedAt>60000)throw Error('Invalid tracked-change read boundary');
  const fence=await store.restoreFence(q,{lock:true});if((fence?.restoreId||null)!==(read.restoreId||null))throw Error('The change read crossed a database restore generation; read it again');
  const id=key(service.key,provider,n);
  // Create then lock one receipt row before locking an incident. Empty rows are
  // transaction-local and never survive a failed source/receipt commit.
  const inserted=await q("INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,'{}',?) ON CONFLICT DO NOTHING RETURNING id",[id,now]);
  const [row]=await q('SELECT id,value FROM sre_checkpoints WHERE id=?'+(store.db.dialect==='postgres'?' FOR UPDATE':''),[id]);
  const prior=inserted.length?null:decode(row);
  if(pollScopeHash(service,provider)!==read.scopeHash)throw Error('The provider scope changed during the read transaction');
  const ci=read.ci?(read.ci.state==='observed'?{state:'observed',sha:read.ci.sha,status:read.ci.status,pipelineId:read.ci.pipelineId,projectId:read.ci.projectId,providerUpdatedAt:read.ci.providerUpdatedAt,eventId:read.ci.eventId,note:String(read.ci.note||'').slice(0,500)}:{state:'unknown',sha:read.ci.sha??null,status:null,pipelineId:read.ci.pipelineId??null,providerUpdatedAt:read.ci.providerUpdatedAt??null,eventId:null,note:String(read.ci.note||'CI is unknown').slice(0,500)}):null;
  return {id,serviceKey:service.key,provider,number:n,scopeHash:read.scopeHash,readStartedAt:read.startedAt,readCompletedAt:read.completedAt,restoreId:fence?.restoreId||null,ci,prior};
}
export async function latestChangeState(q,serviceKey,provider,n,dialect){
  const parameters=[serviceKey,provider,String(n)],where="c.service_key=? AND c.provider=? AND c.change_number=? AND c.stage IN ('pre-merge','merge')";
  const [latest]=await q('SELECT c.*,e.received_at,e.payload AS source_event FROM sre_change_events c JOIN sre_events e ON e.id=c.id WHERE '+where+' ORDER BY c.observed_at DESC,c.id DESC LIMIT 1',parameters);
  if(!latest)return {latest:null,identities:[],conflicting:false};
  const field=(column,name)=>dialect==='postgres'?"("+column+"::jsonb->>'"+name+"')":"json_extract("+column+",'$."+name+"')";
  // Deduplicate identities in SQL before bounding the result. A hundred replay
  // deliveries of head A must not hide an equally timed observation of head B.
  const identities=await q('SELECT DISTINCT c.head_sha,c.stage,'+field('e.payload','status')+' AS state,COALESCE('+field('c.payload','baseSha')+",'') AS base_sha,COALESCE("+field('c.payload','mergedSha')+",'') AS merged_sha FROM sre_change_events c JOIN sre_events e ON e.id=c.id WHERE "+where+' AND c.observed_at=? LIMIT 5',[...parameters,latest.observed_at]);
  const distinct=(field,known=false)=>new Set(identities.map(row=>row[field]).filter(value=>!known||value));
  const conflicting=identities.length>=5||['head_sha','stage','state'].some(field=>distinct(field).size>1)||['base_sha','merged_sha'].some(field=>distinct(field,true).size>1);
  return {latest,identities,conflicting};
}
export async function classifyChangeRead(q,event,dialect){
  const {latest,identities,conflicting}=await latestChangeState(q,event.serviceKey,event.source,event.payload.number,dialect);
  if(!latest)return null;const at=Number(latest.observed_at);
  if(at>event.at)return 'The provider read is older than an already accepted change update';
  if(at<event.at)return null;
  const different=row=>row.head_sha!==event.payload.sha||row.stage!==event.payload.stage||row.state!==event.status||row.merged_sha&&event.payload.mergedSha&&row.merged_sha!==event.payload.mergedSha||row.base_sha&&event.payload.baseSha&&row.base_sha!==event.payload.baseSha;
  if(conflicting||identities.some(different))return 'Conflicting change identities share the latest provider timestamp; reconcile before using this read';
  if(event.payload.baseSha&&!identities.some(row=>row.base_sha)||event.payload.mergedSha&&!identities.some(row=>row.merged_sha))return null;
  return 'unchanged';
}
export async function finishChangeRead(store,q,boundary,event,eventId,error=null){
  if(!boundary)return;
  const prior=boundary.prior;
  // A slow peer cannot replace a newer observation, including with a failure.
  if(prior?.scopeHash===boundary.scopeHash&&(
    event&&prior.providerUpdatedAt!==null&&event.at<prior.providerUpdatedAt||
    (!event||event.at===prior.providerUpdatedAt)&&prior.readStartedAt>boundary.readStartedAt||
    prior.readCompletedAt>boundary.readCompletedAt&&(!event||event.at<=prior.providerUpdatedAt)
  ))return;
  const {id,prior:_,...identity}=boundary;
  const ci=error&&boundary.ci?{state:'unknown',status:null,eventId:null,note:'The parent MR/PR read was not accepted; its reported CI cannot certify the current change.'}:boundary.ci;
  const body={version:2,...identity,complete:!error,error:error?redact(error).slice(0,1000):null,snapshotEventId:eventId,headSha:event?.payload?.sha||null,stage:event?.payload?.stage||null,providerUpdatedAt:event?.at??null,ci:ci||null};
  await q('UPDATE sre_checkpoints SET value=?,updated_at=? WHERE id=?',[JSON.stringify({...body,checksum:hash(body)}),boundary.readCompletedAt,id]);
}

export async function trackedChangeBatch(store,service,provider,{incidentId,limit=20}={}){
  if(!['github','gitlab'].includes(provider)||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid tracked-change batch');
  const args=[service.key,provider],extra=incidentId?' AND i.id=?':'';if(incidentId)args.push(incidentId);
  const rows=await store.db.query("SELECT DISTINCT l.change_number,COALESCE(c.updated_at,0) AS last_attempt FROM sre_incident_change_links l JOIN sre_incidents i ON i.id=l.incident_id LEFT JOIN sre_checkpoints c ON c.id=('change-read:'||i.service_key||':'||l.provider||':'||l.change_number) WHERE i.service_key=? AND l.provider=? AND i.status<>'resolved'"+extra+' ORDER BY last_attempt,l.change_number LIMIT '+(limit+1),args);
  return {items:rows.slice(0,limit).map(row=>({number:number(row.change_number)})),limited:rows.length>limit};
}

export async function readTrackedChanges(store,service,provider,client,signal,{maxAgeMs=180000,referenceTimeoutMs=10000}={}){
  if(!Number.isFinite(referenceTimeoutMs)||referenceTimeoutMs<10||referenceTimeoutMs>60000)throw Error('Tracked-change read deadline must be between ten milliseconds and one minute');
  const batch=await trackedChangeBatch(store,service,provider),failures=[];
  if(batch.items.length&&typeof client.change!=='function')throw Error('The configured repository connector cannot read tracked MR/PR metadata');
  for(const item of batch.items){
    if(signal?.aborted){failures.push('The provider batch deadline expired; remaining references were not attempted');break;}
    const startedAt=await store.coordinationNow(),restoreId=(await store.restoreFence())?.restoreId||null,scopeHash=pollScopeHash(service,provider);let event;
    try{
      const deadline=AbortSignal.timeout(referenceTimeoutMs),referenceSignal=AbortSignal.any(signal?[signal,deadline]:[deadline]);
      referenceSignal.throwIfAborted();const result=await client.change(item.number,{signal:referenceSignal});referenceSignal.throwIfAborted();
      if(result.snapshot?.provider!==provider||result.snapshot?.number!==item.number)throw Error('The provider change read crossed its requested identity');
      if(pollScopeHash(service,provider)!==scopeHash)throw Error('The provider scope changed while collecting this read');
      event=providerChangeEvent(result.snapshot,service);
      const completedAt=await store.coordinationNow();let ci=result.ci;
      if(ci?.state==='observed'&&(!epoch(ci.providerUpdatedAt)||ci.providerUpdatedAt>completedAt+300000))ci={state:'unknown',note:'The pipeline update time is invalid or too far ahead of the read clock. CI remains unknown.'};
      const read={scopeHash,startedAt,completedAt,restoreId,ci},ciEvent=ci?.state==='observed'&&provider==='gitlab'?normalize('gitlab',{project:{id:service.gitlab.project},object_kind:'pipeline',object_attributes:ci.pipeline},service,{deliveryId:'change-read-ci:'+hash([scopeHash,ci.pipeline])}):undefined;
      const accepted=await store.ingestChangeRead(event,read,ciEvent);if(accepted.readError)throw Error(accepted.readError);
      // A pipeline's own SHA/time stay distinct from the MR head and read time.
      // Missing pipeline visibility is unknown, never a passing CI assertion.
    }catch(error){
      if(error instanceof StorageError)throw error;
      failures.push(provider+' #'+item.number+': '+redact(String(error.message)).slice(0,400));
      if(!event)await store.db.transaction(async q=>{
        const completedAt=await store.coordinationNow(q),fake={source:provider,serviceKey:service.key,kind:'problem',issueKey:'review:'+provider+':'+item.number,payload:{number:Number(item.number),providerRead:1}},read={scopeHash,startedAt,completedAt,restoreId};
        if(completedAt-startedAt>60000)return;
        const boundary=await beginChangeRead(store,q,fake,read,completedAt);await finishChangeRead(store,q,boundary,null,null,String(error.message));
      });
    }
  }
  // Oldest-attempt scheduling is durable and lets other references progress
  // around one denied MR. A limited batch is explicitly incomplete coverage.
  if(failures.length)throw Error('Tracked change reading failed: '+failures.slice(0,3).join('; '));
  const field=name=>store.db.dialect==='postgres'?"(c.value::jsonb->>'"+name+"')":"json_extract(c.value,'$."+name+"')",complete=store.db.dialect==='postgres'?field('complete')+"='true'":field('complete')+'=1';
  const [unknown]=await store.db.query("SELECT COUNT(DISTINCT l.change_number) AS count FROM sre_incident_change_links l JOIN sre_incidents i ON i.id=l.incident_id LEFT JOIN sre_checkpoints c ON c.id=('change-read:'||i.service_key||':'||l.provider||':'||l.change_number) WHERE i.service_key=? AND l.provider=? AND i.status<>'resolved' AND (c.id IS NULL OR COALESCE("+field('scopeHash')+",'')<>? OR NOT COALESCE(("+complete+"),false) OR c.updated_at<?)",[service.key,provider,pollScopeHash(service,provider),(await store.coordinationNow())-maxAgeMs]);
  if(Number(unknown.count))throw Error('Tracked changes retain '+Number(unknown.count)+' missing, failed or stale reader observations; current coverage is incomplete.'+(batch.limited?' Remaining references are prioritized in the next 20-reference batch.':''));
  return {read:batch.items.length,batchLimited:batch.limited,complete:true};
}
