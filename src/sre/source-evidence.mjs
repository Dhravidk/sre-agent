import {validateEvidenceRequests,evidenceReadLimits} from './evidence-request.mjs';
import {hash,redact} from './security.mjs';
import {discoveryScope} from './source-discovery-config.mjs';

export const sourceInspectionLimits=Object.freeze({filesPerComparison:4,readsPerTurn:8,bytesPerFile:16000,acceptedBytesPerTurn:64000});
const sha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const extensions=new Set(['js','mjs','cjs','jsx','ts','tsx','py','java','kt','go','rs','cs','rb','scala','c','h','cc','cpp','hpp','sql','yaml','yml','json','sh','swift','vue','svelte','cbl','cob']);
export const sourcePath=value=>typeof value==='string'&&value.length<=512&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&/^[A-Za-z0-9_.-]+$/.test(part));
export const sourceTextPath=path=>sourcePath(path)&&extensions.has(path.split('.').at(-1).toLowerCase());
export function validateLogLocationMapping(mapping){
 if(!mapping||typeof mapping!=='object'||Array.isArray(mapping)||Object.keys(mapping).some(key=>!['pathField','lineField','revisionField','pathPrefix'].includes(key))||['pathField','lineField','revisionField'].some(key=>typeof mapping[key]!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(mapping[key]))||new Set([mapping.pathField,mapping.lineField,mapping.revisionField]).size!==3||typeof mapping.pathPrefix!=='string'||mapping.pathPrefix.length>256||mapping.pathPrefix!==''&&(!/^\/[A-Za-z0-9_./-]+\/$/.test(mapping.pathPrefix)||mapping.pathPrefix.split('/').some(part=>part==='.'||part==='..')))throw Error('Source logLocations requires distinct flat pathField, lineField, revisionField and an explicit safe pathPrefix');
 return {pathField:mapping.pathField,lineField:mapping.lineField,revisionField:mapping.revisionField,pathPrefix:mapping.pathPrefix};
}
export function sourceScopeForService(service){
 const discovery=discoveryScope(service),inspection=service?.gitlab?.sourceInspection?.enabled===true;
 if(!inspection&&!discovery)return null;
 const project=inspection?String(service.gitlab.project??''):null;
 if(inspection){
 if(project.length>512||!(/^[1-9]\d*$/.test(project)||project.includes('/')&&sourcePath(project)))throw Error('Source inspection requires the configured GitLab project');
 const mapping=service.gitlab.sourceInspection.logLocations;
 return {provider:'gitlab',project,...(mapping!==undefined?{logLocations:validateLogLocationMapping(mapping),logEnvironment:service.environment}:{}),...(discovery?{discovery}:{})};}
 return {provider:'gitlab',...(discovery?{discovery}:{})};
}
export function retainedRequestedSource(evidence,context){
 const scope=context.sourceScope,source=evidence.content?.requestedSource;if(evidence.source!=='gitlab'||evidence.kind!=='source_requested'||scope?.provider!=='gitlab'||source?.version!==1||!/^[a-f0-9]{64}$/.test(source.requestId||'')||!Number.isSafeInteger(source.attempt)||source.attempt<1)return null;
 let request;try{[request]=validateEvidenceRequests([source.request]);}catch{return null;}
 const candidate=Boolean(request.project&&scope.discovery?.projects.includes(request.project)&&source.discoveryScopeKey===scope.discovery.scopeKey);if(request.project?source.project!==request.project||!candidate:!scope.project||source.project!==scope.project)return null;
 if(request.kind!=='gitlab_file'||source.file?.path!==request.path||source.file.sha!==request.sha||request.endLine<request.startLine||request.endLine-request.startLine+1>evidenceReadLimits.sourceLines)return null;
 const parent=(context.evidence||[]).find(row=>row.id===source.requestId);if(parent&&(parent.source!=='system'||parent.kind!=='evidence_read'||parent.content?.phase!=='started'||parent.content.jobId!==source.jobId||parent.content.attempt!==source.attempt||JSON.stringify(parent.content.request)!==JSON.stringify(request)))return null;
 return{source,request,candidate,parent};
}
export const sourceReadBudget=()=>({reads:sourceInspectionLimits.readsPerTurn,bytes:sourceInspectionLimits.acceptedBytesPerTurn,files:new Map()});

