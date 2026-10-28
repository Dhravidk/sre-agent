import {discoveryProject} from './source-discovery-config.mjs';
import {diagnosticLogFilters,diagnosticLogFilterSchema} from './diagnostic-log-query.mjs';
export const evidenceReadLimits=Object.freeze({rounds:3,requestsPerRound:2,requests:6,logQueries:2,logWindowMs:900000,logBytes:128000,logRecords:200,sourceLines:80});
const common={kind:{type:'string'},reason:{type:'string',minLength:1,maxLength:500}},file={...common,project:{type:'string',maxLength:128},kind:{const:'gitlab_file'},sha:{type:'string'},path:{type:'string',maxLength:512},startLine:{type:'integer',minimum:1,maximum:1000000},endLine:{type:'integer',minimum:1,maximum:1000000}},tree={...common,project:{type:'string',maxLength:128},kind:{const:'gitlab_tree'},sha:{type:'string'},path:{type:'string',maxLength:512}},logs={...common,kind:{const:'dynatrace_logs'},from:{type:'integer',minimum:0},to:{type:'integer',minimum:0},filters:diagnosticLogFilterSchema};
const required=fields=>Object.keys(fields).filter(key=>!['project','filters'].includes(key));
export const evidenceRequestSchema={oneOf:[{type:'object',additionalProperties:false,properties:tree,required:required(tree)},{type:'object',additionalProperties:false,properties:file,required:required(file)},{type:'object',additionalProperties:false,properties:logs,required:required(logs)}]};
export function validateEvidenceRequests(input){
 if(input===undefined)return [];
 if(!Array.isArray(input)||input.length>evidenceReadLimits.requestsPerRound)throw Error('Invalid follow-up evidence request list');
 return input.map(request=>{
  const fields=request?.kind==='gitlab_file'?file:request?.kind==='gitlab_tree'?tree:request?.kind==='dynatrace_logs'?logs:null;
  if(!fields||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!Object.hasOwn(fields,key))||required(fields).some(key=>!Object.hasOwn(request,key))||typeof request.reason!=='string'||!request.reason.trim()||[...request.reason].length>500)throw Error('Invalid follow-up evidence request shape');
  if(['gitlab_file','gitlab_tree'].includes(request.kind)&&(Object.hasOwn(request,'project')&&!discoveryProject(request.project)||typeof request.path!=='string'||request.path.length>512||typeof request.sha!=='string'||request.sha.length>64||request.kind==='gitlab_file'&&(!Number.isSafeInteger(request.startLine)||!Number.isSafeInteger(request.endLine)||request.startLine<1||request.endLine<1||request.startLine>1000000||request.endLine>1000000)))throw Error('Invalid requested source selector');
  if(request.kind==='dynatrace_logs'&&(!Number.isSafeInteger(request.from)||!Number.isSafeInteger(request.to)||request.from<0||request.to<0))throw Error('Invalid requested log window');
  const result=Object.fromEntries(Object.keys(fields).filter(key=>Object.hasOwn(request,key)).map(key=>[key,request[key]]));
  if(request.kind==='dynatrace_logs'){const filters=diagnosticLogFilters(request.filters);if(filters.length)result.filters=filters;else delete result.filters;}
  return result;
 });
}
export function validateFollowupConfiguration(service){
 if(service.investigation===undefined)return;
 const investigation=service.investigation,followup=investigation?.followUp;
 if(!investigation||typeof investigation!=='object'||Array.isArray(investigation)||Object.keys(investigation).some(key=>key!=='followUp')||!followup||typeof followup!=='object'||Array.isArray(followup)||Object.keys(followup).length!==1||typeof followup.enabled!=='boolean')throw Error('investigation.followUp requires only an explicit enabled boolean');
}
export const evidenceReadResource=item=>JSON.stringify(['gitlab_file','gitlab_tree'].includes(item.kind)?[item.kind,...(item.selector?.project?[item.selector.project]:[]),item.selector?.sha,item.selector?.path]:item.selector?.filters?.length?[item.kind,item.selector.from,item.selector.to,item.selector.filters]:[item.kind]);
const outcomeKey=evidenceReadResource;
export function retainedEvidenceReads(previous,current){
 const rows=new Map();for(const row of [...(previous||[]),...(current||[])]){if(!row||!['gitlab_file','gitlab_tree','dynatrace_logs'].includes(row.kind)||typeof row.phase!=='string')continue;const key=outcomeKey(row);if(row.phase==='duplicate'&&rows.has(key))continue;rows.set(key,row);}return[...rows.values()].slice(-8);
}
export const materialEvidenceReads=rows=>(rows||[]).map(item=>[outcomeKey(item),item.phase,item.coverage?.complete===false?'partial':item.coverage?.complete===true?'complete':'unknown']).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function evidenceReadText(item){
 const target=['gitlab_file','gitlab_tree'].includes(item.kind)?(item.selector?.project?item.selector.project+' / ':'')+String(item.selector?.path||(item.kind==='gitlab_tree'?'[repository root]':'source'))+' @ '+String(item.selector?.sha||'').slice(0,12):'configured service log window';return target+' · '+item.phase+(item.coverage?.complete===false?' · partial coverage':'')+(item.error?' · '+String(item.error).slice(0,180):'');
}
