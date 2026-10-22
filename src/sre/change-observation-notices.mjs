import {latestChangeState} from './change-read.mjs';
import {parseChangeTimelineFact,changeTimelineLimits} from './change-timeline.mjs';
import {pollScopeHash} from './poll-scope.mjs';
import {hash} from './security.mjs';
import {StorageError} from './database.mjs';

const sha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const adverse=ci=>ci.state==='observed-version'&&/^(?:failed|failure|error|timed_out|cancelled|canceled)$/i.test(ci.status);
const rank=ci=>ci.state!=='observed-version'?0:adverse(ci)?1:2;
export const changeObservationNoticeLimits=Object.freeze({changes:100,runs:3});

function readRegistry(value,revision){
  if(value===undefined||value===null)return {changes:new Map(),runs:new Map()};
  try{
    if(value.version!==1||!Number.isSafeInteger(revision)||revision<0)throw Error();
    const result={};
    for(const [name,limit]of [['changes',changeObservationNoticeLimits.changes],['runs',changeTimelineLimits.groups]]){
      if(!Array.isArray(value[name])||value[name].length>limit)throw Error();
      const rows=new Map();
      for(const row of value[name]){
        if(!/^[a-f0-9]{64}$/.test(row.key)||!/^[a-f0-9]{64}$/.test(row.stateHash)||!Number.isSafeInteger(row.changedRevision)||row.changedRevision<0||row.changedRevision>revision||rows.has(row.key))throw Error();
        rows.set(row.key,row);
      }
      result[name]=rows;
    }
    return result;
  }catch{throw new StorageError(new Error('Invalid saved change-notification registry'));}
}
function observationRecord(key,state,previous,revision,{attention=true}={}){
  const stateHash=hash(state),prior=previous.get(key);
  return {key,stateHash,changedRevision:prior?.stateHash===stateHash?prior.changedRevision:(prior?.changedRevision>0||attention?revision:0)};
}

// Omission counts and display priority may change on a routine passing run.
// Only substantive observations and adverse/uncertain coverage affect notices.
export function materialChangeObservations(changes=[]){
  return changes.map(c=>({provider:c.provider,number:c.number,state:c.state,headSha:c.headSha,heads:c.heads,stage:c.stage,status:c.status,ci:c.ci?.filter(run=>run.attention!==false).map(({attention,...run})=>run),ciLimited:c.ciLimited,ciAttention:c.ciAttention||null}));
}