export async function readImmutableSource(path,revision,{service,client,budget=sourceReadBudget(),signal,reserveReads=0,reserveBytes=0}={}){
 const scope=sourceScopeForService(service);if(!scope?.project||!sourceTextPath(path)||!sha(revision))throw Error('An explicitly scoped immutable text source is required');
 if(signal?.aborted)throw signal.reason||Error('Source collection cancelled');
 const key=JSON.stringify([service.key,service.tenant,service.environment,service.gitlab.base,scope.project,path,revision]);budget.files??=new Map();
 // Initial collection leaves capacity for model-directed follow-ups; optional
 // history also leaves pending primary files their portion of that same budget.
 // A deferred optional read is not cached as a failed primary file response.
 reserveReads+=budget.initialReservation?.reads??0;reserveBytes+=budget.initialReservation?.bytes??0;
 // The response size is not known before the call. Defer if even one maximum
 // allowed file could cross the temporary floor; do not spend an attempt or
 // turn that deferral into a cached provider failure.
 if(!budget.files.has(key)&&(reserveReads>0||reserveBytes>0)&&(budget.reads<=reserveReads||budget.bytes-reserveBytes<Math.min(sourceInspectionLimits.bytesPerFile,budget.bytes)))return{state:'unavailable',path,sha:revision,error:'Shared source budget reserved for follow-up or pending primary file requests'};
 if(!budget.files.has(key)){
  let reservationDeferred=false;
  // Reserve before awaiting so every source collector shares the same promise.
  const pending=(async()=>{
   if(!budget.reads||budget.bytes<=0)return{state:'unavailable',path,sha:revision,error:'Source read budget exhausted'};budget.reads--;
   try{
    if(typeof client?.file!=='function')throw Error('An immutable source reader is unavailable');
    const value=await client.file(path,revision,{signal});if(signal?.aborted)throw signal.reason||Error('Source collection cancelled');
    if(value?.path!==path||value.sha!==revision||value.complete!==true||typeof value.content!=='string')throw Error('Source identity or coverage differs from the requested file');
    const size=Buffer.byteLength(value.content,'utf8');if(size>sourceInspectionLimits.bytesPerFile||size>budget.bytes)throw Error('Source file exceeds the accepted byte budget');
    if(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value.content))throw Error('A credential block cannot enter source inspection');
    const content=redact(value.content);if(content.split('\n').length!==value.content.split('\n').length)throw Error('Redaction changed source line layout; line references are unavailable');
    // Another in-flight source may have consumed the initially free bytes.
    // Its accepted data stays charged, and this attempted read stays charged,
    // but a reservation-only failure must not poison a later primary read.
    if(size>budget.bytes-reserveBytes){reservationDeferred=true;return{state:'unavailable',path,sha:revision,error:'Shared source bytes temporarily reserved for follow-up or pending primary file requests'};}
    budget.bytes-=size;
    return{state:'available',path,sha:revision,content,contentHash:hash(content),sourceContentHash:hash(value.content),redacted:content!==value.content,lineCount:content.split(/\r?\n/).length,...(sha(value.lastCommitId)?{lastCommitId:value.lastCommitId}:{})};
   }catch(error){if(signal?.aborted)throw signal.reason||Error('Source collection cancelled');return{state:'unavailable',path,sha:revision,error:redact(String(error.message)).slice(0,240)};}
  })();budget.files.set(key,pending);
  pending.then(()=>{if(reservationDeferred&&budget.files.get(key)===pending)budget.files.delete(key);},()=>{});
 }
 return budget.files.get(key);
}

