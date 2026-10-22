import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {loadConfig,validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {devActivity,seedDemo} from '../src/sre/demo.mjs';
import {boundedContext,modelContextLimits} from '../src/sre/model-context.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {startSreTeams} from '../src/sre/teams.mjs';
import {prepareRestore,releaseRestore} from '../src/sre/restore-recovery.mjs';

function configuration(path=':memory:',count=2) {
  const c=loadConfig({SRE_SQLITE_PATH:path}),rooms=Array.from({length:count},(_,i)=>({id:'group-'+i,name:i===0?'Bidding responders':i===1?'Platform responders':'Response group '+i}));
  c.services[0].teams={...c.services[0].teams,conversations:[...rooms.map(room=>room.id),'private-group'],alertConversationId:rooms[0].id,collaborationGroups:[{key:'auction',name:'Auction response',conversations:rooms}]};
  return validateConfig(c,{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-coordination-test-cli'});
}
async function fixture({path=':memory:',count=2,db,sender}={}) {
  const c=configuration(path,count),sent=[];
  const r=await createSreRuntime({config:c,db,autoStart:false,sender:sender||{send:async(ref,text)=>{sent.push({room:ref.conversation.id,text});return {id:'local-'+sent.length};}}});
  const f={r,c,sent,now:Date.now(),sequence:0};r.store.clock=()=>f.now;
  f.incident=async(key='incident')=>(await r.store.ingest({id:key,source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:key,status:'OPEN',at:f.now-1000,payload:{title:'Synthetic bidding errors'}})).incidentId;
  f.send=async(room,text,{mentioned=true,userId=room==='group-0'?'alex':'sam',displayName=room==='group-0'?'Alex':'Sam',at,thread,serviceUrl='http://127.0.0.1:1'}={})=>{
    f.now+=10;
    const sample=devActivity(text,c.services[0],{id:String(++f.sequence),conversationType:thread?'channel':'groupChat',conversationId:thread?room+';messageid='+thread:room,mentioned,userId,displayName,serviceUrl});sample.activity.timestamp=new Date(at??f.now).toISOString();
    const receipt=await r.router.accept(sample.activity,sample.reference);if(!receipt.ignored)await r.router.processOnce();return {...sample,receipt};
  };
  f.join=async(id,rooms=['group-0','group-1'])=>{for(const room of rooms)await f.send(room,'join '+id);};
  f.drain=async()=>{for(let i=0;i<100&&await r.outbox.runOnce();i++);};
  f.publish=async()=>{f.now+=16000;await r.coordination.runOnce();await f.drain();};
  return f;
}

test('competing theories and duplicated rollback work stay visible after routine chatter, without executing anything',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();
    await f.send('group-0','theory bid-order proposed Winner selection regressed in the new revision; compare accepted bid ordering.');
    await f.send('group-1','theory credit-pool proposed Credit timeouts are the cause; correlate traces before any restart.');
    await f.send('group-0','work rollback active Inspect the exact target for auction prod; do not execute until approved.');
    await f.send('group-1','work rollback active Also preparing the same auction prod rollback; no deployment sent.');
    for(let i=0;i<8;i++)await f.send('group-0','Routine trace sample '+i+' collected.',{mentioned:false});
    await f.publish();const view=await f.r.coordination.snapshot(id);
    assert.ok(view.issues.some(issue=>issue.code==='competing-theories'));
    assert.ok(view.issues.some(issue=>issue.code==='overlapping-work'));
    const briefing=f.sent.findLast(m=>m.room==='group-1'&&m.text.startsWith('Shared incident coordination'));
    assert.match(briefing.text,/Winner selection regressed/);assert.match(briefing.text,/Credit timeouts/);
    assert.match(briefing.text,/one owner/);assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    await f.send('group-1','work rollback cancelled Sam will collect traces instead; Alex keeps rollback preparation.');
    await f.send('group-1','theory credit-pool ruled-out Current traces do not show credit errors for affected bids.');
    const corrected=await f.r.coordination.snapshot(id);
    assert.ok(!corrected.issues.some(issue=>['competing-theories','overlapping-work'].includes(issue.code)));
    assert.equal(corrected.incidentStatus,'open');
  } finally {await f.r.close();}
});

test('a missed briefing is called out once and acknowledging an older round cannot mark a newer update as seen',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();await f.r.coordination.runOnce();await f.drain();
    const first=(await f.r.coordination.snapshot(id)).briefingGeneration;assert.ok(first>0);
    await f.send('group-0','ack '+first);await f.drain();
    f.now+=301000;await f.r.coordination.runOnce();await f.drain();
    const view=await f.r.coordination.snapshot(id);
    assert.ok(view.issues.some(issue=>issue.code==='briefing-unacknowledged'&&issue.roomKey===conversationKey('synthetic','group-1')));
    const notices=f.sent.filter(m=>m.text.startsWith('Coordination delivery check'));assert.ok(notices.length);
    await f.r.coordination.runOnce();await f.drain();assert.equal(f.sent.filter(m=>m.text.startsWith('Coordination delivery check')).length,notices.length);
    await f.send('group-0','work traces active Compare trace failures to the affected auction IDs.');await f.publish();
    const next=(await f.r.coordination.snapshot(id)).briefingGeneration;assert.ok(next>first);
    const latest=f.sent.findLast(m=>m.room==='group-1'&&m.text.startsWith('Shared incident coordination'));
    assert.deepEqual([...latest.text.matchAll(/\breply ack (\d+)\b/g)].map(match=>Number(match[1])),[next],
      'a new briefing must not repeat the previous round acknowledgement command in its warning');
    assert.ok(notices.every(notice=>! /\breply ack \d+\b/.test(notice.text)),
      'a delayed attention notice must direct people to their latest delivered briefing');
    await f.send('group-1','ack '+first);await f.drain();
    assert.equal((await f.r.coordination.snapshot(id)).rooms.find(room=>room.conversationId==='group-1').briefing.acknowledged,false);
    await f.send('group-1','ack '+next);await f.drain();
    assert.equal((await f.r.coordination.snapshot(id)).rooms.find(room=>room.conversationId==='group-1').briefing.acknowledged,true);
    const before=(await f.r.coordination.snapshot(id)).briefingGeneration;await f.r.coordination.runOnce();
    assert.equal((await f.r.coordination.snapshot(id)).briefingGeneration,before,'acknowledgements must not create briefing feedback loops');
  } finally {await f.r.close();}
});

