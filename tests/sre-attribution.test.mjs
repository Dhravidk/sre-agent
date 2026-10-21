import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auctionPolicyPath,reviewPolicySources } from '../src/sre/policy-catalog.mjs';
import { ruleAttribution } from '../src/sre/rule-attribution.mjs';
import { RulesReasoner,boundedContext } from '../src/sre/reasoner.mjs';
import {buildSignalDigest} from '../src/sre/signal-digest.mjs';

const baseline=readFileSync(new URL('../src/auction/rules.mjs',import.meta.url),'utf8');
const source=(before,after,extra={})=>({path:auctionPolicyPath,complete:true,base:before,head:after,...extra});
const regressions=[
  ['checkVersion: true','checkVersion: false','WINNING_BID_REGRESSED'],
  ['enforceCloseTime: true','enforceCloseTime: false','BID_ACCEPTED_AFTER_CLOSE'],
  ['creditTimeoutMs: 100','creditTimeoutMs: 24','CREDIT_TIMEOUT'],
  ['schemaVersion: 1','schemaVersion: 2','SCHEMA_MISMATCH'],
  ['catalogDelayMs: 5','catalogDelayMs: 251','CATALOG_LATENCY'],
];
for(const [before,after,signal] of regressions)test('policy parser recognizes an effective literal regression: '+signal,()=>{
  const result=reviewPolicySources(source(baseline,baseline.replace(before,after)));
  assert.equal(result.supported,true);assert.deepEqual(result.findings.map(item=>item.signal),[signal]);
});
test('comments, text literals, formatting and duplicate-key overrides cannot manufacture a policy regression',()=>{
  for(const head of [
    '// checkVersion: false, catalogDelayMs: 350\n'+baseline,
    baseline.replace("release: 'baseline'","release: 'checkVersion: false, creditTimeoutMs: 1'"),
    baseline.replace('checkVersion: true','checkVersion: false, checkVersion: true'),
    baseline.replace('checkVersion: true',"'checkVersion' : true"),
  ]){const result=reviewPolicySources(source(baseline,head));assert.equal(result.supported,true);assert.deepEqual(result.findings,[]);}
  const bad=baseline.replace('checkVersion: true','checkVersion: false');
  assert.deepEqual(reviewPolicySources(source(bad,bad.replace("release: 'baseline'","release: 'new-name'"))).findings,[]);
});
test('unsupported source is parsed without executing spreads, calls, accessors or added statements',()=>{
  globalThis.srePolicyExecutionMarker=0;
  const expression='(globalThis.srePolicyExecutionMarker++, false)';
  for(const head of [
    baseline.replace('checkVersion: true','checkVersion: '+expression),
    baseline.replace('checkVersion: true','...{checkVersion: false}'),
    baseline.replace('checkVersion: true','get checkVersion() { globalThis.srePolicyExecutionMarker++; return false; }'),
    baseline.replace("return 'AUCTION_CLOSED'","return null"),
    baseline+'\nglobalThis.srePolicyExecutionMarker++;\n',
    baseline.replace('checkVersion: true','checkVersion'),
    baseline.replace('checkVersion: true','["checkVersion"]: false'),
    baseline.replace('checkVersion: true','unknownField: true, checkVersion: false'),
    baseline.replace('export const policy','export let policy'),
    baseline+'!',
    baseline+' '.repeat(65536),
  ]){const result=reviewPolicySources(source(baseline,head));assert.equal(result.supported,false);assert.deepEqual(result.findings,[]);}
  assert.equal(globalThis.srePolicyExecutionMarker,0);delete globalThis.srePolicyExecutionMarker;
});
test('incomplete or unrelated source cannot support the policy catalog',()=>{
  assert.equal(reviewPolicySources(source(baseline,baseline,{complete:false})).supported,false);
  assert.equal(reviewPolicySources(source(baseline,baseline,{path:'other.mjs'})).supported,false);
  assert.deepEqual(reviewPolicySources({path:auctionPolicyPath,complete:true,changed:false}).findings,[]);
});

