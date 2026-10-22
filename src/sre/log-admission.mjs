// Threshold admission is stricter than display grouping. A caller must retain
// its raw source separately; no participant or log field can choose a service.
import {logFieldConsistency} from './log-field-consistency.mjs';
export function detectionLogFields(record){
 if(!record||typeof record!=='object'||Array.isArray(record))return{issues:['record'],scope:null,level:'',levels:[],code:undefined,at:NaN,errorHint:true,codes:[]};
 const {issues,values}=logFieldConsistency(record);
 const at=typeof record.timestamp==='number'?record.timestamp:typeof record.timestamp==='string'?Date.parse(record.timestamp):NaN;
 // Keep the established threshold projection and sample IDs. Additional
 // display aliases above can contradict it but do not silently remap a cache.
 const scope={environment:record['deployment.environment']||record.environment,region:record['cloud.region']||record.region||'unknown',version:record['service.version']||record.sha||'unknown'};
 const level=typeof(record.loglevel||record.level)==='string'?(record.loglevel||record.level).toUpperCase():'',code=record['error.code']||record.code;
 return{issues,scope,level,levels:values.level,code,at,errorHint:values.level.some(value=>['ERROR','FATAL'].includes(value))||issues.some(value=>value.startsWith('level:')),codes:values.code};
}

export function inspectDetectionLog(record,service){
 const fields=detectionLogFields(record),codes=new Set((service.logMonitors||[]).flatMap(rule=>rule.codes)),knownCode=fields.codes.some(code=>codes.has(code));
 const candidate=fields.issues.includes('record')||knownCode&&(fields.errorHint||fields.levels.length===0);
 if(!candidate)return{...fields,rejected:false};
 const issues=[...fields.issues];
 if(knownCode&&!fields.level)issues.push('level:mapping');
 if(knownCode&&!fields.code)issues.push('code:mapping');
 if(!Number.isSafeInteger(fields.at)||fields.at<0)issues.push('timestamp');
 if(!fields.scope?.environment)issues.push('environment:missing');
 return{...fields,issues,rejected:issues.length>0};
}

export function detectionSourceIssue(record,service,source){
 // The actual configured query field is the only reader-specific mapping.
 // Missing fields remain a source-contract limitation; do not invent an
 // entity/name alias or assume a relationship between namespaces.
 const config=source==='dynatrace-logs'?service.dynatraceLogs:null,field=config?.logField;
 if(field&&Object.hasOwn(record,field)&&record[field]!==config.logValue)return 'source-field:mismatch';
 return null;
}

export class LogAdmissionError extends Error{
 constructor(result){const reasons=Object.keys(result.coverage.reasons).sort().join(', ');super('Log detection excluded '+result.coverage.rejected+' invalid or contradictory candidate record(s): '+reasons+'. Accepted observations remain partial; inspect the source mapping before advancing this read.');this.name='LogAdmissionError';this.code='LOG_ADMISSION_INCOMPLETE';this.partialResult=result;}
}
