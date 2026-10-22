import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {loadConfig,validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {devActivity,seedDemo} from '../src/sre/demo.mjs';
import {fictionalDirectory} from '../fixtures/ownership-directory.mjs';
import {createPilotQaAdapter} from '../fixtures/qa-sandbox.mjs';
import {normalizeAlert} from '../src/sre/alert-intake.mjs';
import {normalize} from '../src/sre/normalize.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {createHmac} from 'node:crypto';
import {collaborationText} from '../src/sre/collaboration.mjs';

async function fixture({path=':memory:',db,qaAdapter,autoSeed=true}={}) {
  const c=loadConfig({SRE_SQLITE_PATH:path}),rooms=['bidding','platform','workers','19:alerts@thread.tacv2'];
  c.services[0].teams={...c.services[0].teams,conversations:rooms,captureResponderUpdates:true,collaborationGroups:[{key:'response',name:'Fictional response',conversations:rooms.map(id=>({id,name:id}))}]};
  const r=await createSreRuntime({config:validateConfig(c,{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-casework-cli'}),db,qaAdapter,autoStart:false,sender:{send:async()=>({id:'fixture-delivery'})}});
  let sequence=0,now=Date.now();r.store.clock=()=>now;
  const f={r,c,setNow:value=>now=value,now:()=>now};
  f.send=async(room,text,{user='local-operator',mentioned=true,thread}={})=>{now++;const sample=devActivity(text,c.services[0],{id:'casework-'+ ++sequence,userId:user,displayName:user,conversationId:thread?room+';messageid='+thread:room,conversationType:thread?'channel':'groupChat',mentioned});sample.activity.timestamp=new Date(now).toISOString();const receipt=await r.router.accept(sample.activity,sample.reference);if(!receipt.ignored)await r.router.processOnce();return sample;};
  f.settle=async()=>{for(let i=0;i<30;i++){const [active]=await r.store.db.query("SELECT count(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(active.count))return;await r.worker.runOnce();}throw Error('Jobs did not settle');};
  f.deliver=async()=>{for(let i=0;i<100&&await r.outbox.runOnce();i++);await r.outbox.drainSettled();};
  if(autoSeed){f.id=(await seedDemo(r.store,c.services[0])).incidentId;await f.send('bidding','join '+f.id);await f.send('platform','join '+f.id);await f.send('workers','join '+f.id);await f.settle();}
  f.principal=(room='bidding',user='local-operator')=>({verified:true,simulation:true,tenant:'synthetic',conversationId:room,userId:user});
  return f;
}

test('the ownership directory supplies explicit path owners, a current on-call shift and escalation; absent and stale directories abstain',async()=>{
  const f=await fixture();try{
    assert.equal((await f.r.casework.contacts(f.id)).contacts.length,0);
    await f.r.casework.importDirectory('auction-local',fictionalDirectory(f.now()));
    let view=await f.r.casework.contacts(f.id);assert.ok(view.contacts.some(c=>c.id==='avery'));assert.ok(view.contacts.some(c=>c.id==='noor'));assert.ok(view.contacts.every(c=>c.directoryId&&c.source));
    f.setNow(f.now()+9*3600000);view=await f.r.casework.contacts(f.id);assert.ok(!view.contacts.some(c=>c.id==='noor'));assert.ok(view.contacts.some(c=>c.role==='service-owner'));
    f.setNow(f.now()+86400000);view=await f.r.casework.contacts(f.id);assert.equal(view.contacts.length,0);assert.match(view.unknowns[0],/expired/);
  }finally{await f.r.close();}
});

test('equally timed conflicting directory snapshots cannot silently choose an owner',async()=>{
  const f=await fixture();try{const first=fictionalDirectory(f.now());await f.r.casework.importDirectory('auction-local',first);await f.r.casework.importDirectory('auction-local',{...first,entries:first.entries.slice(1)});const view=await f.r.casework.contacts(f.id);assert.equal(view.contacts.length,0);assert.match(view.unknowns[0],/Conflicting/);}finally{await f.r.close();}
});

test('Markdown fix tickets are idempotent, cite exact code and owners, remain scoped and become stale on new evidence',async()=>{
  const f=await fixture();try{
    await f.r.casework.importDirectory('auction-local',fictionalDirectory(f.now()));
    const p=await f.r.casework.createPlan(f.id),again=await f.r.casework.createPlan(f.id);assert.equal(p.id,again.id);assert.match(p.markdown,/WINNING/);assert.match(p.markdown,/Avery/);assert.match(p.markdown,/Acceptance checks/);assert.equal(p.payload.patch.field,'checkVersion');
    await assert.rejects(f.r.casework.getPlan(p.id,'inc_'+'a'.repeat(20)),/not found/);
    await f.send('bidding','update New provider failures also appeared.');await assert.rejects(f.r.casework.createPlan(f.id),/stale/);
    await assert.rejects(f.r.casework.proposeFix(f.id,p.id,f.principal(),conversationKey('synthetic','bidding'),'stale'),/not configured/);
  }finally{await f.r.close();}
});

test('an unsupported dependency investigation produces a useful ticket without claiming an automatic fix',async()=>{
  const f=await fixture({autoSeed:false});try{f.id=(await seedDemo(f.r.store,f.c.services[0],'dependency-outage')).incidentId;await f.settle();const plan=await f.r.casework.createPlan(f.id);assert.equal(plan.payload.patch,null);assert.match(plan.markdown,/No automatic patch/);assert.match(plan.markdown,/Unknown/);}finally{await f.r.close();}
});

test('only the requesting developer in the joined conversation can approve a fresh QA proposal; its exact command queues once',async()=>{
  let executions=0;const f=await fixture({qaAdapter:{localOnly:true,execute:async()=>{executions++;return {status:'passed',branch:'codex/fixture',commit:'a'.repeat(40),summary:'Fixture only'};}}});
  try{
    const plan=await f.r.casework.createPlan(f.id),key=conversationKey('synthetic','bidding');
    await assert.rejects(f.r.casework.proposeFix(f.id,plan.id,f.principal('bidding','alex'),key,'bad-user'),/configured developer/);
    const request=await f.r.casework.proposeFix(f.id,plan.id,f.principal(),key,'good');
    await assert.rejects(f.r.casework.approveFix(request.id,'wrong',f.principal(),key),/nonce/);
    await assert.rejects(f.r.casework.approveFix(request.id,request.nonce,f.principal('platform'),conversationKey('synthetic','platform')),/original/);
    await f.r.casework.approveFix(request.id,request.nonce,f.principal(),key);
    const repeated=await f.r.casework.approveFix(request.id,request.nonce,f.principal(),key);assert.equal(repeated.status,'approved');
    assert.equal(await f.r.casework.runOnce(),true);assert.equal(await f.r.casework.runOnce(),false);assert.equal(executions,1);
    const snapshot=await f.r.casework.snapshot(f.id);assert.equal(snapshot.qa[0].status,'passed');assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
  }finally{await f.r.close();}
});

test('multiple pending QA proposals make yes ambiguous, passive yes is evidence, and new evidence invalidates approval',async()=>{
  const f=await fixture({qaAdapter:{localOnly:true,execute:async()=>{throw Error('Must not execute');}}});try{
    const p=await f.r.casework.createPlan(f.id),key=conversationKey('synthetic','bidding');
    const a=await f.r.casework.proposeFix(f.id,p.id,f.principal(),key,'a');await f.r.casework.proposeFix(f.id,p.id,f.principal(),key,'b');
    await assert.rejects(f.r.casework.approveFix(null,null,f.principal(),key,{bareYes:true}),/ambiguous/);
    await f.send('bidding','yes',{mentioned:false});assert.equal((await f.r.casework.snapshot(f.id)).qa.filter(q=>q.status==='approved').length,0);
    await assert.rejects(f.r.casework.approveFix(a.id,a.nonce,f.principal(),key),/stale/);
  }finally{await f.r.close();}
});

test('yes cannot choose an older personal QA proposal when another developer has a proposal in the same chat',async()=>{
  const f=await fixture({qaAdapter:{localOnly:true,execute:async()=>{throw Error('Must not execute');}}});try{
    f.c.services[0].teams.approvers.push('alex');const p=await f.r.casework.createPlan(f.id),key=conversationKey('synthetic','bidding');
    const own=await f.r.casework.proposeFix(f.id,p.id,f.principal(),key,'own');await f.r.casework.proposeFix(f.id,p.id,f.principal('bidding','alex'),key,'other-person');
    await assert.rejects(f.r.casework.approveFix(null,null,f.principal(),key,{bareYes:true}),/ambiguous/);
    assert.equal((await f.r.casework.approveFix(own.id,own.nonce,f.principal(),key)).status,'approved');
  }finally{await f.r.close();}
});

test('an actual pending rollback proposal makes a bare QA yes ambiguous for that incident',async()=>{
  const f=await fixture({qaAdapter:{localOnly:true,execute:async()=>{throw Error('Must not execute');}}});try{
    const p=await f.r.casework.createPlan(f.id),key=conversationKey('synthetic','bidding');await f.r.casework.proposeFix(f.id,p.id,f.principal(),key,'qa-next-to-rollback');
    const rollback=await f.r.rollbacks.propose(f.id,f.principal());assert.equal(rollback.eligible,true);assert.equal((await f.r.store.db.query('SELECT status FROM sre_rollbacks WHERE id=?',[rollback.id]))[0].status,'pending');
    await assert.rejects(f.r.casework.approveFix(null,null,f.principal(),key,{bareYes:true}),/ambiguous/);
    assert.equal((await f.r.casework.snapshot(f.id)).qa[0].status,'proposed');
  }finally{await f.r.close();}
});

test('a pending rollback for a separate incident does not obstruct the only QA proposal in this chat',async()=>{
  const f=await fixture({qaAdapter:{localOnly:true,execute:async()=>{throw Error('Not executed in this approval test');}}});try{
    const original=await f.r.store.context(f.id),other=await f.r.store.ingest({id:'other-recovery',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'other-recovery',status:'OPEN',at:f.now(),startedAt:f.now()-1000,payload:{metrics:{violations:['WINNING_BID_REGRESSED'],requests:12}}});
    const proof=original.evidence.find(e=>e.source==='github'&&e.kind==='change');await f.r.store.ingest({id:'other-proof',source:'github',serviceKey:'auction-local',kind:'change',incidentId:other.incidentId,at:f.now(),payload:proof.content});
    const conversation='platform;messageid=1000000000300';await f.send('platform','join '+other.incidentId,{thread:'1000000000300'});await f.settle();
    const rollback=await f.r.rollbacks.propose(other.incidentId,f.principal(conversation));assert.equal(rollback.eligible,true);
    const plan=await f.r.casework.createPlan(f.id);await f.send('bidding','fix '+plan.id);await f.deliver();await f.send('bidding','yes');assert.equal((await f.r.casework.snapshot(f.id)).qa[0].status,'approved');
  }finally{await f.r.close();}
});

test('QA approval expiry and revocation are rechecked before an executor is called',async()=>{
  let calls=0;const f=await fixture({qaAdapter:{localOnly:true,execute:async()=>{calls++;throw Error('Unexpected execution');}}});try{
    const p=await f.r.casework.createPlan(f.id),key=conversationKey('synthetic','bidding'),a=await f.r.casework.proposeFix(f.id,p.id,f.principal(),key,'expiry');await f.r.casework.approveFix(a.id,a.nonce,f.principal(),key);f.setNow(f.now()+600001);await f.r.casework.runOnce();assert.equal(calls,0);assert.match((await f.r.casework.snapshot(f.id)).qa[0].error,/expired/);
  }finally{await f.r.close();}
});

test('real local QA reproduces the faulty code, creates a branch and commit with Markdown, then passes business checks',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sre-casework-qa-'));const f=await fixture({qaAdapter:createPilotQaAdapter(dir)});try{
    const p=await f.r.casework.createPlan(f.id),key=conversationKey('synthetic','bidding'),a=await f.r.casework.proposeFix(f.id,p.id,f.principal(),key,'qa');await f.r.casework.approveFix(a.id,a.nonce,f.principal(),key);await f.r.casework.runOnce();
    const q=(await f.r.casework.snapshot(f.id)).qa[0];q.result=(await f.r.casework.qaRequest(f.id,q.id)).result;assert.equal(q.status,'passed',q.error);assert.notEqual(q.result.reproduction.exitCode,0);assert.equal(q.result.validation.exitCode,0);assert.match(q.result.branch,/^codex\/qa-/);assert.match(q.result.commit,/^[a-f0-9]{40}$/);assert.match(q.result.patch,/checkVersion/);assert.match(q.result.markdown,new RegExp(p.id));assert.match(q.result.mergeRequestDraft,/local MR draft/);assert.match(await readFile(join(q.result.workspace,'docs/fix-plan.md'),'utf8'),new RegExp(p.id));assert.match(await readFile(join(q.result.workspace,'docs/merge-request.md'),'utf8'),/local MR draft/);
  }finally{await f.r.close();await rm(dir,{recursive:true,force:true});}
});

test('MR head, CI, merge and deployment history survive moving heads without claiming recovery',async()=>{
  const f=await fixture({autoSeed:false});try{
    const service=f.c.services[0],first='a'.repeat(40),second='b'.repeat(40),merged='c'.repeat(40);
    const mr=(sha,state='opened')=>({project:{id:17},object_kind:'merge_request',object_attributes:{iid:61,state,last_commit:{id:sha},merge_commit_sha:state==='merged'?merged:null,updated_at:new Date(f.now()).toISOString(),title:'Fix auction winner',url:'https://example.invalid/mr/61'}});
    const opening=await f.r.store.ingest(normalize('gitlab',mr(first),service,{deliveryId:'open'}));
    f.setNow(f.now()+1);await f.r.store.ingest(normalize('gitlab',mr(second),service,{deliveryId:'head'}));
    f.setNow(f.now()+1);await f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{sha:second,status:'success',updated_at:new Date(f.now()).toISOString()}},service,{deliveryId:'ci'}));
    f.setNow(f.now()+1);await f.r.store.ingest(normalize('gitlab',mr(second,'merged'),service,{deliveryId:'merge'}));
    f.setNow(f.now()+1);await f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'deployment',deployment_id:80,sha:merged,environment:'local',status:'success',status_changed_at:new Date(f.now()).toISOString()},service,{deliveryId:'deployed'}));
    const timeline=await f.r.casework.timeline(opening.incidentId);assert.ok(timeline.items.some(i=>i.head_sha===first));assert.ok(timeline.items.some(i=>i.stage==='merge'&&i.payload.mergedSha===merged));assert.ok(timeline.items.some(i=>i.stage==='ci-update'));assert.ok(timeline.items.some(i=>i.stage==='deployment'&&i.head_sha===merged));assert.notEqual((await f.r.store.context(opening.incidentId)).incident.status,'resolved');
  }finally{await f.r.close();}
});

