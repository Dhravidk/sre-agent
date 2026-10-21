import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sqliteDatabase,postgresSql } from '../src/sre/database.mjs';
import { fixtureRisk } from '../src/sre/analytic-risk.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { seedDemo,devActivity } from '../src/sre/demo.mjs';
import { assessRollback,Rollbacks } from '../src/sre/rollback.mjs';
import { TeamsRouter,TeamsOutbox,startSreTeams } from '../src/sre/teams.mjs';
import { EveReasoner,validateInvestigation } from '../src/sre/reasoner.mjs';
import { evidenceCapability,readEvidenceCapability } from '../src/sre/security.mjs';

const config=()=>loadConfig({SRE_SQLITE_PATH:':memory:'});
const issue=(fields={})=>({id:'p1',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'dynatrace:P1',status:'OPEN',title:'Bidding failed',at:Date.now()-1000,payload:{metrics:{codes:['CREDIT_TIMEOUT']}},...fields});
async function store(db=sqliteDatabase(':memory:')){return new SreStore(db).initialize();}
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function close(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
const principal=(service)=>({verified:true,simulation:true,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0],userId:'local-operator'});
async function ready(scenario='recent-regression',db){const r=await createSreRuntime({config:config(),db,autoStart:false});const seeded=await seedDemo(r.store,r.config.services[0],scenario);await r.worker.runOnce();return {r,id:seeded.incidentId,service:r.config.services[0]};}

