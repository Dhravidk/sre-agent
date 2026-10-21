import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {GitlabConnector} from '../src/sre/connectors.mjs';
import {sqliteDatabase} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {IncidentWorker} from '../src/sre/worker.mjs';
import {RulesReasoner} from '../src/sre/reasoner.mjs';
import {seedGitlabSandbox} from './seed-gitlab-sandbox.mjs';

if(!process.argv.includes('--live'))throw Error('Pass --live for read-only GitLab sandbox requests. This exercise never publishes or deploys.');
const out=resolve(process.env.SRE_GITLAB_EXERCISE_OUTPUT||'.local/acceptance/gitlab-history-2026-10-20');mkdirSync(out,{recursive:true,mode:0o700});
const manifest=process.env.SRE_GITLAB_PUBLISHED_MANIFEST?JSON.parse(readFileSync(resolve(process.env.SRE_GITLAB_PUBLISHED_MANIFEST),'utf8')):seedGitlabSandbox(),repo=manifest.repository;
const client=new GitlabConnector({base:'https://gitlab.com',project:'test-group7105743/test-project',tokenEnv:'GITLAB_READ_TOKEN'},{env:process.env});
const project=await client.request(client.project);
assert.equal(project.id,87869540);assert.equal(project.path_with_namespace,'test-group7105743/test-project');assert.equal(project.visibility,'private');assert.equal(project.empty_repo,false);
const branches=await client.pages(client.project+'/repository/branches',{pageSize:100});assert.equal(branches.complete,true);
for(const [ref,sha] of Object.entries(manifest.refs))assert.equal(branches.items.find(row=>'refs/heads/'+row.name===ref)?.commit?.id,sha);
const history=await client.pages(client.project+'/repository/commits?ref_name=main',{pageSize:100});assert.equal(history.complete,true);
assert.deepEqual(history.items.map(row=>row.id).reverse(),manifest.history.map(row=>row.sha));
const remote={at:new Date().toISOString(),project:{id:project.id,path:project.path_with_namespace,visibility:project.visibility},branches:branches.items.map(row=>({name:row.name,sha:row.commit.id})),history:history.items,deployments:await client.deployments('sandbox-eu'),mutations:0};
writeFileSync(resolve(out,'real-gitlab-repository.json'),JSON.stringify(remote,null,2)+'\n');

