import {RulesReasoner,validateInvestigation,investigationSchema} from '../src/sre/reasoner.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {ledgerSourcePath} from './sre-source-references.mjs';
import {sourceFindingInput} from '../src/sre/source-references.mjs';

// This scripted output exercises the model-output boundary without invoking a
// model. It is not evidence of real Claude reasoning or diagnostic accuracy.
export const sourceOutputDouble=()=>({investigate:async(context,options)=>{
 const result=await new RulesReasoner().investigate(context,options),delivered=boundedContext(context),file=delivered.sourceCode?.files.find(file=>file.side==='head'&&file.path===ledgerSourcePath),line=file?.lines.find(line=>line.text.includes('WHERE auction_id = ?')&&!line.text.includes('AND version'));
 const data=Object.fromEntries(Object.keys(investigationSchema.properties).filter(key=>result.analysis[key]!==undefined).map(key=>[key,result.analysis[key]]));
 if(line){data.sourceFindings=[{evidenceId:file.evidenceId,provider:file.provider,project:file.project,sha:file.sha,path:file.path,startLine:line.line,endLine:line.line,quote:line.text,explanation:'The exact update predicate omits the expected version; compare concurrent requests and database behavior before selecting this as cause.'}];if(!data.evidenceIds.includes(file.evidenceId))data.evidenceIds.push(file.evidenceId);}
 return{analysis:{...validateInvestigation(data,context,{deliveredContext:delivered}),mode:'scripted source-output test double',codeReview:result.analysis.codeReview}};
}});

// Deterministic proposal planner for read-loop tests/rehearsals. This is not
// an actual Claude invocation or evidence of model diagnostic accuracy.
export function followupOutputDouble({requestsFor,beforeTurn}={}){
 const turns=[];
 return{turns,investigate:async(context,options)=>{
  const view=boundedContext(context);turns.push(view);await beforeTurn?.(context,view,options);
  const result=await new RulesReasoner().investigate(context,options),data=Object.fromEntries(Object.keys(investigationSchema.properties).filter(key=>result.analysis[key]!==undefined).map(key=>[key,result.analysis[key]]));
  const file=view.sourceCode?.files.find(file=>file.side==='requested-source'&&file.path==='src/ledger/retry.py'),line=file?.lines.find(line=>line.line===2);
  if(data.sourceFindings)data.sourceFindings=sourceFindingInput(data.sourceFindings);
  if(requestsFor)data.evidenceRequests=await requestsFor(context,view);
  else if(!line&&view.evidenceAcquisition?.enabled){const sha=view.sourceCode?.files.find(file=>file.side==='head')?.sha;if(sha)data.evidenceRequests=[{kind:'gitlab_file',sha,path:'src/ledger/retry.py',startLine:1,endLine:2,reason:'Inspect the unchanged retry predicate before attributing the concurrent-write failure.'}];}
  if(line&&!requestsFor){data.sourceFindings=[{evidenceId:file.evidenceId,provider:file.provider,project:file.project,sha:file.sha,path:file.path,startLine:2,endLine:2,quote:line.text,explanation:'Compare this exact retry predicate with the observed exception class and runtime behavior; the cause remains unknown.'}];if(!data.evidenceIds.includes(file.evidenceId))data.evidenceIds.push(file.evidenceId);}
  return{analysis:{...validateInvestigation(data,context,{deliveredContext:view}),mode:'scripted follow-up proposal test double',codeReview:result.analysis.codeReview}};
 }};
}
