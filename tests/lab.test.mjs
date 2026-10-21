import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auction } from '../src/auction/service.mjs';
import { Store } from '../src/core/store.mjs';
import { emptyState, applyEvent, reviewDiff } from '../src/core/engine.mjs';
import { Lab } from '../src/lab.mjs';
import { scenarios } from '../src/scenarios.mjs';
import { seedPilot, pilotDiff } from '../scripts/seed-pilot.mjs';
import { createLabServer } from '../src/server.mjs';
import { GitLabReader, JiraReader, DynatraceReader, ReadClient } from '../src/connectors/clients.mjs';
import { normalizeDynatrace, normalizeGitLabDeployment } from '../src/connectors/normalizers.mjs';
import { createSqsHandler } from '../src/runtime/aws-sqs.mjs';
import { startTeams, teamsConfig } from '../apps/teams/server.mjs';

const manifest=seedPilot();
const base={source:'test',tenant:'synthetic',environment:'local',service:'auction-api',at:1000000};
const problem=(overrides={})=>({...base,id:'alert1',type:'problem',problemId:'P-1',status:'OPEN',metrics:{requests:5,errors:3,codes:['CREDIT_TIMEOUT']},...overrides});
const deployment=(overrides={})=>({...base,id:'deploy1',type:'deployment',status:'success',sha:'a'.repeat(40),artifact:'fixture:one',rollbackCompatible:true,...overrides});
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function close(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}

