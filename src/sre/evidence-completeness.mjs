const positive=value=>Number.isFinite(value)&&value>0;
const fewer=(available,included)=>Number.isFinite(available)&&Number.isFinite(included)&&included<available;

// Known omissions constrain confidence; absence of an omission flag is not
// proof of health, causality or complete source-system visibility.
export function incompleteEvidence(context){
  const c=context.coverage||{},w=context.evidenceWindow||{},s=c.sourceWindow||{},d=context.signalDigest?.coverage||{};
  if(c.metadataTruncated===true||positive(c.truncatedEvidence)||s.candidatesLimited===true||w.candidatesLimited===true)return true;
  if(fewer(c.totalAvailable,c.included)||fewer(c.snapshotAvailable,c.included)||fewer(c.deploymentsAvailable,c.deploymentsIncluded))return true;
  if(d.candidateWindowLimited===true||['recordsNotScanned','partialResults','omittedGroups','omittedChanges','omittedDeployments','missingTimestamps','invalidRecords'].some(key=>positive(d[key])))return true;
  return (context.evidence||[]).some(row=>row.kind==='connector_error'||row.content?.synthetic===true||row.content?.complete===false||row.content?.policySources?.complete===false||row.content?.truncated===true||positive(row.content?.sourceCoverage?.omitted)||row.content?.sourceCoverage?.errors?.length>0||row.content?.sourceFiles?.some(file=>file.complete===false));
}
