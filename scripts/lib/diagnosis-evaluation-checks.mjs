// Author-side evaluation only. No oracle fields enter model context.
export function diagnosisEvaluationChecks({analysis,context,state,provider}){
 const expected=state.expected,source=expected.source,findings=[...(analysis.codeFindings||[]).map(f=>({...f,startLine:f.lineStart,endLine:f.lineEnd})),...(analysis.sourceFindings||[])];
 const logReads=context.evidence.filter(row=>row.kind==='logs'&&row.content.followUp),cited=new Set([...(analysis.evidenceIds||[]),...(analysis.remediation?.evidenceIds||[]),...(analysis.issueSpec?.evidenceIds||[]),...(analysis.codeFindings||[]).flatMap(f=>f.corroboratingEvidenceIds||[])]);
 const checks={
  actualProvider:analysis.mode===provider,
  followUpLogRead:logReads.length>0,
  exactSource:expected.sourceAvailable?findings.some(f=>f.path===source.path&&f.sha===state.entry.revisions.observed&&f.startLine<=source.line&&f.endLine>=source.line&&f.endLine-f.startLine<=8):source?findings.every(f=>f.sha!==state.entry.revisions.observed):findings.length===0,
  recoveryStrategy:expected.remediation.includes(analysis.remediation?.kind),
  rollbackTarget:analysis.remediation?.targetSha===(analysis.remediation?.kind==='rollback-candidate'?expected.target:null),
  attribution:expected.candidate===null?analysis.candidateSha===null:state.entry.denyObservedSource?analysis.candidateSha===null||analysis.candidateSha===expected.candidate:analysis.candidateSha===expected.candidate,
  followUpCited:logReads.some(row=>cited.has(row.id)),
  developerSpec:Boolean(analysis.issueSpec?.acceptanceCriteria?.length&&analysis.issueSpec?.openQuestions?.length)
 };
 if(expected.attribution){
  checks.attributionClass=analysis.changeAssessment===expected.attribution;
  // Finding the right helper alongside false accusations is not a pass. The
  // exact-location validator separately checks delivered bytes/quotes/scope.
  checks.noFalseCandidateFiles=source?findings.every(f=>f.path===source.path&&f.provider==='gitlab'&&(!f.project||f.project===state.entry.project)&&Object.values(state.entry.revisions).includes(f.sha)):findings.length===0;
 }
 return{checks,findings,logReads};
}
