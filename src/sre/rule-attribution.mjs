import {incidentLogScope} from './log-scope.mjs';
import { diagnose } from '../core/engine.mjs';
import { releases,deploymentBlockers } from './deployments.mjs';
import { reviewPolicySources } from './policy-catalog.mjs';
import {latestProblemSnapshots,problemIdentity} from './runtime-problems.mjs';

const codeSignals=['SCHEMA_MISMATCH','WINNING_BID_REGRESSED','BID_ACCEPTED_AFTER_CLOSE','CREDIT_TIMEOUT'];
const recognized=new Set([...codeSignals,'CREDIT_PROVIDER_UNAVAILABLE']);

function observations(context,current) {
  const signals=new Set(),unknown=new Set(),catalog=new Map();let invalid=false,unscopedLatency=false;
  const asOf=Date.parse(context.riskScope?.asOf),now=Number.isFinite(asOf)?asOf:Date.now();
  // Corrected provider snapshots supersede the metrics of the same native
  // problem, while correlated but independent tickets keep separate identities.
  const snapshots=latestProblemSnapshots(context.evidence.filter(item=>item.kind==='problem'&&!['github','gitlab'].includes(item.source)&&!item.content?.reviewOnly),{fallback:item=>JSON.stringify([item.source,context.incident.issue_key])});
  const runtime=snapshots.selected,conflicting=snapshots.conflicts.length>0||Boolean(context.evidenceWindow?.problemSnapshotConflicts?.length);
  let states={},limited=false,incomplete=false;
  try{states=typeof context.incident.source_states==='string'?JSON.parse(context.incident.source_states):context.incident.source_states||{};if(!states||typeof states!=='object'||Array.isArray(states))throw Error();}catch{invalid=true;states={};}
  const alertStates=Object.entries(states).filter(([key])=>key.startsWith('alerts:'));
  for(const [key,state] of alertStates){
    if(!state||!Number.isSafeInteger(state.at)||!['OPEN','CLOSED'].includes(state.status)){invalid=true;continue;}
    if(state.status!=='OPEN')continue;
    const identity=key.match(/^alerts:(datadog|dynatrace):(.+)$/);
    if(!identity||!runtime.some(item=>item.source==='alerts'&&item.content?.provider===identity[1]&&item.content?.alertId===identity[2]&&item.observed_at===state.at))limited=true;
  }
  if(alertStates.length&&context.evidenceWindow?.candidatesLimited)limited=true;
  for(const item of runtime) {
    if(!Number.isSafeInteger(item.observed_at)||item.observed_at>now){invalid=true;continue;}
    if(item.source==='alerts'){
      if(!problemIdentity(item)){invalid=true;continue;}
      const state=states['alerts:'+item.content.provider+':'+item.content.alertId];
      if(!state){incomplete=true;continue;}
      if(state?.status==='CLOSED'&&state.at>=item.observed_at)continue;
    }
    const metrics=item.content?.metrics??item.content?.LabMetrics;
    if(metrics===undefined){if(item.source==='alerts')incomplete=true;continue;}
    if(!metrics||typeof metrics!=='object'||Array.isArray(metrics)){invalid=true;continue;}
    if(item.source==='alerts'&&!['codes','violations','p95Ms','samples'].some(field=>metrics[field]!==undefined))incomplete=true;
    for(const field of ['codes','violations']) {
      if(metrics[field]===undefined)continue;
      if(!Array.isArray(metrics[field])||metrics[field].some(value=>typeof value!=='string')){invalid=true;continue;}
      for(const value of metrics[field])if(recognized.has(value))signals.add(value);else unknown.add(value);
    }
    if(metrics.requests!==undefined&&(!Number.isSafeInteger(metrics.requests)||metrics.requests<0))invalid=true;
    if(metrics.p95Ms!==undefined&&(typeof metrics.p95Ms!=='number'||!Number.isFinite(metrics.p95Ms)||metrics.p95Ms<0))invalid=true;
    if(Number.isSafeInteger(metrics.requests)&&metrics.requests>=3&&typeof metrics.p95Ms==='number'&&metrics.p95Ms>250)unscopedLatency=true;
    if(metrics.samples!==undefined&&!Array.isArray(metrics.samples)){invalid=true;continue;}
    for(const sample of metrics.samples||[]) {
      if(!sample||typeof sample!=='object'){invalid=true;continue;}
      if(sample.operation!=='catalog'||sample.status!==200||typeof sample.durationMs!=='number'||!Number.isFinite(sample.durationMs)||sample.durationMs<0||!Number.isSafeInteger(sample.at)||sample.at>item.observed_at||sample.at>now||(current&&sample.at<current.at))continue;
      catalog.set(JSON.stringify([sample.at,sample.durationMs,sample.status,sample.release]),sample);
    }
  }
  const durations=[...catalog.values()].map(sample=>sample.durationMs).sort((a,b)=>a-b);
  if(durations.length>=3&&durations[Math.ceil(durations.length*.95)-1]>250)signals.add('CATALOG_LATENCY');
  return {signals,unknown:[...unknown],invalid:invalid||conflicting||limited||incomplete,malformed:invalid,conflicting,limited,incomplete,unscopedLatency:unscopedLatency&&!signals.has('CATALOG_LATENCY'),runtime};
}

