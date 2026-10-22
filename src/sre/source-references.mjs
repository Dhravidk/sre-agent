import {verifiedHistory} from './source-history.mjs';
import {hash} from './security.mjs';
import {sourcePath,sourceInspectionLimits,retainedRequestedSource} from './source-evidence.mjs';
import {validReportedLocation,logSourceLimits} from './log-source.mjs';
import {retainedDiscovery,validDiscoveryReference,discoverySummary} from './source-discovery.mjs';
import {sourceIdentityState} from './source-identity-history.mjs';

export const sourceReferenceLimits=Object.freeze({files:8,totalBytes:20000,fileBytes:5000,lines:80,lineBytes:2000,findings:8,quoteLines:20,quoteBytes:4000});
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const sha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const sourceKinds=new Set(['code_review','release_diff','change']);

function availableFiles(context){
 const scope=context.sourceScope;if(scope?.provider!=='gitlab'||!scope.project&&!scope.discovery)return [];
 const files=[];
 const add=(evidence,value,extra)=>{
  if(value?.state!=='available'||!sha(value.sha)||!sourcePath(value.path)||typeof value.content!=='string'||Buffer.byteLength(value.content,'utf8')>sourceInspectionLimits.bytesPerFile||hash(value.content)!==value.contentHash||!/^[a-f0-9]{64}$/.test(value.sourceContentHash||''))return;
  const lines=value.content.split(/\r?\n/);if(lines.length!==value.lineCount)return;
  files.push({evidenceId:evidence.id,provider:'gitlab',project:scope.project,sha:value.sha,path:value.path,contentHash:value.contentHash,sourceContentHash:value.sourceContentHash,redacted:value.redacted===true,sourceLineCount:lines.length,lines,...extra});
 };
 for(const evidence of context.evidence||[]){
  const proof=evidence.content,inspection=proof?.sourceInspection;
  if(evidence.source==='gitlab'&&evidence.kind==='source_discovery'){
   const packet=retainedDiscovery(context,evidence);if(!packet)continue;
   for(const probe of packet.probes){
    if(!probe||!scope.discovery.projects.includes(probe.project)||!sha(probe.revision?.sha)||probe.revision.project!==probe.project||probe.revision.reportedRef!==probe.reportedRef||!['sha','tag'].includes(probe.revision.kind)||probe.revision.kind==='sha'&&probe.revision.sha!==probe.reportedRef||probe.revision.kind==='tag'&&(!scope.discovery.allowTags||sha(probe.reportedRef)))continue;
    for(const value of (Array.isArray(probe.files)?probe.files:[]).slice(0,2)){
     if(value?.sha!==probe.revision.sha)continue;
     const identity={project:probe.project,path:value.path,sourceLineCount:value.lineCount},candidateLogLocations=(Array.isArray(value.candidateLogLocations)?value.candidateLogLocations:[]).slice(0,4).filter(location=>validDiscoveryReference(location,identity,context)&&location.reportedRef===probe.reportedRef&&location.reportedPath===probe.reportedPath);
     if(candidateLogLocations.length){
      add(evidence,value,{project:probe.project,side:'discovery-candidate',mappingCandidate:true,discovery:{scopeKey:packet.scopeKey,refKind:probe.revision.kind,reportedRef:probe.reportedRef,inventoryComplete:probe.inventory?.complete===true,matchingPaths:probe.inventory?.matchingPaths,parentEvidenceOmitted:packet.parentEvidenceOmitted},candidateLogLocations,ranges:value.ranges,comparisonComplete:false});
      const history=verifiedHistory(value,probe.project,scope.discovery,context);
      if(history){const relation={candidateSha:value.sha,candidatePath:value.path,lastCommitSha:history.commit.sha};
       if(history.head.sha!==value.sha)add(evidence,history.head,{project:probe.project,side:'history-last-change',mappingCandidate:true,historyRelation:relation,ranges:history.head.ranges,comparisonComplete:false});
       for(const parent of history.parents)if(parent.state==='available')add(evidence,parent.source,{project:probe.project,side:'history-parent',mappingCandidate:true,historyRelation:{...relation,parentSha:parent.parentSha,delta:parent.delta.state},ranges:[parent.delta.base],comparisonComplete:false});
      }
     }
    }
   }continue;
  }
  if(evidence.source==='gitlab'&&evidence.kind==='source_requested'){
   const retained=retainedRequestedSource(evidence,context);if(!retained)continue;const {source,request,candidate,parent}=retained;
   add(evidence,source.file,{project:source.project,side:'requested-source',...(candidate?{mappingCandidate:true}:{}),requestedBy:{requestId:source.requestId,jobId:source.jobId,attempt:source.attempt,reason:request.reason,parentEvidenceOmitted:!parent},ranges:[{startLine:request.startLine,endLine:request.endLine}],comparisonComplete:false});
   const history=verifiedHistory(source.file,source.project,scope.discovery,context);if(history){const relation={candidateSha:source.file.sha,candidatePath:source.file.path,lastCommitSha:history.commit.sha};if(history.head.sha!==source.file.sha)add(evidence,history.head,{project:source.project,side:'history-last-change',mappingCandidate:true,historyRelation:relation,ranges:history.head.ranges,comparisonComplete:false});for(const p of history.parents)if(p.state==='available')add(evidence,p.source,{project:source.project,side:'history-parent',mappingCandidate:true,historyRelation:{...relation,parentSha:p.parentSha,delta:p.delta.state},ranges:[p.delta.base],comparisonComplete:false});}continue;
  }
  if(evidence.source==='gitlab'&&evidence.kind==='source_locations'){
   const source=proof?.logSource;
   if(!scope.project||source?.version!==1||source.provider!=='gitlab'||source.project!==scope.project||!scope.logLocations||JSON.stringify(source.mapping)!==JSON.stringify(scope.logLocations)||source.environment!==scope.logEnvironment)continue;
   for(const value of (Array.isArray(source.files)?source.files:[]).slice(0,logSourceLimits.files)){
    const reportedLocations=(Array.isArray(value.locations)?value.locations:[]).slice(0,logSourceLimits.locationsPerFile).filter(location=>validReportedLocation(location,value,context)&&location.line<=value.lineCount);
    if(reportedLocations.length)add(evidence,value,{side:'reported-log',reportedLocations,ranges:reportedLocations.map(location=>({startLine:Math.max(1,location.line-5),endLine:location.line+5})),comparisonComplete:false});
   }
   continue;
  }
  if(!scope.project||evidence.source!=='gitlab'||!sourceKinds.has(evidence.kind)||proof?.provider!=='gitlab'||inspection?.version!==1||inspection.provider!=='gitlab'||inspection.project!==scope.project||inspection.baseSha!==proof.baseSha||inspection.headSha!==proof.headSha||!sha(proof.baseSha)||!sha(proof.headSha))continue;
  for(const file of (Array.isArray(inspection.files)?inspection.files:[]).slice(0,sourceInspectionLimits.filesPerComparison))for(const side of ['head','base']){
   const value=file?.[side],revision=side==='head'?proof.headSha:proof.baseSha;
   if(value?.sha!==revision||value.path!==file[side==='head'?'newPath':'oldPath'])continue;
   add(evidence,value,{side,ranges:value.ranges,comparisonComplete:proof.complete===true});
  }
 }
 const identities=new Map();
 for(const file of files){const key=JSON.stringify([file.provider,file.project,file.sha,file.path]),hashes=identities.get(key)||new Set();hashes.add(file.sourceContentHash);identities.set(key,hashes);}
 return files.map(file=>({...file,conflicting:identities.get(JSON.stringify([file.provider,file.project,file.sha,file.path])).size>1||sourceIdentityState(context,file)==='conflicting',...(sourceIdentityState(context,file)==='unverified'?{identityHistoryUnverified:true}:{})}));
}

