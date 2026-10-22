import {hash} from './security.mjs';
import {pollScopeHash} from './poll-scope.mjs';
import {StorageError} from './database.mjs';
import {applyCiReservation} from './ci-history-window.mjs';
import {savedPipelineStatus} from './ci-observations.mjs';

const sha=v=>typeof v==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
const epoch=n=>Number.isSafeInteger(n)&&n>=0;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const stamp=v=>{const n=typeof v==='string'?Date.parse(v):NaN;return epoch(n)?n:null;};
const status=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(v)?v:'unknown';
export const changeTimelineLimits=Object.freeze({facts:500,referenceFacts:200,perReference:20,links:100,groups:100,sourcesPerGroup:25});

export function parseChangeTimelineFact(row){
  try{
    const event=JSON.parse(row.source_event),payload=JSON.parse(row.payload),{observationOrigin:origin,...original}=payload;
    if(hash(event)!==row.body_hash||hash([event.source,event.serviceKey,event.id])!==row.id||event.source!==row.provider||event.serviceKey!==row.service_key||event.at!==Number(row.observed_at)||event.payload?.sha!==row.head_sha||(event.payload.stage||event.kind)!==row.stage||String(event.payload.number??'')!==String(row.change_number??'')||hash(original)!==hash(event.payload))throw Error();
    if(origin){const {checksum,...body}=origin;if(origin.version!==1||checksum!==hash([row.id,body])||!/^[a-f0-9]{64}$/.test(origin.scopeHash)||!positive(origin.projectId))throw Error();}
    return {id:row.id,provider:row.provider,service_key:row.service_key,change_number:row.change_number,head_sha:row.head_sha,stage:row.stage,observed_at:Number(row.observed_at),received_at:Number(row.received_at),payload,sourceStatus:event.status||null,sourceExternalId:event.id};
  }catch{throw new StorageError(new Error('Invalid change timeline source fact or projection'));}
}
function describe(row,service){
  const p=row.payload,origin=p.observationOrigin,ci=row.stage==='ci-update';let scopeHash=origin?.scopeHash||null,projectId=origin?.projectId??(positive(p.pipeline?.project_id)?p.pipeline.project_id:null),run={known:false,id:null,label:'CI reports with unknown run identity'},time={kind:'source-event',at:row.observed_at},state=p.providerState||(row.stage==='merge'?'merged':row.sourceStatus?('review '+row.sourceStatus.toLowerCase()):'unknown');
  if(ci){
    state=row.provider==='gitlab'&&p.pipeline?savedPipelineStatus(p.pipeline.status):status(p.ci?.conclusion||p.ci?.status);time={kind:'unknown',at:null};
    const native=p.pipeline||p.ci||{};
    for(const [field,kind] of [['updated_at','updated'],['finished_at','finished'],['completed_at','finished'],['created_at','created'],['started_at','started']]){const at=stamp(native[field]);if(at!==null){time={kind,at};break;}}
    if(row.provider==='gitlab'&&p.pipeline){
      if(!scopeHash&&row.sourceExternalId==='change-read-ci:'+hash([pollScopeHash(service,'gitlab'),p.pipeline]))scopeHash=pollScopeHash(service,'gitlab');
      if(positive(p.pipeline.id)&&positive(projectId))run={known:true,id:String(p.pipeline.id),label:'Pipeline '+p.pipeline.id};
    }else if(row.provider==='github'&&positive(p.ci?.id)&&typeof p.ci?.url==='string'){
      try{const url=new URL(p.ci.url);if(url.protocol==='https:'&&!url.username&&!url.password)run={known:true,id:String(p.ci.id),resourceKey:hash([url.origin,url.pathname]),label:'CI resource '+p.ci.id};}catch{}
    }
  }else if(row.stage==='deployment')state=status(p.providerStatus||p.status);
  return {status:state,time,run,projectId,scopeHash,scopeMatches:!scopeHash||scopeHash===pollScopeHash(service,row.provider)};
}
function relevance(row,{links,withdrawals,heads,delivered,context}){
  const withdrawn=withdrawals.find(c=>c.provider===row.provider&&c.number===row.change_number);
  if(!row.display.scopeMatches)return {kind:'different-scope',label:'Different provider scope; retained history only',references:[]};
  if(withdrawn)return {kind:'withdrawn-change',label:'Relationship withdrawn; retained provider history',references:[{provider:withdrawn.provider,number:withdrawn.number,evidenceId:withdrawn.evidenceId,state:'withdrawn'}]};
  const direct=links.find(l=>l.provider===row.provider&&l.change_number===row.change_number);
  if(direct){const own=context.incident.issue_key==='review:'+direct.provider+':'+direct.change_number;return {kind:own?'provider-review':direct.historicalAfterRestore?'historical-change':'associated-change',label:own?'This change’s provider review':direct.historicalAfterRestore?'Historical relationship; fresh reaffirmation needed':'Linked change context; not a causal finding',references:[{provider:direct.provider,number:direct.change_number,evidenceId:direct.evidence_id,state:direct.historicalAfterRestore?'historical':'linked'}]};}
  if(!row.change_number){
    const matches=links.filter(l=>l.provider===row.provider&&heads.get(l.provider+':'+l.change_number)?.all.has(row.head_sha));
    if(matches.length){const refs=matches.map(l=>{const h=heads.get(l.provider+':'+l.change_number);return {provider:l.provider,number:l.change_number,evidenceId:l.evidence_id,state:l.historicalAfterRestore?'historical':'linked',headRole:h.current.size===1&&h.current.has(row.head_sha)?'latest recorded head':h.merged.has(row.head_sha)?'recorded merge commit':'earlier or unverified head'};});return {kind:'linked-commit',label:'Commit matches linked changes; run ownership and cause remain unverified',references:refs};}
  }
  if(delivered.has(row.id))return {kind:'retained-evidence',label:'Retained incident evidence; no active change link for this fact',references:[]};
  return {kind:'shared-commit',label:'Shared commit history; no active incident link',references:[]};
}
const referenceOrder=(a,b)=>(b.sourceAt??-1)-(a.sourceAt??-1)||b.receivedAt-a.receivedAt||b.eventId.localeCompare(a.eventId);
function groupFacts(items,incidentId){
  const grouped=new Map();
  for(const row of items){
    const d=row.display,ci=row.stage==='ci-update',relation=hash(row.relevance),identity=ci?[row.provider,row.stage,d.scopeHash,d.projectId,d.run.known?[d.run.id,d.run.resourceKey||null]:'unidentified-runs',row.head_sha,relation]:[row.provider,row.stage,row.change_number,row.head_sha,row.payload.baseSha||null,row.payload.mergedSha||null,d.status,d.time,relation];
    const key=hash([incidentId,identity]);let group=grouped.get(key);
    if(!group){group={id:key,provider:row.provider,stage:row.stage,changeNumber:row.change_number,headSha:row.head_sha,run:ci?d.run:null,projectId:d.projectId,scopeHash:d.scopeHash,relevance:row.relevance,facts:[]};grouped.set(key,group);}
    group.facts.push(row);
  }
  const groups=[];
  for(const group of grouped.values()){
    const sources=group.facts.map(r=>({eventId:r.id,status:r.display.status,sourceAt:r.display.time.at,timeKind:r.display.time.kind,receivedAt:r.received_at,recordedBeforeRestore:r.recordedBeforeRestore})).sort(referenceOrder),ci=group.stage==='ci-update',versioned=sources.filter(s=>s.timeKind==='updated'),lastAt=versioned[0]?.sourceAt??null,latestSources=versioned.filter(s=>s.sourceAt===lastAt),statuses=[...new Set(latestSources.map(s=>s.status))].sort();
    const observations=new Map(sources.map(s=>[hash([s.status,s.sourceAt,s.timeKind]),s]));
    const unknownStatus=group.provider==='gitlab'&&statuses.length===1&&statuses[0]==='unknown';
    const latest=!ci?{state:'recorded',status:sources[0].status,statuses:[sources[0].status],at:sources[0].sourceAt,timeKind:sources[0].timeKind}:!group.run.known?{state:'identity-unknown',status:null,statuses:[...new Set(sources.map(s=>s.status))].sort(),at:null,timeKind:null}:!versioned.length?{state:'unversioned',status:null,statuses:[...new Set(sources.map(s=>s.status))].sort(),at:null,timeKind:null}:{state:unknownStatus?'status-unknown':statuses.length===1?'observed-version':'conflicting',status:statuses.length===1&&!unknownStatus?statuses[0]:null,statuses,at:lastAt,timeKind:'updated'};
    // Reserve representatives of distinct status/time observations before
    // filling the source-reference window with repeated deliveries.
    const representatives=[...observations.values()].sort(referenceOrder),seen=new Set(representatives.map(s=>s.eventId)),references=[...representatives,...sources.filter(s=>!seen.has(s.eventId))].slice(0,changeTimelineLimits.sourcesPerGroup);
    const {facts,...header}=group;groups.push({...header,factCount:facts.length,observationCount:observations.size,latest,unversionedCount:ci?sources.filter(s=>s.timeKind!=='updated').length:0,sources:references,sourcesLimited:sources.length>references.length,lastReceivedAt:Math.max(...sources.map(s=>s.receivedAt)),recordedBeforeRestore:sources.some(s=>s.recordedBeforeRestore),note:ci?'Bounded source history, not current CI or recovery proof. Separate runs, provider scopes and commits stay separate.':'A provider observation does not establish cause, deployment health or recovery.'});
  }
  const rank={'provider-review':0,'associated-change':1,'historical-change':2,'linked-commit':3,'withdrawn-change':4,'retained-evidence':5,'shared-commit':6,'different-scope':7};
  return groups.sort((a,b)=>rank[a.relevance.kind]-rank[b.relevance.kind]||(b.latest.at??b.lastReceivedAt)-(a.latest.at??a.lastReceivedAt)||a.id.localeCompare(b.id));
}

