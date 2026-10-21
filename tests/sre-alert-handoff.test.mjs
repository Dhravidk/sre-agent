import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {normalizeAlert} from '../src/sre/alert-intake.mjs';
import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';
import {seedPilot,pilotDiff,pilotPolicySource} from '../scripts/seed-pilot.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {hash} from '../src/sre/security.mjs';

async function fixture(dialect='sqlite'){
  const profile=rehearsalProfile();profile.services[0].alerts={enabled:false,providers:['datadog','dynatrace']};const config=validateConfig(profile,{SRE_SQLITE_PATH:':memory:',SRE_CLAUDE_BIN:'/nonexistent-alert-handoff-cli'}),service=config.services[0];
  assert.equal(config.sqlitePath,':memory:','Unit fixtures must never open the default workspace database');
  const pg=dialect==='postgres'?new PGlite():null,db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
  let executions=0;const sent=[],r=await createSreRuntime({config,db,autoStart:false,qaAdapter:{localOnly:true,execute:async()=>{executions++;return {status:'passed',summary:'Fixture only'};}},sender:{send:async(ref,text)=>{sent.push({conversationId:ref.conversation.id,text});return {id:'alert-fixture:'+sent.length,simulation:true};}}});
  const now=(await r.store.coordinationNow())-1000;let sequence=0;const manifest=seedPilot(),base=manifest.baseline,head=manifest.releases['bid-race'].sha;
  for(const [i,sha] of [base,head].entries())await r.store.ingest({id:'release-'+i,source:'releases',serviceKey:service.key,kind:'deployment',at:now-(i?300000:900000),payload:{provider:'gitlab',environment:service.environment,sha,status:'success',artifact:'sha256:'+hash(sha),healthy:!i,healthVerifiedAt:!i?now-870000:null,rollbackCompatible:true,dataRollbackSafe:true,schemaVersion:1,dependencyFingerprint:'fixture',configurationFingerprint:'fixture',featureFlagsFingerprint:'fixture'}});
  for(const root of service.teams.conversations){const sample=devActivity('help',service,{conversationId:root,conversationType:'channel'});await r.store.rememberConversation({tenant:service.teams.tenantId,serviceKey:service.key,reference:sample.reference});}
  const f={r,service,now,base,head,sent,executions:()=>executions};
  f.alert=async({alertId='bids',groupKey='eu-bids',provider='datadog',status='OPEN',at=now,metrics={codes:['WINNING_BID_REGRESSED'],requests:3},thread='1000000000001',channel=service.teams.conversations[0],deliveryId='fixture-alert:'+ ++sequence,...rest}={})=>r.store.ingest(normalizeAlert({provider,alertId,groupKey,status,service:service.key,environment:service.environment,title:'Fictional workflow alert',startedAt:now-60000,observedAt:at,metrics,thread:{tenantId:service.teams.tenantId,channelId:channel,messageId:thread},...rest},service,deliveryId));
  f.proof=async id=>r.store.ingest({id:'code:'+id,source:'gitlab',serviceKey:service.key,kind:'change',incidentId:id,at:now,payload:{provider:'gitlab',comparisonKind:'deployment',baseSha:base,headSha:head,sha:head,complete:true,unrecognizedPaths:[],diff:pilotDiff(head),policySources:{path:'src/auction/rules.mjs',complete:true,base:pilotPolicySource(base),head:pilotPolicySource(head)}}});
  f.settle=async()=>{for(let i=0;i<100;i++){const [row]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.count))return;await r.worker.runOnce();}throw Error('Alert fixture did not settle');};
  f.drain=async()=>{for(let i=0;i<100&&await r.outbox.runOnce();i++);};
  f.principal=(thread='1000000000001')=>({verified:true,simulation:true,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0]+';messageid='+thread,userId:'local-operator'});
  return f;
}

for(const dialect of ['sqlite','postgres']){
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
