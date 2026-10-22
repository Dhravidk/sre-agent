import {hash} from './security.mjs';
import {sourceScopeForService,sourceTextPath,readImmutableSource,sourceReadBudget} from './source-evidence.mjs';
import {logFieldConsistency} from './log-field-consistency.mjs';

export const logSourceLimits=Object.freeze({records:2000,files:2,locationsPerFile:4});
const logRow=row=>['dynatrace','dynatrace-logs','logs'].includes(row.source)&&['log','logs'].includes(row.kind);
const records=row=>Array.isArray(row.content?.records)?row.content.records:[row.content];
export function reportedLogLocation(record,scope){
 const mapping=scope?.logLocations;if(!mapping||!record||typeof record!=='object'||Array.isArray(record))return null;
 const {issues,values}=logFieldConsistency(record,{emptyIsMissing:true});
 if(issues.length||!values.environment.length||values.environment[0]!==scope.logEnvironment||!['ERROR','FATAL','CRITICAL'].includes(values.level[0]))return null;
 const raw=record[mapping.pathField],line=record[mapping.lineField],sha=record[mapping.revisionField];
 if(typeof raw!=='string'||raw.length>768||!raw.startsWith(mapping.pathPrefix)||!Number.isSafeInteger(line)||line<1||line>1000000||typeof sha!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))return null;
 const path=raw.slice(mapping.pathPrefix.length);return sourceTextPath(path)?{path,line,sha}:null;
}
export function reportedLogSources(context,scope){
 const files=new Map(),seen=new Set(),coverage={recordsAvailable:0,recordsScanned:0,reportedLocations:0,locationsIncluded:0,locationsOmitted:0,unavailableLocations:0,filesIncluded:0,unavailableFiles:0,completeHistory:false};
 for(const row of context.evidence||[]){if(!logRow(row))continue;const entries=records(row);coverage.recordsAvailable+=entries.length;
  for(let index=0;index<entries.length&&coverage.recordsScanned<logSourceLimits.records;index++){
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
 const row=(context.evidence||[]).find(row=>row.id===location.evidenceId&&logRow(row));if(!row)return false;const record=records(row)[location.recordIndex];if(record===undefined||hash(record)!==location.recordHash)return false;
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