const original=JSON.parse(readFileSync(new URL('../config/sre.local.json',import.meta.url),'utf8')).services[0];
const cases=[...Object.entries(manifest.scenarios),['dependency-outage',{branch:'main',sha:manifest.baseline,probe:'dependency',expected:'CREDIT_PROVIDER_UNAVAILABLE'}]];
const services=cases.map(([name])=>({...structuredClone(original),key:'gitlab-'+name,environment:'sandbox-eu',rollback:{...original.rollback,enabled:false,provider:'gitlab'}}));
const db=sqliteDatabase(resolve(out,'isolated-agent-'+Date.now()+'.sqlite'));
try {
 const store=await new SreStore(db,{services,simulation:true}).initialize();const results=[];
 for(const [index,[name,item]] of cases.entries()) {
  const service=services[index];const prior=name==='dependency-outage'?manifest.history.at(-2).sha:manifest.baseline;
  let observation;
  if(name==='dependency-outage')observation=JSON.parse(execFileSync(process.execPath,['scripts/probe.mjs','dependency'],{cwd:repo,encoding:'utf8'}));
  else observation=JSON.parse(readFileSync(resolve(out,name+'-local-observation.json'),'utf8'));
  assert.equal(observation.sha,item.sha);
  const now=Date.now(),start=now-1000;
  // Release timing is an explicitly simulated exercise ledger. Source bytes,
  // commits and comparisons are fetched from the real GitLab reader below.
  for(const [label,sha,at] of [['baseline',prior,start-2000],['current',item.sha,start-1000]])await store.ingest({id:name+'-'+label,source:'sandbox-release-ledger',serviceKey:service.key,kind:'deployment',at,payload:{provider:'gitlab',project:project.path_with_namespace,sha,environment:service.environment,status:'success',deploymentId:'fictional-'+name+'-'+label,origin:'simulated release timing for locally reproduced code',healthy:false,rollbackCompatible:false}});
  const metrics=structuredClone(observation.metrics);
  // Replay local observations in the exercise window; retain their original
  // capture in provenance instead of presenting the replay as vendor telemetry.
  metrics.samples=metrics.samples.map(sample=>({...sample,at:start+100,release:item.sha}));metrics.observedAt=start+500;
  if(item.unsupported)metrics.codes=['BID_AMOUNT_UNIT_MISMATCH'];
  const event=await store.ingest({id:name+'-problem',source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'FICTIONAL-GITLAB-'+name,status:'OPEN',startedAt:start,at:now,title:'Fictional GitLab drill: '+name,payload:{synthetic:true,problemId:'FICTIONAL-GITLAB-'+name,metrics,provenance:{origin:'local reproduction replay; not Dynatrace',originalObservedAt:observation.metrics.observedAt,sha:item.sha}}});
  if(observation.records.length)await store.ingest({id:name+'-logs',source:'dynatrace-logs',serviceKey:service.key,kind:'log',incidentId:event.incidentId,at:now,payload:{synthetic:true,complete:true,records:observation.records.map(row=>({...row,timestamp:new Date(start+100).toISOString()})),provenance:{origin:'local reproduction replay; not Dynatrace',originalRecords:observation.records}}});
  const worker=new IncidentWorker({store,services,connectors:new Map([[service.key,{gitlab:client}]]),reasoner:new RulesReasoner()});
  try {
   // Claim only this case's pending work; previous case jobs are explicitly
   // drained before advancing, through the same persistent worker path.
   for(let rounds=0;rounds<5;rounds++)if(!await worker.runOnce())break;
   const context=await store.context(event.incidentId),analysis=context.incident.analysis;
   assert.equal(analysis?.mode,'rules');assert.equal(context.incident.status,'open');
   assert.equal(context.evidence.some(row=>row.source==='gitlab'&&row.kind==='connector_error'),false);
   const comparison=context.evidence.find(row=>row.source==='gitlab'&&row.kind==='release_diff');assert.ok(comparison?.content.complete);
   const local=execFileSync('git',['-C',repo,'show',item.sha+':src/auction/rules.mjs'],{encoding:'utf8'});
   if(comparison.content.policySources.changed!==false)assert.equal(comparison.content.policySources.head,local);
   const expected=['bid-race','credit-timeout','catalog-latency','late-bid'].includes(name)?'likely':name==='dependency-outage'?'unlikely':'unknown';
   assert.equal(analysis.changeAssessment,expected,name);
   if(expected==='likely')assert.equal(analysis.candidateSha,item.sha);else assert.equal(analysis.candidateSha,null);
   if(item.expected&&name!=='dependency-outage')assert.ok(analysis.codeReview.findings.some(f=>f.signal===item.expected),name);
   if(item.unsupported)assert.equal(analysis.codeReview.findings.length,0);
   const result={scenario:name,incidentId:event.incidentId,sha:item.sha,baseSha:prior,assessment:analysis.changeAssessment,candidateSha:analysis.candidateSha,findings:analysis.codeReview.findings,unknowns:analysis.unknowns,completeComparison:comparison.content.complete,unrecognizedPaths:comparison.content.unrecognizedPaths,commits:comparison.content.comparison.commits?.map(row=>({sha:row.id,title:row.title})),rollback:analysis.rollback,rawEvidence:context.evidence};
   writeFileSync(resolve(out,name+'-agent.json'),JSON.stringify(result,null,2)+'\n');results.push({...result,rawEvidence:undefined});
  } finally {await worker.close();}
 }
 assert.equal((await db.query('SELECT COUNT(*) AS n FROM sre_rollbacks'))[0].n,0);
 writeFileSync(resolve(out,'real-gitlab-agent-matrix.json'),JSON.stringify({at:new Date().toISOString(),claudeEnabled:false,hostedDeployments:false,telemetry:'locally reproduced synthetic observations replayed into fictional release timelines',source:'real GitLab commits, comparisons and immutable source read by the agent collector',results},null,2)+'\n');
 console.log(JSON.stringify(results.map(({scenario,sha,assessment,findings})=>({scenario,sha,assessment,findings:findings.length})),null,2));
} finally {await db.close();}