test('baseline enforces integer money, minimum increment, and close time',async()=>{
  let now=1000;const a=new Auction({clock:()=>now});const lot=a.lots[0];
  assert.equal((await a.bid(lot.id,lot.currentBidCents+1)).code,'BID_TOO_LOW');
  assert.equal((await a.bid(lot.id,NaN)).code,'BID_TOO_LOW');
  now=lot.endsAt;assert.equal((await a.bid(lot.id,lot.currentBidCents+10000)).code,'AUCTION_CLOSED');
});
test('baseline prevents concurrent lost updates',async()=>{
  const a=new Auction();const lot=a.lots[0];const start=lot.currentBidCents;
  const results=await Promise.all([a.bid(lot.id,start+30000,'A','a',5),a.bid(lot.id,start+20000,'B','b',40)]);
  assert.equal(results.filter(x=>x.status===201).length,1);assert.equal(lot.currentBidCents,start+30000);assert.deepEqual(a.telemetry().violations,[]);
});
test('concurrent repeated request commits one bid and rejects changed payload',async()=>{
  const a=new Auction();const lot=a.lots[0];const amount=lot.currentBidCents+10000;
  const results=await Promise.all([a.bid(lot.id,amount,'A','same'),a.bid(lot.id,amount,'A','same')]);
  assert.equal(results[0].status,201);assert.equal(results[1].status,201);assert.equal(lot.bids.length,1);
  assert.equal((await a.bid(lot.id,amount+10000,'A','same')).code,'IDEMPOTENCY_CONFLICT');
});
for(const scenario of scenarios)test('executable scenario: '+scenario.id,async()=>{
  const store=new Store(':memory:');const lab=new Lab({store});await lab.initialize();
  try{
    const result=await lab.run(scenario.id);
    assert.equal(result.detected,Boolean(scenario.expected));
    const incidents=Object.values(store.read().incidents);
    if(scenario.expected){assert.equal(incidents.length,1);assert.equal(incidents[0].signal,scenario.expected);}
    if(scenario.id==='schema-break')assert.equal(incidents[0].rollback.allowed,false);
    if(scenario.id==='dependency-outage'){assert.equal(incidents[0].candidateDeployment,null);assert.equal(incidents[0].rollback.allowed,false);}
    if(scenario.id==='bid-race')assert.equal(incidents[0].rollback.targetSha,manifest.baseline);
    assert.ok(pilotDiff(manifest.releases[scenario.id].sha).length>0);
  }finally{store.close();}
});
test('duplicate and semantically unchanged alerts produce a single pending message',()=>{
  let s=applyEvent(emptyState(),problem()).state;
  const duplicate=applyEvent(s,problem());assert.equal(duplicate.duplicate,true);
  s=applyEvent(s,problem({id:'alert2',at:base.at+1})).state;
  assert.equal(Object.keys(s.incidents).length,1);assert.equal(s.messages.length,1);assert.equal(s.processed.length,2);
});
test('out-of-order open does not reopen a closed problem; close requires independent verification',()=>{
  let s=applyEvent(emptyState(),problem({id:'close',status:'CLOSED',at:base.at+100})).state;
  s=applyEvent(s,problem()).state;assert.equal(Object.values(s.incidents)[0].status,'verifying');
  s=applyEvent(s,{...base,id:'verify',type:'health_verified',problemId:'P-1',at:base.at+200,healthy:true}).state;
  assert.equal(Object.values(s.incidents)[0].status,'resolved');
  s=applyEvent(s,problem({id:'closed-again',status:'CLOSED',at:base.at+300})).state;
  assert.equal(Object.values(s.incidents)[0].status,'resolved');
});
test('deployment matching is scoped to service, environment, tenant and time',()=>{
  let s=applyEvent(emptyState(),deployment({id:'old',at:base.at-300000,sha:'b'.repeat(40),healthy:true})).state;
  s=applyEvent(s,deployment({id:'current',at:base.at-1000})).state;
  for(const [i,fields] of [{service:'inventory'},{environment:'prod'},{tenant:'other'},{at:base.at+10}].entries())s=applyEvent(s,deployment({id:'wrong'+i,at:base.at-1,...fields,sha:'c'.repeat(40)})).state;
  const incident=Object.values(applyEvent(s,problem()).state.incidents)[0];assert.equal(incident.candidateDeployment.sha,'a'.repeat(40));assert.equal(incident.rollback.targetSha,'b'.repeat(40));
});
test('absent telemetry yields insufficient evidence and no rollback',()=>{
  const incident=Object.values(applyEvent(emptyState(),problem({metrics:{}})).state.incidents)[0];
  assert.equal(incident.signal,'UNKNOWN');assert.equal(incident.rollback.allowed,false);
});
test('an incident update cannot blame a deployment after the incident began',()=>{
  let s=applyEvent(emptyState(),deployment({id:'original',at:base.at-1000})).state;
  s=applyEvent(s,problem()).state;
  s=applyEvent(s,deployment({id:'later-release',at:base.at+1000,sha:'b'.repeat(40)})).state;
  s=applyEvent(s,problem({id:'problem-update',at:base.at+2000})).state;
  assert.equal(Object.values(s.incidents)[0].candidateDeployment.sha,'a'.repeat(40));
  assert.equal(Object.values(s.incidents)[0].startedAt,base.at);
  assert.throws(()=>applyEvent(emptyState(),problem({startedAt:base.at+1})),/startedAt/);
});
test('SQLite restart preserves deduplication and pending outbound messages',()=>{
  const dir=mkdtempSync(join(tmpdir(),'auction-state-'));const path=join(dir,'state.sqlite');
  try{let s=new Store(path);s.event(problem());s.close();s=new Store(path);assert.equal(s.event(problem()).duplicate,true);assert.equal(s.read().messages.length,1);assert.equal(s.read().messages[0].status,'pending');s.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
test('SQS adapter runs the same core and reports individual failed records',async()=>{
  const store=new Store(':memory:');try{
    const handler=createSqsHandler({store});const valid={messageId:'good',eventSource:'aws:sqs',body:JSON.stringify(problem())};
    const result=await handler({Records:[valid,{messageId:'bad',eventSource:'aws:sqs',body:'invalid json'},valid]});
    assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:'bad'}]});assert.equal(store.read().messages.length,1);
  }finally{store.close();}
});
test('static review recognizes added risky code, not removed code',()=>{
  assert.equal(reviewDiff('- checkVersion: false\n+ checkVersion: true').findings.length,0);
  assert.equal(reviewDiff(pilotDiff(manifest.releases['bid-race'].sha)).findings.length,1);
});
test('vendor payload normalizers reject insufficient deployment identity',()=>{
  const p=normalizeDynatrace({ProblemID:'P1',State:'OPEN',ObservedAt:'2026-10-19T12:00:00Z'},base);assert.equal(p.type,'problem');
  assert.throws(()=>normalizeDynatrace({ProblemID:'P1',State:'OPEN'},base),/ObservedAt/);
  const raw={object_kind:'deployment',status:'success',status_changed_at:'2026-10-19T12:00:00Z',deployment_id:1,environment:'local'};
  assert.throws(()=>normalizeGitLabDeployment(raw,{...base,sha:'short'}),/full deployment SHA/);
  assert.equal(normalizeGitLabDeployment(raw,{...base,sha:'a'.repeat(40),artifact:'digest'}).healthy,false);
});
test('connector HTTP contracts cover auth, exact resources, bounded reads and async DQL',async()=>{
  const calls=[];const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;calls.push({path:req.url,method:req.method,headers:req.headers,body:raw?JSON.parse(raw):null});
    res.setHeader('content-type','application/json');
    if(req.url.includes('/diffs'))res.end(JSON.stringify([{new_path:'rules.mjs',diff:'+ checkVersion: false'}]));
    else if(req.url.includes('/query:execute'))res.end(JSON.stringify({state:'RUNNING',requestToken:'sample-token'}));
    else if(req.url.includes('/query:poll'))res.end(JSON.stringify({state:'SUCCEEDED',result:{records:[]}}));
    else res.end(JSON.stringify({id:1,summary:'synthetic issue'}));
  });
  const url=await listen(server);
  try{
    const gl=new GitLabReader({base:url,local:true,token:'fixture-gitlab',project:17});await gl.mergeRequest(3);await gl.deployments();
    await new JiraReader({base:url,local:true,email:'fixture@example.invalid',token:'fixture-jira'}).issue('SA-102');
    await new DynatraceReader({base:url,local:true,token:'fixture-dt'}).problem('P-1');
    const dql=await new DynatraceReader({base:url,local:true,mode:'grail',token:'fixture-oauth',sleep:async()=>{}}).query('fetch dt.davis.problems | limit 1');
    assert.equal(dql.state,'SUCCEEDED');
    assert.ok(calls.some(x=>x.path==='/api/v4/projects/17/merge_requests/3' && x.headers['private-token']==='fixture-gitlab'));
    assert.ok(calls.some(x=>x.path.startsWith('/rest/api/3/issue/SA-102') && x.headers.authorization.startsWith('Basic ')));
    assert.ok(calls.some(x=>x.path==='/api/v2/problems/P-1' && x.headers.authorization==='Api-Token fixture-dt'));
    assert.ok(calls.some(x=>x.method==='POST' && x.body.maxResultRecords===50 && x.headers.authorization==='Bearer fixture-oauth'));
    assert.ok(calls.filter(x=>x.path.startsWith('/rest')).every(x=>x.method==='GET'));
  }finally{await close(server);}
});
test('connector retries bounded transient failures and fails on authorization errors',async()=>{
  let count=0;const c=new ReadClient({base:'https://example.invalid',sleep:async()=>{},fetcher:async()=>{count++;return new Response('{}',{status:count<3?429:200});}});
  await c.request('/resource');assert.equal(count,3);
  const denied=new ReadClient({base:'https://example.invalid',fetcher:async()=>new Response('do not expose this body',{status:401})});
  await assert.rejects(()=>denied.request('/resource'),/^Error: Connector returned HTTP 401$/);
  assert.throws(()=>new ReadClient({base:'http://example.com'}),/HTTPS/);
});
test('local web API accepts bids and scenarios, and blocks cross-origin mutation',async()=>{
  const store=new Store(':memory:');const lab=new Lab({store});const {server}=await createLabServer({lab});const url=await listen(server);
  try{
    const lots=await (await fetch(url+'/api/lots')).json();assert.equal(lots.length,3);
    const blocked=await fetch(url+'/api/reset',{method:'POST',headers:{origin:'https://example.invalid'},body:'{}'});assert.equal(blocked.status,403);
    const run=await fetch(url+'/api/scenarios/run',{method:'POST',body:JSON.stringify({id:'credit-timeout'})});assert.equal((await run.json()).detected,true);
    const question=await fetch(url+'/api/ask',{method:'POST',body:JSON.stringify({text:'Investigate auction-api'})});assert.match((await question.json()).text,/Credit checks/);
  }finally{await close(server);store.close();}
});
test('Teams modes prevent missing live credentials and accidental playground credentials',()=>{
  assert.equal(teamsConfig({mode:'playground',env:{}}).dangerouslyAllowUnauthenticatedRequests,true);
  assert.throws(()=>teamsConfig({mode:'live',env:{}}),/CLIENT_ID/);
  assert.throws(()=>teamsConfig({mode:'playground',env:{CLIENT_ID:'real'}}),/credential-free/);
  assert.equal(teamsConfig({mode:'live',env:{CLIENT_ID:'id',CLIENT_SECRET:'secret',TENANT_ID:'tenant',TEAMS_ALLOWED_CONVERSATIONS:'channel'}}).dangerouslyAllowUnauthenticatedRequests,false);
});
test('Teams SDK bridge receives a Playground activity and delivers a reply to local transport',async()=>{
  const store=new Store(':memory:');const lab=new Lab({store});await lab.initialize();await lab.run('bid-race');
  const {server}=await createLabServer({lab});const labUrl=await listen(server);const deliveries=[];
  const transport=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;deliveries.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'response-id'}));});
  const transportUrl=await listen(transport);
  const bridge=await startTeams({mode:'playground',port:0,env:{SRE_LAB_URL:labUrl},store:new Store(':memory:')});
  try{
    const response=await fetch('http://127.0.0.1:'+bridge.server.address().port+'/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'message',id:'activity-1',timestamp:new Date().toISOString(),channelId:'msteams',serviceUrl:transportUrl,from:{id:'test-user',name:'Tester'},recipient:{id:'test-bot',name:'SRE'},conversation:{id:'test-conversation',conversationType:'personal'},channelData:{tenant:{id:'synthetic'}},text:'Investigate auction-api'})});
    assert.equal(response.status,200);assert.ok(deliveries.some(x=>x.text?.includes('concurrent update')));
    assert.ok(bridge.store.read().teamsReferences['test-conversation']);
  }finally{await bridge.close();await close(transport);await close(server);store.close();}
});

test('Teams live endpoint rejects unauthenticated activities before contacting the lab',async()=>{
  const bridge=await startTeams({mode:'live',port:0,env:{CLIENT_ID:'11111111-1111-1111-1111-111111111111',CLIENT_SECRET:'synthetic-test-secret',TENANT_ID:'22222222-2222-2222-2222-222222222222',TEAMS_ALLOWED_CONVERSATIONS:'test-conversation'},store:new Store(':memory:')});
  try {
    const response=await fetch('http://127.0.0.1:'+bridge.server.address().port+'/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'message',id:'unauthenticated',channelId:'msteams',serviceUrl:'http://127.0.0.1:1',conversation:{id:'test-conversation'},text:'Investigate'})});
    assert.equal(response.status,401);
    assert.equal(bridge.store.read().teamsReferences,undefined);
  } finally { await bridge.close(); }
});
