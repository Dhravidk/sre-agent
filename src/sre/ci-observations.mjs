import {hash} from './security.mjs';
import {pollScopeHash} from './poll-scope.mjs';
import {StorageError} from './database.mjs';

const epoch=n=>Number.isSafeInteger(n)&&n>=0;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const stamp=value=>{const n=typeof value==='string'?Date.parse(value):NaN;return epoch(n)?n:null;};
const sourceTime=p=>{
  for(const [field,kind] of [['updated_at','updated'],['finished_at','finished'],['created_at','created']]){
    const at=stamp(p[field]);if(at!==null)return {kind,at};
  }
  return {kind:'unknown',at:null};
};

// Projection metadata records the configured provider boundary at ingestion.
// The original inbox payload and its delivery hash remain unchanged.
export function ciObservationOrigin(event,id,service){
  const p=event.payload?.pipeline;
  if(event.source!=='gitlab'||event.kind!=='change'||event.payload?.stage!=='ci-update'||!p||!positive(p.id)||!service?.gitlab)return null;
  const projectId=positive(p.project_id)?p.project_id:Number(service.gitlab.project);
  if(!positive(projectId))return null;
  const body={version:1,scopeHash:pollScopeHash(service,'gitlab'),projectId,...sourceTime(p)};
  return {...body,checksum:hash([id,body])};
}

export const savedPipelineStatus=value=>typeof value==='string'&&/^[a-z_]{1,64}$/.test(value)?value:'unknown';

function fact(row,service,scopeHash,ci,{allowUnknownStatus=false}={}){
  try{
    const event=JSON.parse(row.source_event),projection=JSON.parse(row.projection),p=event.payload?.pipeline;
    if(hash(event)!==row.body_hash||hash([event.source,event.serviceKey,event.id])!==row.id||event.source!=='gitlab'||event.serviceKey!==service.key||event.kind!=='change'||event.payload?.stage!=='ci-update'||event.payload.sha!==ci.sha||p?.sha!==ci.sha||p.id!==ci.pipelineId||!allowUnknownStatus&&(typeof p.status!=='string'||!/^[a-z_]{1,64}$/.test(p.status)))throw Error();
    const {observationOrigin:origin,...original}=projection;
    if(hash(original)!==hash(event.payload))throw Error();
    let time,scoped=false;
    if(origin){
      const {checksum,...body}=origin,expected=sourceTime(p);
      if(checksum!==hash([row.id,body])||origin.version!==1||!/^[a-f0-9]{64}$/.test(origin.scopeHash)||!positive(origin.projectId)||origin.kind!==expected.kind||origin.at!==expected.at||p.project_id!==undefined&&p.project_id!==origin.projectId)throw Error();
      if(origin.scopeHash!==scopeHash||origin.projectId!==ci.projectId)return null;
      time=expected;scoped=true;
    }else{
      // Old reader events already bind their full pipeline to the scope hash.
      // Historical webhooks without that proof cannot acquire a new scope.
      if(p.project_id!==ci.projectId)return null;
      time=sourceTime(p);scoped=event.id==='change-read-ci:'+hash([scopeHash,p]);
      if(scoped&&time.kind==='updated'&&event.at!==time.at)throw Error();
    }
    const status=allowUnknownStatus?savedPipelineStatus(p.status):p.status;
    return {eventId:row.id,projectId:ci.projectId,pipelineId:p.id,sha:p.sha,status,providerUpdatedAt:time.at,timeKind:time.kind,receivedAt:Number(row.received_at),scoped,...(allowUnknownStatus?{statusKnown:status!=='unknown'}:{})};
  }catch{throw new StorageError(new Error('Invalid saved pipeline observation or scope projection'));}
}
export {fact as parseSavedPipelineFact};

