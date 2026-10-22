import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import {loadConfig,validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {QaExecution} from '../src/sre/qa-execution.mjs';
import {createPilotQaAdapter} from '../fixtures/qa-sandbox.mjs';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Rollbacks} from '../src/sre/rollback.mjs';
import {hash} from '../src/sre/security.mjs';

async function fixture(dialect,adapter,{timeoutMs=40,path=':memory:',pgPath,existing,autoStart=false}={}){
  const profile=loadConfig({SRE_SQLITE_PATH:path}),service=profile.services[0],rooms=['bidding','platform','workers'];service.teams={...service.teams,conversations:rooms,captureResponderUpdates:true,collaborationGroups:[{key:'qa-response',name:'Fictional QA response',conversations:rooms.map(id=>({id,name:id}))}]};
  const config=validateConfig(profile,{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-qa-deadline-cli'});assert.equal(config.sqlitePath,path);assert.notEqual(path,'.local/sre.sqlite');
  const pg=dialect==='postgres'?new PGlite(pgPath):null,db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
  const sent=[],r=await createSreRuntime({config,db,qaAdapter:adapter,qaOptions:{timeoutMs},autoStart,sender:{send:async(ref,text)=>{sent.push({room:ref.conversation.id,text});return{id:'fictional-qa-send-'+sent.length,simulation:true};}}}),id=existing?.id||(await seedDemo(r.store,service)).incidentId;
  if(!existing){for(const room of rooms){const sample=devActivity('join '+id,service,{conversationId:room,conversationType:'groupChat'});await r.router.accept(sample.activity,sample.reference);await r.router.processOnce();}await until(async()=>{await r.worker.runOnce();return (await r.store.context(id)).assessmentStatus.state==='current';},'Fixture assessment did not settle');}
  const principal={verified:true,simulation:true,tenant:service.teams.tenantId,conversationId:rooms[0],userId:'local-operator'},key=conversationKey(service.teams.tenantId,rooms[0]),plan=existing?await r.casework.getPlan(existing.planId,id):await r.casework.createPlan(id);let sequence=0;
  return {r,id,service,sent,plan,principal,key,async approve(){const request=await r.casework.proposeFix(id,plan.id,principal,key,'qa-deadline-'+ ++sequence);await r.casework.approveFix(request.id,request.nonce,principal,key);return request;},row:async request=>(await r.store.db.query('SELECT * FROM sre_fix_requests WHERE id=?',[request.id]))[0]};
}
async function until(read,message,ms=5000){const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(value)return value;await delay(10);}throw Error(message);}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const otherIncident=async f=>(await f.r.store.ingest({id:'healthy-qa-independent',source:'dynatrace',serviceKey:f.service.key,kind:'problem',issueKey:'healthy-qa-independent',status:'OPEN',at:await f.r.store.coordinationNow(),payload:{codes:['CREDIT_PROVIDER_UNAVAILABLE'],synthetic:true}})).incidentId;
async function protectedRollback(f,{heldRead=false}={}){
  const entered=deferred(),gate=deferred();let writes=0;
  const executor=new Rollbacks({store:f.r.store,services:[f.service],mode:'connected',connectors:new Map([[f.service.key,{github:{deployments:async()=>{entered.resolve();if(heldRead)await gate.promise;return{items:(await f.r.store.context(f.id)).deployments,complete:true};}},rollback:{dispatch:async()=>{writes++;return{id:'fictional-protected-workflow',mock:true};}}}]])});
  const principal={...f.principal,simulation:false},proposal=await executor.propose(f.id,principal);assert.equal(proposal.eligible,true,proposal.text);await executor.approve(proposal.id,proposal.text.split(' ').at(-1),principal);f.r.rollbacks.executeNext=()=>executor.executeNext();
  return {proposal,entered,release:()=>gate.resolve(),writes:()=>writes,row:async()=>(await f.r.store.db.query('SELECT * FROM sre_rollbacks WHERE id=?',[proposal.id]))[0]};
}
async function reconsiderWithoutNewRevision(f){
  const now=await f.r.store.coordinationNow(),id=hash(['controlled-same-revision-review',f.id]),reasoner=f.r.worker.reasoner,investigate=reasoner.investigate.bind(reasoner),before=await f.r.store.context(f.id);
  // A retained reply/refresh job can reassess existing evidence without a new
  // source revision. This explicit fixture job tests that concurrency boundary.
  await f.r.store.db.query("INSERT INTO sre_jobs(id,incident_id,payload,status,attempts,next_at,created_at) VALUES(?,?,?,'pending',0,?,?)",[id,f.id,JSON.stringify({eventId:hash(id),question:null}),now,now]);
  reasoner.investigate=async(...args)=>{const value=await investigate(...args);value.analysis.summary='Controlled review withdrew the previous code attribution.';value.analysis.changeAssessment='unknown';value.analysis.candidateSha=null;value.analysis.unknowns=[...value.analysis.unknowns,'The earlier attribution needs a discriminating check.'];value.analysis.text='Controlled same-revision review: attribution remains unverified.';return value;};
  try{await f.r.investigate();}finally{reasoner.investigate=investigate;}
  const after=await f.r.store.context(f.id);assert.equal(after.incident.revision,before.incident.revision);assert.equal(after.assessmentStatus.state,'current');assert.equal(after.incident.analysis.changeAssessment,'unknown');return after;
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': legacy tickets without an assessment hash remain reviewable but reject a changed conclusion',async()=>{
    const f=await fixture(dialect,{localOnly:true,execute:async()=>{throw Error('No execution in this compatibility check');}});
    try{const {assessmentHash:omitted,...legacy}=f.plan.payload;assert.ok(omitted);await f.r.store.db.query('UPDATE sre_fix_plans SET payload=? WHERE id=?',[JSON.stringify(legacy),f.plan.id]);assert.equal((await f.r.casework.snapshot(f.id)).plans.find(plan=>plan.id===f.plan.id).assessmentCurrent,true);const proposal=await f.r.casework.proposeFix(f.id,f.plan.id,f.principal,f.key,'legacy-review');await reconsiderWithoutNewRevision(f);await assert.rejects(f.r.casework.approveFix(proposal.id,proposal.nonce,f.principal,f.key),/assessment.*stale/i);assert.equal((await f.row(proposal)).status,'proposed');}finally{await f.r.close();}
  });
  test(dialect+': a same-revision reassessment invalidates an older QA proposal before execution',async()=>{
    let calls=0;const f=await fixture(dialect,{localOnly:true,execute:async()=>{calls++;return{status:'passed',summary:'Must not execute an outdated plan'};}});
    try{const request=await f.approve();await reconsiderWithoutNewRevision(f);await f.r.actions();assert.equal(calls,0);assert.equal((await f.row(request)).status,'superseded');assert.match((await f.row(request)).error,/assessment/);assert.equal((await f.r.casework.snapshot(f.id)).plans.find(plan=>plan.id===f.plan.id).assessmentCurrent,false);assert.equal((await f.r.casework.ticketIndex(f.id)).plans.find(plan=>plan.id===f.plan.id).current,false);await assert.rejects(f.approve(),/stale|assessment/i);}finally{await f.r.close();}
  });
  test(dialect+': a same-revision reassessment during isolated QA makes its timely artifacts historical',async()=>{
    const entered=deferred(),gate=deferred();const f=await fixture(dialect,{localOnly:true,execute:async()=>{entered.resolve();await gate.promise;return{status:'passed',branch:'codex/historical-fixture',commit:'a'.repeat(40),summary:'Passing local checks do not preserve the withdrawn attribution'};}},{timeoutMs:90000});
    try{const request=await f.approve(),action=f.r.actions();await entered.promise;await reconsiderWithoutNewRevision(f);gate.resolve();await action;const row=await f.row(request);assert.equal(row.status,'superseded');assert.equal(JSON.parse(row.result).review.current,false);assert.match(row.error,/assessment/);}finally{gate.resolve();await f.r.close();}
  });
  test(dialect+': drafting a ticket cannot commit an assessment replaced during its asynchronous context reads',async()=>{
    const f=await fixture(dialect,{localOnly:true,execute:async()=>{throw Error('No QA execution');}}),entered=deferred(),gate=deferred(),timeline=f.r.casework.timeline.bind(f.r.casework);
    let held=false;try{f.r.casework.timeline=async(...args)=>{if(!held){held=true;entered.resolve();await gate.promise;}return timeline(...args);};const pending=f.r.casework.createPlan(f.id);await entered.promise;await reconsiderWithoutNewRevision(f);gate.resolve();await assert.rejects(pending,/assessment changed/i);assert.equal((await f.r.casework.getPlan(f.plan.id,f.id)).markdown,f.plan.markdown);}finally{gate.resolve();f.r.casework.timeline=timeline;await f.r.close();}
  });
  test(dialect+': rollback remains queued behind an unresolved cancelled QA call while investigations continue',async()=>{
    const entered=deferred(),gate=deferred();let calls=0;const f=await fixture(dialect,{localOnly:true,execute:async()=>{calls++;entered.resolve();await gate.promise;return{status:'passed',summary:'Late controlled QA'};}});
    let rollback;try{const request=await f.approve();rollback=await protectedRollback(f);const action=f.r.actions();await entered.promise;const other=await otherIncident(f);await f.r.investigate();assert.equal((await f.r.store.context(other)).assessmentStatus.state,'current');await action;assert.equal((await f.row(request)).status,'unknown');assert.equal(rollback.writes(),0);assert.equal((await rollback.row()).status,'approved');await f.r.actions();assert.equal(rollback.writes(),0);gate.resolve();await f.r.casework.qaExecution.drainSettled();await f.r.actions();assert.equal(rollback.writes(),1);assert.equal((await rollback.row()).status,'dispatched');assert.equal(calls,1);}finally{gate.resolve();rollback?.release();await f.r.close();}
  });
  test(dialect+': a review started during QA delays protected dispatch until that review finishes',async()=>{
    const qaEntered=deferred(),qaGate=deferred(),readEntered=deferred(),readGate=deferred();const f=await fixture(dialect,{localOnly:true,execute:async()=>{qaEntered.resolve();await qaGate.promise;return{status:'passed',summary:'Timely controlled QA'};}},{timeoutMs:90000});
    let rollback;try{const request=await f.approve();rollback=await protectedRollback(f);const action=f.r.actions();await qaEntered.promise;const other=await otherIncident(f),investigate=f.r.worker.reasoner.investigate.bind(f.r.worker.reasoner);f.r.worker.reasoner.investigate=async(...args)=>{readEntered.resolve();await readGate.promise;return investigate(...args);};const reading=f.r.investigate();await readEntered.promise;qaGate.resolve();await action;assert.equal((await f.row(request)).status,'passed');assert.equal(rollback.writes(),0);assert.equal((await rollback.row()).status,'approved');readGate.resolve();await reading;assert.equal((await f.r.store.context(other)).assessmentStatus.state,'current');await f.r.actions();assert.equal(rollback.writes(),1);}finally{qaGate.resolve();readGate.resolve();rollback?.release();await f.r.close();}
  });
  test(dialect+': action preflight defers a new investigator until the approved isolated QA call has actually started',async()=>{
    const preflight=deferred(),preflightGate=deferred(),entered=deferred(),gate=deferred();const f=await fixture(dialect,{localOnly:true,execute:async()=>{entered.resolve();await gate.promise;return{status:'passed',summary:'Controlled QA'};}},{timeoutMs:90000}),context=f.r.store.context.bind(f.r.store);let held=false;
    try{await f.approve();f.r.store.context=async id=>{if(id===f.id&&!held){held=true;preflight.resolve();await preflightGate.promise;}return context(id);};const action=f.r.actions();await preflight.promise;const other=await otherIncident(f);assert.equal(await f.r.investigate(),false);assert.equal((await context(other)).assessmentStatus.state,'missing');preflightGate.resolve();await entered.promise;await f.r.investigate();assert.equal((await context(other)).assessmentStatus.state,'current');gate.resolve();await action;}finally{preflightGate.resolve();gate.resolve();await f.r.close();}
  });
  test(dialect+': protected rollback revalidation defers investigation but keeps Teams command acknowledgements available',async()=>{
    const f=await fixture(dialect,{localOnly:true,execute:async()=>{throw Error('No QA request in this test');}});let rollback;
    try{rollback=await protectedRollback(f,{heldRead:true});const action=f.r.actions();await rollback.entered.promise;const other=await otherIncident(f);assert.equal(await f.r.investigate(),false);assert.equal((await f.r.store.context(other)).assessmentStatus.state,'missing');const sample=devActivity('help',f.service,{conversationId:'platform',conversationType:'groupChat',userId:'noor'});await f.r.router.accept(sample.activity,sample.reference);await f.r.commands();await until(async()=>{await f.r.deliver();return f.sent.some(message=>message.room==='platform'&&message.text.includes('Use: incidents'));},'The addressed help response did not reach its fictional sender');assert.equal(rollback.writes(),0);rollback.release();await action;assert.equal(rollback.writes(),1);assert.equal((await rollback.row()).status,'dispatched');await f.r.investigate();assert.equal((await f.r.store.context(other)).assessmentStatus.state,'current');}finally{rollback?.release();await f.r.close();}
  });
  test(dialect+': evidence admitted during protected revalidation still blocks dispatch and cannot be bypassed by the separate loops',async()=>{
    const f=await fixture(dialect,{localOnly:true,execute:async()=>{throw Error('No QA request in this test');}});let rollback;
    try{rollback=await protectedRollback(f,{heldRead:true});const action=f.r.actions();await rollback.entered.promise;await f.r.store.ingest({id:'new-primary-evidence-during-action',source:'operator-api',serviceKey:f.service.key,kind:'question',incidentId:f.id,at:await f.r.store.coordinationNow(),payload:{text:'New facts require a fresh review before dispatch.'}});assert.equal(await f.r.investigate(),false);rollback.release();await action;assert.equal(rollback.writes(),0);assert.equal((await rollback.row()).status,'blocked');assert.match((await rollback.row()).error,/evidence changed/);await f.r.investigate();assert.equal((await f.r.store.context(f.id)).assessmentStatus.state,'current');await f.r.actions();assert.equal(rollback.writes(),0);}finally{rollback?.release();await f.r.close();}
  });
  test(dialect+': an action-loop storage failure is observable without preventing a separate incident review',async()=>{
    const f=await fixture(dialect,{localOnly:true,execute:async()=>{throw Error('No approved QA');}}),run=f.r.casework.runOnce.bind(f.r.casework);
    try{f.r.casework.runOnce=async()=>{throw Error('Controlled action-loop storage failure');};await assert.rejects(f.r.actions(),/storage failure/);const other=await otherIncident(f);await f.r.investigate();assert.equal((await f.r.store.context(other)).assessmentStatus.state,'current');assert.ok((await f.r.operations.snapshot()).conditions.some(condition=>condition.key==='loop:actions'&&condition.code==='loop_error'&&condition.scope==='instance'));f.r.casework.runOnce=run;await f.r.actions();assert.ok(!(await f.r.operations.snapshot()).conditions.some(condition=>condition.key==='loop:actions'&&condition.code==='loop_error'));}finally{f.r.casework.runOnce=run;await f.r.close();}
  });
  test(dialect+': shutdown aborts QA and drains a simultaneous investigator without starting a later protected action',async()=>{
    const qaEntered=deferred(),qaGate=deferred(),readEntered=deferred(),readGate=deferred();let signal,writes=0,closed=false;const f=await fixture(dialect,{localOnly:true,execute:async input=>{signal=input.signal;qaEntered.resolve();await qaGate.promise;return{status:'passed',summary:'After shutdown'};}},{timeoutMs:90000});
    try{const request=await f.approve(),action=f.r.actions();await qaEntered.promise;const other=await otherIncident(f),investigate=f.r.worker.reasoner.investigate.bind(f.r.worker.reasoner);f.r.worker.reasoner.investigate=async(...args)=>{readEntered.resolve();await readGate.promise;return investigate(...args);};const reading=f.r.investigate();await readEntered.promise;f.r.rollbacks.executeNext=async()=>{writes++;};const closing=f.r.close().then(()=>closed=true);await until(async()=>(await f.row(request)).status==='unknown','Shutdown did not record the interrupted action');assert.equal(signal.aborted,true);assert.equal(closed,false);qaGate.resolve();readGate.resolve();await action;await reading;await closing;assert.equal(writes,0);assert.equal(await f.r.actions(),false);}finally{qaGate.resolve();readGate.resolve();await f.r.close();}
  });
  test(dialect+': the automatic scheduler investigates another incident during healthy QA before its deadline',async()=>{
    const entered=deferred(),gate=deferred();let calls=0,signal;const f=await fixture(dialect,{localOnly:true,execute:async input=>{calls++;signal=input.signal;entered.resolve();await gate.promise;return{status:'passed',branch:'codex/healthy-fixture',commit:'a'.repeat(40),summary:'Controlled healthy completion'};}},{autoStart:true,timeoutMs:90000});
    try{const request=await f.approve();await entered.promise;const other=await otherIncident(f);await until(async()=>(await f.r.store.context(other)).assessmentStatus.state==='current','A healthy QA call still blocks automatic investigation');assert.equal((await f.row(request)).status,'running');assert.equal(signal.aborted,false);assert.equal(calls,1);assert.equal((await f.r.operations.snapshot()).loops.actions.running,true);gate.resolve();await f.r.actions();assert.equal((await f.row(request)).status,'passed');}finally{gate.resolve();await f.r.close();}
  });
  test(dialect+': investigation and action calls coalesce separately while manual tick remains a full-cycle barrier',async()=>{
    const entered=deferred(),gate=deferred();let calls=0;const f=await fixture(dialect,{localOnly:true,execute:async()=>{calls++;entered.resolve();await gate.promise;return{status:'passed',summary:'Controlled action'};}},{timeoutMs:90000});
    try{const request=await f.approve(),action=f.r.actions();await entered.promise;assert.equal(f.r.actions(),action);const other=await otherIncident(f),investigation=f.r.investigate();assert.equal(f.r.investigate(),investigation);const cycle=f.r.tick();assert.equal(f.r.tick(),cycle);await investigation;assert.equal((await f.r.store.context(other)).assessmentStatus.state,'current');assert.equal((await f.row(request)).status,'running');assert.equal(await Promise.race([cycle.then(()=>true),delay(30).then(()=>false)]),false);gate.resolve();await action;await cycle;assert.equal((await f.row(request)).status,'passed');assert.equal(calls,1);}finally{gate.resolve();await f.r.close();}
  });
  test(dialect+': a trusted adapter attached after runtime construction is selected for the newly approved run',async()=>{
    let oldCalls=0,newCalls=0;const f=await fixture(dialect,{localOnly:true,execute:async()=>{oldCalls++;throw Error('Replaced adapter must not be called');}});
    try{f.r.casework.qaAdapter={localOnly:true,execute:async()=>{newCalls++;return{status:'passed',branch:'codex/reconfigured-fixture',commit:'a'.repeat(40),summary:'Configured trusted adapter'};}};const request=await f.approve();await f.r.casework.runOnce();assert.equal((await f.row(request)).status,'passed');assert.equal(newCalls,1);assert.equal(oldCalls,0);}finally{await f.r.close();}
  });
  test(dialect+': a timed-out adapter keeps the QA slot until its late result is retained, without promoting unknown or replaying work',async()=>{
    let release;const gate=new Promise(resolve=>release=resolve);let calls=0;
    const f=await fixture(dialect,{localOnly:true,execute:async()=>{calls++;if(calls===1)await gate;return{status:'passed',branch:'codex/fixture-'+calls,commit:'a'.repeat(40),summary:'Controlled completion'};}});
    try{
      const first=await f.approve();await f.r.casework.runOnce();assert.equal((await f.row(first)).status,'unknown');assert.deepEqual(f.r.casework.qaState(),{limit:1,reserved:1,unresolved:1,timedOut:1});const second=await f.approve();assert.equal(await f.r.casework.runOnce(),false);assert.equal((await f.row(second)).status,'approved');assert.equal(calls,1);assert.ok((await f.r.operations.snapshot()).conditions.some(condition=>condition.code==='instance_qa_saturated'&&condition.scope==='instance'));
      release();await f.r.casework.qaExecution.drainSettled();assert.equal(f.r.casework.qaState().reserved,0);assert.equal((await f.row(first)).status,'unknown');assert.equal((await f.row(first)).result,null);const events=await f.r.store.db.query("SELECT payload FROM sre_fix_events WHERE request_id=? AND status='late-result'",[first.id]);assert.equal(events.length,1);assert.equal(JSON.parse(events[0].payload).result.status,'passed');assert.match(JSON.parse(events[0].payload).note,/remains unknown/);
      await f.r.casework.runOnce();assert.equal((await f.row(second)).status,'passed');assert.equal(calls,2);assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    }finally{release();await f.r.close();}
  });
  test(dialect+': an adapter that honours cancellation releases its slot while its request stays unknown',async()=>{
    let calls=0;
    const f=await fixture(dialect,{localOnly:true,execute:({signal})=>new Promise((resolve,reject)=>{calls++;signal.addEventListener('abort',()=>reject(Object.assign(Error('Fictional adapter cancelled'),{name:'AbortError'})),{once:true});})});
    try{const request=await f.approve();await f.r.casework.runOnce();await f.r.casework.qaExecution.drainSettled();assert.equal(calls,1);assert.equal((await f.row(request)).status,'unknown');assert.equal(f.r.casework.qaState().reserved,0);assert.equal((await f.r.store.db.query("SELECT status FROM sre_fix_events WHERE request_id=? AND status='late-result'",[request.id])).length,1);assert.equal(await f.r.casework.runOnce(),false);assert.equal(calls,1);}finally{await f.r.close();}
  });
  test(dialect+': a late adapter rejection is retained without an unhandled rejection or a successful result',async()=>{
    let reject;const rejected=new Promise((resolve,fail)=>reject=fail),f=await fixture(dialect,{localOnly:true,execute:()=>rejected});
    try{const request=await f.approve();await f.r.casework.runOnce();reject(Error('Fictional late runner failure'));await f.r.casework.qaExecution.drainSettled();const row=await f.row(request);assert.equal(row.status,'unknown');assert.equal(row.result,null);const [event]=await f.r.store.db.query("SELECT payload FROM sre_fix_events WHERE request_id=? AND status='late-result'",[request.id]);assert.match(JSON.parse(event.payload).error,/late runner failure/);assert.equal(f.r.casework.qaState().reserved,0);}finally{reject(Error('Fixture cleanup'));await f.r.close();}
  });
  test(dialect+': a failure to save late QA evidence remains visible while the original unknown request is preserved',async()=>{
    let release;const gate=new Promise(resolve=>release=resolve),f=await fixture(dialect,{localOnly:true,execute:async()=>{await gate;return{status:'passed',summary:'Unsaved late evidence'};}}),transaction=f.r.store.db.transaction;
    try{const request=await f.approve();await f.r.casework.runOnce();f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('INSERT INTO sre_fix_events')&&args[2]==='late-result')throw Error('Injected late QA storage failure');return q(sql,args);}));release();await f.r.casework.qaExecution.drainSettled();f.r.store.db.transaction=transaction;assert.equal((await f.row(request)).status,'unknown');assert.equal(f.r.casework.qaState().reserved,0);assert.ok((await f.r.operations.snapshot()).conditions.some(condition=>condition.code==='instance_qa_audit'&&condition.scope==='instance'));assert.equal((await f.r.store.db.query("SELECT id FROM sre_fix_events WHERE request_id=? AND status='late-result'",[request.id])).length,0);}finally{f.r.store.db.transaction=transaction;release();await f.r.close();}
  });
  test(dialect+': a timeout remains unknown when evidence changes during the adapter call',async()=>{
    let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),f=await fixture(dialect,{localOnly:true,execute:async()=>{entered();await gate;return{status:'passed',summary:'Old evidence'};}});
    try{const request=await f.approve(),running=f.r.casework.runOnce();await started;await f.r.store.ingest({id:'changed-during-qa',source:'operator-api',serviceKey:f.service.key,kind:'question',incidentId:f.id,at:await f.r.store.coordinationNow(),payload:{text:'New evidence needs review before any further changes.'}});await running;const row=await f.row(request);assert.equal(row.status,'unknown');assert.match(row.error,/evidence changed/i);release();await f.r.casework.qaExecution.drainSettled();assert.equal((await f.row(request)).status,'unknown');}finally{release();await f.r.close();}
  });
  test(dialect+': timed-out QA and its immutable plan survive database reopen without another adapter call',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'sre-qa-deadline-')),options={path:join(directory,'agent.sqlite'),pgPath:join(directory,'postgres')};let release;const gate=new Promise(resolve=>release=resolve);let calls=0,f=await fixture(dialect,{localOnly:true,execute:async()=>{calls++;await gate;return{status:'passed',summary:'Old runtime result'};}},options);
    try{const request=await f.approve(),existing={id:f.id,planId:f.plan.id};await f.r.casework.runOnce();const before=await f.row(request),markdown=f.plan.markdown;await f.r.close();f=await fixture(dialect,{localOnly:true,execute:async()=>{calls++;throw Error('Must not replay interrupted QA');}},{...options,existing});assert.deepEqual(await f.row(request),before);assert.equal(f.plan.markdown,markdown);assert.equal(await f.r.casework.runOnce(),false);assert.equal(calls,1);release();await delay(0);assert.equal((await f.row(request)).status,'unknown');}finally{release();await f.r.close();await rm(directory,{recursive:true,force:true});}
  });
  test(dialect+': a hung QA call times out as unknown and releases the tick for a different incident',async()=>{
    let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);let calls=0,signal;
    const f=await fixture(dialect,{localOnly:true,execute:async input=>{calls++;signal=input.signal;entered();await gate;return{status:'passed',branch:'codex/late-fixture',commit:'a'.repeat(40),summary:'Controlled late result'};}});
    try{
      const request=await f.approve(),running=f.r.tick();await started;
      const other=(await f.r.store.ingest({id:'other-during-hung-qa',source:'dynatrace',serviceKey:f.service.key,kind:'problem',issueKey:'other-during-hung-qa',status:'OPEN',at:await f.r.store.coordinationNow(),payload:{codes:['CREDIT_PROVIDER_UNAVAILABLE'],synthetic:true}})).incidentId;
      assert.equal(await Promise.race([running.then(()=>true),delay(2000).then(()=>false)]),true,'An unresolved QA adapter must not own the incident tick indefinitely');assert.equal((await f.row(request)).status,'unknown');assert.equal(signal.aborted,true);await f.r.tick();assert.equal((await f.r.store.context(other)).assessmentStatus.state,'current');assert.equal(calls,1);assert.ok((await f.r.operations.snapshot()).conditions.some(condition=>condition.code==='qa_unknown'));
    }finally{release();await f.r.close();}
  });
  test(dialect+': runtime shutdown aborts a hung QA wait and records uncertainty before storage closes',async()=>{
    let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);let signal;
    const f=await fixture(dialect,{localOnly:true,execute:async input=>{signal=input.signal;entered();await gate;return{status:'passed',summary:'After shutdown'};}},{timeoutMs:90000});
    let closed=false,closedRow,deployments=0;try{const request=await f.approve(),closeDb=f.r.store.db.close;f.r.store.db.close=async()=>{closedRow=await f.row(request);return closeDb();};f.r.rollbacks.executeNext=async()=>{deployments++;};const running=f.r.tick();await started;const close=f.r.close();closed=await Promise.race([close.then(()=>true),delay(2000).then(()=>false)]);assert.equal(closed,true,'Shutdown must cancel its QA wait before awaiting the tick');assert.equal(signal.aborted,true);await running;assert.equal(closedRow.status,'unknown');assert.match(closedRow.error,/agent stopped/);assert.equal(deployments,0,'The interrupted tick must not move on to deployment execution after shutdown');}finally{release();if(!closed)await f.r.close();}
  });
}

test('local QA host deadlines are bounded independently of model or repository content',()=>{
  for(const timeoutMs of [0,-1,90001,NaN,Infinity,1.5,'40'])assert.throws(()=>new QaExecution({timeoutMs}),/timeout/);
  assert.equal(new QaExecution({}).timeoutMs,90000);
});

test('the trusted pilot adapter honours an already cancelled request before creating a workspace',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-qa-preabort-')),controller=new AbortController();controller.abort();
  try{await assert.rejects(createPilotQaAdapter(join(directory,'qa')).execute({requestId:'fix_'+'a'.repeat(24),plan:{},markdown:'Fictional plan',signal:controller.signal}),{name:'AbortError'});assert.deepEqual(await readdir(directory),[]);}finally{await rm(directory,{recursive:true,force:true});}
});