const now=Date.now(),baseSha='a'.repeat(40),headSha='b'.repeat(40);
function context(signal='WINNING_BID_REGRESSED') {
  const replacement=regressions.find(item=>item[2]===signal)||regressions[0];
  return {
    incident:{id:'inc-attribution',issue_key:'dynatrace:P-1',started_at:now-4000,status:'open'},
    session:{agent_id:'one-incident'},
    riskScope:{stage:'incident',provider:'github',headSha:null,asOf:new Date(now).toISOString()},
    deployments:[{provider:'github',environment:'local',deploymentId:'1',sha:baseSha,status:'success',at:now-9000},{provider:'github',environment:'local',deploymentId:'2',sha:headSha,status:'success',at:now-5000}],
    evidence:[
      {id:'problem',source:'dynatrace',kind:'problem',observed_at:now-3000,content:{problemId:'P-1',metrics:{codes:[signal],requests:3}}},
      {id:'comparison',source:'github',kind:'release_diff',observed_at:now-2000,content:{provider:'github',comparisonKind:'deployment',baseSha,headSha,complete:true,unrecognizedPaths:[],policySources:source(baseline,baseline.replace(replacement[0],replacement[1]))}},
    ],
  };
}
const problem=c=>c.evidence.find(item=>item.id==='problem');
const proof=c=>c.evidence.find(item=>item.id==='comparison').content;
function abstains(c){const result=ruleAttribution(c);assert.equal(result.changeAssessment,'unknown');assert.equal(result.candidateSha,null);return result;}

for(const [name,record,extra] of [
  ['a competing dependency reported only in logs',{errorCode:'CREDIT_PROVIDER_UNAVAILABLE'},{}],
  ['an unexplained error class reported only in logs',{errorCode:'INVARIANT_DEBIT_REPLAYED'},{}],
  ['the same failure on the previous exact release',{errorCode:'WINNING_BID_REGRESSED','service.version':baseSha},{}],
  ['sampled runtime logs',{errorCode:'WINNING_BID_REGRESSED'},{complete:false,metadata:{grail:{sampled:true}}}],
])test('rules withhold a deployment claim for '+name,()=>{
  const c=context();c.evidence.push({id:'contrary-log',source:'dynatrace',kind:'logs',observed_at:now-1000,content:{records:[{timestamp:new Date(now-1000).toISOString(),loglevel:'ERROR','service.version':headSha,content:'Fictional runtime evidence',...record}],complete:true,...extra}});c.signalDigest=buildSignalDigest(c);
  abstains(c);
});

test('routine informational noise does not manufacture a competing failure class',()=>{
  const c=context();c.evidence.push({id:'info-log',source:'dynatrace',kind:'logs',observed_at:now-1000,content:{records:[{timestamp:new Date(now-1000).toISOString(),loglevel:'INFO',content:'Routine health probe'}],complete:true}});c.signalDigest=buildSignalDigest(c);assert.equal(ruleAttribution(c).changeAssessment,'likely');
});

function healthDisplayNoise(mutate=()=>({})) {
  const c=context();c.evidence.push({id:'health-storm',source:'dynatrace',kind:'logs',observed_at:now-1000,content:{complete:true,records:Array.from({length:60},(_,i)=>({timestamp:new Date(now-1000+i).toISOString(),loglevel:'INFO',operation:'/health','http.response.status_code':200,content:'Health probe succeeded request-id='+i,...mutate(i)}))}});c.signalDigest=buildSignalDigest(c);return c;
}
test('a display cap on explicit health HTTP successes does not hide a complete known code regression',()=>{
  const c=healthDisplayNoise();assert.ok(c.signalDigest.coverage.omittedGroups>0);
  assert.equal(ruleAttribution(c).changeAssessment,'likely');
  assert.equal(c.signalDigest.coverage.omittedHealthSuccessGroups,c.signalDigest.coverage.omittedGroups);
  assert.equal(boundedContext(c).signalDigest.coverage.omittedHealthSuccessGroups,c.signalDigest.coverage.omittedGroups);
  // Individual request numbers are still significant; raw groups are not merged.
  assert.equal(c.signalDigest.coverage.recordsScanned,60);assert.equal(c.evidence.at(-1).content.records.length,60);
  problem(c).content.metrics.codes=[];abstains(c);
});
for(const [name,fields] of [
  ['a non-health operation',{operation:'/bids'}],
  ['a failing health HTTP status',{'http.response.status_code':503}],
  ['an explicit health error class',{'error.code':'HEALTH_PROBE_FAILED'}],
  ['unknown severity',{loglevel:'UNKNOWN'}],
  ['error severity',{loglevel:'ERROR'}],
])test('omitted '+name+' still withholds attribution',()=>abstains(healthDisplayNoise(()=>fields)));