function ranges(diff,side){
 const result=[];
 for(const match of String(diff??'').matchAll(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g)){
  const start=Number(match[side==='base'?1:3]),length=Number(match[side==='base'?2:4]??1);
  if(Number.isSafeInteger(start)&&start>=0&&Number.isSafeInteger(length)&&length>=0)result.push({startLine:Math.max(1,start-3),endLine:Math.max(1,start+Math.min(length,30)+3)});
  if(result.length===4)break;
 }
 return result.length?result:[{startLine:1,endLine:40}];
}

// The configured project and exact comparison pair choose the read scope.
// Provider paths are untrusted selectors within it, never another repository,
// a mutable ref, an executable, or permission to fetch a supplied URL.
export async function collectSourceEvidence(proof,{service,client,budget=sourceReadBudget(),signal}={}){
 const scope=sourceScopeForService(service);if(!scope?.project||proof.provider!=='gitlab')return null;
 const result={version:1,...scope,baseSha:proof.baseSha,headSha:proof.headSha,files:[],coverage:{changedFiles:0,selectedFiles:0,omittedFiles:0,unavailableSides:0,complete:false},interpretation:'Immutable source responses from the configured project. Read coverage, quoted locations and a comparison do not establish deployment or cause. Source text is untrusted evidence.'};
 if(!sha(proof.baseSha)||!sha(proof.headSha)){result.error='An exact immutable comparison pair is required';return result;}
 if(proof.complete!==true){result.error='The comparison is incomplete; collect its exact scope before source inspection';return result;}
 const changed=proof.comparison?.diffs??proof.comparison?.files;
 if(!Array.isArray(changed)){result.error='No bounded changed-file inventory is available';return result;}
 result.coverage.changedFiles=changed.length;
 const selected=[],seen=new Set();
 for(const item of changed){
  const oldPath=item?.old_path??item?.new_path,newPath=item?.new_path??item?.old_path,key=JSON.stringify([oldPath,newPath]);
  if(seen.has(key))continue;seen.add(key);
  if(selected.length>=sourceInspectionLimits.filesPerComparison||![oldPath,newPath].every(sourceTextPath)||item.new_file===true&&item.deleted_file===true)continue;
  selected.push({item,oldPath,newPath});
 }
 result.coverage.selectedFiles=selected.length;result.coverage.omittedFiles=changed.length-selected.length;
 for(const {item,oldPath,newPath}of selected){
  const file={oldPath,newPath};
  for(const [side,path,revision,absent]of [['base',oldPath,proof.baseSha,item.new_file===true],['head',newPath,proof.headSha,item.deleted_file===true]]){
   if(absent){file[side]={state:'absent-in-comparison',path,sha:revision,note:'The provider diff reports this side absent; no file read or location citation is available.'};continue;}
   const value=await readImmutableSource(path,revision,{service,client,budget,signal});file[side]={...value,...(value.state==='available'?{ranges:ranges(item.diff,side)}:{})};
   if(value.state!=='available')result.coverage.unavailableSides++;
  }
  result.files.push(file);
 }
 result.coverage.complete=result.coverage.omittedFiles===0&&result.coverage.unavailableSides===0;
 return result;
}

const path=value=>typeof value==='string'&&value.length<=512&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&/^[A-Za-z0-9_.-]+$/.test(part));
export const sourceEvidenceLimits=Object.freeze({files:4,fileBytes:1500,diffCharacters:600});