test('SRE inbox is atomic, idempotent, and rejects changed replay payloads',async()=>{
  const s=await store();try{const event=issue();const first=await s.ingest(event);assert.equal((await s.ingest(event)).duplicate,true);await assert.rejects(()=>s.ingest({...event,title:'different'}),/reused/);await assert.rejects(()=>s.ingest(issue({id:'invalid',status:'invalid'})),/status/);const snapshot=await s.snapshot();assert.equal(snapshot.counts[0].count,1);assert.equal(snapshot.jobs.length,1);assert.equal(snapshot.sessions.length,1);assert.equal((await s.context(first.incidentId)).incident.status,'open');}finally{await s.db.close();}
});
test('each incident has an isolated durable session; service-scoped questions cannot cross scopes',async()=>{
  const s=await store();try{const a=await s.ingest(issue());const b=await s.ingest(issue({id:'p2',issueKey:'dynatrace:P2'}));const ca=await s.context(a.incidentId),cb=await s.context(b.incidentId);assert.notEqual(ca.session.agent_id,cb.session.agent_id);assert.notEqual(ca.evidence[0].id,cb.evidence[0].id);await assert.rejects(()=>s.ingest({id:'q1',source:'operator',serviceKey:'other',kind:'question',incidentId:a.incidentId,at:Date.now(),payload:{text:'cross scope'}}),/Unknown incident/);}finally{await s.db.close();}
});
test('source closures cannot hide another open monitor; recovery requires independent verification',async()=>{
  const s=await store();try{const at=Date.now()-10000;const {incidentId}=await s.ingest(issue({at}));await s.ingest(issue({id:'snow1',source:'servicenow',at:at+1,payload:{sys_id:'1'.repeat(32)}}));await s.ingest(issue({id:'snow2',source:'servicenow',status:'CLOSED',at:at+3,payload:{sys_id:'1'.repeat(32)}}));assert.equal((await s.context(incidentId)).incident.status,'open');await s.ingest(issue({id:'dt2',status:'CLOSED',at:at+2}));assert.equal((await s.context(incidentId)).incident.status,'verifying');await s.ingest(issue({id:'old-open',at}));assert.equal((await s.context(incidentId)).incident.status,'verifying');const deployment={provider:'github',environment:'local',status:'success',sha:'a'.repeat(40),artifact:'sha256:'+'b'.repeat(64)};await s.ingest({id:'deploy',source:'releases',serviceKey:'auction-local',kind:'deployment',at:at-1000,payload:deployment});await s.ingest({id:'healthy',source:'verification',serviceKey:'auction-local',kind:'verification',incidentId,at:at+4,payload:{...deployment,incidentId,deploymentAt:at-1000,observedAt:at+4,healthy:true,checks:{technical:true,businessInvariants:true},evidenceUrl:'https://verifier.invalid/1'}});assert.equal((await s.context(incidentId)).incident.status,'resolved');}finally{await s.db.close();}
});
test('worker lease admits only one investigator and fences a worker after expiry',async()=>{
  const s=await store();let now=Date.now();s.clock=()=>now;try{await s.ingest(issue());const a=await s.claim('a',10);assert.ok(a);assert.equal(await s.claim('b',10),null);now+=11;const b=await s.claim('b',10);assert.equal(b.id,a.id);await assert.rejects(()=>s.finish(a,{text:'stale'}),/lease lost/);await s.fail(b,new Error('temporary'));assert.equal((await s.snapshot()).jobs[0].status,'pending');}finally{await s.db.close();}
});
test('a new event prevents publishing obsolete analysis',async()=>{
  const s=await store();try{const first=await s.ingest(issue());const c=await s.context(first.incidentId);const job=await s.claim('a');await s.ingest(issue({id:'update',at:Date.now()}));assert.equal(await s.finish(job,{text:'stale'},null,c.incident.revision),null);assert.equal((await s.snapshot()).outbox.length,0);}finally{await s.db.close();}
});
test('SQLite restart preserves pending work, conversations, and per-issue identity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sre-'));try{let s=await store(sqliteDatabase(join(dir,'db.sqlite')));const event=issue();const result=await s.ingest(event);const original=(await s.context(result.incidentId)).session.agent_id;await s.rememberConversation({tenant:'synthetic',reference:{conversation:{id:'test-conversation'},serviceUrl:'http://127.0.0.1:1'},serviceKey:'auction-local'});await s.db.close();s=await store(sqliteDatabase(join(dir,'db.sqlite')));assert.equal((await s.context(result.incidentId)).session.agent_id,original);assert.equal((await s.ingest(event)).duplicate,true);assert.ok(await s.claim('new-process'));assert.equal((await s.db.query('SELECT * FROM sre_conversations')).length,1);await s.db.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
for(const [scenario,eligible,pattern] of [['recent-regression',true,null],['old-feature',false,/too old/],['schema-change',false,/data safety/],['dependency-outage',false,/deployment-related/]])test('rollback decision: '+scenario,async()=>{
  const {r,id,service}=await ready(scenario);try{const result=assessRollback(await r.store.context(id),service);assert.equal(result.eligible,eligible,JSON.stringify(result.reasons));if(pattern)assert.match(result.reasons.join(' '),pattern);}finally{await r.close();}
});
test('approval binds identity, tenant, conversation, nonce, policy, and expiry',async()=>{
  const {r,id,service}=await ready();try {
    const p=principal(service),proposal=await r.rollbacks.propose(id,p),nonce=proposal.text.split(' ').at(-1);
    for(const change of [{userId:'outsider'},{tenant:'other'},{conversationId:'other'},{verified:false}])await assert.rejects(()=>r.rollbacks.approve(proposal.id,nonce,{...p,...change}),/authoriz/);
    await assert.rejects(()=>r.rollbacks.approve(proposal.id,'bad',p),/nonce/);
    // Keep a separate pending proposal to exercise expiry. A successful local
    // simulation now prevents creating a fresh replay for the same incident.
    const next=await r.rollbacks.propose(id,p);assert.equal(next.eligible,true);
    await r.rollbacks.approve(proposal.id,nonce,p);
    assert.equal((await r.store.snapshot()).rollbacks.find(row=>row.id===proposal.id).status,'approved');
    await assert.rejects(()=>r.rollbacks.approve(proposal.id,nonce,p),/handled/);
    await r.rollbacks.executeNext();assert.equal((await r.store.snapshot()).rollbacks.find(row=>row.id===proposal.id).status,'simulated');assert.equal(await r.rollbacks.executeNext(),false);
    assert.equal((await r.rollbacks.propose(id,p)).eligible,false);
    r.store.clock=()=>next.expiresAt+1;await assert.rejects(()=>r.rollbacks.approve(next.id,next.text.split(' ').at(-1),p),/expired/);
  }finally{await r.close();}
});
test('approved actions are blocked when a new deployment, revoked authorization, or unsafe metadata arrives',async()=>{
  for(const change of ['deployment','authorization','schema']){const {r,id,service}=await ready();try{const p=principal(service);const proposal=await r.rollbacks.propose(id,p);await r.rollbacks.approve(proposal.id,proposal.text.split(' ').at(-1),p);if(change==='authorization')service.teams.approvers=[];else{const c=await r.store.context(id);const d=assessRollback(c,service).current;await r.store.ingest({id:'changed',source:'releases',serviceKey:service.key,kind:'deployment',at:Date.now(),payload:{...d,sha:change==='deployment'?'f'.repeat(40):d.sha,schemaVersion:2}});}await r.rollbacks.executeNext();assert.equal((await r.store.snapshot()).rollbacks[0].status,'blocked');}finally{await r.close();}}
});
test('connected rollback dispatch occurs once; ambiguous outcome requires reconciliation',async()=>{
  const {r,id,service}=await ready();try{let calls=0;const current=assessRollback(await r.store.context(id),service).current;const executor=new Rollbacks({store:r.store,services:[service],mode:'connected',connectors:new Map([[service.key,{github:{deployments:async()=>({complete:true,items:[current]})},rollback:{dispatch:async()=>{calls++;throw new Error('transport timeout');}}}]])});const p={...principal(service),simulation:false};const proposed=await executor.propose(id,p);await executor.approve(proposed.id,proposed.text.split(' ').at(-1),p);await executor.executeNext();assert.equal(calls,1);assert.equal((await r.store.snapshot()).rollbacks[0].status,'unknown');await executor.executeNext();assert.equal(calls,1);assert.equal((await r.store.context(id)).incident.status,'open');}finally{await r.close();}
});
test('Eve uses separate incident sessions and validates citations and capabilities',async()=>{
  const s=await store();try{const a=await s.ingest(issue()),b=await s.ingest(issue({id:'p2',issueKey:'dynatrace:P2'}));let count=0;const attached=[];const sessions=new Map();const client={sessions:{create:async()=>{const session={state:{sessionId:'s'+(++count),streamIndex:0},send:async(message,options)=>{const c=options.clientContext.evidence;return {result:async()=>({status:'completed',data:{risk:fixtureRisk(c),summary:'Evidence review',hypotheses:[],changeAssessment:'unknown',candidateSha:null,evidenceIds:[c.evidence[0].id],unknowns:[],nextSteps:[]}})};}};sessions.set(session.state.sessionId,session);return {session};},attach:id=>{attached.push(id);return sessions.get(id);}}};const reasoner=new EveReasoner({host:'http://127.0.0.1:2000',token:'fixture',capabilitySecret:'fixture',client});for(const id of [a.incidentId,a.incidentId,b.incidentId])await reasoner.investigate(await s.context(id),{persistRemote:state=>s.setRemoteState(id,state)});assert.equal(count,2);assert.deepEqual(attached,['s1']);const c=await s.context(a.incidentId);assert.throws(()=>validateInvestigation({summary:'bad',hypotheses:[],changeAssessment:'likely',candidateSha:null,evidenceIds:['other-incident'],unknowns:[],nextSteps:[]},c),/outside/);const capability=evidenceCapability(a.incidentId,'secret',100);assert.equal(readEvidenceCapability(capability,'secret',200).incidentId,a.incidentId);assert.equal(readEvidenceCapability(capability,'wrong',200),null);assert.equal(readEvidenceCapability(capability,'secret',300101),null);}finally{await s.db.close();}
});
test('Teams SDK receives a message, persists it, and later delivers outbox through stored reference',async()=>{
  const {r,id,service}=await ready();const delivered=[];const transport=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;delivered.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'reply-1'}));});const url=await listen(transport);const bridge=await startSreTeams({router:r.router,store:r.store,mode:'playground',env:{},port:0});try{const sample=devActivity('join '+id,service,{serviceUrl:url,id:'activity-1'});const response=await fetch('http://127.0.0.1:'+bridge.server.address().port+'/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(sample.activity)});assert.equal(response.status,200);assert.equal(delivered.length,0);assert.equal((await r.store.db.query('SELECT * FROM sre_commands')).length,1);await r.router.processOnce();const output=new TeamsOutbox({store:r.store,services:[service],sender:bridge.sender});await output.runOnce();await output.runOnce();assert.ok(delivered.some(x=>x.text.includes(id.replaceAll('_','\\_'))&&x.textFormat==='extendedmarkdown'));assert.ok((await r.store.db.query('SELECT * FROM sre_conversations')).some(x=>x.incident_id===id));}finally{await bridge.close();await close(transport);await r.close();}
});
test('new Teams live bridge rejects unauthenticated input before database writes',async()=>{
  const r=await createSreRuntime({config:config(),autoStart:false});const bridge=await startSreTeams({router:r.router,store:r.store,mode:'live',port:0,env:{CLIENT_ID:'11111111-1111-1111-1111-111111111111',CLIENT_SECRET:'fixture',TENANT_ID:'22222222-2222-2222-2222-222222222222'}});try{const response=await fetch('http://127.0.0.1:'+bridge.server.address().port+'/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(devActivity('incidents',r.config.services[0]).activity)});assert.equal(response.status,401);assert.equal((await r.store.snapshot()).counts.length,0);}finally{await bridge.close();await r.close();}
});
test('local API simulates requests and prevents cross-origin mutation',async()=>{
  const r=await createSreRuntime({config:config(),autoStart:false});const base=await listen(r.server);try{assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/app.js')).status,200);assert.equal((await fetch(base+'/incident-view.js')).status,200);const denied=await fetch(base+'/api/dev/seed',{method:'POST',headers:{origin:'https://outside.invalid'},body:'{}'});assert.equal(denied.status,403);const response=await fetch(base+'/api/dev/seed',{method:'POST',body:'{"scenario":"old-feature"}'});assert.equal(response.status,202);await r.tick();const data=await (await fetch(base+'/api/status')).json();assert.equal(data.incidents.length,1);assert.equal(data.incidents[0].analysis.rollback.eligible,false);const q=await fetch(base+'/api/incidents/'+data.incidents[0].id+'/questions',{method:'POST',body:'{"text":"Why is this rollback blocked?"}'});assert.equal(q.status,202);assert.equal((await fetch(base+'/internal/evidence')).status,401);}finally{await r.close();}
});
test('connected webhook auth, service mapping, and raw-body signatures precede ingestion',async()=>{
  const c=config();c.mode='connected';c.apiToken='api';c.env={GH_SECRET:'hook'};c.services[0].github={...c.services[0].github,enabled:true,webhookSecretEnv:'GH_SECRET'};const r=await createSreRuntime({config:c,connectors:new Map(),autoStart:false});const url=await listen(r.server);try{const path='/webhooks/github/auction-local';const raw=JSON.stringify({repository:{full_name:'synthetic/smart-auction'},action:'opened',pull_request:{number:1,head:{sha:'a'.repeat(40)},base:{sha:'b'.repeat(40)},title:'SA-101 Bid ordering',updated_at:new Date().toISOString()}});const headers={'x-github-event':'pull_request','x-github-delivery':'delivery-1','x-hub-signature-256':'sha256='+createHmac('sha256','hook').update(raw).digest('hex')};assert.equal((await fetch(url+path,{method:'POST',headers,body:raw+' '})).status,401);assert.equal((await fetch(url+path,{method:'POST',headers,body:raw})).status,202);assert.equal((await fetch(url+path,{method:'POST',headers,body:raw})).status,202);assert.equal((await r.store.snapshot()).counts[0].count,1);const group=JSON.stringify({repository:{full_name:'synthetic/smart-auction'},action:'checks_requested',merge_group:{head_sha:'c'.repeat(40),base_sha:'b'.repeat(40)}});const groupHeaders={'x-github-event':'merge_group','x-github-delivery':'group-delivery','x-hub-signature-256':'sha256='+createHmac('sha256','hook').update(group).digest('hex')};assert.equal((await fetch(url+path,{method:'POST',headers:groupHeaders,body:group})).status,202);const later=Date.now()+5000;r.store.clock=()=>later;assert.equal((await fetch(url+path,{method:'POST',headers:groupHeaders,body:group})).status,202);assert.equal((await r.store.snapshot()).counts[0].count,2);assert.equal((await fetch(url+'/api/status')).status,401);assert.equal((await fetch(url+'/api/dev/teams',{method:'POST',headers:{authorization:'Bearer api'},body:'{}'})).status,404);}finally{await r.close();}
});
test('PostgreSQL dialect executes real schema, transactions, leases, and rollback flow in PGlite',async()=>{
  const pg=new PGlite();const db={dialect:'postgres',query:async(sql,args=[]) =>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[]) =>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};const {r,id,service}=await ready('recent-regression',db);try{assert.equal((await r.store.context(id)).incident.analysis.rollback.eligible,true);const p=principal(service);const proposal=await r.rollbacks.propose(id,p);await r.rollbacks.approve(proposal.id,proposal.text.split(' ').at(-1),p);await r.rollbacks.executeNext();assert.equal((await r.store.snapshot()).rollbacks[0].status,'simulated');}finally{await r.close();}
});

test('multiple synthetic scenarios keep independent release histories',async()=>{
  const r=await createSreRuntime({config:config(),autoStart:false});try{const first=await seedDemo(r.store,r.config.services[0]);await r.worker.runOnce();const second=await seedDemo(r.store,r.config.services[0],'old-feature');for(let i=0;i<3;i++)await r.worker.runOnce();assert.equal((await r.store.context(first.incidentId)).incident.analysis.rollback.eligible,true);assert.equal((await r.store.context(second.incidentId)).incident.analysis.rollback.eligible,false);}finally{await r.close();}
});