function unresolvedLogEvidence(context,observed,current) {
  const digest=context.signalDigest;if(!digest)return {blocked:false,evidenceIds:[]};
  const coverage=digest.coverage||{},asOf=Date.parse(context.riskScope?.asOf),now=Number.isFinite(asOf)?asOf:Date.now();
  const reference=incidentLogScope(context.incident,context.evidence,now),scopeReported=digest.incidentScope?.state==='reported',scoped=scopeReported&&reference.state==='reported'&&reference.evidenceId===digest.incidentScope.evidenceId;
  const failures=(digest.groups||[]).filter(group=>['ERROR','CRITICAL','FATAL'].includes(group.level)||recognized.has(group.code)||group.metadataIssues?.length);
  const unexplained=failures.filter(group=>!group.code||!observed.signals.has(group.code));
  const contrary=failures.filter(group=>current&&observed.signals.has(group.code)&&context.deployments.some(release=>release.sha===group.version&&release.sha!==current.sha&&release.at<=current.at)&&group.firstAt!==null&&group.firstAt>=current.at&&group.lastAt<=now);
  // Display-only omissions of fully scanned HTTP health successes cannot prove
  // recovery, and do not erase a separately established invariant regression.
  // Every other omission continues to block the limited attribution.
  const healthOmissions=Number.isSafeInteger(coverage.omittedHealthSuccessGroups)&&coverage.omittedHealthSuccessGroups>=0&&coverage.omittedHealthSuccessGroups<=coverage.omittedGroups?coverage.omittedHealthSuccessGroups:0;
  const crossScope=scoped&&failures.some(group=>group.scopeRelation==='different'),unknownScope=scoped&&coverage.unknownFailureScopeGroups>0,scopeUnverified=/^log-monitor:/.test(context.incident.issue_key||'')&&reference.state!=='reported';
  const inconsistentMetadata=coverage.inconsistentMetadataRecords>0;
  const limited=scopeUnverified||scopeReported&&!scoped||unknownScope||inconsistentMetadata||coverage.partialResults>0||coverage.recordsNotScanned>0||coverage.omittedGroups>healthOmissions||coverage.invalidRecords>0||coverage.missingTimestamps>0||coverage.candidateWindowLimited&&coverage.recordsAvailable>0;
  const available=new Set(context.evidence.map(row=>row.id));
  return {blocked:limited||crossScope||unexplained.length>0||contrary.length>0,limited,crossScope,unknownScope,scopeUnverified,inconsistentMetadata,unexplained:unexplained.length>0,contrary:contrary.length>0,evidenceIds:[...new Set([...failures.filter(g=>g.metadataIssues?.length),...unexplained,...contrary].flatMap(group=>group.evidenceIds||[]))].filter(id=>available.has(id))};
}