test('an unaccepted handoff and conflicting evidence about the same theory need a lead, not an automatic decision',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);
    await f.send('group-0','work credit-traces active Checking credit traces for affected bids.');
    await f.send('group-0','work credit-traces released Shift ending; Sam must explicitly accept this investigation.');
    await f.send('group-0','theory bid-order supported Reproduction fails only on the new revision.');
    await f.send('group-1','theory bid-order ruled-out My smoke test passed; scope may be different.');
    let view=await f.r.coordination.snapshot(id);
    assert.ok(view.issues.some(issue=>issue.code==='unaccepted-handoff'));
    assert.ok(view.issues.some(issue=>issue.code==='theory-disagreement'));
    assert.match(view.nextStep,/shared incident thread or bridge/);
    await f.send('group-1','work credit-traces active Accepted the handoff; next check is credit traces from affected auction IDs.');
    view=await f.r.coordination.snapshot(id);assert.ok(!view.issues.some(issue=>issue.code==='unaccepted-handoff'));
    assert.equal(view.rooms.find(room=>room.conversationId==='group-1').work.find(item=>item.key==='credit-traces').author,'Sam');
    assert.equal(view.incidentStatus,'open');
  } finally {await f.r.close();}
});

test('new briefings cannot postpone a silent team’s acknowledgement deadline or flood the other team with reminders',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();await f.r.coordination.runOnce();await f.drain();
    const first=(await f.r.coordination.snapshot(id)).briefingGeneration;
    for(let i=0;i<7;i++) {
      f.now+=61000;await f.send('group-0','update Trace check '+i+'; no fresh result from the platform team.');
      await f.r.coordination.runOnce();await f.drain();
      await f.send('group-0','ack '+(await f.r.coordination.snapshot(id)).briefingGeneration);await f.drain();
    }
    const view=await f.r.coordination.snapshot(id),peer=view.rooms.find(room=>room.conversationId==='group-1');
    assert.equal(peer.briefing.attentionGeneration,first);
    assert.ok(view.issues.some(issue=>issue.code==='briefing-unacknowledged'&&issue.roomKey===peer.key));
    assert.equal(f.sent.filter(m=>m.room==='group-0'&&m.text.startsWith('Coordination delivery check')&&m.text.includes('Platform responders')).length,1);
    await f.send('group-1','ack '+view.briefingGeneration);await f.drain();await f.r.coordination.runOnce();
    assert.ok(!(await f.r.coordination.snapshot(id)).issues.some(issue=>issue.delivery&&issue.roomKey===peer.key));
  } finally {await f.r.close();}
});

test('a freshly queued round keeps an old unread reminder without falsely reporting a new delivery delay',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();await f.r.coordination.runOnce();await f.drain();
    const delivered=(await f.r.coordination.snapshot(id)).briefingGeneration;
    f.now+=301000;await f.r.coordination.checkAttention(id);await f.drain();
    const notices=f.sent.filter(message=>message.text.startsWith('Coordination delivery check')).length;
    await f.r.coordination.publish(id,{requestId:'fresh-pending'});
    let view=await f.r.coordination.snapshot(id);
    assert.ok(view.briefingGeneration>delivered);
    assert.ok(view.rooms.every(room=>room.briefing.deliveryStatus==='pending'));
    assert.ok(!view.issues.some(issue=>issue.code==='briefing-delayed'));
    assert.ok(view.issues.filter(issue=>issue.code==='briefing-unacknowledged').every(issue=>issue.generation===delivered));
    await f.r.coordination.checkAttention(id);await f.drain();await f.r.coordination.checkAttention(id);await f.drain();
    assert.equal(f.sent.filter(message=>message.text.startsWith('Coordination delivery check')).length,notices);
    await f.r.coordination.publish(id,{requestId:'genuinely-delayed'});f.now+=301000;
    view=await f.r.coordination.snapshot(id);assert.ok(view.issues.some(issue=>issue.code==='briefing-delayed'));
  } finally {await f.r.close();}
});

test('old delayed corrections and replayed messages cannot replace the current work owner or execute passive commands',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);const at=f.now;
    await f.send('group-0','work traces active Alex checks the affected auction IDs.',{at});
    const release=await f.send('group-0','work traces released Sam must accept this handoff.',{at});
    await f.send('group-1','work traces active Sam accepts scope and will compare errors.',{at});
    await f.send('group-0','work traces active Delayed older claim by Alex.',{at:at-1000});
    await f.send('group-1','work traces done This unmentioned command must remain a quotation.',{mentioned:false});
    const replay=await f.r.router.accept(release.activity,release.reference);assert.equal(replay.duplicate,true);
    const view=await f.r.coordination.snapshot(id);
    assert.equal(view.rooms.find(room=>room.conversationId==='group-0').work[0].state,'released');
    assert.equal(view.rooms.find(room=>room.conversationId==='group-1').work[0].state,'active');
    assert.ok(!view.issues.some(issue=>['overlapping-work','unaccepted-handoff','work-status-disagreement'].includes(issue.code)));
    assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
  } finally {await f.r.close();}
});

test('a past completed task cannot mask a new unaccepted handoff on the same work key',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);
    await f.send('group-1','work traces done Prior trace check completed before the latest regression.');
    await f.send('group-0','work traces active Check the new affected window.');
    assert.ok((await f.r.coordination.snapshot(id)).issues.some(issue=>issue.code==='work-status-disagreement'));
    await f.send('group-0','work traces released Shift ends before the new check can complete.');
    assert.ok((await f.r.coordination.snapshot(id)).issues.some(issue=>issue.code==='unaccepted-handoff'));
    await f.send('group-1','work traces cancelled Sam cannot accept the new scope before shift end.');
    assert.ok((await f.r.coordination.snapshot(id)).issues.some(issue=>issue.code==='unaccepted-handoff'),'a peer declining work does not accept the handoff');
    await f.send('group-1','work traces active Accepted new affected time window.');
    assert.ok(!(await f.r.coordination.snapshot(id)).issues.some(issue=>issue.code==='unaccepted-handoff'));
  } finally {await f.r.close();}
});

test('fresh chatter cannot refresh an old service-state report or old work assignment',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);
    await f.send('group-0','report recovered Alex reports a single successful accepted bid; verification pending.');
    await f.send('group-0','work traces active Still collecting the affected traces.');
    f.now+=301000;await f.send('group-0','update Trace file downloaded; no conclusion yet.');
    let view=await f.r.coordination.snapshot(id);
    assert.ok(view.issues.some(issue=>issue.code==='stale-team-state'));
    assert.ok(view.issues.some(issue=>issue.code==='stale-work'));assert.equal(view.incidentStatus,'open');
    await f.send('group-0','report monitoring Latest accepted bid still needs broader verification.');
    await f.send('group-0','work traces done The reported comparison completed; independent health check is next.');
    view=await f.r.coordination.snapshot(id);assert.ok(!view.issues.some(issue=>['stale-team-state','stale-work'].includes(issue.code)));assert.equal(view.incidentStatus,'open');
    f.now+=301000;await f.publish();
    const briefing=f.sent.findLast(m=>m.text.startsWith('Shared incident coordination'));
    assert.match(briefing.text,/Work traces \[done, older report\]/);
    assert.doesNotMatch(briefing.text,/Work traces \[done, (?:owner )?update overdue\]/,'a closed historical task must not ask for a current owner update');
  } finally {await f.r.close();}
});

