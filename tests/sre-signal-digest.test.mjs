import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSignalDigest,selectSignalEvidence,signalDigestText,signalLimits} from '../src/sre/signal-digest.mjs';
import {boundedContext,modelContextLimits} from '../src/sre/model-context.mjs';
import {DynatraceConnector} from '../src/sre/connectors.mjs';

const now=Date.now(),a='a'.repeat(40),b='b'.repeat(40);
const log=(i,fields={})=>({timestamp:new Date(now+i).toISOString(),content:'Credit timeout for request-'+String(i).padStart(8,'0'),requestId:'request-'+String(i).padStart(8,'0'),loglevel:'ERROR',errorCode:'CREDIT_TIMEOUT','service.name':'checkout',environment:'production',region:'eu',operation:'/checkout','service.version':b,...fields});
const batch=(id,items,extra={})=>({id,source:'dynatrace',kind:'logs',observed_at:now,content:{records:items,complete:true,...extra}});

test('overlapping reads collapse observed signatures while environment, operation, region, release and error codes stay distinct',()=>{
  const common=Array.from({length:120},(_,i)=>log(i));
  const variants=[log(900,{loglevel:'CRITICAL',errorCode:'SCHEMA_MISMATCH',content:'Schema mismatch at line 500'}),log(901,{region:'us'}),log(902,{'service.version':a}),log(903,{environment:'staging'}),log(904,{operation:'/catalog'}),log(905,{content:'HTTP 500'}),log(906,{content:'HTTP 503'})];
  const input=[batch('read-a',common),batch('read-b',[...common.slice(60),...variants])];
  const digest=buildSignalDigest({evidence:input,deployments:[{provider:'gitlab',sha:b,at:now-1000,status:'success',environment:'production'}],incident:{started_at:now}});
  assert.equal(digest.coverage.duplicateObservations,60);assert.equal(digest.groups.length,8);
  assert.equal(digest.groups[0].code,'SCHEMA_MISMATCH','rare critical evidence must precede the frequent timeout');
  const primary=digest.groups.find(group=>group.code==='CREDIT_TIMEOUT'&&group.region==='eu'&&group.environment==='production'&&group.operation==='/checkout'&&group.version===b&&group.message.includes('Credit timeout'));
  assert.equal(primary.observations,120);assert.equal(primary.duplicateObservations,60);assert.equal(primary.deploymentMatches[0].sha,b);
  assert.ok(digest.groups.some(group=>group.message==='HTTP 500'));assert.ok(digest.groups.some(group=>group.message==='HTTP 503'));
  assert.equal(input[0].content.records[0].requestId,'request-00000000','aggregation must not rewrite raw records');
});

test('an older rare error and current GitLab comparison survive informational noise in source selection',()=>{
  const info=Array.from({length:110},(_,i)=>({...batch('info-'+i,[log(i,{loglevel:'INFO',errorCode:'',content:'Health probe successful'})]),observed_at:now+i}));
  const rare={...batch('rare',[log(-1000,{loglevel:'CRITICAL',errorCode:'CORRUPT_BID',content:'Winning bid regressed'})]),observed_at:now-1000};
  const code={id:'code',source:'gitlab',kind:'release_diff',observed_at:now-2000,content:{baseSha:a,headSha:b}};
  const selection=selectSignalEvidence([...info.reverse(),rare,code]);
  assert.ok(selection.selected.some(row=>row.id==='rare'));assert.ok(selection.selected.some(row=>row.id==='code'));
  assert.equal(selection.selected.filter(row=>row.id.startsWith('info')).length,1);assert.equal(selection.redundant,109);
});

test('missing timestamps remain uncertain observations and cannot be silently deduplicated',()=>{
  const record=log(1);delete record.timestamp;
  const digest=buildSignalDigest({evidence:[batch('no-time',[record,record])]});
  assert.equal(digest.coverage.missingTimestamps,2);assert.equal(digest.coverage.duplicateObservations,0);assert.equal(digest.groups[0].observations,2);assert.equal(digest.groups[0].firstAt,null);
  assert.match(signalDigestText(digest),/bounded samples/);
});

test('structured HTTP statuses stay separate and differing raw values are not called overlapping duplicates',()=>{
  const one=log(7,{content:'HTTP request failed','http.response.status_code':500,durationMs:1000});
  const two={...one,durationMs:2000},three={...one,'http.response.status_code':503};
  const digest=buildSignalDigest({evidence:[batch('http-status',[one,two,three])]});
  assert.equal(digest.groups.length,2);assert.equal(digest.coverage.duplicateObservations,0);assert.equal(digest.groups.find(group=>group.statusCode==='500').observations,2);
});

test('unknown schemas remain distinct and unknown severity is retained ahead of routine informational noise',()=>{
  const digest=buildSignalDigest({evidence:[batch('unknown',[{timestamp:new Date(now).toISOString(),unexpected:'first'},{timestamp:new Date(now).toISOString(),unexpected:'second'},log(1,{loglevel:'INFO',content:'Routine probe'})])]});
  assert.equal(digest.groups.length,3);assert.equal(digest.groups[0].level,'UNKNOWN');assert.equal(digest.groups[1].level,'UNKNOWN');assert.equal(digest.groups[2].level,'INFO');
});