test('workflow alert intake binds the installed original thread and is atomic/idempotent across wrong scopes',async()=>{
  const f=await fixture({autoSeed:false});try{
    const service=f.c.services[0];service.alerts={enabled:false,providers:['datadog']};await f.send('19:alerts@thread.tacv2','help',{thread:'1000000000000'});
    const body={provider:'datadog',service:service.key,environment:'local',alertId:'monitor-51',groupKey:'eu-winning-bid',title:'Fictional auction regression',status:'OPEN',startedAt:f.now()-1000,observedAt:f.now(),thread:{tenantId:'synthetic',channelId:'19:alerts@thread.tacv2',messageId:'1000000000001'}};
    const event=normalizeAlert(body,service,'alert-1'),receipt=await f.r.store.ingest(event);assert.equal((await f.r.store.ingest(event)).duplicate,true);
    const [thread]=await f.r.store.db.query('SELECT * FROM sre_alert_threads');assert.equal(thread.incident_id,receipt.incidentId);const [room]=await f.r.store.db.query('SELECT * FROM sre_conversations WHERE id=?',[thread.conversation_key]);assert.equal(room.conversation_id,'19:alerts@thread.tacv2;messageid=1000000000001');assert.equal(room.incident_id,receipt.incidentId);
    await f.settle();assert.ok((await f.r.store.snapshot()).outbox.some(o=>o.conversation_key===room.id&&o.text.includes('Change assessment')));
    const before=(await f.r.store.db.query('SELECT count(*) AS count FROM sre_events'))[0].count;
    await assert.rejects(f.r.store.ingest(normalizeAlert({...body,groupKey:'different'},service,'alert-2')),/another incident/);
    assert.equal((await f.r.store.db.query('SELECT count(*) AS count FROM sre_events'))[0].count,before);
    assert.throws(()=>normalizeAlert({...body,thread:{...body.thread,tenantId:'other'}},service,'x'),/outside/);
  }finally{await f.r.close();}
});