export function projectChangeTimeline({rows,links,withdrawals,context,service,delivered,ciWindow}){
  const facts=rows.map(parseChangeTimelineFact),known=new Set(context.deployments.map(d=>d.sha).filter(sha)),heads=new Map();
  for(const e of context.evidence)for(const s of [e.content?.headSha,e.content?.baseSha,e.content?.sha,e.content?.mergedSha])if(sha(s))known.add(s);
  for(const link of links){
    const native=facts.filter(r=>r.provider===link.provider&&r.change_number===link.change_number),mru=native.filter(r=>['pre-merge','merge'].includes(r.stage)),latest=Math.max(-1,...mru.map(r=>r.observed_at)),head={all:new Set(),current:new Set(),merged:new Set()};
    for(const s of [link.evidenceHead,link.read?.headSha])if(sha(s))head.all.add(s);
    for(const row of native){head.all.add(row.head_sha);if(sha(row.payload.mergedSha)){head.all.add(row.payload.mergedSha);head.merged.add(row.payload.mergedSha);}if(row.observed_at===latest)head.current.add(row.head_sha);}
    for(const s of head.all)known.add(s);heads.set(link.provider+':'+link.change_number,head);
  }
  const selected=facts.filter(r=>known.has(r.head_sha)||delivered.has(r.id)||links.some(l=>l.provider===r.provider&&l.change_number===r.change_number));
  const items=selected.map(row=>{row.display=describe(row,service);row.relevance=relevance(row,{links,withdrawals,heads,delivered,context});row.recordedBeforeRestore=Boolean(context.recoveryFence&&row.received_at<context.recoveryFence.preparedAt);if(row.relevance.kind==='withdrawn-change')row.associationState='withdrawn';return row;});
  const groups=groupFacts(items,context.incident.id),limited=groups.length>changeTimelineLimits.groups;
  if(ciWindow?.runs.length){
    for(const group of groups)applyCiReservation(group,ciWindow);
    const priority=group=>group.ciReserved?(group.ciSelectionRank<4?group.ciSelectionRank:6):group.provider==='gitlab'&&group.stage==='ci-update'&&group.relevance.kind==='linked-commit'&&(!group.scopeHash||group.latest.state!=='observed-version')?3:['provider-review','associated-change'].includes(group.relevance.kind)?4:7;
    groups.sort((a,b)=>priority(a)-priority(b)||(b.ciSelectionAt||0)-(a.ciSelectionAt||0));
  }
  return {items,groups:groups.slice(0,changeTimelineLimits.groups),groupsLimited:limited,totalGroupsInWindow:groups.length};
}

