import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReadAccess } from '../src/sre/access-checks.mjs';

function runCase(scenario,source,options={}) {
  const directory=mkdtempSync(join(tmpdir(),'sre-access-')),configFile=join(directory,'config.json'),callsFile=join(directory,'calls.jsonl');
  const common={enabled:true,base:'https://sre-access-fixture.invalid',tokenEnv:'READ'};
  const readers={
    github:{...common,repository:'fixture/auction',smokePull:42,smokePath:'src/auction/rules.mjs'},
    gitlab:{...common,project:'17',smokeMergeRequest:42,smokePath:'src/auction/rules.mjs'},
    dynatrace:{...common,mode:'classic',entityId:'SERVICE-ACCESS',smokeProblemId:'P-ACCESS'},
    dynatraceLogs:{...common,mode:'grail',logField:'service.name',logValue:'auction'},
    servicenow:{...common,cmdbCi:'c'.repeat(32),smokeIncident:'d'.repeat(32)},
    jira:{...common,auth:'bearer',projects:['SA'],smokeIssue:'SA-1'},
  };
  const service={key:'access-test',name:'Auction access test',tenant:'test-tenant',environment:'staging',teams:{},monitors:scenario.startsWith('metric-')?[{id:'latency',selector:'fixture:latency',threshold:250,operator:'gt',consecutive:3}]:[],...(source?{[source]:readers[source]}:{})};
  if(options.configure)options.configure(service);
  writeFileSync(configFile,JSON.stringify({mode:'connected',agentMode:'rules',services:[service]}));
  const env={SRE_CONFIG:configFile,SRE_API_TOKEN:'private-synthetic-api-token',SRE_CAPABILITY_SECRET:'s'.repeat(32),READ:'private-synthetic-read-token',SRE_ACCESS_CASE:scenario,SRE_ACCESS_CALLS_FILE:callsFile};
  try {
    const result=spawnSync(process.execPath,['--import',new URL('../fixtures/access-check-transport.mjs',import.meta.url).href,'scripts/sre-check.mjs',...(options.withoutOptIn?[]:['--live']),'--json'],{env,encoding:'utf8',timeout:15000});
    return {...result,calls:existsSync(callsFile)?readFileSync(callsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]};
  } finally {rmSync(directory,{recursive:true,force:true});}
}

for(const [scenario,source] of [['github-deployment-denied','github'],['gitlab-deployment-denied','gitlab'],['dynatrace-partial','dynatrace'],['servicenow-active-denied','servicenow'],['metric-invalid','dynatrace'],['grail-truncated','dynatraceLogs']])test(scenario+': access CLI cannot pass an untested or incomplete runtime read path',()=>{
  const result=runCase(scenario,source);assert.notEqual(result.status,0,'The old probe passed while a required runtime operation was denied, incomplete or invalid');
  assert.ok(!result.stdout.includes('private-synthetic-read-token'));assert.ok(!result.stdout.includes('private-synthetic-provider-detail'));
  const report=JSON.parse(result.stdout),operation=scenario.includes('deployment-denied')?'deployment-history':scenario==='dynatrace-partial'?'recent-problems':scenario==='servicenow-active-denied'?'active-inventory':scenario==='metric-invalid'?'metric:latency':'log-query';
  const check=report.checks.find(item=>item.operation===operation);assert.ok(check&&check.status!=='passed');assert.equal(report.allRequiredReadsPassed,false);assert.equal(report.endToEndValidated,false);
});

for(const [scenario,source] of [['github-complete','github'],['gitlab-complete','gitlab'],['dynatrace-complete','dynatrace'],['servicenow-complete','servicenow'],['grail-complete','dynatraceLogs'],['metric-valid','dynatrace'],['jira-complete','jira']])test(scenario+': complete configured probes pass without a deployment or message',()=>{
  const result=runCase(scenario,source);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);const report=JSON.parse(result.stdout);
  assert.equal(report.state,'passed');assert.equal(report.allRequiredReadsPassed,true);assert.equal(report.endToEndValidated,false);assert.equal(report.deploymentWritesAttempted,0);assert.equal(report.externalMessagesSent,0);
  assert.ok(result.calls.length>0);assert.ok(result.calls.every(call=>call.method==='GET'||call.path.endsWith('/query:execute')));assert.ok(!result.stdout.includes('private-synthetic-ticket-body'));
  if(['dynatrace','servicenow'].includes(source))assert.ok(result.calls.some(call=>call.activeInventory));
  if(['github','gitlab'].includes(source)){assert.ok(result.calls.some(call=>call.path.includes('/contents/')||call.path.includes('/repository/files/')));assert.ok(result.calls.some(call=>call.path.includes('/compare')));}
});