test('file-backed restart preserves ticket, directory, MR history and approved QA; interrupted local execution becomes unknown without replay',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sre-casework-restart-')),path=join(dir,'agent.sqlite'),adapter={localOnly:true,execute:async()=>{throw Error('Not run in this test');}};let f=await fixture({path,qaAdapter:adapter});
  try{
    await f.r.casework.importDirectory('auction-local',fictionalDirectory(f.now()));const p=await f.r.casework.createPlan(f.id),key=conversationKey('synthetic','bidding'),a=await f.r.casework.proposeFix(f.id,p.id,f.principal(),key,'persist');await f.r.casework.approveFix(a.id,a.nonce,f.principal(),key);const id=f.id,oldTime=f.now();await f.r.close();
    f=await fixture({path,qaAdapter:adapter,autoSeed:false});f.setNow(oldTime);assert.equal((await f.r.casework.getPlan(p.id,id)).markdown,p.markdown);assert.equal((await f.r.casework.snapshot(id)).qa[0].status,'approved');assert.ok((await f.r.casework.contacts(id)).contacts.length);
    await f.r.store.db.query("UPDATE sre_fix_requests SET status='running',lease_owner='lost',lease_until=? WHERE id=?",[oldTime-1,a.id]);assert.equal(await f.r.casework.runOnce(),false);assert.equal((await f.r.casework.snapshot(id)).qa[0].status,'unknown');assert.ok((await f.r.operations.snapshot()).conditions.some(c=>c.code==='qa_unknown'));assert.ok((await f.r.store.snapshot()).outbox.some(o=>o.text.includes('outcome unknown after an interrupted local run')));
  }finally{await f.r.close();await rm(dir,{recursive:true,force:true});}
});