test('a group cannot acknowledge another group’s undelivered or future briefing or leak acknowledgements to a private room',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();await f.r.coordination.runOnce();
    const version=(await f.r.coordination.snapshot(id)).briefingGeneration;
    await f.send('group-0','ack '+version);
    assert.equal((await f.r.coordination.snapshot(id)).rooms.find(room=>room.conversationId==='group-0').briefing.acknowledged,false);
    await f.drain();await f.send('group-0','ack '+(version+100));
    await f.send('private-group','ack '+version);await f.drain();
    assert.ok(f.sent.some(m=>m.room==='group-0'&&m.text.includes('not addressed to this conversation')));
    assert.ok(!f.sent.some(m=>m.room==='private-group'&&m.text.includes('acknowledged reading')));
    await f.send('group-0','ack '+version);await f.send('group-0','ack '+version);await f.drain();
    assert.equal(f.sent.filter(m=>m.room==='group-1'&&m.text.includes('acknowledged reading shared briefing')).length,1);
    assert.equal((await f.r.coordination.snapshot(id)).rooms.find(room=>room.conversationId==='group-1').briefing.acknowledged,false);
  } finally {await f.r.close();}
});

test('an uncertain delivery warns the reachable team once and explicit receipt leaves the transport audit uncertain',async()=>{
  let fail=false;const sent=[];
  const f=await fixture({sender:{send:async(ref,text)=>{if(fail&&ref.conversation.id==='group-1')throw Error('Connection lost after possible delivery');sent.push({room:ref.conversation.id,text});return {id:'local-'+sent.length};}}});
  try {
    const id=await f.incident();await f.join(id);await f.drain();fail=true;
    await f.send('group-0','work traces active Do not repeat this trace check while Sam is disconnected.');
    await f.r.coordination.runOnce();await f.drain();await f.r.coordination.runOnce();await f.drain();
    const notices=sent.filter(m=>m.text.startsWith('Coordination delivery check'));assert.equal(notices.length,1);assert.match(notices[0].text,/Platform responders/);
    const version=(await f.r.coordination.snapshot(id)).briefingGeneration;
    fail=false;await f.send('group-1','ack '+version);await f.drain();await f.r.coordination.runOnce();
    const peer=(await f.r.coordination.snapshot(id)).rooms.find(room=>room.conversationId==='group-1');assert.equal(peer.briefing.acknowledged,true);assert.equal(peer.briefing.deliveryStatus,'unknown');
    assert.ok(!(await f.r.coordination.snapshot(id)).issues.some(issue=>issue.roomKey===peer.key&&issue.delivery));
    assert.equal(sent.filter(m=>m.room==='group-1'&&m.text.startsWith('Shared incident coordination')).length,0,'uncertain shared message must not be replayed');
  } finally {await f.r.close();}
});

test('bounded ledger keeps active work ahead of closed history and omits unusable model citation IDs',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);
    await f.send('group-0','work important-trace active Critical check survives chatter and closed tasks.');
    await f.send('group-0','theory bid-order proposed New deployment changed the comparator.');
    for(let i=0;i<12;i++)await f.send('group-0','work closed-'+i+' done Old completed check '+i+'.');
    for(let i=0;i<45;i++)await f.send('group-0','Routine progress '+i,{mentioned:false});
    const c=await f.r.store.context(id),room=c.collaboration.rooms.find(room=>room.conversationId==='group-0');
    assert.ok(room.work.some(item=>item.key==='important-trace'));assert.equal(room.work.length,8);assert.equal(room.omittedItems,5);
    const shaped=boundedContext(c),transportRoom=shaped.collaboration.rooms.find(room=>room.conversationId==='group-0');
    for(const item of [...transportRoom.work,...transportRoom.theories]){assert.equal(item.evidenceId,undefined);assert.equal(item.evidenceOmitted,true);}
    assert.ok(room.work[0].evidenceId,'transport shaping must not mutate the stored projection');
  } finally {await f.r.close();}
});

test('large multilingual shared briefings keep every room, coordination warnings and acknowledgement instructions in the delivered text',async()=>{
  const f=await fixture({count:8});try {
    const id=await f.incident();await f.join(id,Array.from({length:8},(_,i)=>'group-'+i));await f.drain();f.sent.length=0;
    for(let i=0;i<8;i++)for(let j=0;j<3;j++) {
      await f.send('group-'+i,'theory cause-'+i+'-'+j+' proposed '+('检查范围🚦'.repeat(180)));
      await f.send('group-'+i,'work shared-'+j+' active '+('仍在检查影响🚦'.repeat(180)));
    }
    await f.publish();const messages=f.sent.filter(m=>m.text.startsWith('Shared incident coordination'));assert.equal(messages.length,8);
    for(const message of messages) {
      assert.ok(Buffer.byteLength(message.text,'utf8')<=14000);
      for(let i=0;i<8;i++)assert.ok(message.text.includes(i===0?'Bidding responders':i===1?'Platform responders':'Response group '+i));
      assert.match(message.text,/Possible duplicate work/);assert.match(message.text,/reply ack \d+/);
      assert.ok(!message.text.includes('[Message shortened.'),'transport must not chop off later rooms or receipt instructions');
    }
    const shaped=boundedContext(await f.r.store.context(id));
    assert.equal(shaped.collaboration.rooms.length,8,'model projection must preserve each room rather than a prefix of JSON');
    assert.ok(shaped.collaboration.rooms.every(room=>room.work.length&&room.theories.length));
    const included=new Set(shaped.evidence.map(item=>item.id));
    for(const room of shaped.collaboration.rooms)for(const item of [...room.reports,...room.work,...room.theories])assert.ok(!item.evidenceId||included.has(item.evidenceId),'metadata must not offer a citation dropped by the final evidence byte budget');
    assert.ok(Buffer.byteLength(JSON.stringify(shaped),'utf8')<=modelContextLimits.totalBytes);
  } finally {await f.r.close();}
});

