import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { loadConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { devActivity } from '../src/sre/demo.mjs';
import { boundedContext,EveReasoner } from '../src/sre/reasoner.mjs';
import { fixtureRisk } from '../src/sre/analytic-risk.mjs';
import { conversationKey } from '../src/sre/store.mjs';
import { startSreTeams,TeamsOutbox } from '../src/sre/teams.mjs';

const config=(path=':memory:')=>loadConfig({SRE_SQLITE_PATH:path});
async function incident(r,key='one') {
  return (await r.store.ingest({id:key,source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:key,status:'OPEN',at:Date.now()-1000,payload:{title:'Bid errors'}})).incidentId;
}
function sample(r,text,{id='1000',thread='1000',...options}={}) {
  return devActivity(text,r.config.services[0],{id,conversationType:'channel',replyToId:thread,...options});
}
async function message(r,text,options) {
  const activity=sample(r,text,options);
  const receipt=await r.router.accept(activity.activity,activity.reference);
  await r.router.processOnce();
  return receipt;
}

test('Teams responder progress persists across restart and reaches the same model session with direct requests',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sre-chat-'));const c=config(join(dir,'db.sqlite'));
  let created=0;const calls=[];const sessions=new Map();
  const client={sessions:{create:async()=>{
    const session={state:{sessionId:'session-'+(++created),streamIndex:0},send:async(text,options)=>{
      const context=options.clientContext.evidence;calls.push({text,context});
      return {result:async()=>({status:'completed',data:{summary:'Fixture reasoning result',hypotheses:[],changeAssessment:'unknown',candidateSha:null,evidenceIds:[],unknowns:[],nextSteps:[],risk:fixtureRisk(context)}})};
    }};
    sessions.set(session.state.sessionId,session);return {session};
  },attach:id=>sessions.get(id)}};
  const reasoner=new EveReasoner({host:'http://127.0.0.1:2000',token:'fixture',capabilitySecret:'fixture',client});
  let r=await createSreRuntime({config:c,reasoner,autoStart:false});
  try {
    const id=await incident(r);await r.worker.runOnce();
    const identity=(await r.store.context(id)).session.agent_id;
    const joinMessage=sample(r,'join '+id);
    await r.router.accept(joinMessage.activity,joinMessage.reference);await r.router.processOnce();
    assert.equal((await r.router.accept(joinMessage.activity,joinMessage.reference)).duplicate,true);
    // Reply to a channel root and an already-threaded ID must resolve to the same incident.
    await message(r,'Restarted the bidder; timeouts persisted.',{id:'1001',mentioned:false,userId:'alex',displayName:'Alex'});
    await message(r,'Correction: the DB pool is saturated; I am checking connection limits.',{id:'1002',mentioned:false,userId:'sam',displayName:'Sam',conversationId:'test-conversation;messageid=1000'});
    assert.equal((await r.store.db.query("SELECT * FROM sre_outbox WHERE id LIKE 'command:%'")).length,1,'passive reports must not each produce an acknowledgement');
    await r.close();r=await createSreRuntime({config:c,reasoner,autoStart:false});
    assert.equal((await r.store.context(id)).session.agent_id,identity);
    await message(r,'Compare the DB pool with Alex’s restart results; focus on connection limits.',{id:'1003',userId:'lead'});
    await r.worker.runOnce();await r.worker.runOnce();
    const request=calls.find(x=>x.text.startsWith('Compare the DB pool'));
    assert.ok(request);assert.equal(created,1);
    const reports=request.context.evidence.filter(x=>x.kind==='responder_update');
    assert.equal(reports.length,2);
    assert.deepEqual(new Set(reports.map(x=>x.content.userId)),new Set(['alex','sam']));
    assert.ok(reports.every(x=>x.content.authority==='responder_report'&&x.content.addressed===false));
    assert.ok(request.context.responderContext.evidenceIds.includes(reports[0].id));
    assert.equal(request.context.incident.status,'open');
  } finally {await r.close();rmSync(dir,{recursive:true,force:true});}
});