test('the same casework SQL, directory, ticket and QA approvals run through the PostgreSQL adapter contract',async()=>{
  const pg=new PGlite();const db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
  const f=await fixture({db,qaAdapter:{localOnly:true,execute:async()=>({status:'passed',branch:'codex/postgres',commit:'a'.repeat(40),summary:'Adapter fixture'})}});try{
    await f.r.casework.importDirectory('auction-local',fictionalDirectory(f.now()));const p=await f.r.casework.createPlan(f.id),key=conversationKey('synthetic','bidding'),a=await f.r.casework.proposeFix(f.id,p.id,f.principal(),key,'postgres');await f.r.casework.approveFix(a.id,a.nonce,f.principal(),key);await f.r.casework.runOnce();assert.equal((await f.r.casework.snapshot(f.id)).qa[0].status,'passed');
  }finally{await f.r.close();}
});

test('a quiet responder remains in model and briefing context while another person floods the same group',async()=>{
  const f=await fixture();try{
    await f.send('workers','update QUIET-OWNER: the winning bid fell only in EU and needs transaction reconciliation.',{user:'avery'});
    for(let i=0;i<60;i++)await f.send('workers','Routine HTTP 200 probe '+i,{user:'noor',mentioned:false});
    await f.send('platform','update CREDIT-SCOPE: provider errors are a separate failure on healthy main.',{user:'sam'});
    const context=await f.r.store.context(f.id);assert.ok(context.evidence.some(e=>e.content.text?.includes('QUIET-OWNER')),'A chatty participant must not evict the other participant from the bounded people window');
    assert.ok(context.collaboration.rooms.find(r=>r.conversationId==='workers').reports.some(r=>r.text.includes('QUIET-OWNER')));
    assert.match(collaborationText(context.collaboration),/QUIET-OWNER/);
  }finally{await f.r.close();}
});

