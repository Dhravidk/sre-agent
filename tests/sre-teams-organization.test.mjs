import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {loadConfig,validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {teamsTrialConfig,trialForwardingAllowed} from '../src/sre/teams-trial.mjs';
import {startSreTeams} from '../src/sre/teams.mjs';

const tenant='11111111-1111-4111-8111-111111111111';
const users=['22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const channel='19:new-team@thread.tacv2',chat='19:new-group@thread.v2',other='19:other-group@thread.v2';
function configuration(path=':memory:') {
  const c=loadConfig({SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-org-test-cli'});
  c.services[0].teams={tenantId:tenant,admission:'tenant',tenantSharing:{key:'organization-incidents',name:'Organization incident response'},conversations:[],approvers:[],captureResponderUpdates:false};
  c.services[0].rollback.enabled=false;
  return c;
}
async function fixture(path) {
  const c=configuration(path),sent=[];
  const r=await createSreRuntime({config:c,autoStart:false,sender:{send:async(ref,text)=>{sent.push({room:ref.conversation.id,text});return {id:'receipt-'+sent.length};}}});
  // Exercise the same HTTPS and identity checks as the native live router. No
  // Microsoft authentication is simulated by these local acceptance fixtures.
  r.router.mode='live';let sequence=1000;
  const sample=(room,text,user=0)=>{
    const s=devActivity(text,c.services[0],{id:String(sequence++),userId:users[user],displayName:user?'Priya fixture':'Alex fixture',conversationId:room,conversationType:room.includes('@thread.tacv2')?'channel':'groupChat',replyToId:room.includes('@thread.tacv2')?'1000':undefined,serviceUrl:'https://smba.trafficmanager.net/amer/'});
    if(s.activity.conversation.conversationType==='channel')s.activity.channelData.team={id:'team-fixture'};
    return s;
  };
  const send=async(room,text,user=0,options={})=>{
    const s=sample(room,text,user),result=await r.router.accept(s.activity,s.reference,{getMember:async()=>({aadObjectId:users[user],tenantId:tenant,userRole:'user'}),...options});
    if(!result.ignored)await r.router.processOnce();return {s,result};
  };
  const incident=async(key)=>(await r.store.ingest({id:key,source:'dynatrace',serviceKey:c.services[0].key,kind:'problem',issueKey:key,status:'OPEN',at:Date.now()-1000,payload:{title:'Fictional incident '+key}})).incidentId;
  const drain=async()=>{for(let i=0;i<100&&await r.outbox.runOnce();i++);};
  return {r,c,sent,sample,send,incident,drain};
}

test('tenant admission needs exact tenant and sharing scope, mention-only capture and an unambiguous service',()=>{
  const c=configuration();assert.doesNotThrow(()=>validateConfig(c,{}));
  for(const patch of [{admission:'*'},{tenantId:'*'},{tenantSharing:undefined},{captureResponderUpdates:true}]) {
    const wrong=structuredClone(c);Object.assign(wrong.services[0].teams,patch);assert.throws(()=>validateConfig(wrong,{}));
  }
  const ambiguous=structuredClone(c);ambiguous.services.push({...structuredClone(ambiguous.services[0]),key:'another-service'});
  assert.throws(()=>validateConfig(ambiguous,{}),/exactly one service/);
});

test('two distinct fixture identities self-enroll a new team and group chat, share only their joined incident and persist through restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-org-')),path=join(directory,'agent.sqlite');let f=await fixture(path);
  try {
    const id=await f.incident('shared'),separate=await f.incident('separate');
    await f.r.worker.runOnce();const agent=(await f.r.store.context(id)).session.agent_id;
    await f.send(channel,'join '+id,0);await f.send(chat,'join '+id,1);await f.send(other,'join '+separate,1);
    await f.send(channel,'theory deployment supported Alex sees errors after release A.',0);
    await f.send(chat,'theory network proposed Priya sees downstream timeouts.',1);
    await f.send(channel,'work canary active Alex owns the auction A canary.',0);
    await f.send(chat,'work canary active Priya is also preparing the same canary.',1);
    await f.r.coordination.publish(id,{requestId:'org-briefing'});await f.drain();
    const view=await f.r.coordination.snapshot(id);assert.equal(view.rooms.length,2);
    assert.ok(view.issues.some(issue=>issue.code==='competing-theories'));assert.ok(view.issues.some(issue=>issue.code==='overlapping-work'));
    const shared=f.sent.filter(item=>item.text.startsWith('Shared incident coordination'));
    assert.equal(shared.length,2);assert.ok(shared.every(item=>item.text.includes('Alex sees errors')&&item.text.includes('Priya sees downstream')));
    assert.ok(shared.every(item=>item.room!==other));
    const reports=(await f.r.store.context(id)).evidence.filter(item=>item.kind==='responder_update');
    assert.deepEqual(new Set(reports.map(item=>item.content.userId)),new Set(users));
    await f.r.close();f=await fixture(path);assert.equal((await f.r.store.context(id)).session.agent_id,agent);
    assert.equal((await f.r.coordination.snapshot(id)).rooms.length,2);
    await f.send(chat,'update Priya resumed after restart; canary ownership stays with Alex.',1);await f.drain();
    assert.ok((await f.r.store.context(id)).evidence.some(item=>item.content.text?.includes('Priya resumed after restart')));
    assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
  } finally {await f.r.close();await rm(directory,{recursive:true,force:true});}
});

test('unbound mentions and ordinary messages cannot leak incident context; leaving stops future shared briefings',async()=>{
  const f=await fixture();try {
    const id=await f.incident('isolated');await f.send(channel,'join '+id);await f.send(chat,'join '+id,1);await f.drain();
    await f.send(other,'status',1);await f.drain();
    assert.ok(f.sent.filter(item=>item.room===other).every(item=>!item.text.includes(id)));
    const plain=f.sample(other,'update UNMENTIONED-SENTINEL',1);delete plain.activity.entities;
    const before=(await f.r.store.snapshot()).counts;
    assert.equal((await f.r.router.accept(plain.activity,plain.reference)).ignored,true);assert.deepEqual((await f.r.store.snapshot()).counts,before);
    await f.send(chat,'leave',1);await f.drain();const count=f.sent.filter(item=>item.room===chat).length;
    await f.send(channel,'update Canary check remains active.');await f.r.coordination.publish(id,{requestId:'after-leave'});await f.drain();
    assert.equal(f.sent.filter(item=>item.room===chat).length,count);
  } finally {await f.r.close();}
});

test('an explicit target cannot redirect investigation or recovery commands away from the incident already joined',async()=>{
  const f=await fixture();try {
    const first=await f.incident('current-target'),otherIncident=await f.incident('other-target');
    await f.send(channel,'join '+first);await f.send(chat,'join '+otherIncident,1);await f.drain();
    const proposals=[];
    f.r.rollbacks.propose=async target=>{proposals.push(target);return {eligible:true,text:'CROSS-TARGET-PROPOSAL-SENTINEL'};};
    const questionsBefore=(await f.r.store.context(otherIncident)).evidence.filter(item=>item.kind==='question').length;
    for(const command of ['investigate '+otherIncident+' CROSS-TARGET-SENTINEL','rollback '+otherIncident,'retry '+otherIncident+' unknown-job CROSS-TARGET-SENTINEL']) {
      await f.send(channel,command);await f.drain();
      assert.match(f.sent.findLast(item=>item.room===channel+';messageid=1000').text,/Request could not be completed/);
    }
    assert.deepEqual(proposals,[],'a wrong incident target must be rejected before the action service is invoked');
    assert.equal((await f.r.store.context(otherIncident)).evidence.filter(item=>item.kind==='question').length,questionsBefore);
    const [room]=await f.r.store.db.query('SELECT incident_id FROM sre_conversations WHERE id=?',[conversationKey(tenant,channel+';messageid=1000')]);assert.equal(room.incident_id,first);
    assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
  } finally {await f.r.close();}
});

test('tenant-wide admission rejects foreign tenants, guests, absent/mismatched membership and personal scope before persistence',async()=>{
  const f=await fixture();try {
    const initial=(await f.r.store.snapshot()).counts;
    const s=f.sample(chat,'incidents',1);
    await assert.rejects(()=>f.r.router.accept(s.activity,s.reference),/membership/);
    for(const member of [null,{aadObjectId:users[1],tenantId:'other'},{aadObjectId:users[0],tenantId:tenant},{aadObjectId:users[1],tenantId:tenant,userRole:'guest'}])await assert.rejects(()=>f.r.router.accept(s.activity,s.reference,{getMember:async()=>member}),/authenticated member/);
    const foreign=structuredClone(s.activity);foreign.channelData.tenant.id='other';
    await assert.rejects(()=>f.r.router.accept(foreign,s.reference,{getMember:async()=>({})}),/tenant/);
    const personal=structuredClone(s.activity);personal.conversation.conversationType='personal';
    await assert.rejects(()=>f.r.router.accept(personal,s.reference,{getMember:async()=>({})}),/tenant/);
    assert.deepEqual((await f.r.store.snapshot()).counts,initial);
    assert.equal((await f.r.store.db.query('SELECT id FROM sre_conversations')).length,0);
  } finally {await f.r.close();}
});

test('joined teams can read an attributed signal digest without creating an investigation or an action',async()=>{
  const f=await fixture();try {
    const id=await f.incident('signal-digest');await f.send(channel,'join '+id);await f.drain();
    await f.r.store.addEvidence(id,'dynatrace','logs',{records:[{timestamp:new Date().toISOString(),loglevel:'ERROR',errorCode:'CREDIT_TIMEOUT',content:'Fictional checkout timeout',region:'eu'}],complete:false});
    const before=(await f.r.store.context(id)).evidence.filter(item=>item.kind==='question').length;
    await f.send(channel,'signals');await f.drain();
    const response=f.sent.findLast(item=>item.room===channel+';messageid=1000').text;
    assert.match(response,/CREDIT_TIMEOUT/);assert.match(response,/Coverage is limited/);
    await f.send(channel,'help');await f.drain();assert.match(f.sent.findLast(item=>item.room===channel+';messageid=1000').text,/signals/);
    assert.equal((await f.r.store.context(id)).evidence.filter(item=>item.kind==='question').length,before);
    assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    await f.send(other,'signals',1);await f.drain();assert.ok(f.sent.filter(item=>item.room===other).every(item=>!item.text.includes('CREDIT_TIMEOUT')));
  } finally {await f.r.close();}
});

test('tenant-wide use never authorizes rollback approval outside explicit rooms and approvers',async()=>{
  const f=await fixture();try {
    const service=f.c.services[0],principal={verified:true,tenant,conversationId:chat,rootConversationId:chat,userId:users[1]};
    assert.doesNotThrow(()=>f.r.rollbacks.authorize(principal,service));
    assert.throws(()=>f.r.rollbacks.authorize(principal,service,{approve:true}),/authorized rollback approver/);
    service.teams.approvers=[users[1]];
    assert.throws(()=>f.r.rollbacks.authorize(principal,service,{approve:true}),/authorized rollback approver/);
    service.teams.conversations=[chat];assert.doesNotThrow(()=>f.r.rollbacks.authorize(principal,service,{approve:true}));
  } finally {await f.r.close();}
});

test('native SDK looks up the actual sender through Bot Connector before enrolling an organization group chat',async()=>{
  const f=await fixture(),lookups=[];
  const connector=createServer((req,res)=>{
    lookups.push(req.url);res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:users[1],objectId:users[1],tenantId:tenant,userRole:'user',name:'Priya fixture'}));
  });
  connector.listen(0,'127.0.0.1');await once(connector,'listening');let teams;
  try {
    f.r.router.mode='playground';teams=await startSreTeams({router:f.r.router,store:f.r.store,mode:'playground',env:{},port:0});
    const id=await f.incident('native-group'),s=f.sample(chat,'join '+id,1);s.activity.serviceUrl='http://127.0.0.1:'+connector.address().port;
    const response=await fetch('http://127.0.0.1:'+teams.server.address().port+'/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(s.activity)});
    assert.equal(response.status,200);await f.r.router.processOnce();
    assert.equal(lookups.length,1);assert.match(decodeURIComponent(lookups[0]),new RegExp('/conversations/'+chat.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/members/'+users[1]));
    const [room]=await f.r.store.db.query('SELECT incident_id FROM sre_conversations WHERE id=?',[conversationKey(tenant,chat)]);assert.equal(room.incident_id,id);
    const events=await f.r.store.db.query("SELECT payload FROM sre_events WHERE source='teams'");assert.equal(JSON.parse(events[0].payload).payload.principal.userId,users[1]);
  } finally {if(teams)await teams.close();await f.r.close();connector.closeAllConnections();await new Promise(resolve=>connector.close(resolve));}
});

test('a bot added to a two-person chat accepts its unq ID, shares joined context and retains membership and lifecycle checks',async()=>{
  const f=await fixture(),twoPeople='19:'+users.join('_')+'@unq.gbl.spaces';
  try {
    const id=await f.incident('two-people');
    await f.send(channel,'join '+id);await f.send(twoPeople,'join '+id,1);
    await f.send(twoPeople,'update Priya received the shared canary handoff.',1);
    await f.r.coordination.publish(id,{requestId:'two-person-briefing'});await f.drain();
    assert.ok(f.sent.some(item=>item.room===channel+';messageid=1000'&&item.text.includes('Priya received the shared canary handoff')));
    assert.ok(f.sent.some(item=>item.room===twoPeople&&item.text.includes('Shared incident coordination')));
    const s=f.sample(twoPeople,'incidents',1),before=(await f.r.store.snapshot()).counts;
    const personal=structuredClone(s.activity);personal.conversation.conversationType='personal';
    await assert.rejects(()=>f.r.router.accept(personal,s.reference,{getMember:async()=>({aadObjectId:users[1],tenantId:tenant,userRole:'user'})}),/tenant/);
    await assert.rejects(()=>f.r.router.accept(s.activity,s.reference,{getMember:async()=>({aadObjectId:users[1],tenantId:tenant,userRole:'guest'})}),/authenticated member/);
    const ordinary=structuredClone(s.activity);delete ordinary.entities;
    assert.equal((await f.r.router.accept(ordinary,s.reference)).ignored,true);
    assert.deepEqual((await f.r.store.snapshot()).counts,before);
    const remove={...s.activity,id:'two-people-remove',timestamp:new Date(Date.now()+1).toISOString()};
    await f.r.router.installation(remove,s.reference,false);
    assert.equal((await f.send(twoPeople,'update Late message',1)).result.ignored,true);
    assert.equal((await f.r.coordination.snapshot(id)).rooms.length,1);
    await f.r.router.installation({...remove,id:'two-people-reinstall',timestamp:new Date(Date.parse(remove.timestamp)+1).toISOString()},s.reference,true);
    assert.equal((await f.r.coordination.snapshot(id)).rooms.length,2);
    assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
  } finally {await f.r.close();}
});

test('removing a self-enrolled team blocks delayed mentions in previously unseen threads until a fresh install',async()=>{
  const f=await fixture();try {
    const id=await f.incident('lifecycle');const {s}=await f.send(channel,'join '+id);
    const at=Date.now();const removed={...s.activity,id:'remove',timestamp:new Date(at).toISOString(),conversation:{id:channel,conversationType:'channel'}};
    await f.r.router.installation(removed,{...s.reference,conversation:removed.conversation},false);
    const unseen=f.sample(channel+';messageid=2000','join '+id,1);
    const result=await f.r.router.accept(unseen.activity,unseen.reference,{getMember:async()=>({aadObjectId:users[1],tenantId:tenant,userRole:'user'})});assert.equal(result.ignored,true);
    assert.equal((await f.r.store.db.query('SELECT id FROM sre_conversations')).length,1);
    await f.r.router.installation({...removed,id:'reinstall',timestamp:new Date(at+1).toISOString()},{...s.reference,conversation:removed.conversation},true);
    await f.send(channel,'update Reinstalled successfully.',1);
    assert.ok((await f.r.store.context(id)).evidence.some(item=>item.content.text==='Reinstalled successfully.'));
  } finally {await f.r.close();}
});

test('a team uninstall disables every enrolled channel and rejects unseen channels; reinstall restores the same incident without affecting its group chat',async()=>{
  const f=await fixture();try {
    const id=await f.incident('whole-team'),second='19:second-channel@thread.tacv2',unseen='19:unseen-channel@thread.tacv2';
    const {s}=await f.send(channel,'join '+id);await f.send(second,'join '+id,1);await f.send(chat,'join '+id,1);
    const at=Date.now(),remove={...s.activity,id:'whole-team-remove',timestamp:new Date(at).toISOString(),conversation:{id:channel,conversationType:'channel'}};
    await f.r.router.installation(remove,{...s.reference,conversation:remove.conversation},false);
    assert.equal((await f.r.coordination.snapshot(id)).rooms.length,1);
    assert.equal((await f.send(unseen,'join '+id,1)).result.ignored,true);
    assert.equal((await f.send(second,'update Delayed old channel message',1)).result.ignored,true);
    assert.ok((await f.send(chat,'update The group remains available',1)).result.eventId);
    await f.r.router.installation({...remove,id:'whole-team-add',timestamp:new Date(at+1).toISOString()},{...s.reference,conversation:remove.conversation},true);
    assert.equal((await f.r.coordination.snapshot(id)).rooms.length,3);
    assert.ok((await f.send(second,'update Both channels are restored',1)).result.eventId);
    const newer=await f.r.router.installation({...remove,id:'delayed-old-team-remove'},{...s.reference,conversation:remove.conversation},false);assert.equal(newer.ignored,true);
    assert.equal((await f.r.coordination.snapshot(id)).rooms.length,3);
  } finally {await f.r.close();}
});

test('an old two-channel forwarding grant cannot activate organization admission or vice versa',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-org-grant-')),path=join(directory,'forwarding.json'),now=Date.now();
  const settings={tenantId:tenant,botId:users[0],admission:'tenant',database:':memory:',rooms:[{id:'19:a@thread.tacv2',name:'A'},{id:'19:b@thread.tacv2',name:'B'}]};
  const credentials={TENANT_ID:tenant,CLIENT_ID:users[0],SRE_TEAMS_TRIAL_API_TOKEN:'fixture-api',SRE_TEAMS_TRIAL_CAPABILITY_SECRET:'fixture-capability-'.repeat(3)};
  const grant={enabled:true,tenantId:tenant,botId:users[0],expiresAt:now+3600000,channelIds:settings.rooms.map(room=>room.id)};
  try {
    const c=teamsTrialConfig(settings,credentials);assert.equal(c.agentMode,'rules');assert.equal(c.services[0].teams.admission,'tenant');assert.equal(c.services[0].rollback.enabled,false);assert.equal(c.services[0].teams.approvers.length,0);
    await writeFile(path,JSON.stringify(grant));assert.equal(trialForwardingAllowed(path,settings,now),false);
    await writeFile(path,JSON.stringify({...grant,admission:'tenant',channelIds:[]}));assert.equal(trialForwardingAllowed(path,settings,now),true);
    assert.equal(trialForwardingAllowed(path,{...settings,admission:'allowlist'},now),false);
  } finally {await rm(directory,{recursive:true,force:true});}
});
