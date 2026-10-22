// The model selects exact values already delivered as evidence. Only the host
// constructs DQL; none of these fields can change tenant/service/environment.
import {logInvestigationOptions} from './dynatrace-log-investigation.mjs';

export const diagnosticLogFields=Object.freeze(['operation','http.route','service.version','trace.id','error.code']);
export const diagnosticLogFilterSchema={type:'array',maxItems:3,items:{type:'object',additionalProperties:false,properties:{field:{type:'string',enum:[...diagnosticLogFields]},value:{type:'string',minLength:1,maxLength:256}},required:['field','value']}};
export function diagnosticLogFilters(input=[]){
 if(!Array.isArray(input)||input.length>3)throw Error('Invalid diagnostic log filters');
 const seen=new Set();
 return input.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).length!==2||!Object.hasOwn(item,'field')||!Object.hasOwn(item,'value')||!diagnosticLogFields.includes(item.field)||seen.has(item.field)||typeof item.value!=='string'||!item.value.trim()||[...item.value].length>256||/[\u0000-\u001f\u007f]/.test(item.value))throw Error('Invalid diagnostic log filter selector');
  seen.add(item.field);return{field:item.field,value:item.value};
 }).sort((a,b)=>a.field.localeCompare(b.field));
}
export function observedDiagnosticLogFilters(snapshot){
 const values=new Map(diagnosticLogFields.map(field=>[field,new Set()]));
 for(const row of snapshot.evidence||[])if(row.source==='dynatrace'&&['logs','log_triage'].includes(row.kind))for(const record of Array.isArray(row.content?.records)?row.content.records:[]){
  for(const field of diagnosticLogFields){const value=record?.[field],set=values.get(field);if(set.size>=16)continue;try{diagnosticLogFilters([{field,value}]);set.add(value);}catch{/* Unsupported/missing values stay unavailable. */}}
 }
 return[...values].filter(([,set])=>set.size).map(([field,set])=>({field,values:[...set]}));
}

export async function readDiagnosticLogs(client,{from,to,environment,filters=[],signal}={}){
 filters=diagnosticLogFilters(filters);
 if(client.config.mode!=='grail'||!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(client.config.logField||'')||typeof client.config.logValue!=='string'||!client.config.logValue.trim())throw Error('Configure an exact Grail service log scope');
 if(!Number.isSafeInteger(from)||from<0||!Number.isSafeInteger(to)||to<=from||to-from>900000||!Number.isFinite(new Date(to).getTime())||typeof environment!=='string'||!environment.trim()||environment.length>256)throw Error('Diagnostic logs require a scoped environment and at most fifteen minutes');
 const options=logInvestigationOptions(client.config),deadline=AbortSignal.timeout(options.timeoutMs),querySignal=signal?AbortSignal.any([signal,deadline]):deadline;
 const scope=[{field:client.config.logField,value:client.config.logValue},{field:options.environmentField,value:environment},...filters];
 const query='fetch logs, samplingRatio:1 | filter '+scope.map(({field,value})=>field+' == '+JSON.stringify(value)).join(' and ')+' | filter timestamp >= toTimestamp('+JSON.stringify(new Date(from).toISOString())+') and timestamp < toTimestamp('+JSON.stringify(new Date(to).toISOString())+') | sort timestamp desc | limit 200';
 const result=await client.query(query,{from,to,signal:querySignal,scanLimitGbytes:options.scanLimitGbytes,fetchTimeoutSeconds:10});
 if(querySignal.aborted)throw querySignal.reason;
 if(!Array.isArray(result.records)||result.records.length>200)throw Error('Invalid bounded diagnostic log response');
 let missingTimes=0;
 for(const row of result.records){
  if(!row||typeof row!=='object'||Array.isArray(row)||scope.some(({field,value})=>row[field]!==value))throw Error('Diagnostic log result is outside its service/environment/filter scope');
  const value=row.timestamp,at=typeof value==='number'&&Number.isSafeInteger(value)?value:typeof value==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
  if(!Number.isSafeInteger(at)){missingTimes++;continue;}
  if(at<from||at>=to)throw Error('Diagnostic log result is outside its requested time window');
 }
 const grail=result.metadata?.grail,complete=result.complete===true&&result.records.length<200&&!missingTimes&&grail?.sampled===false&&Array.isArray(grail.notifications)&&grail.notifications.every(note=>note?.severity==='INFO');
 return{...result,complete,queryScope:{version:1,from,to,environment,service:{field:client.config.logField,value:client.config.logValue},filters},interpretation:'Scoped diagnostic selection, not the full incident population. Empty, sampled, capped, missing-time or incomplete results cannot prove health, absence, causation or rollback safety.'};
}
