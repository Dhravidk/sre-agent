import test from 'node:test';
import assert from 'node:assert/strict';
import {DynatraceConnector} from '../src/sre/connectors.mjs';
import {diagnosticLogFilters,observedDiagnosticLogFilters} from '../src/sre/diagnostic-log-query.mjs';
import {validateEvidenceRequests} from '../src/sre/evidence-request.mjs';
import {EvidenceFollowup} from '../src/sre/evidence-followup.mjs';
import {readEvidenceReadHistory} from '../src/sre/evidence-read-history.mjs';
import {sourceReferenceFixture} from '../fixtures/sre-source-references.mjs';
import {noisyLogCase} from '../fixtures/dynatrace-noise.mjs';
import {validateAgentInvestigation} from '../src/sre/agent-investigation.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const from=1792660000000,to=from+1000,environment='testing',route='/api/requests',base='b'.repeat(40),head='a'.repeat(40);
const record={timestamp:new Date(from+1).toISOString(),'service.name':'diagnostic-api','deployment.environment':environment,'http.route':route,'service.version':head,'trace.id':'trace-1',content:'Observed business request'};
const metadata={grail:{sampled:false,notifications:[]}};
function connector(response={records:[record],metadata}){
 const calls=[],client=new DynatraceConnector({mode:'grail',base:'https://diagnostic.invalid',tokenEnv:'DIAGNOSTIC_TOKEN',logField:'service.name',logValue:'diagnostic-api'},{env:{DIAGNOSTIC_TOKEN:'fictional-token'},retries:0,fetcher:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({state:'SUCCEEDED',result:response}),{headers:{'content-type':'application/json'}});}});
 return{client,calls};
}
test('diagnostic selectors are exact, bounded, canonical and cannot select scope fields or raw DQL',()=>{
 const request={kind:'dynatrace_logs',from,to,reason:'Compare operation and release',filters:[{field:'service.version',value:head},{field:'http.route',value:route}]};
 assert.deepEqual(validateEvidenceRequests([request])[0].filters,[...request.filters].reverse());
 for(const filters of [null,{},[{field:'service.name',value:'foreign'}],[{field:'deployment.environment',value:'production'}],[{field:'trace.id',value:'a',query:'fetch logs'}],[{field:'trace.id',value:'a'},{field:'trace.id',value:'b'}],[{field:'trace.id',value:'x\n| fetch logs'}],[{field:'trace.id',value:'x'.repeat(257)}]])assert.throws(()=>diagnosticLogFilters(filters));
 assert.throws(()=>validateEvidenceRequests([{...request,query:'fetch logs'}]));
 const snapshot={evidence:[{source:'jira',kind:'logs',content:{records:[record]}},{source:'dynatrace',kind:'logs',content:{records:[record]}}]};
 assert.deepEqual(observedDiagnosticLogFilters(snapshot).find(row=>row.field==='http.route').values,[route]);
 assert.equal(observedDiagnosticLogFilters({evidence:snapshot.evidence.slice(0,1)}).length,0);
 assert.deepEqual(observedDiagnosticLogFilters({evidence:[{source:'dynatrace',kind:'logs',content:{records:{malformed:true}}}]}),[]);
});
test('host DQL keeps service, environment, half-open time, exact escaped selectors and explicit scan/sampling budgets',async()=>{
 const value='/api/" or true | fetch logs \\x',row={...record,'http.route':value},f=connector({records:[row],metadata});
 const result=await f.client.diagnosticLogs({from,to,environment,filters:[{field:'http.route',value}]});
 assert.equal(result.complete,true);const body=f.calls[0].body;
 assert.ok(body.query.includes('service.name == "diagnostic-api" and deployment.environment == "testing"'));
 assert.ok(body.query.includes('http.route == '+JSON.stringify(value)));
 assert.ok(body.query.includes('timestamp >= toTimestamp(')&&body.query.includes('timestamp < toTimestamp('));
 assert.ok(body.query.startsWith('fetch logs, samplingRatio:1'));assert.equal(body.defaultSamplingRatio,1);assert.equal(body.defaultScanLimitGbytes,0.125);assert.equal(body.maxResultRecords,200);
 assert.deepEqual(result.queryScope.filters,[{field:'http.route',value}]);
});
test('foreign, denied and malformed query responses stay unavailable; partial selections never become complete',async()=>{
 for(const change of [{'service.name':'foreign'},{'deployment.environment':'production'},{'http.route':'/foreign'},{timestamp:new Date(to).toISOString()}]){
  const f=connector({records:[{...record,...change}],metadata});await assert.rejects(()=>f.client.diagnosticLogs({from,to,environment,filters:[{field:'http.route',value:route}]}),/scope|window/);
 }
 for(const response of [{records:[{...record,timestamp:undefined}],metadata},{records:[record]},{records:[record],metadata:{grail:{sampled:true,notifications:[]}}},{records:Array.from({length:200},()=>record),metadata}]){
  assert.equal((await connector(response).client.diagnosticLogs({from,to,environment})).complete,false);
 }
 const f=connector();await assert.rejects(()=>f.client.diagnosticLogs({from,to:from+900001,environment}),/fifteen/);assert.equal(f.calls.length,0);
 f.client.query=async()=>{throw Error('Provider denied');};await assert.rejects(()=>f.client.diagnosticLogs({from,to,environment}),/denied/);
 const controller=new AbortController();f.client.query=async()=>{controller.abort(Error('Cancelled'));return{records:[record],complete:true,metadata};};await assert.rejects(()=>f.client.diagnosticLogs({from,to,environment,signal:controller.signal}),/Cancelled/);
});
for(const dialect of ['sqlite','postgres'])test(dialect+': filtered old/new reads retain distinct fenced resources and refuse undelivered selectors without a query',async()=>{
 const f=await sourceReferenceFixture(dialect,{followUp:true,logLocations:true});
 try{
  const at=f.manifest.observedAt,records=[f.manifest.base,f.manifest.head].map(sha=>({...f.logReply.records[0],'http.route':route,'service.version':sha}));
  await f.r.store.addEvidence(f.id,'dynatrace','logs',{records,complete:false});await f.question();await f.r.store.release(f.r.worker.owner);const job=await f.r.store.claim('diagnostic-test-owner'),context=await f.r.store.context(f.id),clients=f.r.worker.connectors.get(f.service.key),calls=[];
  clients.dynatraceLogs.diagnosticLogs=async options=>{calls.push(options);return{records:records.filter(row=>options.filters.every(({field,value})=>row[field]===value)),complete:true,metadata};};
  const followup=new EvidenceFollowup({store:f.r.store,job,service:f.service,clients}),policy=await followup.policy(context,0),request={kind:'dynatrace_logs',from:at-1,to:at+1,reason:'Compare exact release request behavior'};
  assert.ok(policy.logs.filters.fields.some(row=>row.field==='service.version'&&row.values.includes(f.manifest.base)));
  policy.logs.filters.fields.push({field:'error.code',values:['invented']});
  await followup.run([{...request,filters:[{field:'error.code',value:'invented'}]}],context,0);assert.equal(calls.length,0);assert.equal(followup.results[0].phase,'refused');
  await followup.run([f.manifest.base,f.manifest.head].map(sha=>({...request,filters:[{field:'service.version',value:sha},{field:'http.route',value:route}]})),context,0);
  assert.equal(calls.length,2);assert.ok(calls.every(row=>row.environment===f.service.environment));
  const fresh=await f.r.store.context(f.id),history=await readEvidenceReadHistory(f.r.store,fresh),collected=history.outcomes.filter(row=>row.phase==='collected'&&row.kind==='dynatrace_logs');
  assert.equal(collected.length,2);assert.deepEqual(new Set(collected.map(row=>row.selector.filters.find(item=>item.field==='service.version').value)),new Set([f.manifest.base,f.manifest.head]));
  const before=calls.length;await followup.policy(fresh,1);await followup.run([{...request,filters:[{field:'http.route',value:route},{field:'service.version',value:f.manifest.head}]}],fresh,1);assert.equal(calls.length,before);
 }finally{await f.close();}
});
test('planning rollback rejects unknown compatibility and contradictory deployment history without choosing a replacement strategy',()=>{
 const original=noisyLogCase().context,data={changeAssessment:'likely',candidateSha:original.deployments[0].sha,remediation:{kind:'rollback-candidate',targetSha:original.deployments[1].sha,rationale:'Historically compatible target',evidenceIds:[],verificationSteps:['Recheck independent health'],blockingUnknowns:['Execution remains disabled']}};
 assert.doesNotThrow(()=>validateAgentInvestigation(data,original));
 for(const field of ['schemaVersion','dependencyFingerprint','configurationFingerprint','featureFlagsFingerprint'])for(const value of [null,'',true,{},-1]){
  const c=structuredClone(original);c.deployments[0][field]=value;c.deployments[1][field]=value;assert.throws(()=>validateAgentInvestigation(data,c),/rollback candidate/);
 }
 for(const mutate of [c=>c.deployments[0].identityConflict=true,c=>c.deployments[1].statusConflict=true,c=>c.deployments[1].historyIncomplete=true,c=>c.deployments[0].attestationConflicts=[{field:'schemaVersion',at:c.deployments[0].at}],c=>c.deployments[1].status='failed',c=>c.deployments.push({...c.deployments[0],sha:'c'.repeat(40),at:c.incident.started_at+1})]){const c=structuredClone(original);mutate(c);assert.throws(()=>validateAgentInvestigation(data,c),/rollback candidate/);}
 const fix={...data,candidateSha:null,changeAssessment:'unknown',remediation:{...data.remediation,kind:'forward-fix',targetSha:null}};assert.doesNotThrow(()=>validateAgentInvestigation(fix,original));
 for(const reverse of [false,true]){const c=structuredClone(original);c.deployments.push({...c.deployments[0],id:'newer-same-sha',at:c.incident.started_at-1,rollbackCompatible:false,configurationFingerprint:'changed'});if(reverse)c.deployments.reverse();assert.throws(()=>validateAgentInvestigation(data,c),/rollback candidate/);}
});