test('work, theories, acknowledgement and reminder deduplication survive a SQLite restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sre-work-reopen-'));let f;
  try {
    const path=join(dir,'db.sqlite');f=await fixture({path});const id=await f.incident();await f.join(id);await f.drain();
    await f.send('group-0','theory bid-order supported New revision reproduces accepted-bid ordering errors.');
    await f.send('group-1','theory bid-order ruled-out Platform smoke test passed; compare scope.');
    await f.send('group-0','work traces released Shift is ending; no owner accepted yet.');
    await f.r.coordination.runOnce();await f.drain();const version=(await f.r.coordination.snapshot(id)).briefingGeneration;
    await f.send('group-0','ack '+version);await f.drain();f.now+=301000;await f.r.coordination.runOnce();await f.drain();
    const before=await f.r.coordination.snapshot(id),identity=(await f.r.store.context(id)).session.agent_id,noticeCount=(await f.r.store.snapshot()).outbox.filter(row=>row.id.startsWith('coordination-attention:')).length,resumeAt=f.now+1000;
    await f.r.close();f=await fixture({path});f.now=Math.max(f.now,resumeAt);f.sequence=1000;
    const after=await f.r.coordination.snapshot(id);assert.equal((await f.r.store.context(id)).session.agent_id,identity);
    assert.deepEqual(after.rooms.map(room=>[room.theories,room.work,room.briefing]),before.rooms.map(room=>[room.theories,room.work,room.briefing]));
    await f.r.coordination.runOnce();await f.drain();assert.equal((await f.r.store.snapshot()).outbox.filter(row=>row.id.startsWith('coordination-attention:')).length,noticeCount);
    await f.send('group-1','work traces active Sam accepted after restart; next check is affected traces.');
    assert.ok(!(await f.r.coordination.snapshot(id)).issues.some(issue=>issue.code==='unaccepted-handoff'));
  } finally {await f?.r.close();await rm(dir,{recursive:true,force:true});}
});

test('SIGKILL during delivery preserves team context and a queued acknowledgement without replaying the uncertain send',{timeout:15000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sre-coordination-kill-'));let child,f,stderr='';
  try {
    const path=join(dir,'db.sqlite'),log=join(dir,'delivered.jsonl');
    child=fork(new URL('../fixtures/coordination-crash.mjs',import.meta.url),[path,log],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,SRE_CLAUDE_BIN:'/nonexistent-coordination-crash-cli',DATABASE_URL:''}});
    child.stderr.on('data',chunk=>stderr+=chunk);
    const checkpoint=await new Promise((resolve,reject)=>{
      child.on('message',message=>{if(message.event==='delivery-in-flight')resolve(message);});
      child.once('error',reject);child.once('exit',code=>reject(Error('Fixture exited before crash boundary: '+code+' '+stderr)));
    });
    const exited=once(child,'exit');child.kill('SIGKILL');assert.deepEqual(await exited,[null,'SIGKILL']);
    f=await fixture({path});f.now=Math.max(f.now,checkpoint.now+91000);f.sequence=1000;
    assert.equal((await f.r.store.context(checkpoint.incidentId)).session.agent_id,checkpoint.agentId);
    const view=await f.r.coordination.snapshot(checkpoint.incidentId);
    assert.equal(view.rooms.length,2);assert.ok(view.issues.some(issue=>issue.code==='unaccepted-handoff'));
    assert.ok(view.rooms.every(room=>room.theories.length===1));
    await f.drain();await f.r.router.processOnce();await f.drain();
    const resumed=await f.r.coordination.snapshot(checkpoint.incidentId),platform=resumed.rooms.find(room=>room.conversationId==='group-1');
    assert.equal(platform.briefing.deliveryStatus,'unknown');
    assert.equal(resumed.rooms.find(room=>room.conversationId==='group-0').briefing.acknowledged,true,'queued explicit acknowledgement must recover');
    await f.r.coordination.runOnce();await f.drain();await f.r.coordination.runOnce();await f.drain();
    assert.equal(f.sent.filter(m=>m.room==='group-1'&&m.text.startsWith('Shared incident coordination')).length,0,'crashed message must not replay');
    assert.equal(f.sent.filter(m=>m.room==='group-0'&&m.text.startsWith('Coordination delivery check')).length,1);
    const delivered=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(delivered.filter(m=>m.room==='group-1'&&m.text.startsWith('Shared incident coordination')).length,1,'fixture must prove the ambiguous side effect occurred before SIGKILL');
    await f.send('group-1','work traces active Accepted after restart; comparing the same affected auction IDs.');await f.publish();
    assert.ok(!(await f.r.coordination.snapshot(checkpoint.incidentId)).issues.some(issue=>issue.code==='unaccepted-handoff'));
  } finally {if(child?.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await f?.r.close();await rm(dir,{recursive:true,force:true});}
});

test('two Teams group chats share one durable issue context and both receive attributed progress and answers',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();f.sent.length=0;
    await f.send('group-0','Alex is checking bid ordering; next check is the accepted winning bid.',{mentioned:false});
    await f.send('group-1','Sam restarted the pool once; errors remain and credit traces are next.',{mentioned:false});
    await f.publish();
    assert.deepEqual(new Set(f.sent.map(m=>m.room)),new Set(['group-0','group-1']));
    assert.ok(f.sent.every(m=>m.text.includes('Alex')&&m.text.includes('Sam')&&m.text.includes('errors remain')&&m.text.includes('unverified')));
    const count=f.sent.length;await f.r.coordination.runOnce();await f.drain();assert.equal(f.sent.length,count,'unchanged coordination must remain quiet');
    const before=await f.r.store.context(id);await f.send('group-0','status');await f.r.worker.runOnce();await f.drain();
    assert.equal((await f.r.store.context(id)).session.agent_id,before.session.agent_id);
    assert.deepEqual(new Set(f.sent.filter(m=>m.text.includes('Outage outlook')).map(m=>m.room)),new Set(['group-0','group-1']));
    assert.ok(!f.sent.some(m=>m.room==='private-group'));assert.equal((await f.r.store.context(id)).collaboration.rooms.length,2);
  } finally {await f.r.close();}
});

test('aging a ruled-out theory or released work does not create another unread briefing',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);
    await f.send('group-0','theory ci ruled-out No hosted CI job ran; this is not the application fault.');
    await f.send('group-0','work traces released Sam will accept the matched trace investigation.');
    const inactiveAt=f.now;f.now+=240000;
    await f.send('group-1','work traces active Accepted; collecting matched traces.');
    for(const room of ['group-0','group-1'])await f.send(room,'report investigating Current business-impact report; the incident is open.');
    await f.publish();const generation=(await f.r.coordination.snapshot(id)).briefingGeneration;
    for(const room of ['group-0','group-1'])await f.send(room,'ack '+generation);
    await f.drain();f.sent.length=0;
    f.now=inactiveAt+301000;await f.r.coordination.runOnce();await f.drain();
    const view=await f.r.coordination.snapshot(id);
    assert.equal(view.briefingGeneration,generation,'an inactive item becoming old must not request another acknowledgement');
    assert.equal(f.sent.filter(x=>x.text.startsWith('Shared incident coordination')).length,0);
    const historical=view.rooms.find(room=>room.conversationId==='group-0');
    assert.equal(historical.theories[0].stale,true,'historical age remains inspectable');
    assert.equal(historical.work[0].stale,true,'released work is retained with its timestamp');
    // Active work and current service reports still age and prompt a fresh round.
    f.now+=301000;await f.r.coordination.runOnce();await f.drain();
    const overdue=await f.r.coordination.snapshot(id);
    assert.ok(overdue.briefingGeneration>generation);
    assert.ok(overdue.issues.some(x=>x.code==='stale-team-state'));
    assert.ok(overdue.issues.some(x=>x.code==='stale-work'));
  } finally {await f.r.close();}
});