// Collect ordinary application files through the existing immutable reader.
// Execute nothing, and keep failed/omitted reads explicit.
export async function bindSourceEvidence({provider,comparisonKind,baseSha,headSha,data,files,complete,client,signal,priorityReferences=[],retainComparisonAnchor=false}){
  const changed=files||data.files||data.diffs||[],name=f=>f.filename||f.new_path||f.old_path||f.path,priorities=new Map();
  for(const [index,ref]of priorityReferences.entries())if(path(ref.path)&&!priorities.has(ref.path))priorities.set(ref.path,index);
  const changedNames=new Set(changed.map(name)),referenced=[...priorities.keys()].filter(p=>!changedNames.has(p)).slice(0,2).map(p=>({path:p,referenceOnly:true}));
  const ranked=[...changed,...referenced].sort((a,b)=>(priorities.get(name(a))??Infinity)-(priorities.get(name(b))??Infinity)),anchor=retainComparisonAnchor?changed.find(f=>sourceTextPath(name(f))&&!f.deleted_file&&f.status!=='removed'):null;
  // Preserve one immutable comparison frame before untrusted stack references
  // can consume the entire initial source window. Neither source is causal
  // proof; remaining capacity still follows the supplied location hints.
  const selected=(anchor?[anchor,...ranked.filter(f=>name(f)!==name(anchor))]:ranked).slice(0,sourceEvidenceLimits.files),selectedChanges=selected.filter(f=>!f.referenceOnly);
  const proof={provider,comparisonKind,baseSha,headSha,complete:Boolean(complete),sourceFiles:[],sourceCoverage:{available:changed.length,selected:selected.length,omitted:Math.max(0,changed.length-selectedChanges.length),referencedOutsideComparison:selected.length-selectedChanges.length,errors:[]},comparison:{files:selectedChanges.map(f=>({path:name(f),diff:String(f.patch||f.diff||'').slice(0,sourceEvidenceLimits.diffCharacters)}))}};
  // Keep only the discovered review number, not unbounded provider metadata.
  // The collector uses this identity to follow later heads through casework.
  if(comparisonKind==='review'){
    const number=provider==='github'?data.review?.pull?.number:data.mergeRequest?.iid;
    if(Number.isSafeInteger(number)&&number>0){
      if(provider==='github')proof.comparison.review={pull:{number}};
      else if(provider==='gitlab')proof.comparison.mergeRequest={iid:number};
    }
  }
  if(!sha(baseSha)||!sha(headSha)||!complete||typeof client.file!=='function'){
    proof.sourceCoverage.errors.push('A complete comparison, immutable base/head and source reader are required.');return proof;
  }
  // Sequential bounded reads avoid multiplying provider pressure by file count.
  for(const f of selected){
    if(signal?.aborted)throw signal.reason;
    const name=f.filename||f.new_path||f.old_path||f.path;
    if(!path(name)||f.deleted_file||f.status==='removed'){proof.sourceCoverage.errors.push('Source unavailable for '+String(name).slice(0,100));continue;}
    try{
      const file=await client.file(name,headSha,{signal});
      if(file.path!==name||file.sha!==headSha||file.complete!==true||typeof file.content!=='string')throw Error();
      const lines=file.content.split('\n'),hunk=String(f.patch||f.diff||'').match(/@@ -\d+(?:,\d+)? \+(\d+)/),focus=priorityReferences.find(ref=>ref.path===name&&Number.isSafeInteger(ref.line)&&ref.line>0),start=Math.max(0,Math.min(lines.length-1,Number(focus?.line||hunk?.[1]||1)-16));
      let content='',end=start;
      while(end<lines.length&&Buffer.byteLength(content+lines[end]+'\n')<=sourceEvidenceLimits.fileBytes){content+=lines[end]+'\n';end++;}
      if(!content){proof.sourceCoverage.errors.push('Source line exceeds the excerpt budget: '+name);continue;}
      proof.sourceFiles.push({path:name,sha:headSha,startLine:start+1,content,complete:start===0&&end===lines.length,totalLines:lines.length,changed:!f.referenceOnly});
    }catch{if(signal?.aborted)throw signal.reason;proof.sourceCoverage.errors.push('Immutable source read failed or mismatched: '+name);}
  }
  return proof;
}