test('many people and incident threads interleave without moving reports or sessions between issues',async()=>{
  const f=await fixture({autoSeed:false});try{
    const issues=await Promise.all(Array.from({length:12},(_,i)=>f.r.store.ingest({id:'parallel-'+i,source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'parallel-'+i,status:'OPEN',at:f.now(),payload:{title:'Fictional concurrent incident '+i}})));
    for(const [i,issue]of issues.entries()){
      const thread=String(1000000000000+i);await f.send('bidding','join '+issue.incidentId,{thread});await f.send('platform','join '+issue.incidentId,{thread});
      for(const user of ['alex','sam','avery','noor'])await f.send('bidding','update PRIVATE-'+i+' from '+user,{thread,user});
    }
    await f.settle();
    for(const [i,issue]of issues.entries()){
      const c=await f.r.store.context(issue.incidentId),reports=c.evidence.filter(e=>e.kind==='responder_update');assert.equal(new Set(reports.map(e=>e.content.userId)).size,4);assert.ok(reports.every(e=>e.content.text.includes('PRIVATE-'+i+' ')));
      assert.equal(c.collaboration.rooms.length,2);
    }
    assert.equal(new Set((await f.r.store.snapshot()).sessions.map(s=>s.agent_id)).size,12);
  }finally{await f.r.close();}
});