test('explicit contradictory reports trigger a common-bridge recommendation without granting recovery or approval',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();f.sent.length=0;
    await f.send('group-0','report recovered Alex says bidding recovered; verify accepted bids next.');
    await f.send('group-1','report mitigating Sam still sees rejected bids; credit traces are next.');
    await f.send('group-1','sync');await f.drain();
    const c=await f.r.store.context(id);assert.equal(c.incident.status,'open');assert.equal(c.collaboration.issues.length,2);
    assert.ok(c.collaboration.issues.some(issue=>issue.code==='reported-state-disagreement'));
    const briefings=f.sent.filter(m=>m.text.startsWith('Shared incident coordination'));
    assert.equal(briefings.length,2);assert.ok(briefings.every(m=>m.text.includes('different service states')&&m.text.includes('one shared incident thread or bridge')&&m.text.includes('not independently verified')));
    assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    const prior=(await f.r.store.snapshot()).outbox.length;
    assert.equal(await f.r.coordination.publish(id,{requestId:'stable-sync-fixture'}),true);
    assert.equal(await f.r.coordination.publish(id,{requestId:'stable-sync-fixture'}),false);
    assert.equal((await f.r.store.snapshot()).outbox.length,prior+2);
    await f.send('group-0','report mitigating Correction: Alex still sees stale winners; prior recovery claim was premature.');
    assert.ok(!(await f.r.coordination.snapshot(id)).issues.some(issue=>issue.code==='reported-state-disagreement'));
  } finally {await f.r.close();}
});

test('a correction at the same source millisecond wins by durable receipt order',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);const at=f.now;
    await f.send('group-0','report recovered First report.',{at});
    await f.send('group-0','report blocked Correction: the problem still exists.',{at});
    const view=await f.r.coordination.snapshot(id);assert.equal(view.rooms.find(room=>room.conversationId==='group-0').reportedStatus,'blocked');
    assert.match(view.rooms.find(room=>room.conversationId==='group-0').reports[0].text,/Correction/);
  } finally {await f.r.close();}
});

test('a busy room cannot evict quieter teams from either durable selection or bounded model context',async()=>{
  const f=await fixture({count:8});try {
    const id=await f.incident();await f.join(id,Array.from({length:8},(_,i)=>'group-'+i));
    for(let i=1;i<8;i++)await f.send('group-'+i,'Quiet group '+i+' owns its dependency check.',{mentioned:false});
    for(let i=0;i<65;i++)await f.send('group-0','Busy '+i+' '+('中文🚦\\"'.repeat(350)),{mentioned:false});
    const c=await f.r.store.context(id),view=boundedContext(c);
    for(let i=1;i<8;i++) {
      const quiet=c.evidence.find(e=>e.content.text==='Quiet group '+i+' owns its dependency check.');assert.ok(quiet,'quiet room missing from durable context '+i);assert.ok(view.evidence.some(e=>e.id===quiet.id),'quiet room missing from model view '+i);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(view),'utf8')<=modelContextLimits.totalBytes);
    assert.equal(c.collaboration.rooms.length,8);assert.ok(view.coverage.truncatedEvidence>0);
    assert.equal(c.responderContext.totalAvailable,72);
  } finally {await f.r.close();}
});

test('a third sharing scope, foreign tenant and unlinked group cannot consume another group’s context',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.send('group-0','Private work marker belongs to the approved bridge.',{mentioned:false});
    await f.send('private-group','join '+id);await f.send('private-group','investigate '+id+' Show all reports.');await f.drain();
    const unrelated=f.sent.filter(m=>m.room==='private-group');assert.ok(unrelated.length);assert.ok(unrelated.every(m=>!m.text.includes('Private work marker')));assert.ok(unrelated.some(m=>m.text.includes('different sharing group')));
    assert.equal((await f.r.coordination.snapshot(id)).rooms.length,2);
    assert.equal((await f.send('private-group','Background capture must not start.',{mentioned:false})).receipt.ignored,true);
    const outsider=devActivity('join '+id,f.c.services[0],{conversationType:'groupChat',conversationId:'group-0'});outsider.activity.channelData.tenant.id='other-tenant';
    await assert.rejects(()=>f.r.router.accept(outsider.activity,outsider.reference),/tenant/);
  } finally {await f.r.close();}
});

test('groups following different incidents are prompted to check identity without merging their reports',async()=>{
  const f=await fixture();try {
    const a=await f.incident('a'),b=await f.incident('b');await f.join(a,['group-0']);await f.join(b,['group-1']);
    await f.send('group-0','Only incident A has this work marker.',{mentioned:false});await f.send('group-1','sync');await f.drain();
    const reply=f.sent.filter(m=>m.room==='group-1').find(m=>m.text.includes('Connection check:'));
    assert.ok(reply);assert.match(reply.text,/different incident/);assert.ok(!reply.text.includes('Only incident A'));
    assert.ok(!(await f.r.store.context(b)).evidence.some(e=>e.content.text==='Only incident A has this work marker.'));
    assert.notEqual((await f.r.store.context(a)).session.agent_id,(await f.r.store.context(b)).session.agent_id);
  } finally {await f.r.close();}
});

test('room context and queued per-room briefings survive SQLite restart without duplicate publication',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sre-coordination-reopen-'));let f;
  try {
    const path=join(dir,'db.sqlite');f=await fixture({path});const id=await f.incident();await f.join(id);await f.drain();
    await f.send('group-0','report investigating Alex owns bid ordering.');await f.send('group-1','report blocked Sam awaits credit logs.');
    await f.r.coordination.runOnce();const identity=(await f.r.store.context(id)).session.agent_id;const pending=(await f.r.store.snapshot()).outbox.filter(m=>m.id.startsWith('coordination:')).length;
    const resumeAt=f.now+1000;await f.r.close();f=await fixture({path});f.now=Math.max(f.now,resumeAt);await f.r.coordination.runOnce();await f.drain();
    assert.equal((await f.r.store.context(id)).session.agent_id,identity);assert.equal((await f.r.coordination.snapshot(id)).rooms.length,2);
    assert.equal((await f.r.store.snapshot()).outbox.filter(m=>m.id.startsWith('coordination:')).length,pending);
    assert.equal(f.sent.filter(m=>m.text.startsWith('Shared incident coordination')).length,2);
  } finally {await f?.r.close();await rm(dir,{recursive:true,force:true});}
});