test('passive conversation cannot execute commands or leak between incident threads',async()=>{
  const r=await createSreRuntime({config:config(),autoStart:false});
  try {
    const a=await incident(r,'a'),b=await incident(r,'b');
    await message(r,'join '+a);
    await message(r,'join '+b,{id:'2000',thread:'2000'});
    let approvals=0;r.rollbacks.approve=async()=>{approvals++;return {text:'fixture approved'};};
    await message(r,'approve proposal nonce',{id:'1001',mentioned:false});
    await message(r,'join '+b,{id:'1002',mentioned:false});
    await message(r,'Do not mix this second incident with the first.',{id:'2001',thread:'2000',mentioned:false});
    assert.equal(approvals,0);
    const aContext=await r.store.context(a),bContext=await r.store.context(b);
    assert.ok(aContext.evidence.some(x=>x.content.text==='approve proposal nonce'));
    assert.ok(!bContext.evidence.some(x=>x.content.text==='approve proposal nonce'));
    const before=(await r.store.snapshot()).counts;
    assert.equal((await message(r,'Unrelated thread message',{id:'3001',thread:'3000',mentioned:false})).ignored,true);
    assert.equal((await message(r,'Other channel in the consented team',{id:'3002',conversationId:'unconfigured-channel',mentioned:false})).ignored,true);
    assert.deepEqual((await r.store.snapshot()).counts,before);
    // Activity IDs are namespaced to a conversation, not assumed globally unique.
    await message(r,'First thread',{id:'5000',mentioned:false});
    await message(r,'Second thread',{id:'5000',thread:'2000',mentioned:false});
    assert.ok((await r.store.context(a)).evidence.some(x=>x.content.text==='First thread'));
    assert.ok((await r.store.context(b)).evidence.some(x=>x.content.text==='Second thread'));
    await message(r,'approve proposal nonce',{id:'1003'});
    assert.equal(approvals,1,'only a direct request reaches the deterministic approval handler');
    await message(r,'join '+b,{id:'1004'});
    const [bound]=await r.store.db.query('SELECT incident_id FROM sre_conversations WHERE id=?',[conversationKey('synthetic','test-conversation;messageid=1000')]);
    assert.equal(bound.incident_id,a);
    assert.ok((await r.store.snapshot()).outbox.some(x=>x.text.includes('separate thread/chat')));
    const outsider=sample(r,'join '+a,{id:'4000'});outsider.activity.channelData.tenant.id='other';
    await assert.rejects(()=>r.router.accept(outsider.activity,outsider.reference),/tenant/);
    const pending=sample(r,'Late report after removal',{id:'1005',mentioned:false});
    const receipt=await r.router.accept(pending.activity,pending.reference);
    await r.store.db.query('UPDATE sre_conversations SET enabled=0 WHERE id=?',[conversationKey('synthetic','test-conversation;messageid=1000')]);
    await r.router.processOnce();
    const [discarded]=await r.store.db.query('SELECT status FROM sre_commands WHERE id=?',[receipt.eventId]);
    assert.equal(discarded.status,'discarded');
    assert.ok(!(await r.store.context(a)).evidence.some(x=>x.content.text==='Late report after removal'));
  } finally {await r.close();}
});

test('mention-only mode supports explicit progress updates and status without claiming recovery',async()=>{
  const c=config();c.services[0].teams.captureResponderUpdates=false;
  const r=await createSreRuntime({config:c,autoStart:false});
  try {
    const id=await incident(r);await message(r,'join '+id);
    assert.equal((await message(r,'Silently missed without RSC',{id:'1001',mentioned:false})).ignored,true);
    await message(r,'update We think it is fixed; Alex is checking bids.',{id:'1002',displayName:'Sam'});
    await message(r,'status',{id:'1003'});
    await r.worker.runOnce();await r.worker.runOnce();
    const context=await r.store.context(id);
    assert.equal(context.incident.status,'open');
    assert.equal(context.evidence.filter(x=>x.kind==='responder_update').length,1);
    assert.ok((await r.store.snapshot()).outbox.some(x=>x.text.includes('Sam: We think it is fixed')&&x.text.includes('cannot interpret arbitrary instructions')));
  } finally {await r.close();}
});

