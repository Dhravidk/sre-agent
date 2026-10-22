import {hash} from './security.mjs';
import {sourceScopeForService,sourceTextPath,readImmutableSource,sourceReadBudget} from './source-evidence.mjs';
import {logFieldConsistency} from './log-field-consistency.mjs';
import {logRecordHash} from './log-observation.mjs';

export const logSourceLimits=Object.freeze({records:2000,files:2,locationsPerFile:4});
const logRow=row=>['dynatrace','dynatrace-logs','logs'].includes(row.source)&&['log','logs'].includes(row.kind);
const records=row=>Array.isArray(row.content?.records)?row.content.records:[row.content];
const triageRow=row=>row.source==='dynatrace'&&row.kind==='log_triage'&&row.content?.hostDataReduction===true;
const verifiedSample=(context,row,index)=>triageRow(row)&&context.logSourceSamples?.some(sample=>sample.evidenceId===row.id&&sample.recordIndex===index&&sample.recordHash===hash(records(row)[index]));

// Verify only bounded selected points against the retained original bytes.
// Raw pages stay out of the ordinary context/model window. Missing, changed or
// shortened samples cannot manufacture a reported source location.
export async function verifiedLogSourceSamples(context,query){
 if(!context.sourceScope?.logLocations)return [];
 const result=[],cache=new Map();let inspected=0;
 const read=async id=>{
  if(!cache.has(id)){
   const [row]=await query("SELECT id,source,kind,content FROM sre_evidence WHERE id=? AND incident_id=?",[id,context.incident.id]);
   let content;try{content=typeof row?.content==='string'?JSON.parse(row.content):row?.content;}catch{}
   cache.set(id,row&&content&&row.source==='dynatrace'&&hash([context.incident.id,row.source,row.kind,content])===row.id?{...row,content}:null);
  }
  return cache.get(id);
 };
 for(const row of context.evidence||[]){
  if(!triageRow(row))continue;
  for(const [index,sample]of records(row).entries()){
   if(inspected>=logSourceLimits.files*logSourceLimits.locationsPerFile)return result;
   const origin=row.content.triage?.sampleOrigins?.[index];
   if(!sample||sample.projectionTruncated===true||!reportedLogLocation(sample,context.sourceScope)||!Number.isSafeInteger(origin?.recordIndex)||origin.recordIndex<0||origin.recordIndex>=100000||typeof row.content.derivedFrom!=='string')continue;
   inspected++;const parent=await read(row.content.derivedFrom);if(parent?.kind!=='logs')continue;
   let original,rawEvidenceId=parent.id;
   if(Array.isArray(parent.content.rawPages)){
    const retention=parent.content.retention,offset=Math.floor(origin.recordIndex/500)*500;
    if(retention?.pageSize!==500||!Number.isSafeInteger(retention.recordsRetained)||origin.recordIndex>=retention.recordsRetained)continue;
    const pageId=parent.content.rawPages[offset/500];if(typeof pageId!=='string')continue;
    const page=await read(pageId);if(page?.kind!=='log_page'||page.content.offset!==offset||!Array.isArray(page.content.records)||page.content.records.length>500)continue;
    original=page.content.records[origin.recordIndex-offset];rawEvidenceId=page.id;
   }else original=parent.content.records?.[origin.recordIndex];
   if(original===undefined||hash(original)!==hash(sample)||logRecordHash('dynatrace',original)!==origin.recordHash)continue;
   result.push({evidenceId:row.id,recordIndex:index,recordHash:hash(sample),parentEvidenceId:parent.id,rawEvidenceId,rawRecordIndex:origin.recordIndex});
  }
 }
 return result;
}
export function reportedLogLocation(record,scope){
 const mapping=scope?.logLocations;if(!mapping||!record||typeof record!=='object'||Array.isArray(record))return null;
 const {issues,values}=logFieldConsistency(record,{emptyIsMissing:true});
 if(issues.length||!values.environment.length||values.environment[0]!==scope.logEnvironment||!['ERROR','FATAL','CRITICAL'].includes(values.level[0]))return null;
 const raw=record[mapping.pathField],line=record[mapping.lineField],sha=record[mapping.revisionField];
 if(typeof raw!=='string'||raw.length>768||!raw.startsWith(mapping.pathPrefix)||!Number.isSafeInteger(line)||line<1||line>1000000||typeof sha!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))return null;
 const path=raw.slice(mapping.pathPrefix.length);return sourceTextPath(path)?{path,line,sha}:null;
}
export function reportedLogSources(context,scope){
 const files=new Map(),seen=new Set(),coverage={recordsAvailable:0,recordsScanned:0,derivedSamplesScanned:0,reportedLocations:0,locationsIncluded:0,locationsOmitted:0,unavailableLocations:0,filesIncluded:0,unavailableFiles:0,completeHistory:false};
 const rows=[...(context.evidence||[])].sort((a,b)=>Number(triageRow(b))-Number(triageRow(a)));
 for(const row of rows){if(!logRow(row)&&!triageRow(row))continue;const entries=records(row);coverage.recordsAvailable+=entries.length;
  for(let index=0;index<entries.length&&coverage.recordsScanned<logSourceLimits.records;index++){
   if(triageRow(row)&&!verifiedSample(context,row,index))continue;
   if(triageRow(row))coverage.derivedSamplesScanned++;
   coverage.recordsScanned++;const location=reportedLogLocation(entries[index],scope);if(!location)continue;
   const key=JSON.stringify([location.sha,location.path]),identity=JSON.stringify([key,location.line]);if(seen.has(identity))continue;seen.add(identity);coverage.reportedLocations++;
   if(!files.has(key)&&files.size<logSourceLimits.files)files.set(key,{path:location.path,sha:location.sha,locations:[]});const file=files.get(key);
   if(!file||file.locations.length>=logSourceLimits.locationsPerFile)continue;
   file.locations.push({evidenceId:row.id,recordIndex:index,recordHash:hash(entries[index]),line:location.line});coverage.locationsIncluded++;
  }
 }
 coverage.locationsOmitted=coverage.reportedLocations-coverage.locationsIncluded;coverage.filesIncluded=files.size;return{files:[...files.values()],coverage};
}
export function validReportedLocation(location,file,context){
 if(!location||typeof location.evidenceId!=='string'||!Number.isSafeInteger(location.recordIndex)||location.recordIndex<0)return false;
 const row=(context.evidence||[]).find(row=>row.id===location.evidenceId&&(logRow(row)||verifiedSample(context,row,location.recordIndex)));if(!row)return false;const record=records(row)[location.recordIndex];if(record===undefined||hash(record)!==location.recordHash)return false;
 const reported=reportedLogLocation(record,context.sourceScope);return reported?.path===file.path&&reported.sha===file.sha&&reported.line===location.line;
}
export async function collectLogSourceEvidence(context,{service,client,budget=sourceReadBudget(),signal}={}){
 const scope=sourceScopeForService(service);if(!scope?.logLocations)return null;
 const selected=reportedLogSources(context,scope),files=[];
 for(const file of selected.files){const value=await readImmutableSource(file.path,file.sha,{service,client,budget,signal});const locations=file.locations.filter(location=>value.state!=='available'||location.line<=value.lineCount);
  selected.coverage.unavailableLocations+=file.locations.length-locations.length;files.push({...value,locations,ranges:locations.map(location=>({startLine:Math.max(1,location.line-5),endLine:location.line+5}))});if(value.state!=='available')selected.coverage.unavailableFiles++;
 }
 return {version:1,provider:scope.provider,project:scope.project,mapping:scope.logLocations,environment:scope.logEnvironment,files,coverage:selected.coverage,interpretation:'The configured log fields report a source location and revision. Retrieved bytes verify that location only; the reported revision is not an independently observed deployment and a location match does not establish cause.'};
}