test('leave and uninstall stop updates without losing the other team or resurrecting a removed installation',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();await f.send('group-0','report investigating Alex checks bids.');await f.r.coordination.runOnce();
    await f.send('group-1','leave');await f.drain();
    assert.ok(!f.sent.some(m=>m.room==='group-1'&&m.text.startsWith('Shared incident coordination')));
    assert.equal((await f.r.coordination.snapshot(id)).rooms.length,1);await f.r.coordination.runOnce();
    await f.send('group-1','join '+id);await f.publish();assert.ok(f.sent.some(m=>m.room==='group-1'&&m.text.startsWith('Shared incident coordination')));
    await f.r.store.db.query('UPDATE sre_conversations SET enabled=0 WHERE id=?',[conversationKey('synthetic','group-1')]);
    assert.equal((await f.send('group-1','status')).receipt.ignored,true);
    const [row]=await f.r.store.db.query('SELECT enabled FROM sre_conversations WHERE id=?',[conversationKey('synthetic','group-1')]);assert.equal(row.enabled,0);
    const view=await f.r.coordination.snapshot(id);assert.equal(view.rooms.length,1);assert.equal(view.rooms[0].conversationId,'group-0');
  } finally {await f.r.close();}
});

for(const failure of ['unknown','forbidden'])test('one '+failure+' Teams delivery does not suppress the other group or replay an uncertain send',async()=>{
  const sent=[];let fail=false;
  const f=await fixture({sender:{send:async(ref,text)=>{if(fail&&ref.conversation.id==='group-0')throw Object.assign(new Error('Synthetic delivery fault'),failure==='forbidden'?{status:403}:{});sent.push({room:ref.conversation.id,text});return {id:'local-'+sent.length};}}});
  try {
    const id=await f.incident();await f.join(id);await f.drain();sent.length=0;fail=true;
    await f.send('group-1','report investigating Sam checks the dependency.');await f.r.coordination.runOnce();await f.drain();
    assert.ok(sent.some(m=>m.room==='group-1'&&m.text.startsWith('Shared incident coordination')));
    const [failed]=await f.r.store.db.query("SELECT status FROM sre_outbox WHERE id LIKE 'coordination:%' AND conversation_key=?",[conversationKey('synthetic','group-0')]);assert.equal(failed.status,failure==='unknown'?'unknown':'failed');
    const before=sent.length;await f.drain();assert.equal(sent.length,before);
  } finally {await f.r.close();}
});

test('rollback approval stays in its original room while action status reaches both groups',async()=>{
  const f=await fixture();try {
    const id=(await seedDemo(f.r.store,f.c.services[0])).incidentId;await f.join(id);await f.r.worker.runOnce();await f.drain();
    await f.send('group-0','rollback '+id,{userId:'local-operator'});await f.drain();
    const proposal=(await f.r.store.snapshot()).rollbacks[0];assert.ok(proposal,'recent fixture should produce a proposal');
    const approval=proposal.proposal.approvalText.match(/^An authorized approver must send: (approve .+)$/m)[1];
    await f.send('group-1',approval,{userId:'local-operator'});await f.drain();assert.equal((await f.r.store.snapshot()).rollbacks[0].status,'pending');
    assert.ok(f.sent.some(m=>m.room==='group-1'&&m.text.includes('conversation where the proposal was requested')));
    await f.send('group-0',approval,{userId:'local-operator'});await f.r.rollbacks.executeNext();await f.publish();
    assert.equal((await f.r.store.snapshot()).rollbacks[0].status,'simulated');assert.equal((await f.r.store.context(id)).incident.status,'open');
    assert.ok(f.sent.some(m=>m.room==='group-1'&&m.text.includes('Rollback simulated')));
    assert.ok(!f.sent.some(m=>m.room==='group-1'&&m.text.includes(approval)),'the approval capability must not be relayed to another room');
  } finally {await f.r.close();}
});

test('two teams approving separate proposals for the same incident cannot repeat a simulated rollback',async()=>{
  const f=await fixture();try {
    const id=(await seedDemo(f.r.store,f.c.services[0])).incidentId;await f.join(id);await f.r.worker.runOnce();await f.drain();
    for(const room of ['group-0','group-1'])await f.send(room,'rollback '+id,{userId:'local-operator'});
    const proposals=(await f.r.store.snapshot()).rollbacks.filter(row=>row.incident_id===id);assert.equal(proposals.length,2);
    for(const proposal of proposals) {
      const command=proposal.proposal.approvalText.match(/^An authorized approver must send: (approve .+)$/m)[1];
      await f.send(proposal.proposal.conversationId,command,{userId:'local-operator'});
    }
    await f.r.rollbacks.executeNext();await f.r.rollbacks.executeNext();await f.drain();
    const actions=(await f.r.store.snapshot()).rollbacks.filter(row=>row.incident_id===id);
    assert.equal(actions.filter(row=>row.status==='simulated').length,1);
    assert.equal(actions.filter(row=>row.status==='blocked').length,1);
    assert.equal((await f.r.store.context(id)).incident.status,'open');
    assert.ok(f.sent.some(m=>m.room==='group-0'&&m.text.includes('already ran')));assert.ok(f.sent.some(m=>m.room==='group-1'&&m.text.includes('already ran')));
    await f.send('group-1','rollback '+id,{userId:'local-operator'});assert.equal((await f.r.store.snapshot()).rollbacks.filter(row=>row.incident_id===id).length,2);
  } finally {await f.r.close();}
});

test('coordination delivery rechecks a changed sharing policy instead of leaking a queued report',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();await f.r.coordination.runOnce();f.sent.length=0;
    f.c.services[0].teams.collaborationGroups[0].conversations=f.c.services[0].teams.collaborationGroups[0].conversations.filter(room=>room.id!=='group-1');
    await f.drain();assert.ok(!f.sent.some(m=>m.room==='group-1'));
    const [discarded]=await f.r.store.db.query("SELECT status FROM sre_outbox WHERE id LIKE 'coordination:%' AND conversation_key=?",[conversationKey('synthetic','group-1')]);assert.equal(discarded.status,'discarded');
  } finally {await f.r.close();}
});

test('configuration rejects overlapping sharing groups and unallowlisted conversations',()=>{
  const c=configuration();c.services[0].teams.collaborationGroups.push(structuredClone(c.services[0].teams.collaborationGroups[0]));c.services[0].teams.collaborationGroups[1].key='other';
  assert.throws(()=>validateConfig(c,{}),/distinct allowlisted/);
  const missing=configuration();missing.services[0].teams.collaborationGroups[0].conversations[0].id='not-allowed';assert.throws(()=>validateConfig(missing,{}),/allowlisted/);
});