test('a log group alone cannot upgrade an unsupported deterministic code hypothesis',()=>{
  const c=context();problem(c).content.metrics.codes=[];c.evidence.push({id:'only-log',source:'dynatrace',kind:'logs',observed_at:now-1000,content:{records:[{timestamp:new Date(now-1000).toISOString(),loglevel:'ERROR',errorCode:'WINNING_BID_REGRESSED','service.version':headSha}],complete:true}});c.signalDigest=buildSignalDigest(c);abstains(c);
});
test('a known runtime signal and exact complete deployment source pair establish a limited code hypothesis',async()=>{
  const c=context(),result=await new RulesReasoner().investigate(c,{question:'q'.repeat(4000)});
  assert.equal(result.analysis.changeAssessment,'likely');assert.equal(result.analysis.candidateSha,headSha);
  assert.deepEqual(result.analysis.codeReview.findings.map(item=>item.signal),['WINNING_BID_REGRESSED']);
  assert.match(result.analysis.text,/Scoped code inspection/);assert.match(result.analysis.text,/src\/auction\/rules\.mjs/);
  assert.ok(result.analysis.evidenceIds.includes('problem'));assert.ok(result.analysis.evidenceIds.includes('comparison'));
  assert.equal(result.analysis.risk.likelihood,'unknown');assert.equal(result.analysis.risk.confidence,'low');
});
for(const [name,mutate] of [
  ['no deployment',c=>{c.deployments=[];}],
  ['no source evidence',c=>{c.evidence=c.evidence.filter(item=>item.id!=='comparison');}],
  ['healthy release with a coincidental symptom',c=>{proof(c).policySources=source(baseline,baseline.replace("release: 'baseline'","release: 'new-name'"));}],
  ['pre-existing bad policy with no new regression',c=>{const bad=baseline.replace('checkVersion: true','checkVersion: false');proof(c).policySources=source(bad,bad.replace("release: 'baseline'","release: 'new-name'"));}],
  ['different head',c=>{proof(c).headSha='c'.repeat(40);}],
  ['different base',c=>{proof(c).baseSha='c'.repeat(40);}],
  ['different provider',c=>{proof(c).provider='gitlab';}],
  ['review-only comparison',c=>{proof(c).comparisonKind='review';}],
  ['partial comparison',c=>{proof(c).complete=false;}],
  ['missing immutable source',c=>{proof(c).policySources.complete=false;}],
  ['changed runtime outside the known module',c=>{proof(c).unrecognizedPaths=['src/auction/service.mjs'];}],
  ['migration outside the known module',c=>{proof(c).unrecognizedPaths=['migrations/002-reserve.sql'];}],
  ['changed implementation function',c=>{proof(c).policySources.head+='\nexport const extra = true;';}],
  ['only timing and a textual patch',c=>{delete proof(c).policySources;proof(c).patch='+ checkVersion: false';}],
  ['dependency and code signals together',c=>{problem(c).content.metrics.codes.push('CREDIT_PROVIDER_UNAVAILABLE');}],
  ['an unexplained signal',c=>{problem(c).content.metrics.codes.push('OTHER_ERROR');}],
  ['malformed code list',c=>{problem(c).content.metrics.codes='WINNING_BID_REGRESSED';}],
  ['future observation',c=>{problem(c).observed_at=now+1;}],
  ['invalid request count',c=>{problem(c).content.metrics.requests=-1;}],
  ['invalid latency',c=>{problem(c).content.metrics.p95Ms=NaN;}],
  ['unscoped latency competes with a known code signal',c=>{problem(c).content.metrics.p95Ms=500;}],
  ['an unsettled deployment at incident start',c=>{c.deployments.push({provider:'github',environment:'local',deploymentId:'3',sha:'c'.repeat(40),status:'pending',at:now-4500});}],
  ['review context has no runtime causal authority',c=>{c.riskScope.headSha=headSha;proof(c).comparisonKind='review';}],
])test('rules withhold attribution for '+name,()=>abstains(mutateContext(mutate)));
function mutateContext(mutate){const c=context();mutate(c);return c;}