export function ruleAttribution(context) {
  const scopeHead=context.riskScope?.headSha;
  const providers=[...new Set(context.deployments.map(item=>item.provider))],provider=context.riskScope?.provider||(providers.length===1?providers[0]:null);
  const atStart=context.deployments.filter(item=>item.at<=context.incident.started_at);
  const chain=releases(atStart).filter(item=>item.provider===provider),current=chain[0],previous=chain[1];
  const observed=observations(context,current);
  const logs=unresolvedLogEvidence(context,observed,current);
  const reviews=context.evidence.filter(item=>['code_review','release_diff','change'].includes(item.kind));
  const scoped=reviews.filter(item=>{
    const proof=item.content;
    if(proof?.provider!==item.source)return false;
    if(scopeHead)return proof.headSha===scopeHead&&proof.comparisonKind==='review';
    return current&&proof.provider===provider&&proof.headSha===current.sha;
  });
  const inspected=scoped.map(entry=>({entry,review:reviewPolicySources(entry.content.policySources)}));
  const allFindings=inspected.flatMap(({entry,review})=>review.findings.map(finding=>({...finding,evidenceId:entry.id,provider:entry.source,baseSha:entry.content.baseSha,headSha:entry.content.headSha})));
  const findings=[...new Map(allFindings.map(finding=>[[finding.signal,finding.provider,finding.baseSha,finding.headSha].join(':'),finding])).values()];
  const causalProofs=inspected.filter(({entry,review})=>current&&previous&&entry.content.comparisonKind==='deployment'&&entry.content.complete===true&&entry.content.provider===provider&&entry.content.headSha===current.sha&&entry.content.baseSha===previous.sha&&Array.isArray(entry.content.unrecognizedPaths)&&entry.content.unrecognizedPaths.length===0&&review.supported);
  const causal=causalProofs.flatMap(({entry,review})=>review.findings.map(finding=>({...finding,evidenceId:entry.id})));
  const code=[...observed.signals].filter(signal=>signal!=='CREDIT_PROVIDER_UNAVAILABLE'),dependency=observed.signals.has('CREDIT_PROVIDER_UNAVAILABLE');
  const unsettled=!current||deploymentBlockers(atStart,current).length>0||previous?.identityConflict||previous?.historyIncomplete||previous?.statusConflict||previous?.attestationConflicts?.length;
  let changeAssessment='unknown';
  if(dependency&&!code.length&&!observed.invalid&&!observed.unknown.length&&!observed.unscopedLatency&&!logs.blocked)changeAssessment='unlikely';
  else if(code.length&&!dependency&&!observed.invalid&&!observed.unknown.length&&!observed.unscopedLatency&&!logs.blocked&&!scopeHead&&!unsettled&&code.every(signal=>causal.some(finding=>finding.signal===signal)))changeAssessment='likely';
  const unknowns=['Deterministic mode covers five literal-policy changes in the known auction module; general code review and production reasoning remain unvalidated.'];
  if(code.length&&changeAssessment!=='likely')unknowns.push('A matching, complete current-versus-previous deployment source comparison has not established the observed code hypothesis.');
  if(!current&&!scopeHead)unknowns.push('No successful deployment identity is available at the incident start.');
  if(dependency&&code.length)unknowns.push('Dependency and code-failure signals coexist; the limited rules cannot select one cause.');
  if(observed.malformed)unknowns.push('Some runtime metrics or lifecycle records have invalid types or values and cannot support attribution.');
  if(observed.conflicting)unknowns.push('Conflicting runtime snapshots have the same source observation time. Retain both versions and request a strictly newer observation before selecting one cause.');
  if(observed.limited)unknowns.push('Current workflow monitor evidence is outside the bounded source window. Collect each active monitor’s current snapshot before selecting one cause.');
  if(observed.incomplete)unknowns.push('Some open workflow monitors lack typed current failure metrics. Request their relevant log or metric snapshots before selecting one cause.');
  if(observed.unknown.length)unknowns.push('Runtime signals outside the documented catalog require a broader investigation.');
  if(observed.unscopedLatency)unknowns.push('Aggregate latency does not establish which request path is slow.');
  if(inspected.some(item=>!item.review.supported))unknowns.push('Some source comparisons are missing, incomplete, or outside the supported module structure.');
  if(logs.unexplained)unknowns.push('Structured logs contain other failure classes that the limited deployment hypothesis has not explained. Reconcile them with the problem metrics before selecting one cause.');
  if(logs.contrary)unknowns.push('Logs report the same failure on a previous exact release in the current deployment window. Compare the same scope and requests before blaming the current release.');
  if(logs.scopeUnverified)unknowns.push('This log-monitor incident’s impact scope is missing, invalid or outside the current source window. Collect the native scope before assigning a regional/release cause.');
  if(logs.crossScope)unknowns.push('Logs contain failures outside this monitor’s reported impact scope. Compare affected requests and dependency paths before connecting or excluding those failures.');
  if(logs.unknownScope)unknowns.push('Some failure observations have missing or conflicting region/release metadata and cannot be assigned to this reported impact scope.');
  if(logs.inconsistentMetadata)unknowns.push('Structured observations contain contradictory or malformed log fields. Inspect the original source aliases and mapping before selecting a cause or an automatic patch.');
  if(logs.limited)unknowns.push('Runtime log coverage is sampled, partial, omitted or has invalid/missing timestamps. The limited rules cannot exclude a competing failure.');
  const diagnoses=[...observed.signals].map(signal=>signal==='CATALOG_LATENCY'?diagnose({requests:3,p95Ms:350}):diagnose({codes:[signal]}));
  return {findings,current,changeAssessment,candidateSha:changeAssessment==='likely'?current.sha:null,diagnoses,unknowns,causalEvidenceIds:[...new Set(causal.map(finding=>finding.evidenceId))],runtimeEvidenceIds:[...new Set([...observed.runtime.map(item=>item.id),...logs.evidenceIds])].slice(0,8),inspectedComparisons:inspected.length,supportedComparisons:inspected.filter(item=>item.review.supported).length};
}