// Numbered lines are whole retained lines. A too-long or omitted line cannot
// be guessed from a clipped serialized prefix and cited as inspected code.
export function sourceReferenceWindow(context){
 const priority=file=>Number(Boolean(file.requestedBy))*2+Number(Boolean(file.reportedLocations||file.candidateLogLocations));
 const candidates=availableFiles(context).sort((a,b)=>priority(b)-priority(a)),files=[],seen=new Set();let omittedLines=0;
 const inspections=(context.evidence||[]).filter(row=>row.source==='gitlab'&&sourceKinds.has(row.kind)&&row.content?.sourceInspection?.version===1&&row.content.sourceInspection.project===context.sourceScope?.project).map(row=>row.content.sourceInspection);
 const locationSources=(context.evidence||[]).filter(row=>row.source==='gitlab'&&row.kind==='source_locations'&&row.content?.logSource?.project===context.sourceScope?.project).map(row=>row.content.logSource);
 const candidateCoverage=discoverySummary(context)?.coverage||{};
 const sourceReadsUnavailable=inspections.reduce((count,inspection)=>count+(Number.isSafeInteger(inspection.coverage?.unavailableSides)&&inspection.coverage.unavailableSides>=0?inspection.coverage.unavailableSides:0),0)+locationSources.reduce((count,source)=>count+(source.coverage?.unavailableFiles||0),0),sourceInventoryOmitted=inspections.reduce((count,inspection)=>count+(Number.isSafeInteger(inspection.coverage?.omittedFiles)&&inspection.coverage.omittedFiles>=0?inspection.coverage.omittedFiles:0),0)+locationSources.reduce((count,source)=>count+(source.coverage?.locationsOmitted||0),0);
 for(const source of candidates){
  const key=JSON.stringify([source.provider,source.project,source.sha,source.path,source.contentHash]);if(seen.has(key))continue;seen.add(key);
  if(files.length>=sourceReferenceLimits.files)continue;
  const {lines,ranges,...identity}=source,entry={...identity,lines:[],omittedLines:0},positions=new Set();
  for(const range of Array.isArray(ranges)?ranges.slice(0,4):[{startLine:1,endLine:40}]){
   if(!Number.isSafeInteger(range.startLine)||!Number.isSafeInteger(range.endLine)||range.startLine<1||range.endLine<range.startLine)continue;
   for(let n=range.startLine;n<=Math.min(range.endLine,lines.length)&&positions.size<sourceReferenceLimits.lines;n++)positions.add(n);
  }
  for(const n of [...positions].sort((a,b)=>a-b)){
   const line={line:n,text:lines[n-1]};if(Buffer.byteLength(line.text,'utf8')>sourceReferenceLimits.lineBytes)continue;
   entry.lines.push(line);if(bytes(entry)>sourceReferenceLimits.fileBytes-100||bytes([...files,entry])>sourceReferenceLimits.totalBytes-1000)entry.lines.pop();
  }
  entry.omittedLines=lines.length-entry.lines.length;omittedLines+=entry.omittedLines;if(entry.lines.length)files.push(entry);
 }
 return{version:1,files,historicalAfterRestore:Boolean(context.recoveryFence?.active),coverage:{filesAvailable:seen.size,filesIncluded:files.length,filesOmitted:Math.max(0,seen.size-files.length),omittedLines,sourceReadsUnavailable,sourceInventoryOmitted,discoveryUnavailableProbes:candidateCoverage.unavailableProbes||0,discoveryUnavailableFiles:candidateCoverage.unavailableFiles||0,discoveryOmittedMatches:candidateCoverage.omittedMatches||0,conflictingFiles:new Set(candidates.filter(f=>f.conflicting).map(f=>JSON.stringify([f.provider,f.project,f.sha,f.path]))).size,...(context.sourceIdentityHistory?{identityHistory:context.sourceIdentityHistory.coverage}:{}),sourceWindowLimited:context.evidenceWindow?.candidatesLimited===true,completeHistory:false},interpretation:'Host-validated numbered source excerpts from configured or approved candidate projects and immutable revisions. Omitted lines are unavailable. A verified location or diff is not a causal finding, observed deployment, approval or verified recovery.'};
}