test('grouped workflow monitors keep independent open states when one monitor closes',async()=>{
  const f=await fixture({autoSeed:false});try{
    const service=f.c.services[0];service.alerts={enabled:false,providers:['datadog']};
    const base={provider:'datadog',service:service.key,environment:'local',groupKey:'auction-eu',title:'Fictional correlated monitors',status:'OPEN',startedAt:f.now()-1000,observedAt:f.now()};
    const a=await f.r.store.ingest(normalizeAlert({...base,alertId:'monitor-1'},service,'m1'));await f.r.store.ingest(normalizeAlert({...base,alertId:'monitor-2'},service,'m2'));
    await f.r.store.ingest(normalizeAlert({...base,alertId:'monitor-1',status:'CLOSED',observedAt:f.now()+1},service,'m1-close'));
    const c=await f.r.store.context(a.incidentId);assert.equal(c.incident.status,'open');assert.equal(Object.keys(JSON.parse(c.incident.source_states)).length,2);
  }finally{await f.r.close();}
});

test('signed HTTP workflow ingestion rejects unauthenticated alerts before writes and replies to the original thread',async()=>{
  const f=await fixture({autoSeed:false});try{
    const service=f.c.services[0];service.alerts={enabled:true,providers:['datadog'],webhookSecretEnv:'ALERT_SIGNING'};service.rollback.enabled=false;f.r.config.mode='connected';
    // The server captured its simulation profile at construction. Use a fresh
    // connected runtime so this exercises the real authenticated ingress path.
    const config=validateConfig({...f.c,mode:'connected'},{SRE_API_TOKEN:'fixture-api',SRE_CAPABILITY_SECRET:'x'.repeat(40),ALERT_SIGNING:'fixture-signing',SRE_SQLITE_PATH:':memory:',SRE_AGENT_MODE:'rules'});
    const r=await createSreRuntime({config,autoStart:false});try{
      const sample=devActivity('help',service,{conversationId:'19:alerts@thread.tacv2',conversationType:'channel',replyToId:'1000000000100'});
      await r.store.rememberConversation({tenant:'synthetic',serviceKey:service.key,reference:{...sample.reference,conversation:{...sample.reference.conversation,id:'19:alerts@thread.tacv2;messageid=1000000000100'}}});
      await new Promise(resolve=>r.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+r.server.address().port+'/webhooks/alerts/auction-local';
      const now=Date.now(),body=JSON.stringify({provider:'datadog',alertId:'native-fixture',groupKey:'signed-fixture',title:'Fictional alert',service:service.key,environment:'local',status:'OPEN',startedAt:now-1000,observedAt:now,thread:{tenantId:'synthetic',channelId:'19:alerts@thread.tacv2',messageId:'1000000000200'}});
      assert.equal((await fetch(url,{method:'POST',body,headers:{'content-type':'application/json'}})).status,401);assert.equal((await r.store.db.query('SELECT count(*) AS count FROM sre_events'))[0].count,0);
      const signature='sha256='+createHmac('sha256','fixture-signing').update(String(now)+'.').update(body).digest('hex'),headers={'content-type':'application/json','x-sre-timestamp':String(now),'x-sre-signature':signature,'x-sre-event-id':'http-alert'};
      const response=await fetch(url,{method:'POST',headers,body});assert.equal(response.status,202,await response.text());assert.equal((await fetch(url,{method:'POST',headers,body})).status,202);
      assert.equal((await r.store.db.query('SELECT count(*) AS count FROM sre_alert_threads'))[0].count,1);await r.worker.runOnce();const messages=(await r.store.snapshot()).outbox;assert.ok(messages.some(m=>m.conversation_key===conversationKey('synthetic','19:alerts@thread.tacv2;messageid=1000000000200')));
    }finally{await r.close();}
  }finally{await f.r.close();}
});

test('persistent log thresholds reject noise, deduplicate overlaps, separate releases and preserve incidents through silent windows',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sre-log-detection-')),path=join(dir,'db.sqlite');let f=await fixture({path,autoSeed:false});
  try{
    const rule={id:'winning-bid',codes:['WINNING_BID_REGRESSED'],minCount:3,windowSeconds:60};f.c.services[0].logMonitors=[rule];
    const record=(n,extra={})=>({timestamp:new Date(f.now()-1000+n).toISOString(),loglevel:'ERROR','deployment.environment':'local','cloud.region':'eu','service.version':'a'.repeat(40),'error.code':'WINNING_BID_REGRESSED',content:'Fictional invariant violation '+n,...extra});
    const rows=[record(1),record(2)];assert.deepEqual((await f.r.logDetector.observe(f.c.services[0],'fixture',{records:rows,complete:true})).incidents,[]);
    assert.equal((await f.r.logDetector.observe(f.c.services[0],'fixture',{records:rows,complete:true})).matched,0);
    await f.r.logDetector.observe(f.c.services[0],'fixture',{records:[record(3,{loglevel:'INFO'}),record(4,{'deployment.environment':'prod'}),record(5,{'service.version':'b'.repeat(40)})],complete:true});assert.equal((await f.r.store.snapshot()).incidents.length,0);
    const third=record(6),result=await f.r.logDetector.observe(f.c.services[0],'fixture',{records:[third],complete:false});assert.equal(result.incidents.length,1);const id=result.incidents[0],time=f.now();assert.equal((await f.r.store.context(id)).signalDigest.coverage.partialResults,1);
    await f.r.close();f=await fixture({path,autoSeed:false});f.setNow(time);f.c.services[0].logMonitors=[rule];const count=(await f.r.store.db.query('SELECT count(*) AS count FROM sre_events'))[0].count;await f.r.logDetector.runOnce();assert.equal((await f.r.store.db.query('SELECT count(*) AS count FROM sre_events'))[0].count,count);
    f.setNow(time+61000);await f.r.logDetector.runOnce();assert.equal((await f.r.store.context(id)).incident.status,'open');
  }finally{await f.r.close();await rm(dir,{recursive:true,force:true});}
});