export function changeGroupText(g){
  const name=g.run?g.run.label:g.changeNumber?'change #'+g.changeNumber:g.stage;
  const latest=g.latest.state==='status-unknown'?'provider status unknown':g.latest.state==='conflicting'?'conflicting update versions: '+g.latest.statuses.join(' / '):g.latest.state==='observed-version'?'latest update version: '+g.latest.status:g.latest.state==='recorded'?'recorded status: '+g.latest.status:g.latest.state==='identity-unknown'?'run identity unknown; reports may cover multiple runs':'no comparable update version; reported '+g.latest.statuses.join(' / ');
  return g.provider+' '+name+' · '+g.stage+' · '+g.headSha+' · '+latest+(g.latest.at!==null?' at '+new Date(g.latest.at).toISOString():'')+' · '+g.factCount+(g.factCount===1?' source fact; ':' source facts; ')+g.observationCount+(g.observationCount===1?' status/time observation. ':' status/time observations. ')+g.relevance.label+(g.relevance.references.length?' ('+g.relevance.references.map(r=>r.provider+' #'+r.number+(r.headRole?': '+r.headRole:'')).join('; ')+')':'')+'. '+g.note+(g.unversionedCount?' '+g.unversionedCount+(g.unversionedCount===1?' report has no comparable update version.':' reports have no comparable update version.'):'');
}

export function changeTimelineText(view,{limit=8}={}){
  return (view.groups||[]).slice(0,limit).map(g=>changeGroupText(g)+'\nSource references: '+g.sources.slice(0,2).map(s=>s.eventId).join(', ')+(g.sourcesLimited?' (further references retained)':'')).join('\n\n')+((view.groups||[]).length>limit||view.groupsLimited?'\nFurther change groups are omitted from this message.':'');
}
