import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {postgresSql,StorageError} from '../src/sre/database.mjs';
import {normalizeAlert} from '../src/sre/alert-intake.mjs';
import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';
import {seedPilot,pilotDiff,pilotPolicySource} from '../scripts/seed-pilot.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {hash} from '../src/sre/security.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

async function fixture(dialect='sqlite',{path=':memory:',pgPath,seed=true}={}){
  const profile=rehearsalProfile();profile.services[0].alerts={enabled:false,providers:['datadog','dynatrace']};const config=validateConfig(profile,{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-alert-handoff-cli'}),service=config.services[0];
  assert.equal(config.sqlitePath,path,'Unit fixtures must never open the default workspace database');assert.notEqual(path,'.local/sre.sqlite');
  const pg=dialect==='postgres'?new PGlite(pgPath):null,db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
  let executions=0;const sent=[],r=await createSreRuntime({config,db,autoStart:false,qaAdapter:{localOnly:true,execute:async()=>{executions++;return {status:'passed',summary:'Fixture only'};}},sender:{send:async(ref,text)=>{sent.push({conversationId:ref.conversation.id,text});return {id:'alert-fixture:'+sent.length,simulation:true};}}});
  const now=(await r.store.coordinationNow())-1000;let sequence=0;const manifest=seedPilot(),base=manifest.baseline,head=manifest.releases['bid-race'].sha;
  if(seed){for(const [i,sha] of [base,head].entries())await r.store.ingest({id:'release-'+i,source:'releases',serviceKey:service.key,kind:'deployment',at:now-(i?300000:900000),payload:{provider:'gitlab',environment:service.environment,sha,status:'success',artifact:'sha256:'+hash(sha),healthy:!i,healthVerifiedAt:!i?now-870000:null,rollbackCompatible:true,dataRollbackSafe:true,schemaVersion:1,dependencyFingerprint:'fixture',configurationFingerprint:'fixture',featureFlagsFingerprint:'fixture'}});
  for(const root of service.teams.conversations){const sample=devActivity('help',service,{conversationId:root,conversationType:'channel'});await r.store.rememberConversation({tenant:service.teams.tenantId,serviceKey:service.key,reference:sample.reference});}}
  const f={r,service,now,base,head,sent,executions:()=>executions};
  f.alert=async({alertId='bids',groupKey='eu-bids',provider='datadog',status='OPEN',at=now,metrics={codes:['WINNING_BID_REGRESSED'],requests:3},thread='1000000000001',channel=service.teams.conversations[0],deliveryId='fixture-alert:'+ ++sequence,...rest}={})=>r.store.ingest(normalizeAlert({provider,alertId,groupKey,status,service:service.key,environment:service.environment,title:'Fictional workflow alert',startedAt:now-60000,observedAt:at,metrics,thread:{tenantId:service.teams.tenantId,channelId:channel,messageId:thread},...rest},service,deliveryId));
  f.proof=async id=>r.store.ingest({id:'code:'+id,source:'gitlab',serviceKey:service.key,kind:'change',incidentId:id,at:now,payload:{provider:'gitlab',comparisonKind:'deployment',baseSha:base,headSha:head,sha:head,complete:true,unrecognizedPaths:[],diff:pilotDiff(head),policySources:{path:'src/auction/rules.mjs',complete:true,base:pilotPolicySource(base),head:pilotPolicySource(head)}}});
  f.settle=async()=>{for(let i=0;i<100;i++){const [row]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.count))return;await r.worker.runOnce();}throw Error('Alert fixture did not settle');};
  f.drain=async()=>{for(let i=0;i<100&&await r.outbox.runOnce();i++);};
  f.principal=(thread='1000000000001')=>({verified:true,simulation:true,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0]+';messageid='+thread,userId:'local-operator'});
  f.key=(thread='1000000000002')=>conversationKey(service.teams.tenantId,service.teams.conversations[0]+';messageid='+thread);
  f.reply=async(id,thread='1000000000002')=>{const [row]=await r.store.db.query('SELECT * FROM sre_checkpoints WHERE id=?',['alert-thread-reply:'+hash([id,f.key(thread)])]);return row?{...row,value:JSON.parse(row.value)}:null;};
  f.exhaust=async()=>{const job=await r.store.claim(r.worker.owner);assert.ok(job);await r.store.fail(job,Error('Fictional evidence outage'),1);await r.store.release(r.worker.owner);return job;};
  return f;
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': a direct answer in one group also fulfils another alert thread without repeating unchanged peer notices',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();f.sent.length=0;await f.alert({thread:'1000000000002'});await f.exhaust();await f.drain();
      await f.r.store.ingest({id:'asking-team',source:'operator-api',serviceKey:f.service.key,kind:'question',incidentId:id,conversationKey:f.key('1000000000001'),at:f.now+10,payload:{text:'What evidence should we check before changing anything?'}});await f.settle();await f.drain();
      assert.equal(f.sent.filter(m=>m.conversationId.endsWith('1000000000002')&&m.text.includes('Change assessment:')).length,1);assert.equal(f.sent.filter(m=>m.conversationId.endsWith('1000000000001')&&m.text.includes('Change assessment:')).length,1);
      const reply=await f.reply(id);assert.equal(reply.value.status,'queued');const [outbox]=await f.r.store.db.query('SELECT * FROM sre_outbox WHERE id=?',[reply.value.outboxId]);assert.equal(outbox.conversation_key,f.key());assert.equal(outbox.status,'simulated');assert.equal((await f.r.store.snapshot()).rollbacks.length,0);assert.equal(f.executions(),0);
    }finally{await f.r.close();}
  });
  test(dialect+': an uncertain alert reply remains a single retained delivery rather than replaying with the next assessment',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();await f.alert({thread:'1000000000002'});await f.drain();
      let posts=0;f.r.outbox.sender.send=async(ref,text)=>{if(ref.conversation.id.endsWith('1000000000002')&&text.includes('Change assessment:')){posts++;throw Error('Fictional connection lost after request');}return{id:'other-fixture',simulation:true};};
      await f.settle();await f.drain();const reply=await f.reply(id),[unknown]=await f.r.store.db.query('SELECT * FROM sre_outbox WHERE id=?',[reply.value.outboxId]);assert.equal(unknown.status,'unknown');assert.equal(posts,1);
      await f.alert({at:f.now+10});await f.settle();await f.drain();assert.equal(posts,1);assert.deepEqual(await f.reply(id),reply);assert.equal((await f.r.store.db.query('SELECT * FROM sre_outbox WHERE id=?',[unknown.id]))[0].status,'unknown');
    }finally{await f.r.close();}
  });
  test(dialect+': leaving cancels an unanswered alert promise and a manual rejoin cannot revive its old job destinations',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();await f.alert({thread:'1000000000002'});await f.drain();f.sent.length=0;assert.equal((await f.reply(id)).value.status,'pending');
      await f.r.store.unbindConversation(f.key(),id);assert.equal((await f.reply(id)).value.status,'cancelled');await f.r.store.bindConversation(f.key(),id);await f.settle();await f.drain();assert.equal(f.sent.filter(m=>m.text.includes('Change assessment:')).length,0);
      await f.r.store.unbindConversation(f.key(),id);await f.alert({thread:'1000000000002'});assert.equal((await f.reply(id)).value.status,'pending');await f.settle();await f.drain();assert.equal(f.sent.filter(m=>m.text.includes('Change assessment:')&&m.conversationId.endsWith('1000000000002')).length,1);
    }finally{await f.r.close();}
  });
  test(dialect+': uninstall cancels an unanswered alert promise across a later installation of the same bot',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();await f.alert({thread:'1000000000002'});await f.drain();f.sent.length=0;
      const sample=devActivity('help',f.service,{conversationId:f.service.teams.conversations[0],conversationType:'channel'});for(const [offset,enabled]of [[10,false],[20,true]])await f.r.router.installation({...sample.activity,id:'fictional-install-'+offset,timestamp:new Date(f.now+offset).toISOString()},sample.reference,enabled);
      assert.equal((await f.reply(id)).value.status,'cancelled');await f.settle();await f.drain();assert.equal(f.sent.filter(m=>m.text.includes('Change assessment:')).length,0);
    }finally{await f.r.close();}
  });
  test(dialect+': an alert reply and its fulfillment commit together; a failed receipt write leaves the promise pending',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();await f.alert({thread:'1000000000002'});await f.drain();const before=await f.r.store.db.query('SELECT * FROM sre_assessments ORDER BY id'),outbox=await f.r.store.db.query('SELECT * FROM sre_outbox ORDER BY id'),transaction=f.r.store.db.transaction;let injected=false;
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('UPDATE sre_checkpoints SET value=')&&String(args[2]).startsWith('alert-thread-reply:')){injected=true;throw Error('Fictional reply-receipt write failure');}return q(sql,args);}));
      assert.equal(await f.r.worker.runOnce(),false);f.r.store.db.transaction=transaction;assert.ok(injected);assert.equal((await f.reply(id)).value.status,'pending');assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_assessments ORDER BY id'),before);assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_outbox ORDER BY id'),outbox);
      await f.alert({at:f.now+10});await f.settle();await f.drain();assert.equal((await f.reply(id)).value.status,'queued');assert.equal(f.sent.filter(m=>m.conversationId.endsWith('1000000000002')&&m.text.includes('Change assessment:')).length,1);
    }finally{await f.r.close();}
  });
  test(dialect+': damaged alert reply provenance cannot publish an assessment, but cannot prevent leaving either',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();await f.alert({thread:'1000000000002'});await f.drain();const reply=await f.reply(id),before=await f.r.store.db.query('SELECT * FROM sre_assessments ORDER BY id');await f.r.store.db.query('UPDATE sre_checkpoints SET value=? WHERE id=?',[JSON.stringify({...reply.value,incidentId:'another-incident'}),reply.id]);
      assert.equal(await f.r.worker.runOnce(),false);assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_assessments ORDER BY id'),before);await f.r.store.unbindConversation(f.key(),id);assert.equal((await f.reply(id)).value.status,'cancelled');assert.equal(f.executions(),0);
    }finally{await f.r.close();}
  });
  test(dialect+': reply tracking survives database reopen, preserves the failed job and does not replay a queued reply',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'sre-alert-reply-')),options={path:join(directory,'agent.sqlite'),pgPath:join(directory,'postgres')};let f=await fixture(dialect,options);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();await f.alert({thread:'1000000000002'});await f.exhaust();await f.drain();const pending=await f.reply(id),events=await f.r.store.db.query('SELECT id,body_hash FROM sre_events ORDER BY id');await f.r.close();f=await fixture(dialect,{...options,seed:false});assert.deepEqual(await f.reply(id),pending);assert.deepEqual(await f.r.store.db.query('SELECT id,body_hash FROM sre_events ORDER BY id'),events);
      await f.alert({deliveryId:'after-reopen',at:f.now+10});await f.settle();await f.drain();assert.equal(f.sent.filter(m=>m.conversationId.endsWith('1000000000002')&&m.text.includes('Change assessment:')).length,1);const queued=await f.reply(id);assert.equal(queued.value.status,'queued');await f.r.close();f=await fixture(dialect,{...options,seed:false});assert.deepEqual(await f.reply(id),queued);await f.alert({deliveryId:'after-queued-reopen',at:f.now+20});await f.settle();await f.drain();assert.equal(f.sent.filter(m=>m.text.includes('Change assessment:')).length,0);assert.ok((await f.r.store.context(id)).jobs.some(j=>j.status==='dead'));
    }finally{await f.r.close();await rm(directory,{recursive:true,force:true});}
  });
  test(dialect+': a later unchanged assessment answers an alert thread whose original investigation exhausted retries',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();f.sent.length=0;
      await f.alert({thread:'1000000000002'});const failed=await f.r.store.claim(f.r.worker.owner);assert.ok(failed);await f.r.store.fail(failed,Error('Fictional evidence outage'),1);await f.r.store.release(f.r.worker.owner);await f.drain();
      assert.equal(f.sent.filter(m=>m.text.includes('Change assessment:')&&m.conversationId.endsWith('1000000000002')).length,0);
      await f.alert({at:f.now+10});await f.settle();await f.drain();
      const c=await f.r.store.context(id);assert.equal(c.assessmentStatus.state,'current');assert.equal(c.jobs.find(j=>j.id===failed.id).status,'dead','Preserve the failed attempt audit');
      assert.equal(f.sent.filter(m=>m.text.includes('Change assessment:')&&m.conversationId.endsWith('1000000000002')).length,1);
      assert.equal(f.sent.filter(m=>m.text.includes('Change assessment:')&&m.conversationId.endsWith('1000000000001')).length,0);
      await f.alert({at:f.now+20});await f.settle();await f.drain();assert.equal(f.sent.filter(m=>m.text.includes('Change assessment:')).length,1,'A fulfilled reply must not recur with unchanged evidence');
    }finally{await f.r.close();}
  });
  test(dialect+': grouped independent workflow monitors retain competing signals instead of selecting the latest monitor as cause',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);
      await f.alert({alertId:'credit',at:f.now+10,metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE'],requests:3},thread:'1000000000002'});await f.alert({at:f.now+20});await f.settle();
      const c=await f.r.store.context(id);assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.equal(c.incident.analysis.rollback.eligible,false);assert.match(c.incident.analysis.summary,/credit provider/i);assert.match(c.incident.analysis.summary,/higher bid/i);assert.equal(c.collaboration.rooms.length,2);
    }finally{await f.r.close();}
  });
  test(dialect+': a correction or closure affects its own monitor while another monitor retains its current signal',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.alert({alertId:'credit',at:f.now+10,metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}});
      await f.alert({at:f.now+20,metrics:{codes:[],requests:3}});await f.settle();let c=await f.r.store.context(id);assert.equal(c.incident.analysis.changeAssessment,'unlikely');assert.match(c.incident.analysis.summary,/credit provider/i);
      await f.alert({at:f.now+30});await f.alert({alertId:'credit',status:'CLOSED',at:f.now+40,metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}});await f.settle();c=await f.r.store.context(id);assert.equal(c.incident.status,'open');assert.equal(c.incident.analysis.changeAssessment,'likely');assert.match(c.incident.analysis.summary,/higher bid/i);
    }finally{await f.r.close();}
  });
  test(dialect+': conflicting metrics for the same monitor/source time remain unknown until a strictly newer snapshot arrives',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.alert({metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}});await f.settle();let c=await f.r.store.context(id);assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.ok(c.incident.analysis.unknowns.some(u=>/conflicting.*snapshot/i.test(u)));
      await f.alert({at:f.now+10});await f.settle();c=await f.r.store.context(id);assert.equal(c.incident.analysis.changeAssessment,'likely');
    }finally{await f.r.close();}
  });
  test(dialect+': repeated equivalent alert deliveries preserve the audit without invalidating a reviewed plan or queuing another investigation',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();const plan=await f.r.casework.createPlan(id),before=await f.r.store.context(id),key=conversationKey('synthetic',f.principal().conversationId),request=await f.r.casework.proposeFix(id,plan.id,f.principal(),key,'qa-proposal');
      for(let i=0;i<6;i++)await f.alert({metrics:{requests:3,codes:['WINNING_BID_REGRESSED']}});
      const c=await f.r.store.context(id);assert.equal(c.incident.revision,before.incident.revision);assert.equal(c.jobs.length,before.jobs.length);assert.equal((await f.r.casework.approveFix(request.id,request.nonce,f.principal(),key)).status,'approved');assert.equal((await f.r.store.db.query("SELECT COUNT(*) AS count FROM sre_events WHERE source='alerts'"))[0].count,7);
    }finally{await f.r.close();}
  });
  test(dialect+': a delayed alert links its original thread and answers from current context without reopening the closed source',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.alert({status:'CLOSED',at:f.now+20,metrics:{codes:[]}});await f.settle();await f.drain();const before=await f.r.store.context(id);
      const delayed=await f.alert({at:f.now-10,thread:'1000000000002',channel:f.service.teams.conversations[1]});assert.equal(delayed.stale,true);await f.settle();await f.drain();const c=await f.r.store.context(id);assert.equal(c.incident.status,before.incident.status);assert.equal(c.incident.revision,before.incident.revision);assert.equal(c.collaboration.rooms.length,2);assert.ok(f.sent.some(m=>m.conversationId.endsWith('1000000000002')&&m.text.includes(id)));
    }finally{await f.r.close();}
  });
  test(dialect+': another monitor invalidates pending or approved QA before execution even when the original monitor repeats',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();const plan=await f.r.casework.createPlan(id),key=conversationKey('synthetic',f.principal().conversationId),request=await f.r.casework.proposeFix(id,plan.id,f.principal(),key,'reviewed-code-fix');await f.r.casework.approveFix(request.id,request.nonce,f.principal(),key);
      await f.alert({alertId:'credit',at:f.now+10,metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}});await f.alert({at:f.now+20});await f.settle();await f.r.casework.runOnce();assert.equal(f.executions(),0);assert.equal((await f.r.casework.snapshot(id)).qa[0].status,'superseded');assert.equal((await f.r.casework.createPlan(id)).payload.patch,null);
    }finally{await f.r.close();}
  });
  test(dialect+': an equivalent observation in a new thread receives the current assessment without broadcasting it again to old recipients',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();f.sent.length=0;const before=await f.r.store.context(id);
      const receipt=await f.alert({thread:'1000000000002'});assert.equal(receipt.unchanged,true);await f.settle();await f.drain();const after=await f.r.store.context(id);assert.equal(after.incident.revision,before.incident.revision);
      assert.equal(f.sent.filter(m=>m.text.includes('Change assessment:')&&m.conversationId.endsWith('1000000000002')).length,1);assert.equal(f.sent.filter(m=>m.text.includes('Change assessment:')&&m.conversationId.endsWith('1000000000001')).length,0);
    }finally{await f.r.close();}
  });
  test(dialect+': stale alert thread admission still enforces the current sharing audience and rolls back an unauthorized destination',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.alert({status:'CLOSED',at:f.now+20});const before=(await f.r.store.snapshot()).counts;
      const group=f.service.teams.collaborationGroups[0];group.conversations=group.conversations.slice(0,3);f.service.teams.collaborationGroups.push({key:'private',name:'Fictional separate private audience',conversations:f.service.teams.conversations.slice(3).map(root=>({id:root,name:root}))});
      await assert.rejects(()=>f.alert({at:f.now-10,thread:'1000000000002',channel:f.service.teams.conversations[3]}),/different sharing group/);assert.deepEqual((await f.r.store.snapshot()).counts,before);assert.equal((await f.r.store.context(id)).collaboration.rooms.length,1);
    }finally{await f.r.close();}
  });
  test(dialect+': a monitor flood cannot hide a different open monitor and turn bounded evidence into a conclusive deployment claim',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.alert({alertId:'credit',at:f.now+1,metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}});
      for(let i=0;i<250;i++)await f.alert({at:f.now+10+i});await f.r.worker.runOnce();const c=await f.r.store.context(id);assert.equal(c.evidenceWindow.candidatesLimited,true);assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.ok(c.incident.analysis.unknowns.some(u=>/bounded source window/i.test(u)));assert.equal(c.incident.analysis.rollback.eligible,false);
    }finally{await f.r.close();}
  });
  test(dialect+': a required original-thread reply survives an unchanged monitor update committed during investigation',async()=>{
    const f=await fixture(dialect);let release;try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();f.sent.length=0;await f.alert({thread:'1000000000002'});
      let entered;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),investigate=f.r.worker.reasoner.investigate.bind(f.r.worker.reasoner);let held=false;
      f.r.worker.reasoner.investigate=async(...args)=>{if(!held){held=true;entered();await gate;}return investigate(...args);};
      const pending=f.r.worker.runOnce();await reached;await f.alert({at:f.now+10});release();await pending;f.r.worker.reasoner.investigate=investigate;await f.settle();await f.drain();
      assert.equal(f.sent.filter(m=>m.conversationId.endsWith('1000000000002')&&m.text.includes('Change assessment:')).length,1);assert.equal((await f.r.store.context(id)).incident.status,'open');
    }finally{release?.();await f.r.close();}
  });
  test(dialect+': equivalent code and violation sets in a repeated observation do not create a new incident revision',async()=>{
    const f=await fixture(dialect);try{
      const metrics={codes:['WINNING_BID_REGRESSED','BID_ACCEPTED_AFTER_CLOSE'],violations:['CREDIT_TIMEOUT','SCHEMA_MISMATCH'],requests:3};const {incidentId:id}=await f.alert({metrics});const before=await f.r.store.context(id);
      const repeated=await f.alert({metrics:{requests:3,codes:['BID_ACCEPTED_AFTER_CLOSE','WINNING_BID_REGRESSED','WINNING_BID_REGRESSED'],violations:['SCHEMA_MISMATCH','CREDIT_TIMEOUT']}});assert.equal(repeated.unchanged,true);assert.equal((await f.r.store.context(id)).incident.revision,before.incident.revision);
    }finally{await f.r.close();}
  });
  test(dialect+': an open monitor missing typed failure metrics prevents a conclusive cause based only on another monitor',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.alert({alertId:'unexplained',at:f.now+10,metrics:{requests:3}});await f.alert({at:f.now+20});await f.settle();const c=await f.r.store.context(id);assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.ok(c.incident.analysis.unknowns.some(u=>/open workflow monitors lack typed/i.test(u)));assert.equal(c.incident.analysis.rollback.eligible,false);
    }finally{await f.r.close();}
  });
}

