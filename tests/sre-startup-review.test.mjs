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
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {normalizeAlert} from '../src/sre/alert-intake.mjs';

async function fixture(dialect,{path=':memory:',seed=true}={}){
  const config=validateConfig(rehearsalProfile(),{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-startup-review-cli'});assert.equal(config.sqlitePath,path);
  const pg=dialect==='postgres'?new PGlite():null,db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
  let executions=0;const r=await createSreRuntime({config,db,autoStart:false,qaAdapter:{localOnly:true,execute:async()=>{executions++;throw Error('Historical approval must not execute');}}}),service=config.services[0],f={r,service,executions:()=>executions};
  f.settle=async()=>{for(let i=0;i<60;i++){const [row]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.count))return;await r.worker.runOnce();}throw Error('Startup review did not settle');};
  f.legacy=async id=>{const c=await r.store.context(id),states=JSON.parse(c.incident.source_states),keys=Object.keys(states).filter(key=>key.startsWith('servicenow:'));assert.equal(keys.length,1);const s=states[keys[0]];delete states[keys[0]];states.servicenow={at:s.at,status:s.status};await r.store.db.query('UPDATE sre_incidents SET source_states=? WHERE id=?',[JSON.stringify(states),id]);return c;};
  if(seed){f.id=(await seedDemo(r.store,service)).incidentId;await f.settle();}
  return f;
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': an identity-only legacy upgrade schedules exactly one current review and restores fix-ticket freshness',async()=>{
    const f=await fixture(dialect);try{
      const plan=await f.r.casework.createPlan(f.id),before=await f.legacy(f.id),events=await f.r.store.db.query('SELECT id,body_hash FROM sre_events ORDER BY id');
      await f.r.store.initialize();const upgraded=await f.r.store.context(f.id);assert.equal(upgraded.incident.status,before.incident.status);assert.equal(upgraded.incident.started_at,before.incident.started_at);assert.equal(upgraded.session.agent_id,before.session.agent_id);assert.equal(upgraded.incident.revision,before.incident.revision+1);
      assert.equal(upgraded.jobs.filter(j=>j.status==='pending').length,1);assert.equal(upgraded.evidence.filter(e=>e.kind==='source_identity_upgrade').length,1);assert.ok(upgraded.incident.analysis,'The previous reply remains available while the identity-only review runs');
      await assert.rejects(()=>f.r.casework.createPlan(f.id),/stale/);await f.r.store.initialize();assert.equal((await f.r.store.context(f.id)).jobs.length,upgraded.jobs.length);
      await f.settle();const fresh=await f.r.casework.createPlan(f.id);assert.equal(fresh.payload.revision,upgraded.incident.revision);assert.ok(fresh.payload.patch);assert.notEqual(fresh.id,plan.id);assert.deepEqual(await f.r.store.db.query('SELECT id,body_hash FROM sre_events ORDER BY id'),events);
      assert.equal((await f.r.casework.getPlan(plan.id,f.id)).markdown,plan.markdown,'A new review must not rewrite the original ticket');
    }finally{await f.r.close();}
  });
  test(dialect+': a failed review enqueue rolls back the whole legacy upgrade and can be retried without duplicate audit',async()=>{
    const f=await fixture(dialect);try{
      await f.legacy(f.id);const before=await f.r.store.context(f.id),transaction=f.r.store.db.transaction;let injected=false;
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('INSERT INTO sre_jobs')){injected=true;throw Error('Injected startup review enqueue failure');}return q(sql,args);}));
      await assert.rejects(()=>f.r.store.initialize(),/Injected startup review/);f.r.store.db.transaction=transaction;assert.ok(injected);
      let c=await f.r.store.context(f.id);assert.equal(c.incident.source_states,before.incident.source_states);assert.equal(c.incident.revision,before.incident.revision);assert.equal(c.evidence.filter(e=>e.kind==='source_identity_upgrade').length,0);
      await f.r.store.initialize();await f.r.store.initialize();c=await f.r.store.context(f.id);assert.equal(c.evidence.filter(e=>e.kind==='source_identity_upgrade').length,1);assert.equal(c.jobs.filter(j=>j.status==='pending').length,1);
    }finally{await f.r.close();}
  });
  test(dialect+': startup review cannot revive a prior approved QA request or create a deployment',async()=>{
    const f=await fixture(dialect);try{
      const room=f.service.teams.conversations[0],sample=devActivity('join '+f.id,f.service,{conversationId:room,conversationType:'groupChat'});await f.r.router.accept(sample.activity,sample.reference);await f.r.router.processOnce();await f.settle();
      const plan=await f.r.casework.createPlan(f.id),principal={verified:true,simulation:true,tenant:'synthetic',conversationId:room,userId:'local-operator'},key=conversationKey('synthetic',room),request=await f.r.casework.proposeFix(f.id,plan.id,principal,key,'before-upgrade');await f.r.casework.approveFix(request.id,request.nonce,principal,key);
      await f.legacy(f.id);await f.r.store.initialize();await f.settle();await f.r.casework.runOnce();assert.equal(f.executions(),0);assert.equal((await f.r.casework.snapshot(f.id)).qa[0].status,'superseded');assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    }finally{await f.r.close();}
  });
  test(dialect+': an alert channel cannot be invented from a saved group-chat or untyped reference',async()=>{
    const f=await fixture(dialect,{seed:false});try{
      const root=f.service.teams.conversations[0];f.service.alerts={enabled:false,providers:['datadog']};const now=Date.now()-1000;
      for(const type of ['groupChat','personal',undefined]){
        const sample=devActivity('help',f.service,{conversationId:root,conversationType:'groupChat'});sample.reference.conversation.conversationType=type;await f.r.store.rememberConversation({tenant:'synthetic',serviceKey:f.service.key,reference:sample.reference});
        const event=normalizeAlert({provider:'datadog',alertId:'fixture',groupKey:'fixture',title:'Fictional alert',service:f.service.key,environment:'local',status:'OPEN',startedAt:now-1000,observedAt:now,thread:{tenantId:'synthetic',channelId:root,messageId:'1000000000001'}},f.service,'wrong-reference-'+type);
        await assert.rejects(()=>f.r.store.ingest(event),/installed channel reference/i);assert.equal((await f.r.store.snapshot()).incidents.length,0);assert.equal((await f.r.store.snapshot()).counts.length,0);
      }
    }finally{await f.r.close();}
  });
  test(dialect+': alert binding uses a valid channel reference even when an earlier root reference has another conversation type',async()=>{
    const f=await fixture(dialect,{seed:false});try{
      const root=f.service.teams.conversations[0];f.service.alerts={enabled:false,providers:['datadog']};const now=Date.now()-1000;
      const group=devActivity('help',f.service,{conversationId:root,conversationType:'groupChat',serviceUrl:'http://127.0.0.1:1'});await f.r.store.rememberConversation({tenant:'synthetic',serviceKey:f.service.key,reference:group.reference});
      const channel=devActivity('help',f.service,{conversationId:root+';messageid=1000000000001',conversationType:'channel',serviceUrl:'http://127.0.0.1:2'});await f.r.store.rememberConversation({tenant:'synthetic',serviceKey:f.service.key,reference:channel.reference});
      const event=normalizeAlert({provider:'datadog',alertId:'fixture',groupKey:'fixture',title:'Fictional alert',service:f.service.key,environment:'local',status:'OPEN',startedAt:now-1000,observedAt:now,thread:{tenantId:'synthetic',channelId:root,messageId:'1000000000002'}},f.service,'valid-channel-reference');await f.r.store.ingest(event);
      const [bound]=await f.r.store.db.query('SELECT reference FROM sre_conversations WHERE conversation_id=?',[root+';messageid=1000000000002']);assert.equal(JSON.parse(bound.reference).serviceUrl,'http://127.0.0.1:2');assert.equal(JSON.parse(bound.reference).conversation.conversationType,'channel');
    }finally{await f.r.close();}
  });
}

test('a file-backed identity upgrade survives runtime reconstruction without losing the session or recreating its review job',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-startup-review-')),path=join(directory,'agent.sqlite');let f=await fixture('sqlite',{path});try{
    const id=f.id,before=await f.legacy(id);await f.r.close();f=await fixture('sqlite',{path,seed:false});const upgraded=await f.r.store.context(id);assert.equal(upgraded.session.agent_id,before.session.agent_id);assert.equal(upgraded.jobs.filter(j=>j.status==='pending').length,1);await f.settle();const plan=await f.r.casework.createPlan(id);assert.ok(plan.payload.patch);
    await f.r.close();f=await fixture('sqlite',{path,seed:false});assert.equal((await f.r.store.context(id)).jobs.length,upgraded.jobs.length);assert.equal((await f.r.casework.getPlan(plan.id,id)).markdown,plan.markdown);
  }finally{await f.r.close();await rm(directory,{recursive:true,force:true});}
});