test('filtered read history survives reopen without replaying a provider query',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'diagnostic-read-reopen-')),f=await sourceReferenceFixture('sqlite',{directory,databasePath:join(directory,'state.sqlite'),followUp:true,logLocations:true});
 try{
  const record={...f.logReply.records[0],'http.route':route};await f.r.store.addEvidence(f.id,'dynatrace','logs',{records:[record],complete:false});await f.question();await f.r.store.release(f.r.worker.owner);const job=await f.r.store.claim('filtered-reopen'),context=await f.r.store.context(f.id),clients=f.r.worker.connectors.get(f.service.key);let calls=0;
  clients.dynatraceLogs.diagnosticLogs=async()=>{calls++;return{records:[record],complete:true,metadata};};const followup=new EvidenceFollowup({store:f.r.store,job,service:f.service,clients});
  await followup.policy(context,0);await followup.run([{kind:'dynatrace_logs',from:f.manifest.observedAt-1,to:f.manifest.observedAt+1,filters:[{field:'http.route',value:route}],reason:'Inspect per-request outcomes'}],context,0);
  const before=await readEvidenceReadHistory(f.r.store,await f.r.store.context(f.id));await f.restart();const after=await readEvidenceReadHistory(f.r.store,await f.r.store.context(f.id));assert.deepEqual(after,before);assert.equal(calls,1);assert.equal(after.outcomes[0].phase,'collected');
 }finally{await f.close();await rm(directory,{recursive:true,force:true});}
});
for(const mode of ['cancel','revision'])test('filtered read '+mode+' during a request cannot retain a late artifact',async()=>{
 const f=await sourceReferenceFixture('sqlite',{followUp:true,logLocations:true});
 try{
  const record={...f.logReply.records[0],'http.route':route};await f.r.store.addEvidence(f.id,'dynatrace','logs',{records:[record],complete:false});await f.question();await f.r.store.release(f.r.worker.owner);const job=await f.r.store.claim('filtered-fence'),context=await f.r.store.context(f.id),clients=f.r.worker.connectors.get(f.service.key),controller=new AbortController();let enter,release;
  const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);clients.dynatraceLogs.diagnosticLogs=async()=>{enter();await gate;return{records:[record],complete:true,metadata};};const followup=new EvidenceFollowup({store:f.r.store,job,service:f.service,clients,signal:controller.signal});
  await followup.policy(context,0);const pending=followup.run([{kind:'dynatrace_logs',from:f.manifest.observedAt-1,to:f.manifest.observedAt+1,filters:[{field:'http.route',value:route}],reason:'Inspect per-request outcomes'}],context,0);await entered;
  if(mode==='cancel')controller.abort(Error('Cancelled filtered read'));else await f.r.store.db.query('UPDATE sre_incidents SET revision=revision+1 WHERE id=?',[f.id]);release();
  if(mode==='cancel')await assert.rejects(()=>pending,/Cancelled/);else assert.equal(await pending,false);
  assert.equal((await f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='logs' AND content LIKE '%followUp%' ")).length,0);
 }finally{await f.close();}
});