const unavailableRows=f=>f.r.store.db.query("SELECT * FROM sre_outbox WHERE id LIKE 'alert-thread-unavailable:%' ORDER BY id");
const alertPromises=async(f,id)=>(await f.r.store.db.query("SELECT id,value FROM sre_checkpoints WHERE id LIKE 'alert-thread-reply:%' ORDER BY id")).map(row=>({id:row.id,value:JSON.parse(row.value)})).filter(row=>row.value.incidentId===id);
for(const dialect of ['sqlite','postgres']){
  test(dialect+': exhausted work informs each unanswered original alert thread once and leaves the later diagnosis pending',async()=>{
    const f=await fixture(dialect);try{
      const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();f.sent.length=0;await f.alert({thread:'1000000000002'});await f.alert({thread:'1000000000003',channel:f.service.teams.conversations[1]});const job=await f.exhaust();await f.drain();
      const notices=await unavailableRows(f);assert.equal(notices.length,2);assert.ok(notices.every(row=>row.incident_id===id&&row.text.includes(job.id)&&row.text.includes('diagnosis reply for this workflow alert is still pending')&&row.text.includes('retry '+id+' '+job.id+' <reason>')));assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,2);assert.equal(f.sent.filter(row=>row.conversationId.endsWith('1000000000001')&&row.text.startsWith('Investigation needs attention')).length,0);assert.equal((await alertPromises(f,id)).filter(row=>row.value.status==='pending').length,2);
      await f.alert({at:f.now+10});await f.settle();await f.drain();assert.equal((await alertPromises(f,id)).filter(row=>row.value.status==='queued').length,3);assert.equal(f.sent.filter(row=>row.text.includes('Change assessment:')&&!row.conversationId.endsWith('1000000000001')).length,2);assert.equal((await unavailableRows(f)).length,2);assert.equal((await f.r.store.context(id)).jobs.find(row=>row.id===job.id).status,'dead');assert.equal(f.executions(),0);assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    }finally{await f.r.close();}
  });
  test(dialect+': repeated exhausted jobs coalesce feedback per unanswered promise and retain a bounded redacted first error',async()=>{
    const f=await fixture(dialect);try{const {incidentId:id}=await f.alert();for(let n=0;n<3;n++){if(n)await f.alert({at:f.now+n});const job=await f.r.store.claim(f.r.worker.owner);assert.ok(job);await f.r.store.fail(job,Error('password=fictional-password Bearer fictional-credential\n'+'界😀'.repeat(1000)),1);await f.r.store.release(f.r.worker.owner);}const rows=await unavailableRows(f);assert.equal(rows.length,1);assert.ok(Buffer.byteLength(rows[0].text,'utf8')<2000);assert.ok(!rows[0].text.includes('fictional-password'));assert.ok(!rows[0].text.includes('fictional-credential'));assert.ok(rows[0].text.includes('[redacted]'));assert.equal((await alertPromises(f,id))[0].value.status,'pending');await f.drain();assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,1);}finally{await f.r.close();}
  });
  test(dialect+': leave, uninstall and changed sharing scope suppress feedback to the revoked original thread',async()=>{
    for(const mode of ['leave-and-rejoin','uninstall','sharing-scope']){const f=await fixture(dialect);try{const {incidentId:id}=await f.alert();if(mode==='leave-and-rejoin'){await f.r.store.unbindConversation(f.key('1000000000001'),id);await f.r.store.bindConversation(f.key('1000000000001'),id);}else if(mode==='uninstall'){const a=devActivity('help',f.service,{conversationId:f.service.teams.conversations[0],conversationType:'channel'});await f.r.router.installation({...a.activity,id:'unavailable-uninstall',timestamp:new Date(f.now+1).toISOString()},a.reference,false);}else f.service.teams.collaborationGroups=[{key:'changed-audience',name:'Fictional changed audience',conversations:f.service.teams.conversations.map(root=>({id:root,name:root}))}];await f.exhaust();await f.drain();assert.equal((await unavailableRows(f)).length,0,mode);assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,0,mode);assert.equal((await f.r.store.context(id)).jobs.some(row=>row.status==='dead'),true);}finally{await f.r.close();}}
  });
  test(dialect+': damaged ancillary reply provenance cannot authorize feedback or suppress another valid thread failure notice',async()=>{
    const f=await fixture(dialect);try{const {incidentId:id}=await f.alert();await f.alert({thread:'1000000000002'});const first=await f.reply(id,'1000000000001');await f.r.store.db.query('UPDATE sre_checkpoints SET value=? WHERE id=?',['{broken',first.id]);const job=await f.exhaust();await f.drain();const rows=await unavailableRows(f);assert.equal(rows.length,1);assert.equal(rows[0].conversation_key,f.key());assert.equal((await f.r.store.db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'dead');assert.equal((await f.reply(id)).value.status,'pending');assert.equal((await f.r.store.db.query('SELECT value FROM sre_checkpoints WHERE id=?',[first.id]))[0].value,'{broken');}finally{await f.r.close();}
  });
  test(dialect+': failed feedback persistence rolls back job exhaustion and every sibling notice before retrying the same attempt',async()=>{
    const f=await fixture(dialect),transaction=f.r.store.db.transaction;try{await f.alert();await f.alert({thread:'1000000000002'});const job=await f.r.store.claim(f.r.worker.owner),before=await f.r.store.db.query('SELECT * FROM sre_jobs WHERE id=?',[job.id]);let writes=0;f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('INSERT INTO sre_outbox')&&String(args[0]).startsWith('alert-thread-unavailable:')&&++writes===2)throw new StorageError(Error('Controlled unavailable-notice persistence denial'));return q(sql,args);}));await assert.rejects(f.r.store.fail(job,Error('Fictional evidence outage'),1),error=>error.code==='SRE_STORAGE_UNAVAILABLE');assert.equal(writes,2);assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_jobs WHERE id=?',[job.id]),before);assert.equal((await unavailableRows(f)).length,0);f.r.store.db.transaction=transaction;await f.r.store.fail(job,Error('Fictional evidence outage'),1);assert.equal((await unavailableRows(f)).length,2);assert.equal((await f.r.store.db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'dead');}finally{f.r.store.db.transaction=transaction;await f.r.close();}
  });
  test(dialect+': expired, changed-attempt and wrong-incident failure callbacks cannot mark replacement work dead or queue feedback',async()=>{
    for(const mode of ['expired','attempt','incident']){const f=await fixture(dialect);try{await f.alert();const job=await f.r.store.claim(f.r.worker.owner);if(mode==='expired')await f.r.store.db.query('UPDATE sre_jobs SET lease_until=0 WHERE id=?',[job.id]);else if(mode==='attempt')await f.r.store.db.query('UPDATE sre_jobs SET attempts=attempts+1 WHERE id=?',[job.id]);else job.incident_id='inc_wrong_fictional_callback';await f.r.store.fail(job,Error('Stale failure callback'),1);assert.equal((await f.r.store.db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'running');assert.equal((await unavailableRows(f)).length,0);}finally{await f.r.close();}}
  });
  test(dialect+': an uncertain failure notice is not replayed by another failed job or by the later diagnosis',async()=>{
    const f=await fixture(dialect);try{const {incidentId:id}=await f.alert();await f.proof(id);let posts=0;f.r.outbox.sender.send=async(ref,text)=>{if(text.startsWith('Investigation needs attention')){posts++;throw Error('Fictional connection lost after request');}f.sent.push({conversationId:ref.conversation.id,text});return{id:'other-fixture',simulation:true};};await f.exhaust();await f.drain();const [notice]=await unavailableRows(f);assert.equal(notice.status,'unknown');assert.equal(posts,1);await f.alert({at:f.now+10});await f.exhaust();await f.drain();assert.equal(posts,1);await f.alert({at:f.now+20});await f.settle();await f.drain();assert.equal(posts,1);assert.equal((await unavailableRows(f))[0].status,'unknown');assert.equal((await f.reply(id,'1000000000001')).value.status,'queued');assert.ok(f.sent.some(row=>row.text.includes('Change assessment:')));}finally{await f.r.close();}
  });
  test(dialect+': failure feedback and pending diagnosis survive durable reopen without re-sending the notice',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'sre-unavailable-alert-')),options={path:join(directory,'agent.sqlite'),pgPath:join(directory,'postgres')};let f=await fixture(dialect,options);try{const {incidentId:id}=await f.alert();await f.proof(id);const job=await f.exhaust();await f.drain();const before=await unavailableRows(f),promise=await f.reply(id,'1000000000001');assert.equal(before[0].status,'simulated');assert.equal(promise.value.status,'pending');await f.r.close();f=await fixture(dialect,{...options,seed:false});assert.deepEqual(await unavailableRows(f),before);assert.deepEqual(await f.reply(id,'1000000000001'),promise);await f.drain();assert.equal(f.sent.length,0);await f.alert({deliveryId:'unavailable-reopen-update',at:f.now+10});await f.settle();await f.drain();assert.equal((await f.r.store.context(id)).jobs.find(row=>row.id===job.id).status,'dead');assert.equal((await f.reply(id,'1000000000001')).value.status,'queued');assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,0);assert.equal(f.sent.filter(row=>row.text.includes('Change assessment:')).length,1);}finally{await f.r.close();await rm(directory,{recursive:true,force:true});}
  });
  test(dialect+': a restore hold or an unrelated incident cannot turn another thread promise into failure feedback',async()=>{
    const f=await fixture(dialect);try{const {incidentId:id}=await f.alert();await f.r.store.checkpoint('recovery:database-restore',{version:1,active:true,restoreId:'unavailable-alert-held',backupSha256:'a'.repeat(64),preparedAt:Date.now()});await f.exhaust();assert.equal((await unavailableRows(f)).length,0);assert.equal((await f.reply(id,'1000000000001')).value.status,'pending');await f.r.store.checkpoint('recovery:database-restore',{version:1,active:false,restoreId:'unavailable-alert-held',backupSha256:'a'.repeat(64),preparedAt:Date.now()});const other=await f.r.store.ingest({id:'unrelated-no-alert-thread',source:'dynatrace',serviceKey:f.service.key,kind:'problem',issueKey:'unrelated-no-thread',status:'OPEN',at:f.now+10,payload:{}}),job=await f.exhaust();assert.equal(job.incident_id,other.incidentId);assert.equal((await unavailableRows(f)).length,0);}finally{await f.r.close();}
  });
  test(dialect+': the real worker gives no exhaustion notice for retryable attempts, then one notice after three failed publications',async()=>{
    const f=await fixture(dialect),transaction=f.r.store.db.transaction;try{const {incidentId:id}=await f.alert();await f.proof(id);let denied=0;f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('INSERT INTO sre_assessments')){denied++;throw new StorageError(Error('Controlled assessment persistence failure'));}return q(sql,args);}));for(let attempt=1;attempt<=3;attempt++){assert.equal(await f.r.worker.runOnce(),false);const jobs=await f.r.store.db.query("SELECT status,attempts FROM sre_jobs WHERE status IN ('running','pending','dead')");assert.equal(jobs.length,1);assert.equal(Number(jobs[0].attempts),attempt);assert.equal(jobs[0].status,attempt===3?'dead':'pending');assert.equal((await unavailableRows(f)).length,attempt===3?1:0);await f.r.store.db.query("UPDATE sre_jobs SET next_at=0 WHERE status='pending'");}assert.equal(denied,3);assert.equal((await f.r.store.db.query('SELECT id FROM sre_assessments WHERE incident_id=?',[id])).length,0);await f.drain();f.r.store.db.transaction=transaction;await f.alert({at:f.now+10});await f.settle();await f.drain();assert.equal((await f.reply(id,'1000000000001')).value.status,'queued');assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,1);assert.ok(f.sent.some(row=>row.text.includes('Change assessment:')));}finally{f.r.store.db.transaction=transaction;await f.r.close();}
  });
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': original alert service provenance must agree with the current destination before failure feedback is queued',async()=>{
    const f=await fixture(dialect);try{const {incidentId:id}=await f.alert(),reply=await f.reply(id,'1000000000001');await f.r.store.db.query('UPDATE sre_events SET service_key=? WHERE id=?',['foreign-fictional-service',reply.value.eventId]);const job=await f.exhaust();assert.equal((await unavailableRows(f)).length,0);assert.equal((await f.r.store.db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'dead');assert.equal((await f.reply(id,'1000000000001')).value.status,'pending');}finally{await f.r.close();}
  });
  test(dialect+': denied reply-source reads are storage failures rather than ignorable damaged receipts',async()=>{
    const f=await fixture(dialect),transaction=f.r.store.db.transaction;try{await f.alert();const job=await f.r.store.claim(f.r.worker.owner);f.r.store.db.transaction=fn=>transaction(q=>fn((sql,args=[])=>{if(sql.startsWith('SELECT t.created_at,e.service_key'))throw new StorageError(Error('Controlled alert source read denial'));return q(sql,args);}));await assert.rejects(f.r.store.fail(job,Error('Fictional investigation failure'),1),error=>error.code==='SRE_STORAGE_UNAVAILABLE');assert.equal((await f.r.store.db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'running');assert.equal((await unavailableRows(f)).length,0);f.r.store.db.transaction=transaction;await f.r.store.fail(job,Error('Fictional investigation failure'),1);assert.equal((await unavailableRows(f)).length,1);}finally{f.r.store.db.transaction=transaction;await f.r.close();}
  });
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': a completed assessment retires only its two unsent failure notices and delivers the current result',async()=>{
    const f=await fixture(dialect);try{const {incidentId:id}=await f.alert();await f.proof(id);await f.alert({thread:'1000000000002'});await f.drain();const failed=await f.exhaust(),before=await unavailableRows(f);assert.ok(before.every(row=>row.status==='pending'));await f.alert({at:f.now+10});await f.settle();const after=await unavailableRows(f);assert.equal(after.length,2);for(const row of after){const original=before.find(value=>value.id===row.id);assert.equal(row.status,'discarded');assert.equal(row.text,original.text);assert.equal(Number(row.attempts),0);assert.equal(row.created_at,original.created_at);const reply=(await alertPromises(f,id)).find(value=>value.value.conversationKey===row.conversation_key);assert.equal(reply.value.status,'queued');assert.ok(row.error.includes(reply.value.outboxId));}await f.drain();assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,0);assert.equal(f.sent.filter(row=>row.text.includes('Change assessment:')).length,2);assert.equal((await f.r.store.context(id)).assessmentStatus.state,'current');assert.equal((await f.r.store.db.query('SELECT status FROM sre_jobs WHERE id=?',[failed.id]))[0].status,'dead');assert.equal((await f.r.store.context(id)).incident.status,'open');assert.equal(f.executions(),0);}finally{await f.r.close();}
  });
  test(dialect+': an unchanged result still retires delayed feedback for its newly joined original alert thread',async()=>{
    const f=await fixture(dialect);try{const {incidentId:id}=await f.alert();await f.proof(id);await f.settle();await f.drain();f.sent.length=0;await f.alert({thread:'1000000000002'});await f.drain();await f.exhaust();await f.alert({at:f.now+10});await f.settle();assert.equal((await unavailableRows(f))[0].status,'discarded');await f.drain();assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,0);assert.equal(f.sent.filter(row=>row.text.includes('Change assessment:')&&row.conversationId.endsWith('1000000000002')).length,1);assert.equal(f.sent.filter(row=>row.text.includes('Change assessment:')&&row.conversationId.endsWith('1000000000001')).length,0);assert.equal((await f.reply(id)).value.status,'queued');}finally{await f.r.close();}
  });
  test(dialect+': a claimed failure notice pauses before preparation and is discarded after result commit or cancellation',async()=>{
    for(const outcome of ['assessment','leave-and-rejoin']){const f=await fixture(dialect);let release,running;const prepared=f.r.outbox.prepare.bind(f.r.outbox);try{const {incidentId:id}=await f.alert();await f.proof(id);await f.drain();await f.exhaust();let entered,selected;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);f.r.outbox.prepare=async(call,...args)=>{selected=call.message.id;entered();await gate;return prepared(call,...args);};running=f.r.outbox.runOnce();await reached;if(outcome==='assessment'){await f.alert({at:f.now+10});await f.settle();}else{await f.r.store.unbindConversation(f.key('1000000000001'),id);await f.r.store.bindConversation(f.key('1000000000001'),id);}assert.equal((await unavailableRows(f))[0].status,'sending');release();await running;assert.equal((await unavailableRows(f))[0].status,'discarded');assert.equal((await f.r.store.db.query('SELECT id FROM sre_checkpoints WHERE id LIKE ?',['teams-delivery:prepared:'+selected+':%'])).length,0);assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,0);f.r.outbox.prepare=prepared;await f.drain();if(outcome==='assessment')assert.equal(f.sent.filter(row=>row.text.includes('Change assessment:')).length,1);}finally{release?.();await running?.catch(()=>{});await f.r.close();}}
  });
  test(dialect+': already submitted feedback is retained while a newer assessment queues and cannot be recalled as unsent',async()=>{
    const f=await fixture(dialect);let release,running;try{const {incidentId:id}=await f.alert();await f.proof(id);await f.drain();await f.exhaust();let entered,posts=0;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),sender=f.r.outbox.sender.send;f.r.outbox.sender.send=async(...args)=>{if(args[1].startsWith('Investigation needs attention')){posts++;entered();await gate;}return sender(...args);};running=f.r.outbox.runOnce();await reached;const [inflight]=await unavailableRows(f);assert.equal(inflight.status,'sending');await f.alert({at:f.now+10});await f.settle();assert.deepEqual((await unavailableRows(f))[0],inflight);release();await running;assert.equal((await unavailableRows(f))[0].status,'simulated');await f.drain();assert.equal(posts,1);assert.equal(f.sent.filter(row=>row.text.includes('Change assessment:')).length,1);}finally{release?.();await running?.catch(()=>{});await f.r.close();}
  });
  test(dialect+': a rejected rate-limit retry is retired after result commit without losing its preparation and outcome audit',async()=>{
    const f=await fixture(dialect);try{await f.alert();await f.proof((await f.r.store.db.query('SELECT id FROM sre_incidents'))[0].id);await f.drain();await f.exhaust();const sender=f.r.outbox.sender.send;let posts=0;f.r.outbox.sender.send=async(...args)=>{if(args[1].startsWith('Investigation needs attention')){posts++;throw Object.assign(Error('Fictional rate limit'),{status:429,headers:{'retry-after':'60'}});}return sender(...args);};await f.r.outbox.runOnce();const [pending]=await unavailableRows(f);assert.equal(pending.status,'pending');assert.equal(Number(pending.attempts),1);const audit=await f.r.store.db.query('SELECT id,value FROM sre_checkpoints WHERE id LIKE ? ORDER BY id',['teams-delivery:%'+pending.id+'%']);assert.ok(audit.some(row=>row.id.startsWith('teams-delivery:prepared:')));assert.ok(audit.some(row=>row.id.startsWith('teams-delivery:outcome:')));await f.alert({at:f.now+10});await f.settle();const [retired]=await unavailableRows(f);assert.equal(retired.status,'discarded');assert.equal(Number(retired.attempts),1);assert.equal(retired.text,pending.text);assert.equal(retired.next_at,pending.next_at);assert.deepEqual(await f.r.store.db.query('SELECT id,value FROM sre_checkpoints WHERE id LIKE ? ORDER BY id',['teams-delivery:%'+pending.id+'%']),audit);await f.drain();assert.equal(posts,1);}finally{await f.r.close();}
  });
  test(dialect+': retirement and replacement reply failures preserve the failed notice, promise and assessment transaction',async()=>{
    for(const fault of ['retirement','replacement']){const f=await fixture(dialect),transaction=f.r.store.db.transaction;try{const {incidentId:id}=await f.alert();await f.proof(id);await f.alert({thread:'1000000000002'});await f.drain();await f.exhaust();const notices=await unavailableRows(f),assessments=await f.r.store.db.query('SELECT * FROM sre_assessments ORDER BY id');await f.alert({at:f.now+10});let injected=false;f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(!injected&&(fault==='retirement'?sql.startsWith("UPDATE sre_outbox SET status='discarded',error=?")&&String(args[1]).startsWith('alert-thread-unavailable:'):sql.startsWith('INSERT INTO sre_outbox')&&String(args[3]).startsWith('Incident brief · '+id))){injected=true;throw new StorageError(Error('Controlled feedback replacement persistence failure'));}return q(sql,args);}));assert.equal(await f.r.worker.runOnce(),false);assert.equal(injected,true,fault);assert.deepEqual(await unavailableRows(f),notices);assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_assessments ORDER BY id'),assessments);assert.ok((await alertPromises(f,id)).every(row=>row.value.status==='pending'));f.r.store.db.transaction=transaction;await f.r.store.db.query("UPDATE sre_jobs SET next_at=0 WHERE status='pending'");await f.settle();assert.ok((await unavailableRows(f)).every(row=>row.status==='discarded'));assert.ok((await alertPromises(f,id)).every(row=>row.value.status==='queued'));}finally{f.r.store.db.transaction=transaction;await f.r.close();}}
  });
  test(dialect+': retirement is scoped to the exact source promise and does not discard ordinary or other-case messages',async()=>{
    const f=await fixture(dialect);try{const {incidentId:id}=await f.alert();await f.proof(id);await f.drain();await f.exhaust();const room=f.key('1000000000001'),foreign='alert-thread-unavailable:'+'a'.repeat(64);await f.r.store.queueMessage(id,'Fictional ordinary note with a different immutable source identity',room,foreign);const other=await f.r.store.ingest({id:'separate-feedback-case',source:'dynatrace',serviceKey:f.service.key,kind:'problem',issueKey:'separate-feedback-case',status:'OPEN',at:f.now,payload:{}});const otherMessage='separate-feedback-message';await f.r.store.queueMessage(other.incidentId,'Fictional unrelated case note',null,otherMessage);await f.alert({at:f.now+10});await f.settle();assert.equal((await f.r.store.db.query('SELECT status FROM sre_outbox WHERE id=?',[foreign]))[0].status,'pending');assert.equal((await f.r.store.db.query('SELECT status FROM sre_outbox WHERE id=?',[otherMessage]))[0].status,'pending');await f.drain();assert.ok(f.sent.some(row=>row.text==='Fictional ordinary note with a different immutable source identity'));assert.equal((await f.r.store.db.query('SELECT status FROM sre_outbox WHERE id=?',[foreign]))[0].status,'simulated');}finally{await f.r.close();}
  });
  test(dialect+': retirement and the replacement result survive durable reopen without sending the obsolete feedback',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'sre-retired-feedback-')),options={path:join(directory,'agent.sqlite'),pgPath:join(directory,'postgres')};let f=await fixture(dialect,options);try{const {incidentId:id}=await f.alert();await f.proof(id);await f.alert({thread:'1000000000002'});await f.drain();const failed=await f.exhaust();await f.alert({at:f.now+10});await f.settle();const retained=await unavailableRows(f),promises=await alertPromises(f,id);assert.ok(retained.every(row=>row.status==='discarded'));await f.r.close();f=await fixture(dialect,{...options,seed:false});assert.deepEqual(await unavailableRows(f),retained);assert.deepEqual(await alertPromises(f,id),promises);await f.drain();assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,0);assert.equal(f.sent.filter(row=>row.text.includes('Change assessment:')).length,2);assert.equal((await f.r.store.context(id)).jobs.find(row=>row.id===failed.id).status,'dead');}finally{await f.r.close();await rm(directory,{recursive:true,force:true});}
  });
  test(dialect+': a claim that expires while checking a completed promise stays unknown rather than being labelled unsent',async()=>{
    const f=await fixture(dialect),prepared=f.r.outbox.prepare.bind(f.r.outbox),transaction=f.r.store.db.transaction,clock=f.r.store.coordinationNow;let release,running;try{await f.alert();await f.drain();await f.exhaust();let entered;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);f.r.outbox.prepare=async(...args)=>{entered();await gate;return prepared(...args);};running=f.r.outbox.runOnce();await reached;await f.alert({at:f.now+10});await f.settle();const fixed=await clock.call(f.r.store),[sending]=await unavailableRows(f);let expire=false;f.r.store.coordinationNow=async()=>expire?Number(sending.lease_until)+1:fixed;f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{const rows=await q(sql,args);if(sql.startsWith('SELECT t.created_at,e.service_key'))expire=true;return rows;}));release();await running;assert.equal((await unavailableRows(f))[0].status,'unknown');assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,0);}finally{release?.();await running?.catch(()=>{});f.r.store.coordinationNow=clock;f.r.store.db.transaction=transaction;await f.r.close();}
  });
  test(dialect+': denied preflight promise reads preserve delivery uncertainty and cannot silently discard feedback',async()=>{
    const f=await fixture(dialect),prepared=f.r.outbox.prepare.bind(f.r.outbox),transaction=f.r.store.db.transaction;let release,running;try{await f.alert();await f.drain();await f.exhaust();let entered;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);f.r.outbox.prepare=async(...args)=>{entered();await gate;return prepared(...args);};running=f.r.outbox.runOnce();await reached;await f.alert({at:f.now+10});await f.settle();f.r.store.db.transaction=fn=>transaction(q=>fn((sql,args=[])=>{if(sql.startsWith('SELECT t.created_at,e.service_key'))throw new StorageError(Error('Controlled feedback preflight read denial'));return q(sql,args);}));release();await running;assert.equal((await unavailableRows(f))[0].status,'unknown');assert.equal(f.sent.filter(row=>row.text.startsWith('Investigation needs attention')).length,0);}finally{release?.();await running?.catch(()=>{});f.r.store.db.transaction=transaction;await f.r.close();}
  });
}