test('missing code-review probe configuration remains unverified instead of a pass',()=>{
  const result=runCase('github-missing-review','github',{configure:service=>{delete service.github.smokePull;delete service.github.smokePath;}}),report=JSON.parse(result.stdout);
  assert.equal(result.status,2);assert.equal(report.state,'incomplete');assert.equal(report.checks.find(item=>item.operation==='review-diff').status,'unverified');assert.equal(report.checks.find(item=>item.operation==='repository-metadata').status,'passed');
});

test('an empty deployment list cannot certify deployment-status access',()=>{
  const result=runCase('github-empty-deployments','github'),report=JSON.parse(result.stdout);assert.equal(result.status,2);
  assert.equal(report.checks.find(item=>item.operation==='deployment-history').status,'passed');assert.equal(report.checks.find(item=>item.operation==='deployment-statuses').status,'unverified');
});

test('CI endpoint rejection stays visible when the pull request and file diff succeed',()=>{
  const result=runCase('github-checks-denied','github'),report=JSON.parse(result.stdout);assert.notEqual(result.status,0);
  assert.equal(report.checks.find(item=>item.operation==='review-diff').status,'passed');assert.equal(report.checks.find(item=>item.operation==='ci-status').status,'incomplete');
});

test('HTTP success for a different repository cannot pass the metadata scope check',()=>{
  const result=runCase('github-wrong-scope','github'),report=JSON.parse(result.stdout);assert.equal(result.status,1);
  assert.equal(report.checks.find(item=>item.operation==='repository-metadata').code,'response-scope');assert.ok(!result.stdout.includes('unrelated/private'));
});

test('no enabled readers remains not configured and makes zero requests',()=>{
  const result=runCase('no-readers',null),report=JSON.parse(result.stdout);assert.equal(result.status,2);assert.equal(report.state,'not-configured');assert.equal(result.calls.length,0);
});

test('the CLI requires network opt-in even with configured credentials',()=>{
  const result=runCase('no-opt-in','github',{withoutOptIn:true});assert.notEqual(result.status,0);assert.equal(result.calls.length,0);
});

test('configured rollback remains excluded from the read-only client factory',()=>{
  const result=runCase('rollback-excluded','github',{configure:service=>service.rollback={enabled:true,provider:'github',workflow:'rollback.yml',ref:'main',tokenEnv:'WRITE'}});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.ok(result.calls.every(call=>call.method==='GET'));assert.ok(!result.calls.some(call=>call.path.includes('/dispatches')));
});

for(const scenario of ['github-malformed-checks','github-wrong-status-head'])test(scenario+': unusable CI data cannot certify the status reader',()=>{
  const result=runCase(scenario,'github'),report=JSON.parse(result.stdout);assert.equal(result.status,1);assert.equal(report.checks.find(item=>item.operation==='ci-status').status,'failed');
});

test('missing immutable merge-request refs cannot certify a complete review',()=>{
  const result=runCase('gitlab-missing-review-refs','gitlab'),report=JSON.parse(result.stdout);assert.equal(result.status,1);assert.equal(report.checks.find(item=>item.operation==='review-diff').status,'failed');
});

test('immutable source permission is exercised separately from repository metadata',()=>{
  const result=runCase('github-source-denied','github'),report=JSON.parse(result.stdout);assert.equal(result.status,1);assert.equal(report.checks.find(item=>item.operation==='repository-metadata').status,'passed');assert.equal(report.checks.find(item=>item.operation==='immutable-source').status,'failed');
});

test('one reader construction failure does not prevent another source probe',()=>{
  const result=runCase('independent-reader','dynatrace',{configure:service=>service.github={enabled:true,base:'https://sre-access-fixture.invalid',repository:'invalid',tokenEnv:'READ'}}),report=JSON.parse(result.stdout);
  assert.equal(result.status,1);assert.equal(report.checks.find(item=>item.source==='github'&&item.operation==='reader-initialization').status,'failed');assert.equal(report.checks.find(item=>item.source==='dynatrace'&&item.operation==='active-inventory').status,'passed');
});

test('a result returned after cancellation cannot become a passing probe or disclose its abort reason',async()=>{
  const controller=new AbortController();
  const report=await checkReadAccess({services:[{key:'cancel-probe',jira:{enabled:true,smokeIssue:'SA-1'}}]},{signal:controller.signal,connectorFactory:()=>({jira:{issue:async()=>{controller.abort(new Error('private-synthetic-abort-detail'));return {key:'SA-1'};}}})});
  assert.equal(report.state,'failed');assert.equal(report.checks.find(item=>item.operation==='smoke-issue').code,'probe-deadline');assert.ok(!JSON.stringify(report).includes('private-synthetic'));
});

test('a failed parallel PR read aborts its remaining request before the probe ends',()=>{
  const result=runCase('github-sibling-cancel','github'),report=JSON.parse(result.stdout);assert.equal(result.status,1);
  assert.equal(report.checks.find(item=>item.operation==='review-diff').status,'failed');assert.ok(result.calls.some(call=>call.event==='aborted'&&call.path.endsWith('/pulls/42/files')),'The failed probe left its sibling read active');
});
