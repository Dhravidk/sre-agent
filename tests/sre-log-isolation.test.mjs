import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {logIsolationFixture} from '../fixtures/sre-log-isolation.mjs';
import {LogScopeLimitError} from '../src/sre/log-detection.mjs';
import {StorageError} from '../src/sre/database.mjs';
import {prepareRestore} from '../src/sre/restore-recovery.mjs';
import {normalize} from '../src/sre/normalize.mjs';
import {seedPilot} from '../scripts/seed-pilot.mjs';

async function limited(task){let error;try{await task;}catch(value){error=value;}assert.ok(error instanceof LogScopeLimitError,error?.stack);assert.equal(error.code,'LOG_SCOPE_LIMIT');return error;}
const rows=(f,table)=>f.r.store.db.query('SELECT * FROM '+table+' ORDER BY id');
const problems=(f,service)=>f.r.store.db.query("SELECT * FROM sre_incidents WHERE service_key=? AND issue_key LIKE 'log-monitor:%' ORDER BY id",[service.key]);

for(const dialect of ['sqlite','postgres']){
 test(dialect+': an overflowing monitor leaves its own scopes unavailable while another monitor on that service detects once',async()=>{
  const f=await logIsolationFixture(dialect,{seed:false});try{
   const hot=await f.samples(f.noisy,{scopes:101}),auth=await f.samples(f.noisy,{code:'CACHE_TOKEN_EXPIRED'}),page={records:[...hot,...auth],complete:true},error=await limited(f.r.logDetector.observe(f.noisy,'dynatrace-logs',page));
   assert.deepEqual(error.failures,[{serviceKey:f.noisy.key,monitorId:'preview-cache',scopeLimit:100,scopesObservedAtLeast:101}]);assert.equal(error.partialResult.matched,306);assert.equal(error.partialResult.coverage.complete,true);assert.equal(error.partialResult.evaluationComplete,false);const detected=await problems(f,f.noisy);assert.equal(detected.length,1);assert.ok(detected[0].issue_key.startsWith('log-monitor:cache-auth:'));assert.deepEqual(error.incidents,[detected[0].id]);const cache=await rows(f,'sre_log_samples'),events=await rows(f,'sre_events');assert.equal(cache.length,306);
   const replay=await limited(f.r.logDetector.observe(f.noisy,'dynatrace-logs',page));assert.equal(replay.partialResult.matched,0);assert.deepEqual(await rows(f,'sre_log_samples'),cache);assert.deepEqual(await rows(f,'sre_events'),events);
  }finally{await f.close();}
 });

 for(const noisyFirst of [true,false])test(dialect+': queued code investigation and quiet cached detection progress with the overflowing service '+(noisyFirst?'first':'last'),async()=>{
  const f=await logIsolationFixture(dialect,{noisyFirst});try{
   assert.equal((await problems(f,f.quiet)).length,0);assert.equal((await f.r.store.context(f.state.id)).incident.analysis,null);
   let qa=0,rollback=0;f.r.casework.runOnce=async()=>{qa++;};f.r.rollbacks.executeNext=async()=>{rollback++;};await limited(f.r.tick());assert.equal(qa,0);assert.equal(rollback,0);
   const c=await f.r.store.context(f.state.id);assert.equal(c.assessmentStatus.state,'current');assert.equal(c.incident.analysis.mode,'rules');assert.ok(c.incident.analysis.codeReview.findings.some(item=>item.path==='src/auction/rules.mjs'&&item.headSha===f.state.sha));assert.ok(c.signalDigest.groups.some(group=>group.code==='WINNING_BID_REGRESSED'));assert.equal(JSON.stringify(c.signalDigest).includes('CACHE_TOKEN_EXPIRED'),false);assert.equal((await problems(f,f.quiet)).length,1);assert.equal((await problems(f,f.noisy)).length,1);
   const plan=await f.r.casework.createPlan(f.state.id);for(const marker of ['ISOLATION-AVERY:','ISOLATION-NOOR:','ISOLATION-SAM:'])assert.ok(plan.markdown.includes(marker));assert.ok(plan.payload.contacts.contacts.some(contact=>contact.id==='avery'));assert.equal(plan.markdown.includes('preview-cache@example.invalid'),false);const cacheContacts=await f.r.casework.contacts((await problems(f,f.noisy))[0].id);assert.deepEqual(cacheContacts.contacts.map(contact=>contact.id),['morgan-cache']);
   await f.message(f.state.rooms[0],'sync');await f.deliver();for(const room of f.state.rooms)assert.ok(f.sent.some(message=>message.room===room&&message.text.startsWith('Shared incident coordination')&&message.text.includes('duplicate work')));
   const ops=await f.r.operations.snapshot();assert.ok(ops.conditions.some(condition=>condition.code==='loop_error'&&condition.message.includes('preview-cache-fixture/preview-cache')));assert.equal(c.incident.status,'open');assert.equal((await rows(f,'sre_fix_requests')).length,0);assert.equal((await rows(f,'sre_rollbacks')).length,0);
  }finally{await f.close();}
 });

 test(dialect+': separate scope-limit failures are retained together while independent accepted monitors stay available',async()=>{
  const f=await logIsolationFixture(dialect,{seed:false,noisyFirst:true});try{
   const pressure={id:'ledger-preview-pressure',codes:['LEDGER_PREVIEW_UNAVAILABLE'],minCount:3,windowSeconds:900};f.quiet.logMonitors.push(pressure);
   await limited(f.r.logDetector.observe(f.noisy,'fixture',{records:await f.samples(f.noisy,{scopes:101}),complete:true}));
   const page={records:[...await f.samples(f.quiet,{scopes:101,code:pressure.codes[0]}),...await f.samples(f.quiet)],complete:true};await limited(f.r.logDetector.observe(f.quiet,'fixture',page));
   const error=await limited(f.r.logDetector.runOnce());assert.equal(error.failures.length,2);assert.deepEqual(new Set(error.failures.map(item=>item.serviceKey)),new Set([f.noisy.key,f.quiet.key]));assert.equal((await problems(f,f.quiet)).length,1);assert.equal(error.incidents.length,1);assert.match(error.message,/detection is incomplete/);
  }finally{await f.close();}
 });

 test(dialect+': contradictory admission and scope overflow are both visible without recounting or certifying the accepted samples',async()=>{
  const f=await logIsolationFixture(dialect,{seed:false});try{
   const records=[...await f.samples(f.noisy,{scopes:101}),...await f.samples(f.noisy,{code:'CACHE_TOKEN_EXPIRED'})],invalid={...records[0],timestamp:null,requestId:'invalid-candidate'},error=await limited(f.r.logDetector.observe(f.noisy,'fixture',{records:[...records,invalid],complete:true}));assert.equal(error.partialResult.coverage.rejected,1);assert.equal(error.partialResult.coverage.complete,false);assert.equal(error.partialResult.matched,306);assert.match(error.message,/excluded 1/);assert.ok((await rows(f,'sre_log_samples')).every(row=>JSON.parse(row.payload).partial));const id=(await problems(f,f.noisy))[0].id;assert.equal((await f.r.store.context(id)).evidence.find(row=>row.source==='log-monitor').content.complete,false);
  }finally{await f.close();}
 });

 test(dialect+': an incomplete monitor evaluation retains raw provider reads and the old successful poll cursor',async()=>{
  const f=await logIsolationFixture(dialect,{seed:false});try{
   f.noisy.dynatraceLogs={enabled:true,base:'https://dynatrace-isolation.invalid',mode:'grail',logField:'service.name',logValue:'preview-cache'};let page={records:[],complete:true};f.r.poller.connectors.get(f.noisy.key).dynatraceLogs={logs:async()=>page};await f.r.poller.runOnce();const key='dynatraceLogs:'+f.noisy.key,before=await f.r.store.checkpoint(key);
   page={records:[...await f.samples(f.noisy,{scopes:101}),...await f.samples(f.noisy,{code:'CACHE_TOKEN_EXPIRED'})],complete:true};await f.r.poller.runOnce();const failed=await f.r.store.checkpoint(key);assert.equal(failed.until,before.until);assert.equal(failed.successAt,before.successAt);assert.match(failed.error,/100 active scopes/);assert.equal(f.r.poller.localState(key,failed.scopeHash).complete,false);assert.ok((await rows(f,'sre_events')).some(row=>row.source==='dynatrace-logs'));assert.equal((await problems(f,f.noisy)).length,1);assert.ok((await f.r.operations.snapshot()).conditions.some(condition=>condition.serviceKey===f.noisy.key&&condition.code==='instance_poll_error'));
  }finally{await f.close();}
 });

 test(dialect+': storage failures, unexpected errors and code-shaped impostors still stop before investigation and protected work',async()=>{
  const f=await logIsolationFixture(dialect,{seed:false});try{
   let worker=0,actions=0;f.r.worker.runOnce=async()=>{worker++;};f.r.casework.runOnce=async()=>{actions++;};
   for(const failure of [new StorageError(Error('Controlled SQL denial')),Error('Unexpected detector failure'),{code:'LOG_SCOPE_LIMIT',message:'An untrusted shape cannot become a host-classified scope limit'}]){f.r.logDetector.runOnce=async()=>{throw failure;};await assert.rejects(f.r.tick(),error=>error===failure);assert.equal(worker,0);assert.equal(actions,0);}
  }finally{await f.close();}
 });

 test(dialect+': expiry clears the operational scope limit without resolving a business incident or rewriting its saved plan',async()=>{
  const f=await logIsolationFixture(dialect);try{
   await f.advance();const plan=await f.r.casework.createPlan(f.state.id),now=await f.r.store.coordinationNow();f.r.store.clock=()=>now+901000;f.r.store.coordinationNow=async()=>now+901000;await f.r.tick();assert.equal((await f.r.operations.snapshot()).conditions.some(condition=>condition.code==='loop_error'&&condition.key==='loop:tick'),false);assert.equal((await f.r.store.context(f.state.id)).incident.status,'open');assert.equal((await f.r.casework.getPlan(plan.id,f.state.id)).markdown,plan.markdown);assert.equal((await rows(f,'sre_fix_requests')).length,0);assert.equal((await rows(f,'sre_rollbacks')).length,0);
  }finally{await f.close();}
 });

 test(dialect+': a linked forward-fix MR keeps moving and invalidates its old plan while an unrelated monitor remains incomplete',async()=>{
  const f=await logIsolationFixture(dialect,{noisyFirst:true});try{
   const finish=async()=>{for(let n=0;n<12;n++){const[row]=await f.r.store.db.query("SELECT COUNT(*) AS n FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.n))return;await f.advance();}throw Error('Independent incident work did not drain under the scope limit');};
   await finish();let at=await f.r.store.coordinationNow();const mr=async(head,n)=>f.r.store.ingest(normalize('gitlab',{project:{id:f.quiet.gitlab.project},object_kind:'merge_request',object_attributes:{iid:73,state:'opened',last_commit:{id:head},updated_at:new Date(++at).toISOString(),title:'Fictional version-guard revert under investigation'}},f.quiet,{deliveryId:'log-isolation-mr-'+n}));
   await mr(f.state.sha,1);await f.r.casework.trackChange(f.state.id,'gitlab',73,{kind:'local-operator',id:'Fictional lead'});await finish();const old=await f.r.casework.createPlan(f.state.id),baseline=seedPilot().baseline;await mr(baseline,2);assert.equal((await f.r.casework.snapshot(f.state.id)).plans.find(plan=>plan.id===old.id).current,false);await finish();const context=await f.r.store.context(f.state.id);assert.equal(context.assessmentStatus.state,'current');assert.ok(context.incident.analysis.observedChanges.some(change=>change.number==='73'&&change.headSha===baseline));assert.equal((await f.r.casework.getPlan(old.id,f.state.id)).markdown,old.markdown);assert.ok(context.incident.analysis.codeReview.findings.some(item=>item.headSha===f.state.sha));assert.ok(f.r.operations.loops.tick.error.includes('100 active scopes'));assert.equal((await rows(f,'sre_fix_requests')).length,0);assert.equal((await rows(f,'sre_rollbacks')).length,0);
  }finally{await f.close();}
 });

 test(dialect+': restore reconciliation retains source history and cannot revive cached detection or protected actions',async()=>{
  const f=await logIsolationFixture(dialect);try{
   const now=await f.r.store.coordinationNow();await prepareRestore(f.r.store,{restoreId:'log-isolation-restore',backupSha256:'e'.repeat(64),backupAt:now-1,reason:'Fictional monitor-isolation restoration',actor:{kind:'local-operator',id:'Fictional lead'},offline:true});const events=await rows(f,'sre_events'),outbox=await rows(f,'sre_outbox'),sent=f.sent.length;await f.r.investigate();assert.deepEqual(await rows(f,'sre_events'),events);const after=await rows(f,'sre_outbox');for(const row of outbox)assert.deepEqual(after.find(item=>item.id===row.id),row);const oldIds=new Set(outbox.map(row=>row.id));assert.ok(after.filter(row=>!oldIds.has(row.id)).every(row=>row.status==='held_restore'));assert.equal(await f.r.outbox.runOnce(),false);assert.equal(f.sent.length,sent);assert.equal((await rows(f,'sre_log_samples')).length,0);assert.equal((await f.r.store.restoreFence()).active,true);assert.equal((await rows(f,'sre_fix_requests')).length,0);assert.equal((await rows(f,'sre_rollbacks')).length,0);
  }finally{await f.close();}
 });
}

test('file-backed reopen retains admitted cache, incident identity and old Markdown while partial detection still permits an independent review',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sre-log-isolation-')),path=join(directory,'agent.sqlite');let f=await logIsolationFixture('sqlite',{path,noisyFirst:true});try{
  const id=f.state.id,cache=await rows(f,'sre_log_samples'),events=await rows(f,'sre_events');await f.restart();assert.deepEqual(await rows(f,'sre_log_samples'),cache);assert.deepEqual(await rows(f,'sre_events'),events);await f.advance();const plan=await f.r.casework.createPlan(id),session=(await f.r.store.context(id)).session.agent_id;await f.restart();assert.equal((await f.r.casework.getPlan(plan.id,id)).markdown,plan.markdown);assert.equal((await f.r.store.context(id)).session.agent_id,session);await f.message(f.state.rooms[0],'report blocked REOPEN-AVERY: business correctness remains unresolved.');for(let n=0;n<6&&(await f.r.store.context(id)).assessmentStatus.state!=='current';n++)await f.advance();assert.equal((await f.r.store.context(id)).assessmentStatus.state,'current');for(const incident of[...await problems(f,f.quiet),...await problems(f,f.noisy)])assert.equal((await f.r.store.context(incident.id)).assessmentStatus.state,'current');assert.equal((await f.r.casework.getPlan(plan.id,id)).markdown,plan.markdown);assert.equal((await rows(f,'sre_fix_requests')).length,0);assert.equal((await rows(f,'sre_rollbacks')).length,0);
 }finally{await f.close();await rm(directory,{recursive:true,force:true});}
});

test('the existing automatic scheduler reviews a quiet queued case after restart while the independent scope-limit error stays visible',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sre-log-scheduled-')),path=join(directory,'agent.sqlite');let f=await logIsolationFixture('sqlite',{path,noisyFirst:true});const id=f.state.id,oldError=console.error,errors=[];try{
  await f.close();console.error=(...args)=>errors.push(args.join(' '));f=await logIsolationFixture('sqlite',{path,seed:false,autoStart:true,noisyFirst:true});const deadline=Date.now()+7000;let c;do{await delay(25);c=await f.r.store.context(id);}while(c.assessmentStatus.state!=='current'&&Date.now()<deadline);assert.equal(c.assessmentStatus.state,'current');assert.equal(c.incident.analysis.mode,'rules');assert.equal((await problems(f,f.quiet)).length,1);assert.ok((await f.r.operations.snapshot()).conditions.some(condition=>condition.code==='loop_error'&&condition.message.includes('100 active scopes')));assert.ok(errors.some(text=>text.includes('100 active scopes')));assert.equal((await rows(f,'sre_fix_requests')).length,0);assert.equal((await rows(f,'sre_rollbacks')).length,0);
 }finally{await f.close();console.error=oldError;await rm(directory,{recursive:true,force:true});}
});
