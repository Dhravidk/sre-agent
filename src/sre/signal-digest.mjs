import {hash} from './security.mjs';
import {latestProblemSnapshots,problemIdentity} from './runtime-problems.mjs';

export const signalLimits=Object.freeze({candidates:240,evidence:80,records:2000,groups:12,changes:8});
const logRow=row=>['log','logs'].includes(row.kind)&&['dynatrace','dynatrace-logs','logs'].includes(row.source)||row.source==='log-monitor'&&row.kind==='problem';
export const changeEvidence=row=>['github','gitlab'].includes(row.source)&&(['code_review','release_diff','linked_changes','deployments'].includes(row.kind)||row.kind==='change'&&['deployment','review'].includes(row.content?.comparisonKind));
const short=(value,n=160)=>Array.from(typeof value==='string'?value:'').slice(0,n).join('');
const scalar=value=>typeof value==='string'||typeof value==='number'?String(value):'';
const field=(row,keys)=>{for(const key of keys){const value=scalar(row?.[key]);if(value)return value;}return '';};
const stamp=value=>{const n=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;return Number.isSafeInteger(n)&&n>=0?n:null;};
const fullSha=value=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value||'');
const severity={FATAL:5,CRITICAL:5,ERROR:4,WARN:3,WARNING:3,INFO:2,DEBUG:1,TRACE:1};
const healthSuccess=group=>['INFO','DEBUG','TRACE'].includes(group.level)&&['/health','/healthz'].includes(group.operation)&&/^2\d{2}$/.test(group.statusCode)&&!group.code&&!group.errorType;
const records=row=>Array.isArray(row.content?.records)?row.content.records:[row.content];
const logSource=(row,index)=>{const source=row.source==='log-monitor'&&Array.isArray(row.content?.recordSources)?row.content.recordSources[index]:row.source;return source==='dynatrace-logs'?'dynatrace':source;};

function logIdentity(record,source) {
  const level=field(record,['loglevel','level','severity']).toUpperCase()||'UNKNOWN';
  const requestId=field(record,['request.id','requestId','request_id']),traceId=field(record,['trace.id','trace_id','traceId']);
  let message=field(record,['content','message','text']);
  // Only explicit correlation IDs are normalized. HTTP codes, amounts, line
  // numbers, releases and arbitrary numbers in the message stay significant.
  for(const [value,label] of [[requestId,'<request-id>'],[traceId,'<trace-id>']])if(value.length>=8)message=message.split(value).join(label);
  const identity={source,level,code:field(record,['error.code','errorCode','code']),errorType:field(record,['error.type','exception.type']),statusCode:field(record,['http.response.status_code','http.status_code','statusCode']),entity:field(record,['dt.entity.service','entityId','service.name','service']),environment:field(record,['deployment.environment','environment','env']),region:field(record,['cloud.region','region']),operation:field(record,['operation','http.route','endpoint']),version:field(record,['service.version','release','version','sha']),message};
  const unknown=identity.message||identity.code||identity.errorType||identity.statusCode?'':hash(record);
  return {identity,key:hash([identity,unknown]),rank:severity[level]??4};
}

export function selectSignalEvidence(rows,limit=signalLimits.evidence) {
  const buckets=new Map(),seen=new Set();let redundant=0;
  const problems=latestProblemSnapshots(rows.filter(row=>row.kind==='problem'&&!logRow(row))),retainedProblems=new Set(problems.selected);
  for(const row of rows) {
    if(row.kind==='problem'&&!logRow(row)&&problemIdentity(row)&&!retainedProblems.has(row)){redundant++;continue;}
    let signature;
    if(logRow(row)&&records(row).length<=200)signature=hash([row.source,row.kind,[...new Set(records(row).map(record=>logIdentity(record,row.source).key))].sort()]);
    if(signature&&seen.has(signature)){redundant++;continue;}
    if(signature)seen.add(signature);
    const key=row.source+':'+row.kind,bucket=buckets.get(key)||[];bucket.push(row);buckets.set(key,bucket);
  }
  // An older rare error precedes informational noise within its source.
  for(const bucket of buckets.values())if(logRow(bucket[0]))bucket.sort((a,b)=>Math.max(0,...records(b).slice(0,200).map(r=>logIdentity(r,b.source).rank))-Math.max(0,...records(a).slice(0,200).map(r=>logIdentity(r,a.source).rank))||b.observed_at-a.observed_at||b.id.localeCompare(a.id));
  const selected=[];
  while(selected.length<limit&&[...buckets.values()].some(bucket=>bucket.length))for(const bucket of buckets.values())if(bucket.length&&selected.length<limit)selected.push(bucket.shift());
  selected.sort((a,b)=>(a.kind==='problem'?0:1)-(b.kind==='problem'?0:1)||b.observed_at-a.observed_at||b.id.localeCompare(a.id));
  return {selected,redundant,problemSnapshotConflicts:problems.conflicts};
}