export const sourceFindingSchema={type:'object',additionalProperties:false,properties:{evidenceId:{type:'string'},provider:{type:'string',enum:['gitlab']},project:{type:'string'},sha:{type:'string'},path:{type:'string'},startLine:{type:'integer',minimum:1},endLine:{type:'integer',minimum:1},quote:{type:'string',maxLength:4000},explanation:{type:'string',minLength:1,maxLength:600}},required:['evidenceId','provider','project','sha','path','startLine','endLine','quote','explanation']};
export function validateSourceFindings(input,context,delivered){
 if(input===undefined)return [];
 if(!Array.isArray(input)||input.length>sourceReferenceLimits.findings)throw Error('Invalid source findings');
 const authoritative=availableFiles(context),included=new Set((delivered?.evidence||[]).map(row=>row.id)),windows=delivered?.sourceCode?.files||[],seen=new Set();
 return input.map(finding=>{
  if(!finding||typeof finding!=='object'||Array.isArray(finding)||Object.keys(finding).some(key=>!sourceFindingSchema.required.includes(key))||sourceFindingSchema.required.some(key=>!Object.hasOwn(finding,key)))throw Error('Invalid source finding shape');
  const {evidenceId,provider,project,sha:revision,path,startLine,endLine,quote,explanation}=finding;
  if(provider!=='gitlab'||typeof evidenceId!=='string'||!included.has(evidenceId)||!sha(revision)||!sourcePath(path)||!Number.isSafeInteger(startLine)||!Number.isSafeInteger(endLine)||startLine<1||endLine<startLine||endLine-startLine>=sourceReferenceLimits.quoteLines||typeof quote!=='string'||!quote.trim()||Buffer.byteLength(quote,'utf8')>sourceReferenceLimits.quoteBytes||typeof explanation!=='string'||!explanation.trim()||[...explanation].length>600)throw Error('Invalid source finding location');
  const identity=file=>file.evidenceId===evidenceId&&file.provider===provider&&file.project===project&&file.sha===revision&&file.path===path;
  const original=authoritative.find(identity),window=windows.find(identity);if(!original||original.conflicting||original.identityHistoryUnverified||!window||window.conflicting||window.identityHistoryUnverified||window.contentHash!==original.contentHash||endLine>original.lines.length)throw Error('Source finding is outside the verified delivered source or its immutable identity is conflicting or unverified');
  const expected=original.lines.slice(startLine-1,endLine).join('\n');
  if(quote!==expected||Array.from({length:endLine-startLine+1},(_,n)=>startLine+n).some(n=>!window.lines.some(line=>line.line===n&&line.text===original.lines[n-1])))throw Error('Source finding quotes omitted or mismatched lines');
  const key=JSON.stringify([provider,project,revision,path,startLine,endLine]);if(seen.has(key))throw Error('Duplicate source finding location');seen.add(key);
  const reportedLogLocations=original.reportedLocations?.filter(location=>included.has(location.evidenceId)&&location.line>=startLine&&location.line<=endLine&&window.reportedLocations?.some(item=>item.evidenceId===location.evidenceId&&item.recordIndex===location.recordIndex&&item.recordHash===location.recordHash&&item.line===location.line));
  const candidateLogLocations=original.candidateLogLocations?.filter(location=>included.has(location.evidenceId)&&location.line>=startLine&&location.line<=endLine&&window.candidateLogLocations?.some(item=>item.evidenceId===location.evidenceId&&item.recordIndex===location.recordIndex&&item.recordHash===location.recordHash&&item.line===location.line));
  return {...finding,verifiedLocation:true,contentHash:original.contentHash,sourceContentHash:original.sourceContentHash,...(reportedLogLocations?.length?{reportedLogLocations}:{}),...(original.historyRelation?{historyRelation:original.historyRelation}:{}),...(original.mappingCandidate?{mappingCandidate:true,...(candidateLogLocations?.length?{candidateLogLocations}:{})}:{}),interpretation:original.mappingCandidate?'The quote matches candidate source bytes. The runtime repository, revision mapping and cause remain unverified.':'The location and quote match delivered immutable source; the explanation is an investigation hypothesis, not established cause.'};
 });
}