test('an exact pre-merge finding stays a conditional code review and has no candidate deployment',async()=>{
  const c=context();c.deployments=[];c.riskScope.headSha=headSha;c.riskScope.stage='pre-merge';
  c.evidence=c.evidence.filter(item=>item.id==='comparison');proof(c).comparisonKind='review';
  const {analysis}=await new RulesReasoner().investigate(c);
  assert.equal(analysis.codeReview.findings.length,1);assert.equal(analysis.changeAssessment,'unknown');assert.equal(analysis.candidateSha,null);
  assert.ok(analysis.evidenceIds.includes('comparison'));assert.equal(analysis.risk.likelihood,'unknown');
});
test('a superseded review head cannot keep reporting a finding on a clean new head',()=>{
  const c=context();c.deployments=[];c.riskScope.headSha='c'.repeat(40);proof(c).comparisonKind='review';
  c.evidence.push({id:'new-head',source:'github',kind:'code_review',observed_at:now-1000,content:{...proof(c),headSha:c.riskScope.headSha,policySources:source(baseline,baseline)}});
  assert.deepEqual(abstains(c).findings,[]);
});
test('latest corrected metrics supersede malformed history for the same native problem',()=>{
  const c=context();c.evidence.push({...structuredClone(problem(c)),id:'old-invalid',observed_at:now-3500,content:{problemId:'P-1',metrics:'broken'}});
  assert.equal(ruleAttribution(c).changeAssessment,'likely');
  c.evidence.push({...structuredClone(problem(c)),id:'new-invalid',observed_at:now-1000,content:{problemId:'P-1',metrics:'broken'}});
  abstains(c);
});
test('a newer clean snapshot removes an old signature, while independent tickets retain their own signals',()=>{
  const c=context();c.evidence.push({...structuredClone(problem(c)),id:'new-clean',observed_at:now-1000,content:{problemId:'P-1',metrics:{codes:[],requests:3}}});
  assert.equal(abstains(c).diagnoses.length,0);
  c.evidence.push({id:'other-ticket',source:'servicenow',kind:'problem',observed_at:now-1500,content:{sys_id:'1'.repeat(32),metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}}});
  assert.equal(ruleAttribution(c).changeAssessment,'unlikely');
});
test('dependency-only evidence avoids blaming a deployment, but unexplained latency keeps attribution open',()=>{
  const c=context();problem(c).content.metrics.codes=['CREDIT_PROVIDER_UNAVAILABLE'];
  assert.equal(ruleAttribution(c).changeAssessment,'unlikely');assert.equal(ruleAttribution(c).candidateSha,null);
  problem(c).content.metrics.p95Ms=500;abstains(c);
});
test('catalog attribution requires distinct successful catalog samples in the deployed window',()=>{
  const c=context('CATALOG_LATENCY'),metrics=problem(c).content.metrics;metrics.codes=[];metrics.p95Ms=350;
  metrics.samples=[0,1,2].map(index=>({operation:'catalog',status:200,at:now-3400+index,durationMs:350}));
  assert.equal(ruleAttribution(c).changeAssessment,'likely');
  for(const mutate of [
    samples=>samples.map(item=>({...item,operation:'bid'})),
    samples=>samples.map(item=>({...item,status:503})),
    samples=>samples.map(item=>({...item,at:now+1})),
    samples=>samples.map(item=>({...item,at:now-8000})),
    samples=>samples.map(()=>samples[0]),
    samples=>samples.slice(0,2),
  ]){const copy=structuredClone(c);problem(copy).content.metrics.samples=mutate(metrics.samples);abstains(copy);}
});
test('failed catalog requests and malformed samples do not establish successful catalog latency',()=>{
  const c=context('CATALOG_LATENCY');problem(c).content.metrics={requests:3,p95Ms:500,samples:[null,null,null]};
  abstains(c);problem(c).content.metrics.samples='not-an-array';abstains(c);
});