export function buildSignalDigest({evidence=[],deployments=[],incident={},evidenceWindow={}}) {
  const groups=new Map(),seen=new Set(),batches=evidence.filter(logRow).map(row=>({row,items:records(row),index:0}));
  const recordsAvailable=batches.reduce((n,batch)=>n+batch.items.length,0);let scanned=0,duplicates=0,missingTimestamps=0,invalidRecords=0;
  // Round-robin batches: one large result must not hide another source's rare
  // error. Counts describe observed signatures, never total failed requests.
  while(scanned<signalLimits.records&&batches.some(batch=>batch.index<batch.items.length))for(const batch of batches) {
    if(batch.index>=batch.items.length||scanned>=signalLimits.records)continue;
    const recordIndex=batch.index,record=batch.items[batch.index++],row=batch.row,source=logSource(row,recordIndex);scanned++;
    if(!record||typeof record!=='object'||Array.isArray(record)){invalidRecords++;continue;}
    const {identity,key,rank}=logIdentity(record,source),recordAt=stamp(record.timestamp??record.at);
    if(recordAt===null)missingTimestamps++;
    const unique=recordAt===null?null:hash([source,record]);
    const group=groups.get(key)||{key,...Object.fromEntries(Object.entries(identity).map(([k,v])=>[k,short(v,k==='message'?220:100)])),rank,observations:0,duplicateObservations:0,firstAt:null,lastAt:null,evidenceIds:[]};
    if(!group.evidenceIds.includes(row.id)&&group.evidenceIds.length<4)group.evidenceIds.push(row.id);
    if(unique&&seen.has(unique)){duplicates++;group.duplicateObservations++;}
    else {if(unique)seen.add(unique);group.observations++;if(recordAt!==null){group.firstAt=group.firstAt===null?recordAt:Math.min(group.firstAt,recordAt);group.lastAt=group.lastAt===null?recordAt:Math.max(group.lastAt,recordAt);}}
    groups.set(key,group);
  }
  const changes=evidence.filter(changeEvidence).filter(row=>['code_review','release_diff','change'].includes(row.kind)).sort((a,b)=>(a.content?.comparisonKind==='deployment'?0:1)-(b.content?.comparisonKind==='deployment'?0:1)||b.observed_at-a.observed_at||b.id.localeCompare(a.id));
  const history=changes.slice(0,signalLimits.changes).map(row=>{
    const content=row.content||{},comparison=content.comparison||{},mr=content.mergeRequest||comparison.review?.mergeRequest;
    const files=comparison.diffs||comparison.files||content.diffs||content.files;
    const paths=(Array.isArray(files)?files:[]).map(file=>file?.new_path||file?.filename||file?.old_path).filter(path=>typeof path==='string');
    if(!paths.length&&content.policySources?.changed!==false&&content.policySources?.complete===true&&typeof content.policySources.base==='string'&&typeof content.policySources.head==='string'&&typeof content.policySources.path==='string')paths.push(content.policySources.path);
    return {evidenceId:row.id,provider:row.source,at:row.observed_at,comparisonKind:content.comparisonKind||'unknown',baseSha:fullSha(content.baseSha)?content.baseSha:null,headSha:fullSha(content.headSha)?content.headSha:null,complete:content.complete===true&&fullSha(content.baseSha)&&fullSha(content.headSha),paths:paths.slice(0,8).map(path=>short(path,160)),omittedPaths:Math.max(0,paths.length-8),mergeRequest:mr?{number:mr.iid??mr.number,title:short(mr.title),state:short(mr.state,40)}:null,commits:(Array.isArray(comparison.commits)?comparison.commits:[]).filter(commit=>commit&&fullSha(commit.id||commit.sha)).slice(0,5).map(commit=>({sha:commit.id||commit.sha,title:short(commit.title||commit.commit?.message),at:stamp(commit.created_at||commit.committed_date)})),codeInspection:content.policySources?.complete===true?'Known module sources available; general code reasoning still requires investigation.':'Full immutable source inspection is unavailable or incomplete.'};
  });
  const releases=deployments.filter(row=>fullSha(row.sha)&&Number.isSafeInteger(row.at)).slice(0,8).map(row=>({provider:row.provider,sha:row.sha,at:row.at,status:row.status,environment:row.environment,atIncidentStart:row.at<=Number(incident.started_at)}));
  const sorted=[...groups.values()].sort((a,b)=>b.rank-a.rank||b.observations-a.observations||(b.lastAt||0)-(a.lastAt||0)||a.key.localeCompare(b.key));
  const partialResults=batches.filter(batch=>{const grail=batch.row.content?.metadata?.grail;return batch.row.content?.complete===false||grail?.sampled===true||Array.isArray(grail?.notifications)&&grail.notifications.some(note=>note?.severity!=='INFO');}).length;
  return {coverage:{evidenceCandidates:evidence.length,totalStoredEvidence:Number(evidenceWindow.totalAvailable??evidence.length),candidateWindowLimited:Boolean(evidenceWindow.candidatesLimited),recordsAvailable,recordsScanned:scanned,recordsNotScanned:recordsAvailable-scanned,duplicateObservations:duplicates,missingTimestamps,invalidRecords,partialResults,omittedGroups:Math.max(0,sorted.length-signalLimits.groups),omittedHealthSuccessGroups:sorted.slice(signalLimits.groups).filter(healthSuccess).length,omittedChanges:Math.max(0,changes.length-signalLimits.changes),deploymentsAvailable:deployments.length,omittedDeployments:Math.max(0,deployments.length-releases.length)},groups:sorted.slice(0,signalLimits.groups).map(({rank,...group})=>({...group,deploymentMatches:fullSha(group.version)?releases.filter(row=>row.sha===group.version).map(row=>({provider:row.provider,sha:row.sha,at:row.at,status:row.status,environment:row.environment,atIncidentStart:row.atIncidentStart})):[]})),changes:history,deployments:releases,interpretation:'Grouped observations are bounded samples, not total failures or rates. Repeated snapshots are collapsed only for display; raw evidence remains stored. Environment, region, operation, severity and release stay separate. An exact SHA match links identity, not causation. Team reports and recovery claims remain unverified.'};
}