test('changing a log monitor does not reuse counts from its previous configuration',async()=>{
  const f=await fixture({autoSeed:false});try{
    const s=f.c.services[0];s.logMonitors=[{id:'logs',codes:['A'],minCount:3,windowSeconds:60}];const records=[1,2].map(i=>({timestamp:new Date(f.now()-i).toISOString(),level:'ERROR',environment:'local',code:'A'}));await f.r.logDetector.observe(s,'fixture',{records,complete:true});s.logMonitors=[{id:'logs',codes:['B'],minCount:1,windowSeconds:60}];await f.r.logDetector.runOnce();assert.equal((await f.r.store.snapshot()).incidents.length,0);
  }finally{await f.r.close();}
});

test('a late QA result cannot replace an expired execution marked unknown by another worker',async()=>{
  let release,entered;const waiting=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);let executions=0;
  const f=await fixture({qaAdapter:{localOnly:true,execute:async()=>{executions++;entered();await waiting;return {status:'passed',branch:'codex/late',commit:'a'.repeat(40),summary:'Late result'};}}});
  try{
    const p=await f.r.casework.createPlan(f.id),key=conversationKey('synthetic','bidding'),a=await f.r.casework.proposeFix(f.id,p.id,f.principal(),key,'late');await f.r.casework.approveFix(a.id,a.nonce,f.principal(),key);
    const running=f.r.casework.runOnce();await started;f.setNow(f.now()+120001);assert.equal(await f.r.casework.runOnce(),false);release();await running;
    assert.equal((await f.r.casework.snapshot(f.id)).qa[0].status,'unknown');assert.equal(executions,1);assert.ok((await f.r.store.db.query("SELECT * FROM sre_fix_events WHERE request_id=? AND status='late-result'",[a.id])).length);
  }finally{release();await f.r.close();}
});

