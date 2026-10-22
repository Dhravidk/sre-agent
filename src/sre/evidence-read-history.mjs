import {validatedSourceInventory} from './source-inventory.mjs';
import {discoveryScope} from './source-discovery-config.mjs';
import {hash} from './security.mjs';
import {validateEvidenceRequests,retainedEvidenceReads,evidenceReadResource} from './evidence-request.mjs';

export const evidenceReadHistoryLimits=Object.freeze({candidates:64,resources:8});
const id=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const semantic=request=>Object.fromEntries(Object.entries(request).filter(([key])=>key!=='reason'));
const resource=evidenceReadResource;
function receipt(row,incident){
 const body=JSON.parse(row.content);
 if(row.incident_id!==incident.id||row.source!=='system'||row.kind!=='evidence_read'||hash([incident.id,'system','evidence_read',body])!==row.id||body.version!==1||body.serviceKey!==incident.service_key||!id(body.jobId)||!Number.isSafeInteger(body.attempt)||body.attempt<1||!Number.isSafeInteger(body.revision)||body.revision<0||body.revision>Number(incident.revision)||!Number.isSafeInteger(body.round)||body.round<0||body.round>2||!Number.isSafeInteger(body.index)||body.index<0||body.index>1)throw Error('Unverified read receipt');
 const [request]=validateEvidenceRequests([body.request]);return{body,request};
}
function verifiedOutcome(row,incident,service){
 const {body,request}=receipt(row,incident);if(row.job_incident!==incident.id||!['collected','unavailable','refused','limited'].includes(body.phase))throw Error('Unverified read job or phase');
 if(['collected','unavailable'].includes(body.phase)){
  if(!id(body.requestId)||row.start_incident!==incident.id)throw Error('Missing read start');
  const start=receipt({id:body.requestId,incident_id:row.start_incident,source:row.start_source,kind:row.start_kind,content:row.start_content},incident);
  if(start.body.phase!=='started'||start.body.jobId!==body.jobId||start.body.attempt!==body.attempt||start.body.revision!==body.revision||start.body.round!==body.round||start.body.index!==body.index||JSON.stringify(start.request)!==JSON.stringify(request))throw Error('Read start identity mismatch');
 }
 if(body.phase==='collected'){
  if(!id(body.sourceEvidenceId)||row.artifact_incident!==incident.id)throw Error('Missing collected read artifact');const artifact=JSON.parse(row.artifact_content);
  if(hash([incident.id,row.artifact_source,row.artifact_kind,artifact])!==body.sourceEvidenceId)throw Error('Read artifact identity mismatch');
  if(request.kind==='gitlab_file'){
   const source=artifact.requestedSource;if(row.artifact_source!=='gitlab'||row.artifact_kind!=='source_requested'||source?.version!==1||(request.project?source.project!==request.project||!discoveryScope(service)?.projects.includes(request.project)||source.discoveryScopeKey!==discoveryScope(service).scopeKey:source.project!==String(service.gitlab?.project||''))||source.requestId!==body.requestId||source.jobId!==body.jobId||source.attempt!==body.attempt||source.file?.sha!==request.sha||source.file.path!==request.path||JSON.stringify(validateEvidenceRequests([source.request])[0])!==JSON.stringify(request))throw Error('Requested source scope mismatch');
  }else if(request.kind==='gitlab_tree'){
   const source=artifact.sourceInventory,host=source?.hostRead;if(row.artifact_source!=='gitlab'||row.artifact_kind!=='source_inventory'||source?.version!==1||(request.project?source.project!==request.project||!discoveryScope(service)?.projects.includes(request.project)||source.discoveryScopeKey!==discoveryScope(service).scopeKey:source.project!==String(service.gitlab?.project||''))||host?.requestId!==body.requestId||host.jobId!==body.jobId||host.attempt!==body.attempt||JSON.stringify(validateEvidenceRequests([source.request])[0])!==JSON.stringify(request))throw Error('Requested directory scope mismatch');
   const inventory=validatedSourceInventory(source,{project:source.project,sha:request.sha,path:request.path});if(JSON.stringify({complete:inventory.complete,entries:inventory.entries.length,invalidEntries:inventory.invalidEntries,limitReached:inventory.limitReached})!==JSON.stringify(body.coverage))throw Error('Requested directory coverage mismatch');
  }else{
   const source=artifact.followUp;if(row.artifact_source!=='dynatrace'||row.artifact_kind!=='logs'||!Array.isArray(artifact.records)||typeof artifact.complete!=='boolean'||source?.requestId!==body.requestId||source.jobId!==body.jobId||source.attempt!==body.attempt||source.from!==request.from||source.to!==request.to||JSON.stringify(source.filters||[])!==JSON.stringify(request.filters||[])||request.filters?.some(({field,value})=>artifact.records.some(record=>record?.[field]!==value))||JSON.stringify(source.coverage)!==JSON.stringify(body.coverage))throw Error('Requested logs scope mismatch');
  }
 }
 return{kind:request.kind,selector:semantic(request),phase:body.phase,...(body.error?{error:String(body.error).slice(0,500)}:{}),...(body.coverage?{coverage:body.coverage}:{}),eventId:row.id,...(body.requestId?{requestId:body.requestId}:{}),...(body.sourceEvidenceId?{sourceEvidenceId:body.sourceEvidenceId}:{}),observedAt:Number(row.observed_at),order:{jobId:body.jobId,attempt:body.attempt,round:body.round,index:body.index}};
}