const findingLocation=f=>[f.provider,f.project,f.sha,f.path,f.startLine,f.endLine,f.sourceContentHash||f.contentHash];
export const materialSourceFindings=findings=>(findings||[]).map(f=>[...findingLocation(f),Boolean(f.mappingCandidate),String(f.explanation||'').replace(/\s+/gu,' ').trim()]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
export const sourceFindingInput=findings=>(findings||[]).map(finding=>Object.fromEntries(sourceFindingSchema.required.map(key=>[key,finding[key]])));
export function reportedSourceFindings(context,delivered){
 const findings=[],seen=new Set(),ids=new Set((delivered.evidence||[]).map(row=>row.id));
 for(const file of delivered.sourceCode?.files||[])for(const location of file.reportedLocations||file.candidateLogLocations||[]){
  const key=JSON.stringify([file.project,file.sha,file.path,location.line]);if(seen.has(key)||file.conflicting||file.identityHistoryUnverified||!ids.has(location.evidenceId))continue;const line=file.lines.find(line=>line.line===location.line);if(!line?.text.trim())continue;
  const finding={evidenceId:file.evidenceId,provider:file.provider,project:file.project,sha:file.sha,path:file.path,startLine:location.line,endLine:location.line,quote:line.text,explanation:file.mappingCandidate?'This approved project contains candidate source matching the log-reported ref and filename. The quote is verified; runtime repository, filename mapping and cause remain unverified. Compare other candidates and obtain runtime identity.':'Error logs report this exact revision, file and line. Inspect the input and runtime/source mapping before attributing a failure mechanism; a reported execution location is not causal proof.'};
  try{validateSourceFindings([finding],context,delivered);}catch{continue;}findings.push(finding);seen.add(key);if(findings.length===4)return findings;
 }
 return findings;
}
export function sourceFindingChanges(previous,current){
 const before=new Set((previous||[]).map(finding=>JSON.stringify(findingLocation(finding)))),after=new Set((current||[]).map(finding=>JSON.stringify(findingLocation(finding))));
 return{added:[...after].filter(value=>!before.has(value)).length,removed:[...before].filter(value=>!after.has(value)).length};
}