export function signalDigestText(digest,{groupLimit=6,changeLimit=4}={}) {
  const c=digest.coverage,omitted=c.omittedGroups+Math.max(0,digest.groups.length-groupLimit),changesOmitted=c.omittedChanges+Math.max(0,digest.changes.length-changeLimit),lines=['Incident signals and code history','Observed log sample: '+c.recordsScanned+' records scanned; '+c.duplicateObservations+' overlapping observations; '+Math.min(digest.groups.length,groupLimit)+' displayed groups.'];
  if(c.candidateWindowLimited||c.recordsNotScanned||omitted||c.partialResults||c.missingTimestamps||c.invalidRecords||changesOmitted)lines.push('Coverage is limited: '+c.recordsNotScanned+' unscanned records, '+omitted+' omitted groups, '+c.partialResults+' partial/sampled results, '+c.missingTimestamps+' missing timestamps, '+c.invalidRecords+' invalid records, '+changesOmitted+' omitted comparisons. Absence does not establish health.');
  if(c.omittedHealthSuccessGroups)lines.push(c.omittedHealthSuccessGroups+' groups omitted by the digest limit contain low-severity 2xx /health or /healthz responses without an error class. These responses do not verify business recovery.');
  for(const group of digest.groups.slice(0,groupLimit))lines.push(group.level+' · '+(group.code||group.errorType||(group.statusCode?'HTTP '+group.statusCode:'unclassified'))+' · '+group.observations+' observed signatures · '+(group.entity||'entity unknown')+' / '+(group.environment||'environment unknown')+' / '+(group.region||'region unknown')+' / '+(group.operation||'operation unknown')+' / '+(group.version?short(group.version,40):'release unknown')+'\n'+short(group.message,180));
  if(!digest.groups.length)lines.push('No log groups in this bounded evidence sample; this is not a healthy-state check.');
  for(const change of digest.changes.slice(0,changeLimit))lines.push(change.provider+' '+change.comparisonKind+' · '+(change.baseSha?.slice(0,12)||'base unknown')+' → '+(change.headSha?.slice(0,12)||'head unknown')+' · '+(change.complete?'provider comparison marked complete':'comparison incomplete')+' · '+(change.paths.slice(0,4).join(', ')||'changed paths unavailable')+'\n'+change.codeInspection+(change.commits.length?'\nCommit history: '+change.commits.slice(0,2).map(commit=>commit.sha.slice(0,12)+' '+short(commit.title,100)).join('; '):''));
  if(!digest.changes.length)lines.push('No GitLab/GitHub source comparison in this evidence window. A recent deployment alone cannot establish the cause.');
  lines.push(digest.interpretation);return lines.join('\n');
}
