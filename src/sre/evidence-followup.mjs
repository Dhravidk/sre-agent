import {sourceDirectoryPath,validatedSourceInventory,sourceInventoryLimits} from './source-inventory.mjs';
import {collectCandidateHistory} from './source-history.mjs';
import {discoveryScope} from './source-discovery-config.mjs';
import {retainDiscoveryEvidence,discoveryMetadataReader} from './source-discovery.mjs';
import {hash,redact} from './security.mjs';
import {boundedContext} from './model-context.mjs';
import {sourceScopeForService,sourceTextPath,readImmutableSource,sourceReadBudget,sourceInspectionLimits} from './source-evidence.mjs';
import {collectLogSourceEvidence} from './log-source.mjs';
import {evidenceReadLimits,validateEvidenceRequests} from './evidence-request.mjs';

const fullSha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const semantic=request=>Object.fromEntries(Object.entries(request).filter(([key])=>key!=='reason'));
function logReadCoverage(content,request){
 let invalidRecords=0,missingTimes=0,conflictingTimes=0,outsideWindow=0;
 const stamp=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:typeof value==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isSafeInteger(Date.parse(value))?Date.parse(value):null;
 for(const record of content.records){if(!record||typeof record!=='object'||Array.isArray(record)){invalidRecords++;continue;}const values=['timestamp','at'].filter(key=>Object.hasOwn(record,key)).map(key=>stamp(record[key]));if(!values.length||values.some(value=>value===null)){missingTimes++;continue;}if(new Set(values).size>1){conflictingTimes++;continue;}if(values[0]<request.from||values[0]>request.to)outsideWindow++;}
 const grail=content.metadata?.grail,flags=['partial','sampled','truncated'],metadataUnverified=content.metadata!==undefined&&(!content.metadata||typeof content.metadata!=='object'||Array.isArray(content.metadata))||grail!==undefined&&(!grail||typeof grail!=='object'||Array.isArray(grail)||grail.sampled!==undefined&&typeof grail.sampled!=='boolean'||grail.notifications!==undefined&&!Array.isArray(grail.notifications))||flags.some(key=>content[key]!==undefined&&typeof content[key]!=='boolean');
 const partial=flags.some(key=>content[key]===true)||grail?.sampled===true||(Array.isArray(grail?.notifications)&&grail.notifications.some(note=>note?.severity!=='INFO'));
 const recordLimitReached=content.records.length===evidenceReadLimits.logRecords;
 return{complete:content.complete===true&&!recordLimitReached&&!partial&&!metadataUnverified&&!invalidRecords&&!missingTimes&&!conflictingTimes&&!outsideWindow,records:content.records.length,invalidRecords,missingTimes,conflictingTimes,outsideWindow,recordLimitReached,metadataUnverified:Boolean(metadataUnverified)};
}
export class EvidenceFollowup {
 constructor({store,job,service,clients,sourceBudget=sourceReadBudget(),signal}){Object.assign(this,{store,job,service,clients,sourceBudget,signal});this.used=0;this.logQueries=0;this.seen=new Set();this.results=[];}
 async policy(context,round){
  const view=boundedContext(context),scope=sourceScopeForService(this.service),revisions=[...new Set([...(view.sourceCode?.files||[]).filter(f=>scope?.project&&f.project===scope.project).map(f=>f.sha),...(view.sourceInventories?.inventories||[]).filter(f=>scope?.project&&f.project===scope.project).map(f=>f.sha),...view.deployments.filter(d=>d.provider==='gitlab').map(d=>d.sha),...(view.signalDigest?.changes||[]).filter(c=>c.provider==='gitlab').flatMap(c=>[c.baseSha,c.headSha])].filter(fullSha))].slice(0,scope?.discovery?16:32),now=await this.store.coordinationNow(),started=context.incident.started_at;
  const logs=this.clients.dynatraceLogs||(this.clients.dynatrace?.config.mode==='grail'?this.clients.dynatrace:null);this.logs=logs;
  const additionalProjects=scope?.discovery?scope.discovery.projects.map(project=>({project,allowedRevisions:[...new Set([...(view.sourceCode?.files||[]),...(view.sourceInventories?.inventories||[])].filter(file=>file.project===project).map(file=>file.sha).filter(fullSha))].slice(0,8)})).filter(item=>item.allowedRevisions.length):[];
  const enabled=this.service.investigation?.followUp?.enabled===true&&!context.recoveryFence?.active,kinds=[];
  if(enabled&&(scope?.project&&typeof this.clients.gitlab?.file==='function'&&revisions.length||additionalProjects.length&&typeof this.clients.gitlab?.discoveryFile==='function'))kinds.push('gitlab_file');
  if(enabled&&(scope?.project&&typeof this.clients.gitlab?.directory==='function'&&revisions.length||additionalProjects.length&&typeof this.clients.gitlab?.discoveryDirectory==='function'))kinds.push('gitlab_tree');
  if(enabled&&typeof logs?.logs==='function'&&Number.isSafeInteger(started)&&started>=0&&started-evidenceReadLimits.logWindowMs<=now)kinds.push('dynatrace_logs');
  const policy={version:1,enabled,round,remainingRounds:Math.max(0,evidenceReadLimits.rounds-round),remainingRequests:Math.max(0,evidenceReadLimits.requests-this.used),remainingLogQueries:Math.max(0,evidenceReadLimits.logQueries-this.logQueries),kinds,source:scope?{project:scope.project,allowedRevisions:scope.project?revisions:[],...(additionalProjects.length?{additionalProjects}:{}),maxLines:evidenceReadLimits.sourceLines,...(kinds.includes('gitlab_tree')?{directory:{recursive:false,maxEntries:sourceInventoryLimits.pages*sourceInventoryLimits.pageSize,maxPages:sourceInventoryLimits.pages}}:{})}:null,logs:{earliestFrom:Math.max(0,started-evidenceReadLimits.logWindowMs),latestTo:now,maxWindowMs:evidenceReadLimits.logWindowMs},note:'These are host read constraints, not credentials or action authority. Only the configured fixed project or explicitly listed additional project/revision pairs and service are accessible. Additional projects remain runtime mapping candidates. Omitted evidence and failed/partial reads stay unknown.'};
  this.policies??=new Map();this.policies.set(round,structuredClone(policy));return policy;
 }
 refusal(request,policy){
  if(!policy.enabled||!policy.kinds.includes(request.kind))return'This follow-up reader is not enabled within the configured scope';
  if(['gitlab_file','gitlab_tree'].includes(request.kind)&&(!fullSha(request.sha)||!(request.project?policy.source?.additionalProjects?.find(item=>item.project===request.project)?.allowedRevisions.includes(request.sha):policy.source?.project&&policy.source.allowedRevisions.includes(request.sha))||(request.kind==='gitlab_tree'?!sourceDirectoryPath(request.path):!sourceTextPath(request.path)||request.endLine<request.startLine||request.endLine-request.startLine+1>evidenceReadLimits.sourceLines)))return'The source selector is outside the delivered immutable revisions, safe text paths or line budget';
  if(request.kind==='dynatrace_logs'&&(request.from<policy.logs.earliestFrom||request.to>policy.logs.latestTo||request.to<=request.from||request.to-request.from>policy.logs.maxWindowMs))return'The log request is outside the permitted incident time window';
  return null;
 }
 async run(requests,context,round,{limited=false}={}){
  requests=validateEvidenceRequests(requests);const policy=this.policies?.get(round)||await this.policy(context,round),revision=Number(context.incident.revision);let logsCollected=false;
  if(!policy.enabled&&requests.length)throw Error('Follow-up evidence reads are not enabled');
  for(const[index,request]of requests.entries()){
   if(this.signal?.aborted)throw this.signal.reason;const key=hash(semantic(request)),refusal=this.refusal(request,policy),base={round,index,request,requestHash:hash(request)};
   let reason=refusal,phase='refused';
   if(!reason&&(limited||this.used>=evidenceReadLimits.requests||request.kind==='dynatrace_logs'&&this.logQueries>=evidenceReadLimits.logQueries)){reason='The investigation follow-up read budget is exhausted';phase='limited';}
   if(!reason&&this.seen.has(key)){reason='This selector was already attempted in this job attempt; no automatic retry is made';phase='duplicate';}
   if(reason){const saved=await this.store.recordEvidenceRead(this.job,revision,{...base,phase,error:reason});if(!saved)return false;this.results.push({kind:request.kind,selector:semantic(request),phase,error:reason,eventId:saved.eventId});this.used=Math.min(evidenceReadLimits.requests,this.used+1);continue;}
   this.seen.add(key);this.used++;const start=await this.store.recordEvidenceRead(this.job,revision,{...base,phase:'started'});if(!start)return false;
   let content,artifact,coverage={},error;
   try{
    if(request.kind==='gitlab_tree'){
     const project=request.project||policy.source.project,read=discoveryMetadataReader(this.service,this.sourceBudget,{signal:this.signal,clock:()=>this.store.coordinationNow()});
     const observed=await read('directory',project,JSON.stringify([request.sha,request.path]),()=>request.project?this.clients.gitlab.discoveryDirectory(project,request.path,request.sha,{signal:this.signal}):this.clients.gitlab.directory(request.path,request.sha,{signal:this.signal}));
     const inventory=validatedSourceInventory(observed.value,{project,sha:request.sha,path:request.path});
     coverage={complete:inventory.complete,entries:inventory.entries.length,invalidEntries:inventory.invalidEntries,limitReached:inventory.limitReached};
     artifact={source:'gitlab',kind:'source_inventory',content:{sourceInventory:{version:1,...inventory,request,hostRead:{requestId:start.eventId,jobId:this.job.id,attempt:this.job.attempts},...(request.project?{discoveryScopeKey:discoveryScope(this.service).scopeKey}:{}),interpretation:'Host-retrieved non-recursive paths at an immutable candidate revision. Filenames support further scoped reads, not cause, runtime mapping, source contents or action authority.'}}};
    }else if(request.kind==='gitlab_file'){
     const project=request.project||policy.source.project,service=request.project?{...this.service,gitlab:{...this.service.gitlab,project,sourceInspection:{enabled:true}}}:this.service,client=request.project?{file:(path,sha,options)=>this.clients.gitlab.discoveryFile(project,path,sha,options)}:this.clients.gitlab;
     let file=await readImmutableSource(request.path,request.sha,{service,client,budget:this.sourceBudget,signal:this.signal});
     if(file.state!=='available')throw Error(file.error||'Source unavailable');
     const pendingFiles=requests.slice(index+1).filter(next=>next.kind==='gitlab_file'&&!this.refusal(next,policy)&&!this.seen.has(hash(semantic(next)))).length;const scope=discoveryScope(this.service);if(scope?.history&&scope.projects.includes(project)){const read=discoveryMetadataReader(this.service,this.sourceBudget,{signal:this.signal,clock:()=>this.store.coordinationNow()}),history=await collectCandidateHistory(file,{service:this.service,project,client:this.clients.gitlab,budget:this.sourceBudget,read,revision:{sha:request.sha},signal:this.signal,reserveReads:pendingFiles,reserveBytes:pendingFiles*sourceInspectionLimits.bytesPerFile});file={...file,history};}
     coverage={fileComplete:true,complete:request.endLine<=file.lineCount,requestedLines:request.endLine-request.startLine+1,linesAvailable:Math.max(0,Math.min(file.lineCount,request.endLine)-request.startLine+1)};
     artifact={source:'gitlab',kind:'source_requested',content:{requestedSource:{version:1,project,...(request.project?{discoveryScopeKey:discoveryScope(this.service).scopeKey}:{}),requestId:start.eventId,jobId:this.job.id,attempt:this.job.attempts,request,file:{...file,ranges:[{startLine:request.startLine,endLine:request.endLine}]},interpretation:'Host-retrieved immutable source for a bounded follow-up proposal. This does not attest deployment, cause, approval or recovery.'}}};
    }else{
     this.logQueries++;content=await this.logs.logs({from:request.from,to:request.to,signal:this.signal});
     if(!content||!Array.isArray(content.records)||typeof content.complete!=='boolean'||content.records.length>evidenceReadLimits.logRecords||Buffer.byteLength(JSON.stringify(content),'utf8')>evidenceReadLimits.logBytes)throw Error('Follow-up log response exceeds the accepted shape or byte budget');
     coverage=logReadCoverage(content,request);artifact={source:'dynatrace',kind:'logs',content:{...content,complete:coverage.complete,followUp:{requestId:start.eventId,jobId:this.job.id,attempt:this.job.attempts,round,from:request.from,to:request.to,sourceComplete:content.complete,coverage}}};
    }
   }catch(failure){if(this.signal?.aborted)throw this.signal.reason;error=redact(String(failure.message)).slice(0,500);}
   if(this.signal?.aborted)throw this.signal.reason;
   const outcomePhase=error?'unavailable':'collected',saved=await this.store.recordEvidenceRead(this.job,revision,{...base,requestId:start.eventId,phase:outcomePhase,...(error?{error}:{}),coverage},error?undefined:artifact);if(!saved)return false;this.results.push({kind:request.kind,selector:semantic(request),phase:outcomePhase,...(error?{error}:{}),coverage,eventId:saved.eventId,requestId:start.eventId,...(saved.sourceEvidenceId?{sourceEvidenceId:saved.sourceEvidenceId}:{})});if(!error&&request.kind==='dynatrace_logs')logsCollected=true;
  }
  if(logsCollected&&this.service.gitlab?.sourceInspection?.enabled&&this.service.gitlab.sourceInspection.logLocations&&this.clients.gitlab){
   const started=await this.store.recordEvidenceRead(this.job,revision,{round,index:2,phase:'derived-source-started',reason:'Apply the reviewed error-location mapping to retained follow-up logs'});if(!started)return false;
   const fresh=await this.store.context(context.incident.id),logSource=await collectLogSourceEvidence(fresh,{service:this.service,client:this.clients.gitlab,budget:this.sourceBudget,signal:this.signal});
   const saved=await this.store.recordEvidenceRead(this.job,revision,{round,index:2,phase:'derived-source',requestId:started.eventId,reason:'Apply the reviewed error-location mapping to retained follow-up logs'},{source:'gitlab',kind:'source_locations',content:{logSource}});if(!saved)return false;
  }
  if(logsCollected&&discoveryScope(this.service)&&this.clients.gitlab){const fresh=await this.store.context(context.incident.id);if(!await retainDiscoveryEvidence({store:this.store,job:this.job,context:fresh,service:this.service,client:this.clients.gitlab,budget:this.sourceBudget,signal:this.signal,pass:round+1}))return false;}
  return true;
 }
}