test('concurrent coordination ticks deduplicate and an interrupted multi-room enqueue rolls back as one unit',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();
    const queue=f.r.store.queueMessage.bind(f.r.store);let calls=0;
    f.r.store.queueMessage=async(...args)=>{if(++calls===2)throw Error('Synthetic failure before second room');return queue(...args);};
    await assert.rejects(()=>f.r.coordination.publish(id),/Synthetic failure/);
    assert.equal((await f.r.store.snapshot()).outbox.filter(m=>m.id.startsWith('coordination:')).length,0);
    assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_coordination_receipts'))[0].count),0,'recipient receipts must roll back with their outbox entries');
    f.r.store.queueMessage=queue;
    const results=await Promise.all([f.r.coordination.publish(id),f.r.coordination.publish(id)]);assert.equal(results.filter(Boolean).length,1);
    assert.equal((await f.r.store.snapshot()).outbox.filter(m=>m.id.startsWith('coordination:')).length,2);
  } finally {await f.r.close();}
});

test('a ninth incident conversation is directed to a common thread without creating another binding',async()=>{
  const f=await fixture();try {
    const id=await f.incident();for(let i=0;i<9;i++)await f.send('group-0','join '+id,{thread:String(i)});
    assert.equal((await f.r.coordination.snapshot(id)).rooms.length,8);
    assert.ok((await f.r.store.snapshot()).outbox.some(m=>m.text.includes('Eight conversations already follow')));
  } finally {await f.r.close();}
});

test('an attempted conflicting group-chat join cannot pin the new incident’s sharing audience',async()=>{
  const f=await fixture();try {
    const a=await f.incident('a'),b=await f.incident('b');await f.join(a,['group-0']);await f.send('group-0','join '+b);
    const [audience]=await f.r.store.db.query('SELECT * FROM sre_incident_audiences WHERE incident_id=?',[b]);assert.equal(audience,undefined);
    const [room]=await f.r.store.db.query('SELECT incident_id FROM sre_conversations WHERE id=?',[conversationKey('synthetic','group-0')]);assert.equal(room.incident_id,a);
  } finally {await f.r.close();}
});

test('database restore holds shared briefings and releasing the hold starts a fresh coordination round',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.drain();await f.r.coordination.runOnce();await f.drain();f.sent.length=0;
    const input={restoreId:'coordination-restore',backupSha256:'a'.repeat(64),backupAt:f.now-1000,reason:'Synthetic restore rehearsal',actor:{kind:'local-operator',id:'fixture'},offline:true};
    await prepareRestore(f.r.store,input);await f.r.coordination.runOnce();await f.drain();assert.equal(f.sent.length,0);
    await releaseRestore(f.r.store,{restoreId:input.restoreId,requestId:'release',reason:'External state reconciled in the local fixture',actor:input.actor,observedAt:f.now,evidenceUrls:['https://fictional.invalid/review']});
    await f.r.coordination.runOnce();await f.drain();assert.equal(f.sent.filter(m=>m.text.startsWith('Shared incident coordination')).length,2);
    assert.equal((await f.r.store.context(id)).incident.status,'open');
  } finally {await f.r.close();}
});

test('bounded coordination metadata flags omitted source reports instead of offering invalid citation IDs',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);const c=await f.r.store.context(id);
    c.collaboration.rooms[0].statusEvidenceId='not-in-this-evidence-window';c.collaboration.rooms[0].reports=[{evidenceId:'also-omitted',author:'Sam',text:'An old report.',verified:false}];
    const view=boundedContext(c),room=view.collaboration.rooms[0];assert.equal(room.statusEvidenceId,undefined);assert.equal(room.statusEvidenceOmitted,true);assert.equal(room.reports[0].evidenceId,undefined);assert.equal(room.reports[0].evidenceOmitted,true);
    assert.equal(c.collaboration.rooms[0].statusEvidenceId,'not-in-this-evidence-window','transport shaping must not mutate the stored context');
  } finally {await f.r.close();}
});

test('a newly joined team receives the first team’s retained work without importing hidden chat history',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id,['group-0']);await f.send('group-0','Alex already restarted the bidder once; it did not fix accepted-bid ordering.',{mentioned:false});
    await f.r.coordination.runOnce();await f.drain();f.sent.length=0;
    await f.join(id,['group-1']);await f.r.coordination.runOnce();await f.drain();
    assert.ok(f.sent.some(m=>m.room==='group-1'&&m.text.startsWith('Shared incident coordination')&&m.text.includes('already restarted')&&m.text.includes('did not fix')));
    assert.equal((await f.r.store.context(id)).responderContext.totalAvailable,1);assert.equal((await f.r.coordination.snapshot(id)).rooms.find(room=>room.conversationId==='group-1').reports.length,0);
  } finally {await f.r.close();}
});

test('a burst of report changes coalesces while a silent peer is never presented as agreeing',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);await f.r.coordination.runOnce();await f.drain();f.sent.length=0;
    for(let i=0;i<8;i++)await f.send('group-0','Bidding progress '+i,{mentioned:false});
    await f.r.coordination.runOnce();await f.drain();assert.equal(f.sent.filter(m=>m.text.startsWith('Shared incident coordination')).length,0);
    await f.publish();const briefings=f.sent.filter(m=>m.text.startsWith('Shared incident coordination'));assert.equal(briefings.length,2);
    assert.ok(briefings.every(m=>m.text.includes('Bidding progress 7')&&m.text.includes('No delivered report yet')&&m.text.includes('silence does not mean agreement')));
  } finally {await f.r.close();}
});

test('mention-only groups can coordinate explicit reports without claiming access to background messages',async()=>{
  const f=await fixture();try {
    f.c.services[0].teams.captureResponderUpdates=false;const id=await f.incident();await f.join(id);
    assert.equal((await f.send('group-0','report recovered Background claim must not be consumed.',{mentioned:false})).receipt.ignored,true);
    await f.send('group-0','report mitigating Alex checks accepted bids.');await f.publish();
    const view=await f.r.coordination.snapshot(id);assert.equal(view.rooms.find(room=>room.conversationId==='group-0').reportedStatus,'mitigating');assert.equal(view.rooms.find(room=>room.conversationId==='group-1').reportedStatus,null);
    assert.ok(f.sent.some(m=>m.room==='group-1'&&m.text.includes('Alex checks accepted bids')));assert.ok(!f.sent.some(m=>m.text.includes('Background claim must not be consumed')));
  } finally {await f.r.close();}
});

test('coordination scanning reaches active incidents beyond its first 100-item batch',async()=>{
  const f=await fixture();try {
    for(let i=0;i<101;i++) {
      const id=await f.incident('batch-'+i);
      await f.send('group-0','join '+id,{thread:String(i)});await f.send('group-1','join '+id,{thread:String(i)});
    }
    await f.r.coordination.runOnce();await f.r.coordination.runOnce();
    const [row]=await f.r.store.db.query("SELECT COUNT(DISTINCT incident_id) AS count FROM sre_outbox WHERE id LIKE 'coordination:%'");assert.equal(Number(row.count),101);
  } finally {await f.r.close();}
});