// Select read resources before applying the candidate limit. Raw receipts and
// artifacts remain immutable; this bounded view neither retries nor approves.
export async function readEvidenceReadHistory(store,context){
 const {incident}=context,service=store.services.find(item=>item.key===incident.service_key)||{},field=path=>store.db.dialect==='postgres'?"e.content::jsonb#>>'{"+path.split('.').join(',')+"}'":"CAST(json_extract(e.content,'$."+path+"') AS TEXT)",kind=field('request.kind'),sha=field('request.sha'),path=field('request.path'),project=field('request.project'),phase=field('phase'),filters=field('request.filters'),filteredWindow=","+filters+",CASE WHEN "+filters+" IS NOT NULL THEN "+field('request.from')+" END,CASE WHEN "+filters+" IS NOT NULL THEN "+field('request.to')+" END";
 const sql="WITH ranked AS (SELECT e.*,ROW_NUMBER() OVER (PARTITION BY "+kind+","+project+","+sha+","+path+filteredWindow+" ORDER BY e.observed_at DESC,e.id DESC) AS resource_rank FROM sre_evidence e WHERE e.incident_id=? AND e.source='system' AND e.kind='evidence_read' AND "+phase+" IN ('collected','unavailable','refused','limited')), selected AS MATERIALIZED (SELECT * FROM ranked ORDER BY resource_rank,observed_at DESC,id DESC LIMIT ?) SELECT e.id,e.incident_id,e.source,e.kind,e.observed_at,e.content,s.incident_id AS start_incident,s.source AS start_source,s.kind AS start_kind,s.content AS start_content,a.incident_id AS artifact_incident,a.source AS artifact_source,a.kind AS artifact_kind,a.content AS artifact_content,j.incident_id AS job_incident FROM selected e LEFT JOIN sre_evidence s ON s.id="+field('requestId')+" LEFT JOIN sre_evidence a ON a.id="+field('sourceEvidenceId')+" LEFT JOIN sre_jobs j ON j.id="+field('jobId')+" ORDER BY e.resource_rank,e.observed_at DESC,e.id DESC";
 const selected=await store.db.query(sql,[incident.id,evidenceReadHistoryLimits.candidates+1]),rows=selected.slice(0,evidenceReadHistoryLimits.candidates),coverage={candidatesRead:rows.length,limited:selected.length>rows.length,unverified:0,resourcesOmitted:0,tiedOutcomes:0,...(context.recoveryFence?.active?{historicalAfterRestore:true}:{})},groups=new Map();
 for(const row of rows){try{const outcome=verifiedOutcome(row,incident,service);if(!Number.isSafeInteger(outcome.observedAt)||outcome.observedAt<0)throw Error('Invalid read time');const key=resource(outcome),group=groups.get(key);if(!group||outcome.observedAt>group[0].observedAt)groups.set(key,[outcome]);else if(outcome.observedAt===group[0].observedAt)group.push(outcome);}catch{coverage.unverified++;}}
 const outcomes=[...groups.values()].map(group=>{
  // One job's fenced attempt/round/index gives order even when clock values
  // tie. Different jobs at one timestamp do not have an invented order.
  if(new Set(group.map(row=>row.order.jobId)).size===1){group.sort((a,b)=>b.order.attempt-a.order.attempt||b.order.round-a.order.round||b.order.index-a.order.index);const top=group[0].order;group=group.filter(row=>row.order.attempt===top.attempt&&row.order.round===top.round&&row.order.index===top.index);}
  const {order,...first}=group[0],states=new Set(group.map(row=>JSON.stringify([row.phase,row.coverage?.complete??null])));if(states.size===1)return first;coverage.tiedOutcomes++;return{kind:first.kind,selector:first.selector,phase:'conflicting',coverage:{complete:false},observedAt:first.observedAt,eventIds:group.map(row=>row.eventId).sort().slice(0,4),omittedEvents:Math.max(0,group.length-4),error:'Retained outcomes at the same host time disagree; inspect the original read receipts.'};
 }).sort((a,b)=>a.observedAt-b.observedAt||resource(a).localeCompare(resource(b)));
 coverage.resourcesOmitted=Math.max(0,outcomes.length-evidenceReadHistoryLimits.resources);return{outcomes:retainedEvidenceReads([],outcomes),coverage};
}
export function evidenceReadHistoryWarning(coverage){return coverage&&(coverage.limited||coverage.unverified||coverage.resourcesOmitted)?'Read history is bounded or contains unverified receipts; omitted or unverified outcomes remain unknown. Inspect retained read evidence before reusing a previous result.':'';}