test('drawings and attachments retain unread metadata without pretending to inspect contents or fetching their URLs',async()=>{
  const f=await fixture();try{
    const sample=devActivity('',f.c.services[0],{id:'drawing',conversationId:'workers',conversationType:'groupChat',userId:'avery',displayName:'Avery'});
    sample.activity.attachments=[{name:'auction-sequence.png',contentType:'image/png',contentUrl:'https://example.invalid/private-image?secret=do-not-fetch'}];
    await f.r.router.accept(sample.activity,sample.reference);await f.r.router.processOnce();
    const report=(await f.r.store.context(f.id)).evidence.find(e=>e.content.unreadAttachments);assert.ok(report);assert.equal(report.content.unreadAttachments[0].contentRead,false);assert.match(report.content.text,/not read/);assert.ok(!JSON.stringify(report).includes('private-image'));
    assert.ok((await f.r.store.snapshot()).outbox.some(o=>o.text.includes('Attachment contents were not read')));
  }finally{await f.r.close();}
});

test('Teams inline HTML copies of an ordinary text message do not generate a false unread-file warning',async()=>{
  const f=await fixture();try{
    const sample=devActivity('contacts',f.c.services[0],{id:'inline-html',conversationId:'workers',conversationType:'groupChat'});sample.activity.attachments=[{contentType:'text/html',content:'<p>contacts</p>'}];
    await f.r.router.accept(sample.activity,sample.reference);await f.r.router.processOnce();const messages=(await f.r.store.snapshot()).outbox;
    assert.ok(messages.some(o=>o.text.startsWith('Who to contact')));assert.ok(!messages.some(o=>o.text.includes('Attachment contents were not read')));
  }finally{await f.r.close();}
});

test('normal Dynatrace log polling can start a new incident before any human report or vendor problem exists',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),s=config.services[0],now=Date.now();s.logMonitors=[{id:'auction-winner',codes:['WINNING_BID_REGRESSED'],minCount:2,windowSeconds:60}];
  const records=[1,2].map(i=>({timestamp:new Date(now-1000+i).toISOString(),level:'ERROR',environment:'local',region:'eu',code:'WINNING_BID_REGRESSED',message:'Fictional winning-bid invariant '+i}));
  const r=await createSreRuntime({config,autoStart:false,connectors:new Map([[s.key,{dynatraceLogs:{logs:async()=>({records,complete:true})}}]])});
  try{await r.poller.readSource(s,'dynatraceLogs',r.worker.connectors.get(s.key).dynatraceLogs);const state=await r.store.snapshot();assert.equal(state.incidents.length,1);assert.match(state.incidents[0].issue_key,/log-monitor/);await r.worker.runOnce();const c=await r.store.context(state.incidents[0].id);assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.equal(c.signalDigest.coverage.recordsScanned,4);assert.equal(c.signalDigest.coverage.duplicateObservations,2);assert.equal(c.signalDigest.groups.length,2);assert.equal(c.signalDigest.groups.reduce((n,g)=>n+g.observations,0),2);}finally{await r.close();}
});

test('the simulator rejects sending a selected incident update into a group following another incident before enqueue',async()=>{
  const f=await fixture();try{
    const other=await f.r.store.ingest({id:'other-selected',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'other-selected',status:'OPEN',at:f.now(),payload:{}});
    await new Promise(resolve=>f.r.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+f.r.server.address().port+'/api/dev/teams';
    const before=(await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_commands'))[0].count;
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'update This belongs to the selected issue',expectedIncidentId:other.incidentId,conversationId:'bidding',conversationType:'groupChat'})});
    assert.equal(response.status,409);assert.match((await response.json()).error,/separate thread/);assert.equal((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_commands'))[0].count,before);
  }finally{await f.r.close();}
});