test('post-incident deployment matches retain their time boundary instead of implying the version was deployed at incident start',()=>{
  const digest=buildSignalDigest({incident:{started_at:now},evidence:[batch('future-release',[log(1)])],deployments:[{provider:'gitlab',sha:b,at:now+1000,status:'success',environment:'production'}]});
  assert.equal(digest.groups[0].deploymentMatches[0].atIncidentStart,false);
});

test('record and group budgets expose omissions and partial reads rather than implying a complete error inventory',()=>{
  const digest=buildSignalDigest({evidence:[batch('large',Array.from({length:2500},(_,i)=>log(i,{content:'Distinct error '+i})),{complete:false})],evidenceWindow:{totalAvailable:999,candidatesLimited:true}});
  assert.equal(digest.coverage.recordsScanned,signalLimits.records);assert.equal(digest.coverage.recordsNotScanned,500);assert.equal(digest.groups.length,signalLimits.groups);assert.ok(digest.coverage.omittedGroups>0);assert.equal(digest.coverage.partialResults,1);assert.match(signalDigestText(digest),/Coverage is limited/);
});

test('GitLab digest retains exact comparison and commit history, keeps incomplete review conditional and does not infer causation',()=>{
  const evidence=[{id:'diff',source:'gitlab',kind:'release_diff',observed_at:now,content:{provider:'gitlab',comparisonKind:'deployment',baseSha:a,headSha:b,complete:true,policySources:{complete:true},comparison:{commits:[{id:b,title:'Tighten credit timeout',created_at:new Date(now-1000).toISOString()}],diffs:[{new_path:'src/credit/client.js',diff:'+ timeout = 10'}]}}},{id:'review',source:'gitlab',kind:'code_review',observed_at:now+1,content:{provider:'gitlab',comparisonKind:'review',baseSha:b,headSha:'c'.repeat(40),complete:false}}];
  const digest=buildSignalDigest({evidence});
  assert.equal(digest.changes.find(row=>row.evidenceId==='diff').commits[0].sha,b);assert.deepEqual(digest.changes.find(row=>row.evidenceId==='diff').paths,['src/credit/client.js']);assert.equal(digest.changes.find(row=>row.evidenceId==='review').complete,false);assert.equal(digest.deployments.length,0);assert.match(digest.interpretation,/not causation/);
});

test('model digest references only raw evidence IDs surviving the final bounded transport',()=>{
  const context={incident:{id:'inc_digest',service_key:'checkout',issue_key:'P1'},session:{agent_id:'agent_digest'},evidence:[batch('retained',[log(1)])],deployments:[],signalDigest:buildSignalDigest({evidence:[batch('retained',[log(1)]),batch('missing',[log(1)])]})};
  context.signalDigest.changes=[{evidenceId:'unseen-comparison',provider:'gitlab',baseSha:a,headSha:b,complete:true,paths:[],commits:[]}];
  const view=boundedContext(context);assert.deepEqual(view.signalDigest.groups[0].evidenceIds,['retained']);assert.equal(view.signalDigest.groups[0].evidenceOmitted,true);assert.equal(view.signalDigest.changes[0].evidenceId,undefined);assert.equal(view.signalDigest.changes[0].evidenceOmitted,true);assert.ok(Buffer.byteLength(JSON.stringify(view))<=modelContextLimits.totalBytes);
});

for(const [name,grail,complete] of [['ordinary',{sampled:false,notifications:[]},true],['sampled',{sampled:true,notifications:[]},false],['warning',{sampled:false,notifications:[{severity:'WARN',notificationType:'BYTE_LIMIT'}]},false],['informational',{notifications:[{severity:'INFO',notificationType:'NOTICE'}]},true]])test('Grail '+name+' metadata controls completeness even below the record limit',async()=>{
  const connector=new DynatraceConnector({base:'https://dynatrace.invalid',mode:'grail',tokenEnv:'TOKEN'},{env:{TOKEN:'fixture'},fetcher:async()=>new Response(JSON.stringify({state:'SUCCEEDED',result:{records:[],metadata:{grail}}}),{headers:{'content-type':'application/json'}})});
  const result=await connector.query('fetch logs',{from:now-1000,to:now});assert.equal(result.complete,complete);assert.deepEqual(result.metadata.grail,grail);
});

test('a successful Grail state without records is a connector failure, not an empty complete result',async()=>{
  const connector=new DynatraceConnector({base:'https://dynatrace.invalid',mode:'grail',tokenEnv:'TOKEN'},{env:{TOKEN:'fixture'},fetcher:async()=>new Response(JSON.stringify({state:'SUCCEEDED',result:{metadata:{}}}),{headers:{'content-type':'application/json'}})});
  await assert.rejects(()=>connector.query('fetch logs',{from:now-1000,to:now}),/record array/);
});

test('malformed Grail sampling metadata fails closed instead of declaring complete coverage',async()=>{
  const connector=new DynatraceConnector({base:'https://dynatrace.invalid',mode:'grail',tokenEnv:'TOKEN'},{env:{TOKEN:'fixture'},fetcher:async()=>new Response(JSON.stringify({state:'SUCCEEDED',result:{records:[],metadata:{grail:{sampled:'true'}}}}),{headers:{'content-type':'application/json'}})});
  await assert.rejects(()=>connector.query('fetch logs',{from:now-1000,to:now}),/sampling metadata/);
});