test('responder context has a reserved evidence window and budget during a telemetry flood',async()=>{
  const r=await createSreRuntime({config:config(),autoStart:false});
  try {
    const id=await incident(r);await message(r,'join '+id);
    await message(r,'Redis restart did not help; check the pool instead.',{id:'1001',mentioned:false,userId:'alex'});
    for(let i=0;i<90;i++)await r.store.addEvidence(id,'dynatrace','problem',{sequence:i,log:'x'.repeat(15000)});
    const c=boundedContext(await r.store.context(id));
    assert.ok(c.evidence.some(x=>x.kind==='responder_update'&&x.content.userId==='alex'));
    assert.ok(c.evidence.some(x=>x.kind==='problem'));
    assert.equal(c.responderContext.totalAvailable,1);
    assert.equal(c.responderContext.evidenceIds.length,1);
    assert.ok(c.coverage.included<c.coverage.totalAvailable);
  } finally {await r.close();}
});

test('resolved incidents and bot echoes stop passive capture',async()=>{
  const r=await createSreRuntime({config:config(),autoStart:false});
  try {
    const id=await incident(r);await message(r,'join '+id);
    const echo=sample(r,'approve proposal nonce',{id:'1001',mentioned:false});echo.activity.from={id:'local-sre'};
    assert.equal((await r.router.accept(echo.activity,echo.reference)).ignored,true);
    await r.store.db.query("UPDATE sre_incidents SET status='resolved' WHERE id=?",[id]);
    assert.equal((await message(r,'Unrelated discussion after recovery',{id:'1002',mentioned:false})).ignored,true);
    assert.equal((await r.store.context(id)).responderContext.totalAvailable,0);
  } finally {await r.close();}
});

test('local HTTP simulator accepts different responders and unmentioned group-chat messages',async()=>{
  const r=await createSreRuntime({config:config(),autoStart:false});
  r.server.listen(0,'127.0.0.1');await once(r.server,'listening');
  const url='http://127.0.0.1:'+r.server.address().port;
  const send=body=>fetch(url+'/api/dev/teams',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try {
    const id=await incident(r);
    assert.equal((await send({text:'join '+id,conversationType:'groupChat'})).status,202);await r.router.processOnce();
    assert.equal((await send({text:'Lowered concurrency; observing queue depth.',conversationType:'groupChat',mentioned:false,userId:'sam',displayName:'Sam'})).status,202);await r.router.processOnce();
    const context=await r.store.context(id);
    assert.equal(context.evidence.find(x=>x.kind==='responder_update').content.userId,'sam');
  } finally {await r.close();}
});

test('actual Teams SDK transports channel replies into the incident thread and accepts passive updates',async()=>{
  const r=await createSreRuntime({config:config(),autoStart:false});const delivered=[];
  const transport=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;delivered.push({url:decodeURIComponent(req.url),body:JSON.parse(raw)});res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'1100'}));});
  transport.listen(0,'127.0.0.1');await once(transport,'listening');
  const serviceUrl='http://127.0.0.1:'+transport.address().port;
  const bridge=await startSreTeams({router:r.router,store:r.store,mode:'playground',env:{},port:0});
  const input='http://127.0.0.1:'+bridge.server.address().port+'/api/messages';
  try {
    const id=await incident(r);
    for(const event of [sample(r,'join '+id,{serviceUrl}),sample(r,'Alex is checking the DB connection pool.',{serviceUrl,id:'1001',mentioned:false,userId:'alex'})]) {
      const response=await fetch(input,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event.activity)});
      assert.equal(response.status,200);await r.router.processOnce();
    }
    await new TeamsOutbox({store:r.store,services:r.config.services,sender:bridge.sender}).runOnce();
    assert.equal(delivered.length,1);
    assert.ok(delivered[0].url.includes('test-conversation;messageid=1000'));
    assert.ok(delivered[0].body.text.includes(id.replaceAll('_','\\_')));
    assert.ok(delivered[0].body.text.includes('join \\<incident\\-id\\>'));
    assert.equal(delivered[0].body.textFormat,'extendedmarkdown','escaped command placeholders remain literal while paragraphs stay readable');
    assert.ok((await r.store.context(id)).evidence.some(x=>x.kind==='responder_update'&&x.content.userId==='alex'));
  } finally {await bridge.close();transport.closeAllConnections();await new Promise(resolve=>transport.close(resolve));await r.close();}
});

