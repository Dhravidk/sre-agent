import {hash,redact} from './security.mjs';
import {discoverySha,discoveryScope} from './source-discovery-config.mjs';
import {sourceTextPath,readImmutableSource,sourceInspectionLimits,retainedRequestedSource} from './source-evidence.mjs';

export const sourceHistoryLimits=Object.freeze({files:4,parents:2,excerptLines:8,excerptBytes:800});
const lines=file=>file.content.split(/\r?\n/);
const validFile=file=>file?.state==='available'&&discoverySha(file.sha)&&sourceTextPath(file.path)&&typeof file.content==='string'&&Buffer.byteLength(file.content,'utf8')<=sourceInspectionLimits.bytesPerFile&&hash(file.content)===file.contentHash&&/^[a-f0-9]{64}$/.test(file.sourceContentHash||'')&&(file.redacted===true||file.sourceContentHash===file.contentHash)&&lines(file).length===file.lineCount;
const validCommit=commit=>commit&&discoverySha(commit.sha)&&commit.parentsComplete===true&&Number.isSafeInteger(commit.parentCount)&&commit.parentCount>=0&&Array.isArray(commit.parents)&&commit.parentCount===commit.parents.length&&commit.parentCount<=4&&commit.parents.every(parent=>discoverySha(parent)&&parent!==commit.sha)&&new Set(commit.parents).size===commit.parents.length;
const scopedService=(service,project)=>({...service,gitlab:{...service.gitlab,project,sourceInspection:{enabled:true}}});