// Host-owned material state for linked changes, including webhook-only setups.
// Delivery IDs, source timestamps, replay counts and untrusted prose are deliberately
// absent: a repeated observation must not become another proactive message.
export async function changeObservationNotices(store,context,service,casework){
  const revision=Number(context.incident.revision),previous=readRegistry(context.incident.analysis?.observedChangeRegistry,revision),runRegistry=new Map(),changeRegistry=[];
  const registry=()=>({version:1,changes:changeRegistry.sort((a,b)=>a.key.localeCompare(b.key)),runs:[...runRegistry.values()].sort((a,b)=>a.key.localeCompare(b.key))});
  if(!casework||!context.changeAssociations?.links?.length)return {changes:[],limited:false,registry:registry()};
  const timeline=await casework.timeline(context.incident.id,context),changes=[];
  for(const link of timeline.links.slice(0,changeObservationNoticeLimits.changes)){
    if(link.historicalAfterRestore)continue;
    const {latest,identities,conflicting}=await latestChangeState(store.db.query,service.key,link.provider,link.change_number,store.db.dialect);
    if(!latest)continue;
    const fact=parseChangeTimelineFact(latest),fence=context.recoveryFence;
    if(fence&&fact.received_at<fence.preparedAt)continue;
    const overflow=identities.length>=5,heads=overflow?[]:[...new Set(identities.map(row=>row.head_sha).filter(sha))].sort();
    const headSha=!conflicting&&sha(fact.head_sha)?fact.head_sha:null;
    const project=/^[1-9]\d*$/.test(String(service.gitlab?.project))?String(service.gitlab.project):null;
    const ciCoverage=link.provider==='gitlab'&&project!==null&&timeline.ciCoverage?.project===project&&timeline.ciCoverage.scopeHash===pollScopeHash(service,'gitlab')&&timeline.ciCoverage.heads.find(row=>row.headSha===headSha);
    const matches=timeline.groups.filter(group=>headSha&&group.provider===link.provider&&group.stage==='ci-update'&&group.headSha===headSha&&group.relevance.kind==='linked-commit'&&group.relevance.references.some(ref=>ref.provider===link.provider&&ref.number===link.change_number&&ref.state==='linked')&&!(group.provider==='gitlab'&&project&&group.projectId!==null&&String(group.projectId)!==project)&&!(ciCoverage&&group.provider==='gitlab'&&group.scopeHash===timeline.ciCoverage.scopeHash&&!group.ciReserved));
    const runs=matches.map(group=>{
      // GitLab ingestion records its configured scope in a checked projection.
      // An old unscoped webhook cannot acquire that proof retrospectively.
      const scoped=group.provider==='gitlab'&&group.scopeHash===pollScopeHash(service,'gitlab')&&Number.isSafeInteger(group.projectId)&&String(group.projectId)===String(service.gitlab?.project);
      const latestSources=group.latest.at===null?group.sources:group.sources.filter(source=>source.timeKind==='updated'&&source.sourceAt===group.latest.at);
      const historical=Boolean(fence&&latestSources.some(source=>source.recordedBeforeRestore));
      const state=historical?'historical':!scoped?'scope-unknown':group.unversionedCount?'unversioned':group.latest.state==='conflicting'?'conflicting':timeline.limited&&!group.ciVersionChecked?'coverage-limited':group.latest.state;
      const statuses=state==='unversioned'?[...new Set(group.sources.map(source=>source.status))].sort():group.latest.statuses;
      const summary={id:group.run?.id||null,label:group.run?.label||'CI reports',resourceKey:group.run?.resourceKey||null,state,status:state==='observed-version'?group.latest.status:null,statuses};
      const key=hash([group.provider,group.scopeHash,group.projectId,group.headSha,summary.id,summary.resourceKey]),record=observationRecord(key,summary,previous.runs,revision,{attention:rank(summary)<2});
      runRegistry.set(key,record);return {key,summary,changedRevision:record.changedRevision};
    }).sort((a,b)=>b.changedRevision-a.changedRevision||rank(a.summary)-rank(b.summary)||a.key.localeCompare(b.key));
    const selected=runs.slice(0,changeObservationNoticeLimits.runs),omitted=runs.slice(selected.length),count=(rows,category)=>rows.filter(row=>category==='adverse'?adverse(row.summary):category==='uncertain'?row.summary.state!=='observed-version':rank(row.summary)===2).length;
    const scopedRuns=runs.filter(row=>matches.some(group=>group.ciReserved&&group.run?.id===row.summary.id)),totals=!context.recoveryFence&&ciCoverage,extraAdverse=Number.isSafeInteger(totals?.adverse)?Math.max(0,totals.adverse-count(scopedRuns,'adverse')):0,extraUncertain=Number.isSafeInteger(totals?.uncertain)?Math.max(0,totals.uncertain-count(scopedRuns,'uncertain')):0,extraOther=Number.isSafeInteger(totals?.runs)?Math.max(0,totals.runs-scopedRuns.length-extraAdverse-extraUncertain):0;
    const attention=runs.filter(row=>rank(row.summary)<2).map(row=>[row.key,hash(row.summary)]).sort((a,b)=>a[0].localeCompare(b[0]));
    if(extraAdverse||extraUncertain)attention.push(['outside-window',extraAdverse,extraUncertain]);
    const change={provider:link.provider,number:link.change_number,state:conflicting?'conflicting':'observed',headSha,heads,stage:conflicting?null:fact.stage,status:conflicting?null:fact.sourceStatus,ci:selected.map(row=>({...row.summary,attention:row.changedRevision>0})),ciLimited:overflow||timeline.limited||runs.length>changeObservationNoticeLimits.runs,ciAttention:{adverse:count(runs,'adverse')+extraAdverse,uncertain:count(runs,'uncertain')+extraUncertain,fingerprint:hash(attention)},ciOmitted:{adverse:count(omitted,'adverse')+extraAdverse,uncertain:count(omitted,'uncertain')+extraUncertain,other:count(omitted,'other')+extraOther}};
    const record=observationRecord(hash([link.provider,link.change_number]),materialChangeObservations([change])[0],previous.changes,revision);changeRegistry.push(record);
    changes.push({...change,materialRevision:record.changedRevision});
  }
  return {changes:changes.sort((a,b)=>(a.provider+':'+a.number).localeCompare(b.provider+':'+b.number)),limited:Boolean(context.changeAssociations.linksLimited||timeline.coverage.linksLimited),registry:registry()};
}

export function observedChangeText(change){
  const head=change.state==='conflicting'?'conflicting observed heads'+(change.heads.length?': '+change.heads.join(' / '):'; identity window limited'):'observed head '+(change.headSha||'unknown');
  const ci=change.ci.map(run=>run.state==='observed-version'?run.label+' '+run.status:run.label+' '+run.state+'; reported '+run.statuses.join(' / '));
  const omitted=change.ciOmitted,counts=omitted?[omitted.adverse?omitted.adverse+' additional failure/cancellation reports':null,omitted.uncertain?omitted.uncertain+' additional uncertain reports':null,omitted.other?omitted.other+' other run reports omitted':null].filter(Boolean):[];
  return change.provider+' #'+change.number+' · '+head+(counts.length?' · '+counts.join('; '):'')+(ci.length?' · '+ci.join('; '):' · CI unknown')+(change.ciLimited?' · history window limited':'');
}