test('a queued passive report is discarded when its sharing membership is revoked before processing',async()=>{
  const f=await fixture();try {
    const id=await f.incident();await f.join(id);
    const sample=devActivity('A revoked report must not enter shared context.',f.c.services[0],{conversationId:'group-1',conversationType:'groupChat',mentioned:false,id:'queued-before-policy-change'});sample.activity.timestamp=new Date(f.now).toISOString();
    const receipt=await f.r.router.accept(sample.activity,sample.reference);
    f.c.services[0].teams.collaborationGroups[0].conversations[1]={id:'private-group',name:'New approved responders'};
    await assert.doesNotReject(()=>f.r.router.processOnce());
    const [row]=await f.r.store.db.query('SELECT status FROM sre_commands WHERE id=?',[receipt.eventId]);assert.equal(row.status,'discarded');assert.ok(!(await f.r.store.context(id)).evidence.some(e=>e.content.text==='A revoked report must not enter shared context.'));
  } finally {await f.r.close();}
});

test('actual Teams SDK group-chat transport delivers the same coordination briefing to both chats',async()=>{
  const f=await fixture(),delivered=[];
  const transport=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;delivered.push({path:decodeURIComponent(req.url),body:JSON.parse(raw)});res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'receipt-'+delivered.length}));});
  transport.listen(0,'127.0.0.1');await once(transport,'listening');
  const serviceUrl='http://127.0.0.1:'+transport.address().port,bridge=await startSreTeams({router:f.r.router,store:f.r.store,mode:'playground',env:{},port:0});
  try {
    f.r.outbox.sender=bridge.sender;const id=await f.incident();
    for(const [room,text] of [['group-0','join '+id],['group-1','join '+id],['group-0','report recovered Alex sees healthy bids.'],['group-1','report blocked Sam still sees errors.']]) {
      const sample=devActivity(text,f.c.services[0],{conversationType:'groupChat',conversationId:room,id:String(++f.sequence),serviceUrl,userId:room==='group-0'?'alex':'sam',displayName:room==='group-0'?'Alex':'Sam'});sample.activity.timestamp=new Date(f.now).toISOString();
      const response=await fetch('http://127.0.0.1:'+bridge.server.address().port+'/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(sample.activity)});assert.equal(response.status,200);await f.r.router.processOnce();
    }
    await f.r.coordination.runOnce();await f.drain();
    const briefings=delivered.filter(message=>message.body.text.startsWith('Shared incident coordination'));
    assert.equal(briefings.length,2);assert.ok(briefings.some(m=>m.path.includes('group-0')));assert.ok(briefings.some(m=>m.path.includes('group-1')));assert.ok(briefings.every(m=>m.body.text.includes('different service states')));
  } finally {await bridge.close();transport.closeAllConnections();await new Promise(resolve=>transport.close(resolve));await f.r.close();}
});

for(const dialect of ['sqlite','postgres'])test(dialect+': responder-chosen room names stay scoped and survive new references and restart',async()=>{
  const directory=dialect==='sqlite'?await mkdtemp(join(tmpdir(),'sre-room-name-')):null;
  const path=directory?join(directory,'agent.sqlite'):':memory:';
  const pg=dialect==='postgres'?new PGlite():null;
  const db=pg?{dialect:'postgres',query:async(sql,args=[]) =>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[]) =>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
  let f=await fixture({path,db});
  try {
    const id=await f.incident();await f.join(id);
    await f.send('group-1','name EU Platform responders');
    await f.send('group-1','update A new authenticated activity replaces the native reference.');
    await f.send('private-group','name Private triage');
    let view=await f.r.coordination.snapshot(id);
    assert.equal(view.rooms.find(room=>room.conversationId==='group-1').name,'EU Platform responders');
    assert.equal(view.rooms.find(room=>room.conversationId==='group-0').name,'Bidding responders');
    assert.ok(!view.rooms.some(room=>room.name==='Private triage'));
    await f.send('group-1','name Bad\nLabel');
    await assert.rejects(()=>f.r.store.setConversationName({id:conversationKey('synthetic','group-1'),tenant:'foreign',serviceKey:'auction-local',name:'Foreign label'}),/authorized service and tenant/);
    if(dialect==='sqlite'){await f.r.close();f=await fixture({path});}
    view=await f.r.coordination.snapshot(id);
    assert.equal(view.rooms.find(room=>room.conversationId==='group-1').name,'EU Platform responders');
    await f.r.coordination.publish(id,{requestId:'readable-room-name'});await f.drain();
    const copies=f.sent.filter(item=>item.text.startsWith('Shared incident coordination'));
    assert.equal(copies.length,2);assert.ok(copies.every(item=>item.text.includes('EU Platform responders')));
    assert.equal(view.rooms.length,2);
  } finally {await f.r.close();if(directory)await rm(directory,{recursive:true,force:true});}
});

test('fair context, audience fencing and atomic per-room publication execute against PostgreSQL in PGlite',async()=>{
  const pg=new PGlite(),db={dialect:'postgres',query:async(sql,args=[]) =>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[]) =>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
  const f=await fixture({db});try {
    const id=await f.incident();await f.join(id);await f.send('group-0','report recovered Alex reports recovery.');await f.send('group-1','report mitigating Sam reports errors.');
    await f.r.coordination.runOnce();await f.drain();assert.equal(f.sent.filter(m=>m.text.startsWith('Shared incident coordination')).length,2);
    assert.equal((await f.r.store.context(id)).collaboration.issues.length,2);await f.r.coordination.runOnce();
    assert.equal((await f.r.store.snapshot()).outbox.filter(m=>m.id.startsWith('coordination:')).length,2);
    await f.send('group-0','theory ordering supported Reproduced the same accepted-bid failure.');
    await f.send('group-1','theory ordering ruled-out Smoke test passed for a possibly different scope.');
    await f.send('group-0','work traces active Compare affected auction traces.');await f.send('group-1','work traces active Also checking the same trace scope.');
    assert.ok((await f.r.coordination.snapshot(id)).issues.some(issue=>issue.code==='theory-disagreement'));
    assert.ok((await f.r.coordination.snapshot(id)).issues.some(issue=>issue.code==='overlapping-work'));
    await f.r.coordination.publish(id,{requestId:'postgres-ledger-round'});await f.drain();
    const version=(await f.r.coordination.snapshot(id)).briefingGeneration;
    await f.send('group-0','ack '+version);await f.drain();
    assert.equal((await f.r.coordination.snapshot(id)).rooms.find(room=>room.conversationId==='group-0').briefing.acknowledged,true);
    await prepareRestore(f.r.store,{restoreId:'pg-ledger-restore',backupSha256:'a'.repeat(64),backupAt:Date.now()-1000,reason:'Exercise the new ledger and receipt locks',actor:{kind:'local-operator',id:'fixture-operator'},offline:true});
    await assert.rejects(()=>f.r.coordination.acknowledge(id,conversationKey('synthetic','group-1'),version,{userId:'sam'}),/restore reconciliation/);
  } finally {await f.r.close();}
});
