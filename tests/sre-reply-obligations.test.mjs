import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createSreRuntime} from '../src/sre/server.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';
import {normalizeAlert} from '../src/sre/alert-intake.mjs';
import {seedPilot,pilotDiff,pilotPolicySource} from '../scripts/seed-pilot.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {hash} from '../src/sre/security.mjs';

async function fixture(dialect,{path=':memory:',seed=true}={}){
  const profile=rehearsalProfile();profile.services[0].alerts={enabled:false,providers:['datadog']};
  const config=validateConfig(profile,{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-reply-obligations-cli'});assert.equal(config.sqlitePath,path);
  const pg=dialect==='postgres'?new PGlite():null,db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
  const sent=[],r=await createSreRuntime({config,db,autoStart:false,sender:{send:async(ref,text)=>{sent.push({conversationId:ref.conversation.id,text});return {id:'fixture-'+sent.length,simulation:true};}}}),service=config.services[0];
  let clock=Date.now(),sequence=0,calls=0;const now=clock-1000;r.store.clock=()=>clock;r.store.coordinationNow=async()=>clock;
  const investigate=r.worker.reasoner.investigate.bind(r.worker.reasoner);r.worker.reasoner.investigate=async(...args)=>{calls++;return investigate(...args);};
  const f={r,service,now,sent,calls:()=>calls,advance:ms=>clock+=ms,room:(n,root=service.teams.conversations[0])=>root+';messageid='+(1000000000000+n)};
  f.alert=async(n,{at=now,root=service.teams.conversations[0],groupKey='reply-fixture',...rest}={})=>r.store.ingest(normalizeAlert({provider:'datadog',alertId:'bid-monitor',groupKey,title:'Fictional accepted-bid regression',service:service.key,environment:service.environment,status:'OPEN',startedAt:now-60000,observedAt:at,metrics:{codes:['WINNING_BID_REGRESSED'],requests:3},thread:{tenantId:'synthetic',channelId:root,messageId:String(1000000000000+n)},...rest},service,'reply-fixture-'+ ++sequence));
  f.settle=async()=>{for(let i=0;i<100;i++){const [row]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.count))return;await r.worker.runOnce();}throw Error('Reply obligations did not settle');};
  f.drain=async()=>{for(let i=0;i<150&&await r.outbox.runOnce();i++);};
  f.answers=(n,id=f.id,root=service.teams.conversations[0])=>sent.filter(m=>m.conversationId===f.room(n,root)&&m.text.includes('Change assessment:')&&m.text.includes(id));
  if(seed){
    const manifest=seedPilot(),base=manifest.baseline,head=manifest.releases['bid-race'].sha;
    for(const [i,sha] of [base,head].entries())await r.store.ingest({id:'reply-release-'+i,source:'releases',serviceKey:service.key,kind:'deployment',at:now-(i?300000:900000),payload:{provider:'gitlab',environment:service.environment,sha,status:'success',artifact:'sha256:'+hash(sha),healthy:!i,healthVerifiedAt:!i?now-870000:null,rollbackCompatible:true,dataRollbackSafe:true,schemaVersion:1,dependencyFingerprint:'fixture',configurationFingerprint:'fixture',featureFlagsFingerprint:'fixture'}});
    for(const root of service.teams.conversations){const sample=devActivity('help',service,{conversationId:root,conversationType:'channel'});await r.store.rememberConversation({tenant:'synthetic',serviceKey:service.key,reference:sample.reference});}
    f.id=(await f.alert(1)).incidentId;
    await r.store.ingest({id:'reply-code',source:'gitlab',serviceKey:service.key,kind:'change',incidentId:f.id,at:now,payload:{provider:'gitlab',comparisonKind:'deployment',baseSha:base,headSha:head,sha:head,complete:true,unrecognizedPaths:[],diff:pilotDiff(head),policySources:{path:'src/auction/rules.mjs',complete:true,base:pilotPolicySource(base),head:pilotPolicySource(head)}}});
    await f.settle();await f.drain();await r.store.release(r.worker.owner);assert.equal((await r.store.context(f.id)).incident.analysis.changeAssessment,'likely');sent.length=0;
  }
  return f;
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': coalesced equivalent alert threads each get one current answer without another old-room broadcast',async()=>{
    const f=await fixture(dialect);try{
      const before=await f.r.store.context(f.id),calls=f.calls();for(const n of [2,3,4])await f.alert(n);await f.settle();await f.drain();
      for(const n of [2,3,4])assert.equal(f.answers(n).length,1,'Missing current assessment in thread '+n);assert.equal(f.answers(1).length,0);assert.equal(f.calls()-calls,1);assert.equal((await f.r.store.context(f.id)).incident.revision,before.incident.revision);
    }finally{await f.r.close();}
  });
  test(dialect+': ordinary telemetry can coalesce waiting replies without losing destinations or repeating inference per thread',async()=>{
    const f=await fixture(dialect);try{
      const calls=f.calls();await f.alert(1,{at:f.now+10});for(const n of [2,3,4])await f.alert(n,{at:f.now+10});await f.settle();await f.drain();
      for(const n of [2,3,4])assert.equal(f.answers(n).length,1);assert.equal(f.answers(1).length,0);assert.equal(f.calls()-calls,1);
    }finally{await f.r.close();}
  });
  test(dialect+': repeated deliveries for seven newly joined threads remain one review and one answer per waiting destination',async()=>{
    const f=await fixture(dialect);try{
      const calls=f.calls(),before=await f.r.store.db.query("SELECT id FROM sre_events WHERE source='alerts'");for(let i=0;i<10;i++)for(let n=2;n<=8;n++)await f.alert(n);await f.settle();await f.drain();
      for(let n=2;n<=8;n++)assert.equal(f.answers(n).length,1);assert.equal(f.answers(1).length,0);assert.equal(f.calls()-calls,1);assert.equal((await f.r.store.context(f.id)).collaboration.rooms.length,8);assert.equal((await f.r.store.db.query("SELECT id FROM sre_events WHERE source='alerts'")).length,before.length+70);
    }finally{await f.r.close();}
  });
  test(dialect+': reply obligations survive an expired claim and are completed by the replacement owner',async()=>{
    const f=await fixture(dialect);try{
      for(const n of [2,3,4])await f.alert(n);const abandoned=await f.r.store.claim('crashed-fixture-worker',1000);assert.ok(abandoned);f.advance(1001);const calls=f.calls();await f.settle();await f.drain();
      for(const n of [2,3,4])assert.equal(f.answers(n).length,1);assert.equal(f.calls()-calls,1);assert.equal((await f.r.store.db.query('SELECT status FROM sre_jobs WHERE id=?',[abandoned.id]))[0].status,'done');
    }finally{await f.r.close();}
  });
  test(dialect+': a newer observation during a merged review preserves every required reply on reassessment',async()=>{
    const f=await fixture(dialect);let release;try{
      await f.alert(1,{at:f.now+10});for(const n of [2,3])await f.alert(n,{at:f.now+10});
      let entered;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),investigate=f.r.worker.reasoner.investigate.bind(f.r.worker.reasoner);let held=false;
      f.r.worker.reasoner.investigate=async(...args)=>{if(!held){held=true;entered();await gate;}return investigate(...args);};
      const running=f.r.worker.runOnce();await reached;await f.alert(1,{at:f.now+20});release();await running;f.r.worker.reasoner.investigate=investigate;await f.settle();await f.drain();
      for(const n of [2,3])assert.equal(f.answers(n).length,1);assert.equal(f.answers(1).length,0);assert.equal((await f.r.store.context(f.id)).jobs.filter(j=>['pending','running','dead'].includes(j.status)).length,0);
    }finally{release?.();await f.r.close();}
  });
  test(dialect+': a waiting thread moved to a different incident cannot receive the old answer or block a remaining peer',async()=>{
    const f=await fixture(dialect);let release;try{
      await f.alert(1,{at:f.now+10});for(const n of [2,3])await f.alert(n,{at:f.now+10});
      let entered;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),investigate=f.r.worker.reasoner.investigate.bind(f.r.worker.reasoner);let held=false;
      f.r.worker.reasoner.investigate=async(...args)=>{if(!held){held=true;entered();await gate;}return investigate(...args);};
      const running=f.r.worker.runOnce();await reached;const key=conversationKey('synthetic',f.room(2));await f.r.store.unbindConversation(key,f.id);const other=await f.alert(10,{groupKey:'separate-provider-case',root:f.service.teams.conversations[3],metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}});await f.r.store.bindConversation(key,other.incidentId);
      release();await running;f.r.worker.reasoner.investigate=investigate;await f.settle();await f.drain();assert.equal(f.answers(2).length,0);assert.equal(f.answers(3).length,1);assert.ok(f.answers(2,other.incidentId).length>=1);
    }finally{release?.();await f.r.close();}
  });
  test(dialect+': failing the second destination enqueue rolls back the assessment and all replies, then retries the whole durable obligation',async()=>{
    const f=await fixture(dialect);try{
      for(const n of [2,3])await f.alert(n);const before=await f.r.store.db.query('SELECT id FROM sre_assessments ORDER BY id'),transaction=f.r.store.db.transaction;let inserts=0;
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('INSERT INTO sre_outbox')&&String(args[3]).includes('Change assessment:')&&++inserts===2)throw Error('Injected second reply enqueue failure');return q(sql,args);}));
      await f.r.worker.runOnce();f.r.store.db.transaction=transaction;assert.equal(inserts,2);assert.deepEqual(await f.r.store.db.query('SELECT id FROM sre_assessments ORDER BY id'),before);assert.equal((await f.r.store.db.query("SELECT id FROM sre_outbox WHERE status='pending' AND text LIKE '%Change assessment:%'")).length,0);
      f.advance(60001);await f.settle();await f.drain();for(const n of [2,3])assert.equal(f.answers(n).length,1);
    }finally{await f.r.close();}
  });
  test(dialect+': a failed coalescing claim leaves all jobs and destinations available for retry',async()=>{
    const f=await fixture(dialect);try{
      for(const n of [2,3])await f.alert(n);const before=await f.r.store.db.query('SELECT id,status,payload,attempts FROM sre_jobs ORDER BY id'),transaction=f.r.store.db.transaction;let injected=false;
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('UPDATE sre_jobs SET status=\'running\'')){injected=true;throw Error('Injected claim failure');}return q(sql,args);}));
      await assert.rejects(()=>f.r.store.claim('fixture-claim-failure'),/Injected claim/);f.r.store.db.transaction=transaction;assert.ok(injected);assert.deepEqual(await f.r.store.db.query('SELECT id,status,payload,attempts FROM sre_jobs ORDER BY id'),before);
      await f.settle();await f.drain();for(const n of [2,3])assert.equal(f.answers(n).length,1);
    }finally{await f.r.close();}
  });
  test(dialect+': two responders keep their separate questions while background reply work is coalesced',async()=>{
    const f=await fixture(dialect);try{
      for(const n of [2,3])await f.alert(n);const questions=['Which exact source revision disables the bid version guard?','Why does a passing health probe leave accepted bids unverified?'];
      for(const [i,text] of questions.entries()){
        const sample=devActivity('ask '+f.id+' '+text,f.service,{id:'reply-question-'+i,conversationId:f.room(i+2),conversationType:'channel',userId:['avery','sam'][i],displayName:['Avery','Sam'][i]});await f.r.router.accept(sample.activity,sample.reference);await f.r.router.processOnce();
      }
      await f.settle();await f.drain();for(const [i,text] of questions.entries())assert.ok(f.sent.some(m=>m.conversationId===f.room(i+2)&&m.text.includes(text)));
      const c=await f.r.store.context(f.id);assert.equal(c.evidence.filter(e=>e.kind==='question').length,2);assert.ok(c.jobs.every(j=>!['pending','running','dead'].includes(j.status)));assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    }finally{await f.r.close();}
  });
  test(dialect+': a sharing-group removal during merged investigation excludes that destination without withholding an authorized reply',async()=>{
    const f=await fixture(dialect);let release;try{
      await f.alert(2);const root=f.service.teams.conversations[1];await f.alert(3,{root});
      let entered;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),investigate=f.r.worker.reasoner.investigate.bind(f.r.worker.reasoner);let held=false;
      f.r.worker.reasoner.investigate=async(...args)=>{if(!held){held=true;entered();await gate;}return investigate(...args);};
      const running=f.r.worker.runOnce();await reached;const group=f.service.teams.collaborationGroups[0];group.conversations=group.conversations.filter(room=>room.id!==root);release();await running;f.r.worker.reasoner.investigate=investigate;await f.settle();await f.drain();
      assert.equal(f.answers(2).length,1);assert.equal(f.answers(3,f.id,root).length,0);assert.equal(f.answers(1).length,0);
    }finally{release?.();await f.r.close();}
  });
}

test('file-backed coalesced replies survive runtime reconstruction after a claim and retain the same incident session',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-reply-obligations-')),path=join(directory,'agent.sqlite');let f=await fixture('sqlite',{path});try{
    const id=f.id,session=(await f.r.store.context(id)).session.agent_id;for(const n of [2,3,4])await f.alert(n);const abandoned=await f.r.store.claim('fixture-pre-restart',1000);assert.ok(abandoned);await f.r.close();
    f=await fixture('sqlite',{path,seed:false});f.id=id;f.advance(1001);await f.settle();await f.drain();assert.equal((await f.r.store.context(id)).session.agent_id,session);for(const n of [2,3,4])assert.equal(f.answers(n).length,1);assert.equal(f.answers(1).length,0);
  }finally{await f.r.close();await rm(directory,{recursive:true,force:true});}
});