export async function reconcileReadCI(q,service,receipt,dialect){
  const ci=receipt.ci;if(receipt.provider!=='gitlab'||ci?.state!=='observed')return ci;
  const field=(base,...path)=>dialect==='postgres'?base+'::jsonb'+path.map((part,i)=>(i===path.length-1?'->>':'->')+"'"+part+"'").join(''):"json_extract("+base+",'$."+path.join('.')+"')";
  const pipeline=field('c.payload','pipeline','id'),project=field('c.payload','pipeline','project_id'),scope=field('c.payload','observationOrigin','scopeHash'),at=field('c.payload','observationOrigin','at'),kind=field('c.payload','observationOrigin','kind'),status=field('c.payload','pipeline','status');
  // Deduplicate status/source-time identities before bounding the scan. Replay
  // deliveries must not crowd an equally timed contradictory status out.
  const select='SELECT c.id,c.payload AS projection,e.payload AS source_event,e.body_hash,e.received_at,COALESCE(CAST('+at+' AS BIGINT),c.observed_at) AS source_at,ROW_NUMBER() OVER(PARTITION BY '+scope+','+at+','+kind+','+status+',CASE WHEN '+scope+' IS NULL THEN c.observed_at ELSE 0 END ORDER BY e.received_at DESC,c.id DESC) AS identity_rank FROM sre_change_events c JOIN sre_events e ON e.id=c.id WHERE c.service_key=? AND c.provider=\'gitlab\' AND c.stage=\'ci-update\' AND c.head_sha=? AND CAST('+pipeline+' AS TEXT)=?',parameters=[service.key,ci.sha,String(ci.pipelineId)];
  const rows=await q('SELECT * FROM ('+select+' AND (('+scope+'=? AND '+kind+"='updated') OR ("+scope+' IS NULL AND CAST('+project+' AS TEXT)=? AND e.external_id LIKE \'change-read-ci:%\'))) candidates WHERE identity_rank=1 ORDER BY source_at DESC,received_at DESC,id DESC LIMIT 51',[...parameters,receipt.scopeHash,String(ci.projectId)]);
  // Unversioned hooks are checked separately, so a long versioned history
  // cannot hide a recently received report with no comparable update time.
  const reports=await q('SELECT * FROM ('+select+' AND '+status+'<>? AND (('+scope+'=? AND '+kind+"<>'updated' AND (e.received_at>=? OR CAST("+at+' AS BIGINT)>?)) OR ('+scope+' IS NULL AND CAST('+project+' AS TEXT)=? AND e.external_id NOT LIKE \'change-read-ci:%\' AND e.received_at>=?))) candidates WHERE identity_rank=1 ORDER BY received_at DESC,id DESC LIMIT 3',[...parameters,ci.status,receipt.scopeHash,receipt.readStartedAt,ci.providerUpdatedAt,String(ci.projectId),receipt.readStartedAt]);
  const observed={eventId:ci.eventId,projectId:ci.projectId,pipelineId:ci.pipelineId,sha:ci.sha,status:ci.status,providerUpdatedAt:ci.providerUpdatedAt,timeKind:'updated'},facts=rows.map(r=>fact(r,service,receipt.scopeHash,ci)).filter(Boolean);
  const unknown=(state,latest,note)=>({...ci,state:'unknown',status:null,eventId:null,consistency:{state,observed,latest:latest.slice(0,3)},note});
  const unversioned=reports.map(r=>fact(r,service,receipt.scopeHash,ci)).filter(Boolean);
  if(unversioned.length)return unknown('unversioned',unversioned,'A contradictory pipeline report has no comparable provider update version or verified historical scope. Collect a fresh provider read after that report; CI remains unknown.');
  const versioned=facts.filter(f=>f.scoped&&f.timeKind==='updated'),latestAt=Math.max(ci.providerUpdatedAt,...versioned.map(f=>f.providerUpdatedAt)),latest=[...new Map(versioned.filter(f=>f.providerUpdatedAt===latestAt).map(f=>[f.status,f])).values()].sort((a,b)=>a.status.localeCompare(b.status));
  if(rows.length>50&&latestAt<=Number(rows.at(-1).source_at))return unknown('limited',latest,'The saved pipeline history exceeds this reconciliation window at the latest source time. CI remains unknown; inspect its source history before relying on a status.');
  if(latestAt===ci.providerUpdatedAt&&!latest.some(f=>f.status===ci.status))latest.push(observed);
  if(latest.length>1)return unknown('conflict',latest,'Conflicting statuses share the latest provider update time for this exact pipeline and commit. Reconcile with a newer provider observation; CI remains unknown.');
  if(latestAt>ci.providerUpdatedAt)return unknown('stale',latest,'The MR read reports an older pipeline version than another saved observation. A fresh read does not make that older status current; CI remains unknown.');
  return ci;
}

export function ciConsistencyText(ci){
  if(!ci?.consistency)return '';
  const item=o=>o.status+' at '+(o.providerUpdatedAt===null?'unknown source time':new Date(o.providerUpdatedAt).toISOString())+' ('+o.timeKind+'); source event '+o.eventId;
  return ' Pipeline reconciliation '+ci.consistency.state+'. MR read: '+item(ci.consistency.observed)+'. Other saved observations: '+(ci.consistency.latest.map(item).join('; ')||'outside the bounded window')+'.';
}

export function ciReadState(read){
  const ci=read?.ci;
  return {state:ci?.state||'unknown',status:ci?.status||null,pipelineId:ci?.pipelineId||null,sha:ci?.sha||null,consistency:ci?.consistency?.state||null,otherStatuses:(ci?.consistency?.latest||[]).map(o=>o.status).sort()};
}