// This identifies the changed visible span, not a generated patch or a count
// of hunks. Excerpts are whole numbered lines from retained source bytes.
export function sourceDelta(base,head){
 const a=lines(base),b=lines(head);let prefix=0,suffix=0;
 while(prefix<Math.min(a.length,b.length)&&a[prefix]===b[prefix])prefix++;
 while(suffix<Math.min(a.length,b.length)-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 const range=(size,end)=>({startLine:Math.max(1,Math.min(size,prefix+1)-2),endLine:Math.min(size,Math.max(prefix+1,Math.min(end,prefix+5)))});
 return{state:base.sourceContentHash===head.sourceContentHash?'unchanged':base.content===head.content?'redacted-difference':prefix===a.length&&prefix===b.length?'line-endings-only':'changed',base:range(a.length,a.length-suffix),head:range(b.length,b.length-suffix),baseChangedLines:Math.max(0,a.length-prefix-suffix),headChangedLines:Math.max(0,b.length-prefix-suffix),interpretation:'A bounded changed span of retained source text, not a patch, runtime mapping or causal conclusion. Separated changes inside the span may be omitted from excerpts.'};
}
function comparisonFor(value,project,parent,head,path){
 if(value?.project!==project||value.baseSha!==parent||value.headSha!==head||value.timedOut!==false||!Array.isArray(value.files)||value.files.length>100)throw Error('History comparison scope or coverage is unverified');
 const matches=value.files.filter(file=>file?.newPath===path);if(matches.length>1)throw Error('History comparison has conflicting paths');const selected=matches[0];
 if(selected&&(!sourceTextPath(selected.oldPath)||!sourceTextPath(selected.newPath)||['newFile','deletedFile','renamedFile','diffAvailable'].some(key=>typeof selected[key]!=='boolean')||selected.deletedFile||selected.newFile&&selected.renamedFile||!selected.diffAvailable))throw Error('History comparison path or diff coverage is unverified');
 return{project,baseSha:parent,headSha:head,timedOut:false,matchingPaths:matches.length,inventoryEntries:value.files.length,...(selected?{file:selected}:{})};
}
export async function collectCandidateHistory(file,{service,project,client,budget,read,revision,signal,reserveReads=0,reserveBytes=0}={}){
 if(signal?.aborted)throw signal.reason||Error('History collection cancelled');
 budget.history??={remaining:sourceHistoryLimits.files,cache:new Map()};const cache=budget.history,key=JSON.stringify([service.key,service.tenant,service.environment,service.gitlab.base,project,file.sha,file.path,file.sourceContentHash,file.lastCommitId]);
 if(cache.cache.has(key))return cache.cache.get(key);
 const pending=(async()=>{
  const result={version:1,project,path:file.path,candidateSha:file.sha,reportedLastCommit:file.lastCommitId||null,state:'unavailable',parents:[],parentsOmitted:0,interpretation:'History is conditional on this candidate repository. Last-modifying metadata, ancestry and source versions do not establish deployment, incident cause, approval or a safe fix.'};
  const scope=discoveryScope(service);if(!scope?.history||!scope.projects.includes(project))return{...result,error:'Candidate history is outside the approved read boundary'};
  if(!validFile(file)||!discoverySha(file.lastCommitId))return{...result,error:'A complete candidate file and immutable last-modifying metadata are required'};
  if(!cache.remaining)return{...result,error:'Candidate history selection budget exhausted'};cache.remaining--;
  try{
   if(!validFile(file)||!discoverySha(file.lastCommitId))throw Error('A complete candidate file and immutable last-modifying metadata are required');
   const last=file.lastCommitId,commit=last===revision.sha&&validCommit(revision)?{...revision,kind:'sha',reportedRef:last}:(await read('revision',project,last,()=>client.discoveryRevision(project,last,{signal}))).value;
   if(commit?.project!==project||commit.sha!==last||commit.kind!=='sha'||commit.reportedRef!==last||!validCommit(commit))throw Error('Last-modifying commit identity or parent list is unverified');result.commit=commit;
   result.ancestry=last===file.sha?{project,ancestor:last,revision:file.sha,mergeBase:last,sameRevision:true}:(await read('ancestry',project,JSON.stringify([last,file.sha]),()=>client.discoveryAncestry(project,last,file.sha,{signal}))).value;
   if(result.ancestry?.project!==project||result.ancestry.ancestor!==last||result.ancestry.revision!==file.sha||result.ancestry.mergeBase!==last)throw Error('The last-modifying candidate commit is not a verified ancestor of the reported candidate revision');
   const clientFile={file:(path,sha,options)=>client.discoveryFile(project,path,sha,options)},options={service:scopedService(service,project),client:clientFile,budget,signal,reserveReads,reserveBytes};result.head=last===file.sha?{...file}:{...await readImmutableSource(file.path,last,options)};
   if(!validFile(result.head)||result.head.path!==file.path||result.head.sha!==last||result.head.sourceContentHash!==file.sourceContentHash)throw Error('Candidate bytes differ from the last-modifying file version');
   if(!commit.parentCount){result.state='root-commit';return result;}
   result.parentsOmitted=Math.max(0,commit.parentCount-sourceHistoryLimits.parents);
   for(const parent of commit.parents.slice(0,sourceHistoryLimits.parents)){
    const row={parentSha:parent,state:'unavailable'};result.parents.push(row);
    try{
     const observed=await read('history-comparison',project,JSON.stringify([parent,last]),()=>client.discoveryComparison(project,parent,last,{signal}));row.comparison=comparisonFor(observed.value,project,parent,last,file.path);row.observedAt=observed.observedAt;
     if(row.comparison.file?.newFile){row.state='added-file';row.source={state:'absent-in-comparison',path:row.comparison.file.oldPath,sha:parent};continue;}
     const path=row.comparison.file?.oldPath||file.path;row.source={...await readImmutableSource(path,parent,options)};
     if(!validFile(row.source))throw Error(row.source.error||'Parent source is unavailable');
     row.delta=sourceDelta(row.source,result.head);
     if(!row.comparison.file&&row.delta.state!=='unchanged')throw Error('Changed parent bytes lack the candidate path comparison');
     row.state='available';row.source.ranges=[row.delta.base];
    }catch(error){if(signal?.aborted)throw signal.reason;row.error=redact(String(error.message)).slice(0,240);}
   }
   result.head.ranges=result.parents.filter(parent=>parent.state==='available').map(parent=>parent.delta.head).slice(0,2);if(!result.head.ranges.length)result.head.ranges=[{startLine:1,endLine:8}];
   result.state=result.parents.every(parent=>['available','added-file'].includes(parent.state))&&!result.parentsOmitted?'observed':'partial';
  }catch(error){if(signal?.aborted)throw signal.reason;result.error=redact(String(error.message)).slice(0,240);}
  return result;
 })();cache.cache.set(key,pending);return pending;
}

export function verifiedHistory(file,project,scope,context){
 const h=file?.history;if(!scope?.history||h?.version!==1||h.project!==project||h.path!==file.path||h.candidateSha!==file.sha||h.reportedLastCommit!==file.lastCommitId||!validFile(file)||!validCommit(h.commit)||h.commit.project!==project||h.commit.kind!=='sha'||h.commit.reportedRef!==h.commit.sha||h.commit.sha!==h.reportedLastCommit||!scope.projects.includes(project)||h.ancestry?.project!==project||h.ancestry.ancestor!==h.commit.sha||h.ancestry.revision!==file.sha||h.ancestry.mergeBase!==h.commit.sha||!validFile(h.head)||h.head.sha!==h.commit.sha||h.head.path!==file.path||h.head.sourceContentHash!==file.sourceContentHash||!Array.isArray(h.parents)||h.parents.length>sourceHistoryLimits.parents)return null;
 const parents=[],seen=new Set();for(const parent of h.parents){
  if(!parent||seen.has(parent.parentSha)||!h.commit.parents.includes(parent.parentSha))continue;seen.add(parent.parentSha);const c=parent.comparison;
  if(!c||c.project!==project||c.baseSha!==parent.parentSha||c.headSha!==h.commit.sha||c.timedOut!==false||![0,1].includes(c.matchingPaths)||Boolean(c.file)!==(c.matchingPaths===1)||c.matchingPaths===1&&(!c.file||c.file.newPath!==file.path||!sourceTextPath(c.file.oldPath)||c.file.diffAvailable!==true||c.file.deletedFile!==false||typeof c.file.newFile!=='boolean'||typeof c.file.renamedFile!=='boolean'||c.file.newFile&&c.file.renamedFile))continue;
  if(parent.state==='added-file'&&c.file?.newFile===true){parents.push(parent);continue;}
  if(parent.state!=='available'||c.file?.newFile===true||!validFile(parent.source)||parent.source.sha!==parent.parentSha||parent.source.path!==(c.file?.oldPath||file.path))continue;
  const delta=sourceDelta(parent.source,h.head);if(JSON.stringify(delta)!==JSON.stringify(parent.delta)||!c.file&&delta.state!=='unchanged')continue;parents.push(parent);
 }
 const result={...h,state:!h.commit.parentCount?'root-commit':parents.length===h.commit.parentCount?'observed':'partial',parents,parentsOmitted:Math.max(0,h.commit.parentCount-parents.length)};return context&&(conflictingHistory(result,project,context)||historyIdentityState(result,project,context)==='unverified')?null:result;
}
function excerpt(file,range){
 const all=lines(file),selected=[];let used=0;for(let n=range.startLine;n<=Math.min(range.endLine,all.length)&&selected.length<sourceHistoryLimits.excerptLines;n++){const text=all[n-1],size=Buffer.byteLength(text,'utf8');if(size>sourceHistoryLimits.excerptBytes-used)break;selected.push({line:n,text});used+=size;}
 return{sha:file.sha,path:file.path,contentHash:file.contentHash,lines:selected,range,omittedLines:Math.max(0,range.endLine-range.startLine+1-selected.length)};
}
function historyIdentityState(history,project,context){
 if(!context?.sourceIdentityHistory)return undefined;
 const states=[history.head,...history.parents.filter(parent=>parent.state==='available').map(parent=>parent.source)].map(file=>{const identity=context.sourceIdentityHistory.identities?.find(identity=>identity.project===project&&identity.sha===file.sha&&identity.path===file.path);return identity?.state==='conflicting'?'conflicting':identity?.state==='consistent'&&identity.sourceContentHashes?.includes(file.sourceContentHash)?'consistent':'unverified';});
 return states.includes('conflicting')?'conflicting':states.includes('unverified')?'unverified':'consistent';
}
function conflictingHistory(history,project,context){
 if(!context)return false;const targets=[history.head,...history.parents.filter(parent=>parent.state==='available').map(parent=>parent.source)];
 if(historyIdentityState(history,project,context)==='conflicting')return true;
 for(const row of context.evidence||[]){
  if(row.source!=='gitlab'||context.incident?.id&&hash([context.incident.id,row.source,row.kind,row.content])!==row.id)continue;
  const files=[];
  if(row.kind==='source_discovery'&&row.content?.sourceDiscovery?.scopeKey===context.sourceScope?.discovery?.scopeKey)for(const probe of (Array.isArray(row.content.sourceDiscovery.probes)?row.content.sourceDiscovery.probes:[]).slice(0,8))if(probe?.project===project)files.push(...(Array.isArray(probe.files)?probe.files:[]).slice(0,2));
  const requested=retainedRequestedSource(row,context);if(requested?.source.project===project)files.push(requested.source.file);
  const inspection=row.content?.sourceInspection;if(['code_review','release_diff','change'].includes(row.kind)&&inspection?.project===project&&context.sourceScope?.project===project)for(const pair of (Array.isArray(inspection.files)?inspection.files:[]).slice(0,4))files.push(pair?.head,pair?.base);
  for(const file of files){const observed=[file,file?.history?.head,...(Array.isArray(file?.history?.parents)?file.history.parents:[]).slice(0,2).map(parent=>parent?.source)];
   if(observed.some(value=>validFile(value)&&value.sha===history.candidateSha&&value.path===history.path&&discoverySha(value.lastCommitId)&&value.lastCommitId!==history.reportedLastCommit))return true;
   if(observed.some(value=>validFile(value)&&targets.some(target=>value.sha===target.sha&&value.path===target.path&&value.sourceContentHash!==target.sourceContentHash)))return true;
  }
 }return false;
}
export function historySummary(file,project,scope,context){
 if(!scope?.history)return null;const valid=verifiedHistory(file,project,scope);
 if(!valid)return{state:'unavailable',path:file.path,...(typeof file.history?.error==='string'?{error:file.history.error.slice(0,240)}:{error:'No verified retained candidate history is available'})};
 if(conflictingHistory(valid,project,context))return{state:'conflicting',path:file.path,lastCommitSha:valid.commit.sha,parents:[],error:'Retained source responses disagree at an immutable file identity; history quotations are withheld.'};
 if(historyIdentityState(valid,project,context)==='unverified')return{state:'unavailable',path:file.path,lastCommitSha:valid.commit.sha,parents:[],error:'Retained source identity history is unverified; historical quotations are withheld pending a source review.'};
 return{state:valid.state,path:file.path,lastCommitSha:valid.commit.sha,title:typeof valid.commit.title==='string'?valid.commit.title.slice(0,240):'',candidateSha:file.sha,parentsOmitted:valid.parentsOmitted,parents:valid.parents.map(parent=>({parentSha:parent.parentSha,state:parent.state,...(parent.delta?{delta:parent.delta.state,before:excerpt(parent.source,parent.delta.base),after:excerpt(valid.head,parent.delta.head)}:{})})),note:'Conditional repository history; source versions and commit ancestry do not establish runtime mapping or cause.'};
}
export function historySummaryText(summary,{limit=2}={}){
 if(!summary)return'';const all=summary.retainedHistories?.length?summary.retainedHistories:summary.probes.flatMap(probe=>probe.files.filter(file=>file.history).map(file=>({project:probe.project,...file.history}))),selected=all.slice(0,limit);if(!selected.length)return'';
 const quote=(label,side)=>side?(side.lines||[]).slice(0,2).map(line=>label+' '+side.sha.slice(0,12)+':L'+line.line+' '+(Buffer.byteLength(line.text,'utf8')<=140?line.text:'[whole line omitted from brief; inspect source]')):[];
 return['Candidate file history · mapping and cause unverified',...selected.flatMap(item=>[item.project+' / '+item.path+' · '+item.state+(item.lastCommitSha?' · provider-reported last modifying '+item.lastCommitSha.slice(0,12):'')+(item.historical?' · prior retained observation':''),...(item.title?['Commit title (untrusted metadata): '+item.title.replace(/[\r\n]/g,' ').slice(0,100)]:[]),...(item.parents||[]).slice(0,1).flatMap(parent=>['Parent '+parent.parentSha.slice(0,12)+' · '+parent.state+(parent.delta?' · '+parent.delta:''),...quote('Before',parent.before),...quote('After',parent.after)]),item.error||'',item.parentsOmitted||item.parents?.length>1?'Some parent evidence is omitted from this brief or unavailable; inspect the saved sources.':'',item.evidenceId?'Host history evidence '+item.evidenceId:'']),selected.length<all.length?'Further retained file histories are omitted from this brief.':''].filter(Boolean).join('\n');
}

export function historyMetadata(file,project,scope,context){const h=historySummary(file,project,scope,context);return h?{state:h.state,path:h.path,lastCommitSha:h.lastCommitSha,candidateSha:h.candidateSha,title:h.title,parentsOmitted:h.parentsOmitted,error:h.error,parents:(h.parents||[]).map(parent=>({parentSha:parent.parentSha,state:parent.state,delta:parent.delta,before:parent.before?{sha:parent.before.sha,path:parent.before.path,contentHash:parent.before.contentHash}:undefined,after:parent.after?{sha:parent.after.sha,path:parent.after.path,contentHash:parent.after.contentHash}:undefined})),note:'History source text is supplied only as numbered sourceCode excerpts. Parent code is not a log-reported runtime location.'}:undefined;}