for(const root of ['test-channel','test_channel'])test('native Teams reinstall restores joined threads within the exact root '+root,async()=>{
  const peer=root.includes('_')?'testXchannel':'other-channel',c=config();
  c.services[0].teams={...c.services[0].teams,conversations:[root,peer],alertConversationId:root,captureResponderUpdates:false,
    collaborationGroups:[{key:'trial',name:'Trial responders',conversations:[{id:root,name:'Bidding'},{id:peer,name:'Platform'}]}]};
  const r=await createSreRuntime({config:c,autoStart:false}),bridge=await startSreTeams({router:r.router,store:r.store,mode:'playground',env:{},port:0});
  const input='http://127.0.0.1:'+bridge.server.address().port+'/api/messages';
  const post=async activity=>assert.equal((await fetch(input,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(activity)})).status,200);
  let lifecycleAt=Date.now(),lifecycleSequence=0;
  const installation=(room,action)=>{
    const {activity}=devActivity('',c.services[0],{id:room+':'+action+':'+(++lifecycleSequence),conversationType:'channel',conversationId:room});
    activity.timestamp=new Date(lifecycleAt+=10).toISOString();activity.type='installationUpdate';activity.action=action;delete activity.text;delete activity.entities;return activity;
  };
  let sequence=1000;
  const send=async(room,text)=>{await post(sample(r,text,{conversationId:room,thread:'1000',id:String(++sequence)}).activity);await r.router.processOnce();};
  const rooms=()=>r.store.db.query('SELECT conversation_id,enabled,incident_id FROM sre_conversations ORDER BY conversation_id');
  try {
    const id=await incident(r),identity=(await r.store.context(id)).session.agent_id;
    const firstInstall=installation(root,'add');await post(firstInstall);await send(root,'join '+id);
    await post(installation(peer,'add'));await send(peer,'join '+id);
    const removal=installation(root,'remove');await post(removal);
    let saved=await rooms();
    assert.ok(saved.filter(row=>row.conversation_id===root||row.conversation_id.startsWith(root+';messageid=')).every(row=>row.enabled===0));
    assert.ok(saved.filter(row=>row.conversation_id===peer||row.conversation_id.startsWith(peer+';messageid=')).every(row=>row.enabled===1),'removing one root must not match underscores as SQL wildcards');
    const before=(await r.store.snapshot()).counts;
    await send(root,'update This removed installation cannot capture me.');
    assert.deepEqual((await r.store.snapshot()).counts,before);
    await post(firstInstall);
    assert.equal((await rooms()).find(row=>row.conversation_id===root).enabled,0,'a replayed old install must not reverse removal');
    await post(installation(root,'add'));
    saved=await rooms();assert.ok(saved.every(row=>row.enabled===1),'a fresh install must restore the existing incident thread, not only its channel root');
    await post(removal);
    assert.ok((await rooms()).every(row=>row.enabled===1),'a delayed old removal must not reverse a newer installation');
    await send(root,'update The same incident thread is reachable after reinstall.');
    const context=await r.store.context(id);
    assert.equal(context.session.agent_id,identity);
    assert.ok(context.evidence.some(row=>row.content.text==='The same incident thread is reachable after reinstall.'));
    assert.equal((await rooms()).find(row=>row.conversation_id===root+';messageid=1000').incident_id,id);
    await post(installation(root,'remove'));
    for(let i=0;i<7;i++){
      await post(sample(r,'join '+id,{conversationId:peer,thread:String(2000+i),id:String(++sequence)}).activity);await r.router.processOnce();
    }
    await post(installation(root,'add'));
    const overflow=(await rooms()).find(row=>row.conversation_id===root+';messageid=1000');
    assert.equal(overflow.enabled,1,'an overflow thread must remain reachable for an explicit new join');assert.equal(overflow.incident_id,null);
    await send(root,'join '+id);
    assert.equal((await rooms()).filter(row=>row.incident_id===id&&row.enabled===1).length,8,'reinstall must preserve the eight-conversation boundary');
  } finally {await bridge.close();await r.close();}
});
