// Stable host-derived observations for peer notifications. Counts, times,
// evidence IDs and sample ordering must not turn repeated logs into chatter.
// This descriptor carries no incident routing, recovery or approval authority.
export function signalNotice(digest){
 const scope=digest?.incidentScope,coverage=digest?.coverage||{},failures=(digest?.groups||[]).filter(g=>/^[a-f0-9]{64}$/.test(g.key||'')&&(g.metadataIssues?.length||!['TRACE','DEBUG','INFO','WARN','WARNING'].includes(g.level))).map(g=>({key:g.key,level:g.level,scopeRelation:g.scopeRelation||'unknown'})).sort((a,b)=>a.key.localeCompare(b.key));
 return{version:1,available:Boolean(digest),scope:scope?.state==='reported'?{state:'reported',environment:scope.environment,region:scope.region,version:scope.version}:{state:'unknown'},failures,coverage:{candidateWindowLimited:coverage.candidateWindowLimited===true,unscanned:Number(coverage.recordsNotScanned)>0,partial:Number(coverage.partialResults)>0,missingTimes:Number(coverage.missingTimestamps)>0,invalidRecords:Number(coverage.invalidRecords)>0,...(Number(coverage.inconsistentMetadataRecords)>0?{inconsistentMetadata:true}:{}),omittedFailureGroups:Number(coverage.omittedGroups)>Number(coverage.omittedHealthSuccessGroups||0)}};
}

export function signalNoticeChanges(previous,current){
 const prior=new Map((previous?.version===1?previous.failures||[]:[]).map(g=>[g.key,JSON.stringify([g.level,g.scopeRelation])]));
 return{keys:current.failures.filter(g=>prior.get(g.key)!==JSON.stringify([g.level,g.scopeRelation])).map(g=>g.key)};
}
