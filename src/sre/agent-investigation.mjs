// The model proposes diagnoses and specifications. The host binds references
// to the exact evidence it delivered; no field grants execution authority.
import {deploymentBlockers,deploymentHistory} from './deployments.mjs';
const compatibilityFields=['schemaVersion','dependencyFingerprint','configurationFingerprint','featureFlagsFingerprint'];
const knownCompatibility=(field,value)=>typeof value==='string'&&value.trim().length>0||field==='schemaVersion'&&Number.isSafeInteger(value)&&value>=0;
const text = (maxLength=2000) => ({type:'string',minLength:1,maxLength});
const strings = (maxItems=10) => ({type:'array',items:text(),maxItems});
export const agentInvestigationProperties = {
  remediation:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['rollback-candidate','forward-fix','dependency-mitigation','collect-evidence']},targetSha:{type:['string','null'],maxLength:64},rationale:text(),verificationSteps:strings(),evidenceIds:strings(20),blockingUnknowns:strings()},required:['kind','targetSha','rationale','verificationSteps','evidenceIds','blockingUnknowns']},
  codeFindings:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,properties:{evidenceId:text(256),provider:{type:'string',enum:['gitlab','github']},path:text(512),sha:text(64),lineStart:{type:'integer',minimum:1},lineEnd:{type:'integer',minimum:1},explanation:text(),corroboratingEvidenceIds:strings(10)},required:['evidenceId','provider','path','sha','lineStart','lineEnd','explanation','corroboratingEvidenceIds']}},
  issueSpec:{type:'object',additionalProperties:false,properties:{title:text(200),problem:text(),impact:text(),proposedChange:text(),acceptanceCriteria:strings(),evidenceIds:strings(20),openQuestions:strings()},required:['title','problem','impact','proposedChange','acceptanceCriteria','evidenceIds','openQuestions']},
  teamsMessages:{type:'array',maxItems:4,items:{type:'object',additionalProperties:false,properties:{roomKey:text(128),text:text(2000),evidenceIds:strings(20)},required:['roomKey','text','evidenceIds']}}
};

function check(value,schema,name) {
  if(Array.isArray(schema.type)){if(value===null&&schema.type.includes('null'))return;return check(value,{...schema,type:'string'},name);}
  if(schema.type==='string'&&(typeof value!=='string'||!value.trim()||[...value].length>schema.maxLength||schema.enum&&!schema.enum.includes(value)))throw Error('Invalid agent '+name);
  if(schema.type==='integer'&&(!Number.isSafeInteger(value)||value<schema.minimum))throw Error('Invalid agent '+name);
  if(schema.type==='array'){
    if(!Array.isArray(value)||value.length>schema.maxItems)throw Error('Invalid agent '+name);
    value.forEach((entry,i)=>check(entry,schema.items,name+'['+i+']'));
  }
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(value,k)))throw Error('Invalid agent '+name);
    for(const [key,item]of Object.entries(value))check(item,schema.properties[key],name+'.'+key);
  }
}
export function validateAgentInvestigation(data,context){
  const evidence=new Map(context.evidence.map(row=>[row.id,row]));
  const citations=ids=>{if(ids.some(id=>!evidence.has(id)))throw Error('Agent reference is outside delivered incident evidence');};
  for(const [key,schema]of Object.entries(agentInvestigationProperties))if(data[key]!==undefined)check(data[key],schema,key);
  for(const finding of data.codeFindings||[]){
    citations([finding.evidenceId,...finding.corroboratingEvidenceIds]);
    const row=evidence.get(finding.evidenceId),file=row.content?.sourceFiles?.find(file=>file.path===finding.path&&file.sha===finding.sha);
    if(row.source!==finding.provider||!file||typeof file.content!=='string'||!Number.isSafeInteger(file.startLine)||file.startLine<1||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(finding.sha)||finding.lineEnd<finding.lineStart||finding.lineStart<file.startLine||finding.lineEnd>=file.startLine+file.content.replace(/\n$/,'').split('\n').length)throw Error('Agent code location is not present in the delivered immutable source');
  }
  if(data.issueSpec)citations(data.issueSpec.evidenceIds);
  if(data.remediation){
    const r=data.remediation;citations(r.evidenceIds);
    if(r.kind!=='rollback-candidate'&&r.targetSha!==null)throw Error('Agent rollback target is only valid for a rollback candidate');
    if(r.kind==='rollback-candidate'){
      const history=deploymentHistory(context.deployments).sort((a,b)=>b.at-a.at),current=history.find(d=>d.sha===data.candidateSha),target=history.find(d=>d.sha===r.targetSha&&d.sha!==current?.sha&&d.at<current?.at&&d.healthy===true&&Number.isSafeInteger(d.healthVerifiedAt)&&d.healthVerifiedAt>=d.at&&d.healthVerifiedAt<=context.incident.started_at);
      if(!current||!target||!['gitlab','github'].includes(current.provider)||current.rollbackCompatible!==true||current.dataRollbackSafe!==true||!current.environment||current.environment!==context.riskScope?.environment||['provider','environment','repository','project'].some(k=>current[k]!==target[k])||compatibilityFields.some(k=>!knownCompatibility(k,current[k])||!knownCompatibility(k,target[k])||current[k]!==target[k])||[current,target].some(d=>!(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(d.sha||''))||!/^(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(d.artifact||'')))throw Error('Agent rollback candidate lacks matching healthy artifacts and verified compatibility');
      const repository=current.provider==='gitlab'?current.project:current.repository;
      if(data.changeAssessment!=='likely'||current.at>context.incident.started_at||typeof repository!=='string'||!repository.trim()||[current,target].some(d=>d.status!=='success'||!Number.isSafeInteger(d.at)||d.at<0)||deploymentBlockers(context.deployments,current).length||target.identityConflict||target.statusConflict||target.attestationConflicts?.length||target.historyIncomplete)throw Error('Agent rollback candidate has unverified or conflicting deployment identity/history');
    }
  }
  const rooms=new Set((context.collaboration?.rooms||[]).map(room=>room.key)),seen=new Set();
  for(const message of data.teamsMessages||[]){
    citations(message.evidenceIds);
    if(!rooms.has(message.roomKey)||seen.has(message.roomKey))throw Error('Agent message destination is outside the incident audience or duplicated');
    seen.add(message.roomKey);
  }
}
export function remediationText(remediation){
  if(!remediation)return '';
  return ['Recovery proposal (read-only): '+remediation.kind,remediation.rationale,...(remediation.targetSha?['Candidate target: '+remediation.targetSha]:[]),...remediation.verificationSteps.map(s=>'Verify: '+s),...remediation.blockingUnknowns.map(s=>'Unresolved: '+s),'This draft does not authorize execution. Current deployment, freshness, policy and independent approval must be checked by the host.'].join('\n');
}
export function issueSpecMarkdown(spec){
  if(!spec)return '';
  const clean=s=>String(s).replace(/\r/g,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
  return ['## Issue specification',clean(spec.title),'','### Problem',clean(spec.problem),'','### Impact',clean(spec.impact),'','### Proposed change',clean(spec.proposedChange),'','### Acceptance criteria',...spec.acceptanceCriteria.map(s=>'- '+clean(s)),'','### Open questions',...spec.openQuestions.map(s=>'- '+clean(s)),'','### Evidence',...spec.evidenceIds.map(id=>'- Evidence `'+clean(id)+'`'),'','Draft for review; source references establish location, not proven causality or verified recovery.'].join('\n');
}
