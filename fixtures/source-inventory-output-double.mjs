import {RulesReasoner,validateInvestigation,investigationSchema} from '../src/sre/reasoner.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {sourceFindingInput} from '../src/sre/source-references.mjs';

// Controlled fixture planner, not a model or general diagnosis. It exercises
// the same host proposal policy that a future Claude response must satisfy.
export function inventoryOutputDouble({beforeTurn,refreshDirectories=false,readCallers=true}={}){
 const turns=[];return{turns,investigate:async(context,options)=>{
  const view=boundedContext(context);turns.push(view);await beforeTurn?.(context,view,options);
  const result=await new RulesReasoner().investigate(context,options),data=Object.fromEntries(Object.keys(investigationSchema.properties).filter(key=>result.analysis[key]!==undefined).map(key=>[key,result.analysis[key]]));
  if(data.sourceFindings)data.sourceFindings=sourceFindingInput(data.sourceFindings);
  const candidates=(view.sourceCode?.files||[]).filter(file=>file.side==='discovery-candidate'&&file.path==='src/ledger/retry.py'),inventories=view.sourceInventories?.inventories||[],files=(view.sourceCode?.files||[]).filter(file=>file.side==='requested-source'&&file.path==='src/ledger/handler.py'),requests=[];
  for(const candidate of candidates){const currentJob=context.jobs?.find(job=>job.status==='running')?.id,readThisJob=(context.evidence||[]).some(row=>row.kind==='source_inventory'&&row.content?.sourceInventory?.project===candidate.project&&row.content.sourceInventory.sha===candidate.sha&&row.content.sourceInventory.hostRead?.jobId===currentJob);const directory=inventories.find(item=>item.project===candidate.project&&item.sha===candidate.sha&&item.path==='src/ledger');
   if((!directory||refreshDirectories&&!readThisJob)&&view.evidenceAcquisition?.kinds.includes('gitlab_tree'))requests.push({kind:'gitlab_tree',project:candidate.project,sha:candidate.sha,path:'src/ledger',reason:'Controlled fixture: locate the caller beside the reported retry predicate.'});
   else if(readCallers&&directory&&!directory.conflicting&&directory.entries.some(entry=>entry.type==='blob'&&entry.path==='src/ledger/handler.py')&&!files.some(file=>file.project===candidate.project&&file.sha===candidate.sha)&&view.evidenceAcquisition?.kinds.includes('gitlab_file'))requests.push({kind:'gitlab_file',project:candidate.project,sha:candidate.sha,path:'src/ledger/handler.py',startLine:1,endLine:4,reason:'Controlled fixture: inspect the exact caller discovered in the directory before selecting a cause.'});
  }
  data.evidenceRequests=requests.slice(0,2);const findings=files.flatMap(file=>{const line=file.lines.find(line=>line.line===4);return line?[{evidenceId:file.evidenceId,provider:file.provider,project:file.project,sha:file.sha,path:file.path,startLine:4,endLine:4,quote:line.text,explanation:'This candidate caller delegates to the retry predicate. Compare the actual input, exception and running repository before attributing cause.'}]:[];});
  if(findings.length){data.sourceFindings=findings;data.evidenceIds=[...new Set([...data.evidenceIds,...findings.map(item=>item.evidenceId)])].slice(0,20);}
  return{analysis:{...validateInvestigation(data,context,{deliveredContext:view}),mode:'scripted directory-browsing test double',codeReview:result.analysis.codeReview}};
 }};
}
