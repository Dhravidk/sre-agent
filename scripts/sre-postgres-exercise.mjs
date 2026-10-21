import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync,openSync,closeSync,readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { startPostgresCluster } from '../fixtures/postgres-cluster.mjs';
import { postgresDatabase,schema } from '../src/sre/database.mjs';
import { releases } from '../src/sre/deployments.mjs';
import { hash } from '../src/sre/security.mjs';
import { proposalWorkflowRequest } from '../src/sre/workflow-contract.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { prepareRestore,releaseRestore } from '../src/sre/restore-recovery.mjs';
import { restoreProviderRetries } from '../src/sre/restore-provider-retries.mjs';
import { configuredRetryDescriptor,providerRetryGate } from '../src/sre/provider-retry.mjs';

const root=resolve('.'),bin=process.argv.includes('--bin')?process.argv[process.argv.indexOf('--bin')+1]:process.env.SRE_TEST_PG_BIN;
if(!bin)throw new Error('Usage: pnpm sre:postgres-exercise --bin /absolute/postgresql/bin');
const directory=resolve('.local/postgres-runs',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));mkdirSync(directory,{recursive:true,mode:0o700});
const reportPath=join(directory,'report.json'),dispatchLog=join(directory,'dispatch.jsonl'),apiToken=randomBytes(24).toString('hex');
const report={mode:'isolated-network-postgres',status:'running',startedAt:new Date().toISOString(),directory,supervisorPid:process.pid,cases:[],failures:[],peers:[],limitations:['Real loopback TCP/SCRAM PostgreSQL and separate Node processes; provider dispatch/identity and model session state are synthetic.','Short two-second scheduled worker leases and one-second competition leases make failover observable. SIGQUIT tests immediate database shutdown and WAL recovery on the same data directory; no RDS, TLS, backup restore, replica failover or real model validation.']};
const save=()=>writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
function fingerprint() {
  const files={};
  function walk(path){for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const name=join(path,entry.name);if(entry.isDirectory())walk(name);else if(entry.isFile())files[name]=createHash('sha256').update(readFileSync(name)).digest('hex');}}
  for(const path of ['src','fixtures','scripts','config'])walk(path);
  for(const name of ['package.json','pnpm-lock.yaml'])files[name]=createHash('sha256').update(readFileSync(name)).digest('hex');
  return files;
}
const sources=fingerprint();report.sourceFingerprint=createHash('sha256').update(JSON.stringify(sources)).digest('hex');
writeFileSync(join(directory,'source-fingerprints.json'),JSON.stringify(sources,null,2)+'\n');save();
let cluster,db;const peers=[];
async function waitFor(label,fn,milliseconds=10000) {
  const deadline=Date.now()+milliseconds;let last;
  while(Date.now()<deadline){try{const result=await fn();if(result)return result;}catch(error){last=error;}await delay(40);}
  throw new Error(label+' was not observed'+(last?': '+last.message:''));
}
async function check(name,fn) {
  const started=performance.now();
  try{const evidence=await fn();report.cases.push({name,passed:true,durationMs:Math.round(performance.now()-started),evidence});console.log(JSON.stringify({case:name,passed:true}));}
  catch(error){report.cases.push({name,passed:false,durationMs:Math.round(performance.now()-started)});throw error;}
  finally{save();}
}
function peer(name,{scheduled=false,pause=false}={}) {
  const log=openSync(join(directory,name+'-'+(peers.length+1)+'.log'),'a',0o600),url=new URL(cluster.url);url.searchParams.set('application_name',name);
  const child=spawn(process.execPath,[join(root,'fixtures/postgres-peer.mjs')],{cwd:root,env:{PATH:process.env.PATH||'',LANG:'C',TZ:'UTC',SRE_FIXTURE_DATABASE:url.href,SRE_FIXTURE_PEER:name,SRE_FIXTURE_API_TOKEN:apiToken,SRE_FIXTURE_DISPATCH_LOG:dispatchLog,SRE_FIXTURE_SCHEDULED:String(scheduled),SRE_FIXTURE_PAUSE:String(pause)},stdio:['ignore',log,log,'ipc']});
  const record={name,pid:child.pid,scheduled,pause,startedAt:new Date().toISOString()},pending=new Map(),events=[];report.peers.push(record);save();
  let readyResolve,readyReject;
  const ready=new Promise((accept,reject)=>{readyResolve=accept;readyReject=reject;});
  const exited=new Promise(accept=>child.once('exit',(code,signal)=>{
    record.exit={code,signal};closeSync(log);save();const error=new Error(name+' exited '+code+'/'+signal);readyReject(error);for(const task of pending.values())task.reject(error);pending.clear();accept(record.exit);
  }));
  child.on('error',error=>{readyReject(error);for(const task of pending.values())task.reject(error);pending.clear();});
  child.on('message',message=>{
    if(message.type==='ready'){record.port=message.port;record.owner=message.owner;readyResolve(message);save();}
    else if(message.type==='result'){
      const task=pending.get(message.id);if(!task)return;pending.delete(message.id);
      if(message.error)task.reject(Object.assign(new Error(message.error.message),message.error));else task.accept(message.result);
    } else events.push(message);
  });
  const instance={child,record,ready,events,async request(action,input={}) {
    await ready;const id=randomUUID();let timer;
    try{return await Promise.race([new Promise((accept,reject)=>{pending.set(id,{accept,reject});child.send({id,action,input},error=>{if(error)reject(error);});}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(name+' '+action+' timed out')),15000);})]);}
    finally{clearTimeout(timer);pending.delete(id);}
  },async stop(signal='SIGTERM'){
    if(child.exitCode===null&&child.signalCode===null)child.kill(signal);
    let timer;try{return await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(name+' did not stop gracefully'));},12000);})]);}finally{clearTimeout(timer);}
  }};
  peers.push(instance);return instance;
}
const tables=schema.filter(sql=>sql.startsWith('CREATE TABLE')).map(sql=>sql.match(/EXISTS (\w+)/)[1]);
const reset=()=>db.query('TRUNCATE '+tables.join(','));
const event=(id,extra={})=>({id,source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'P-'+id,status:'OPEN',at:Date.now(),payload:{problemId:'P-'+id,metrics:{codes:[],requests:3}},...extra});
const analysis=summary=>({summary,text:summary,hypotheses:[],changeAssessment:'unknown',candidateSha:null,evidenceIds:[],unknowns:[],nextSteps:[]});
try {
  cluster=await startPostgresCluster({directory:join(directory,'cluster'),bin});report.postgres={version:cluster.version,port:cluster.port,processes:cluster.processes};save();
  const adminUrl=new URL(cluster.url);adminUrl.searchParams.set('application_name','exercise-supervisor');db=await postgresDatabase(adminUrl.href);
  let a=peer('peer-a'),b=peer('peer-b');
  await check('simultaneous-empty-database-startup',async()=>{await Promise.all([a.ready,b.ready]);const count=Number((await db.query("SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'sre_%'"))[0].count);assert.equal(count,tables.length);return {pids:[a.record.pid,b.record.pid],tables:count};});
  await check('SCRAM-and-independent-TCP-sessions',async()=>{
    const bad=new URL(cluster.url);bad.password='deliberately-invalid-fixture-password';const client=new Client({connectionString:bad.href,connectionTimeoutMillis:2000});
    try{await assert.rejects(()=>client.connect(),error=>error.code==='28P01');}finally{await client.end().catch(()=>{});}
    const connections=await db.query("SELECT DISTINCT application_name,pid FROM pg_stat_activity WHERE application_name IN ('peer-a','peer-b')");
    assert.ok(connections.some(row=>row.application_name==='peer-a'));assert.ok(connections.some(row=>row.application_name==='peer-b'));
    return {authenticationRejected:true,connections};
  });
  await check('concurrent-idempotent-inbox-and-conflicting-replay',async()=>{
    await reset();const input=event('duplicate'),receipts=await Promise.all(Array.from({length:12},(_,i)=>(i%2?a:b).request('ingest',input)));
    assert.equal(receipts.filter(item=>!item.duplicate).length,1);assert.equal(new Set(receipts.map(item=>item.incidentId)).size,1);
    for(const table of ['sre_events','sre_incidents','sre_sessions','sre_jobs'])assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM '+table))[0].count),1);
    await assert.rejects(()=>b.request('ingest',{...input,payload:{...input.payload,changed:true}}),/reused with different content/);
    return {deliveries:12,committedEvents:1,incidentId:receipts[0].incidentId};
  });
  await check('independent-correlated-ticket-row-updates',async()=>{
    await reset();const input=event('correlated'),opened=await a.request('ingest',input),at=input.at;
    const ticket=(id,status,time)=>event('ticket-'+id+'-'+status,{source:'servicenow',issueKey:input.issueKey,status,at:time,payload:{sys_id:id.repeat(32),state:status==='OPEN'?'2':'6'}});
    await Promise.all([a.request('ingest',ticket('1','OPEN',at)),b.request('ingest',ticket('2','OPEN',at))]);
    await Promise.all([a.request('ingest',ticket('1','CLOSED',at+1)),b.request('ingest',{...input,id:'dt-close',status:'CLOSED',at:at+1})]);
    const [row]=await db.query('SELECT status,source_states FROM sre_incidents WHERE id=?',[opened.incidentId]),states=JSON.parse(row.source_states);
    assert.equal(row.status,'open');assert.equal(states['servicenow:'+'2'.repeat(32)].status,'OPEN');
    await b.request('ingest',ticket('2','CLOSED',at+2));assert.equal((await db.query('SELECT status FROM sre_incidents WHERE id=?',[opened.incidentId]))[0].status,'verifying');
    return {incidentId:opened.incidentId,openUntilLastTicketClosed:true,resolvedWithoutProof:false};
  });
  await check('peer-local-alerts-have-independent-owners-and-shared-alerts-deduplicate',async()=>{
    await reset();const first=await a.request('operations-notices',{enabled:true}),second=await b.request('operations-notices',{enabled:true});
    const notices=()=>db.query('SELECT text FROM sre_outbox ORDER BY created_at,id');
    try {
      await a.request('operations-fault',{message:'Synthetic failure on the first instance'});
      await a.request('observe-operations');await b.request('observe-operations');
      await Promise.all([a.request('observe-operations'),b.request('observe-operations')]);
      assert.equal((await notices()).length,1);assert.ok((await notices())[0].text.includes(first.runtimeId.slice(0,8)));
      await b.request('operations-fault',{message:'A different second-instance failure'});await b.request('observe-operations');
      assert.equal((await notices()).length,2);
      await a.request('operations-fault',{});await a.request('observe-operations');await b.request('observe-operations');
      const partial=await notices();assert.equal(partial.length,3);
      assert.equal(partial.filter(row=>row.text.includes('Instance checks recovered')).length,1);
      assert.ok(partial.find(row=>row.text.includes('Instance checks recovered')).text.includes(first.runtimeId.slice(0,8)));
      await b.request('operations-fault',{});await b.request('observe-operations');assert.equal((await notices()).length,4);
      await a.request('operations-source',{error:'Synthetic shared reader failure'});await b.request('operations-source',{error:'Synthetic shared reader failure'});
      await Promise.all([a.request('observe-operations'),b.request('observe-operations')]);assert.equal((await notices()).length,5);
      await a.request('operations-source',{});await Promise.all([a.request('observe-operations'),b.request('observe-operations')]);
      const final=await notices();assert.equal(final.length,6);assert.equal(final.filter(row=>row.text.includes('Shared service checks recovered')).length,1);
      return {runtimeIds:[first.runtimeId,second.runtimeId],instanceIds:[first.instanceId,second.instanceId],localFaultNotices:2,matchingLocalRecoveries:2,sharedFaultNotices:1,sharedRecoveries:1,concurrentObservers:true,actualTeamsMessagesSent:0};
    } finally {await a.request('operations-notices',{enabled:false});await b.request('operations-notices',{enabled:false});}
  });
  await check('peer-success-cannot-hide-an-instance-credential-failure',async()=>{
    await reset();await a.request('operations-notices',{enabled:true});await b.request('operations-notices',{enabled:true});
    try {
      await a.request('poll-auth',{enabled:true,denied:true});await b.request('poll-auth',{enabled:true,denied:false});
      await a.request('poll-source');await a.request('observe-operations');
      await b.request('poll-source');await b.request('observe-operations');
      const failed=await a.request('operations'),healthy=await b.request('operations');
      assert.equal(failed.state,'needs-attention');assert.ok(failed.conditions.some(item=>item.code==='instance_poll_error'&&item.message.includes('401')));assert.equal(healthy.state,'healthy');
      const checkpoint=JSON.parse((await db.query("SELECT value FROM sre_checkpoints WHERE id='github:auction-local'"))[0].value),notices=Number((await db.query('SELECT COUNT(*) AS count FROM sre_outbox'))[0].count);
      await a.request('poll-source');await a.request('observe-operations');await b.request('observe-operations');
      const retained=JSON.parse((await db.query("SELECT value FROM sre_checkpoints WHERE id='github:auction-local'"))[0].value);assert.equal(retained.until,checkpoint.until);assert.equal(retained.successAt,checkpoint.successAt);
      assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM sre_outbox'))[0].count),notices);
      for(const [agent,state] of [[a,'needs-attention'],[b,'healthy']]) {
        const response=await fetch('http://127.0.0.1:'+agent.record.port+'/api/status',{headers:{authorization:'Bearer '+apiToken}});assert.equal(response.status,200);
        const payload=await response.json();assert.equal(payload.operations.state,state);assert.equal(payload.connections.find(item=>item.source==='github').health.state,state);
      }
      await a.request('poll-auth',{enabled:true,denied:false});await a.request('poll-source');await a.request('observe-operations');
      assert.equal((await a.request('operations')).state,'healthy');
      await Promise.all([a.request('poll-source'),b.request('poll-source')]);
      const sources=await Promise.all([a.request('operations'),b.request('operations')]),shared=JSON.parse((await db.query("SELECT value FROM sre_checkpoints WHERE id='github:auction-local'"))[0].value);
      assert.equal(shared.until,Math.max(...sources.map(item=>item.localSources.find(source=>source.id==='github:auction-local').until)));
      const rows=await db.query('SELECT text FROM sre_outbox');assert.equal(rows.filter(row=>row.text.includes('Instance checks recovered')).length,1);
      return {productionGithubReadClient:true,syntheticHttp401:true,failedInstanceRemainedVisible:true,peerSharedSuccessPreserved:true,repeatedFailureDidNotToggleSharedAlert:true,httpConnectionBadgesScopedCorrectly:true,ownReadRequiredForRecovery:true,concurrentSuccessfulCursorsMonotonic:true,realVendorCalls:0};
    } finally {await a.request('poll-auth',{enabled:false});await b.request('poll-auth',{enabled:false});await a.request('operations-notices',{enabled:false});await b.request('operations-notices',{enabled:false});}
  });
  await check('a-fast-application-clock-cannot-reclaim-a-live-database-lease',async()=>{
    await reset();await a.request('ingest',event('fast-clock'));
    const job=await a.request('claim',{leaseMs:5000});assert.ok(job);
    const [row]=await db.query('SELECT lease_until FROM sre_jobs WHERE id=?',[job.id]);
    try {
      const clock=await b.request('clock-offset',{ms:120000});
      const stolen=await b.request('claim',{leaseMs:5000});
      assert.equal(stolen,null,'A fast application clock reclaimed a still-live job before its real lease expired');
      assert.ok(Number(row.lease_until)>Date.now());
      return {jobId:job.id,competingApplicationClockOffsetMs:clock.offsetMs,leaseStillLive:true,earlyReclaimRejected:true};
    } finally {await b.request('clock-offset',{ms:0});}
  });
  await check('slow-and-fast-application-clocks-cannot-delay-due-work-or-revive-expired-work',async()=>{
    await reset();
    try {
      await a.request('clock-offset',{ms:-120000});await b.request('clock-offset',{ms:120000});
      for(const agent of [a,b])assert.ok((await agent.request('operations')).conditions.some(item=>item.code==='clock_skew'));
      await b.request('ingest',event('opposite-clocks'));
      const job=await a.request('claim',{leaseMs:1000});assert.ok(job,'A slow application clock could not claim due work created by a fast peer');
      const until=Number((await db.query('SELECT lease_until FROM sre_jobs WHERE id=?',[job.id]))[0].lease_until);
      assert.ok(until>Date.now()&&until<Date.now()+2000,'The lease was not bound to current database time');
      await delay(Math.max(0,until-Date.now()+60));
      await assert.rejects(()=>a.request('checkpoint',{incidentId:job.incident_id,job,remoteState:{sessionId:'expired-slow-clock'}}),/lease/);
      await assert.rejects(()=>a.request('heartbeat',{jobId:job.id}),/lease/);
      await assert.rejects(()=>a.request('finish',{job,analysis:analysis('expired result from slow clock')}),/lease/);
      await a.request('fail',{job,message:'Expired slow clock must not publish this failure'});
      const [before]=await db.query('SELECT status,error,attempts FROM sre_jobs WHERE id=?',[job.id]);assert.equal(before.status,'running');assert.equal(before.error,null);
      const next=await b.request('claim');assert.equal(next.id,job.id);assert.equal(next.attempts,2);
      await b.request('finish',{job:next,analysis:analysis('database-clock-owned result')});
      assert.equal((await db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'done');
      return {jobId:job.id,applicationClockOffsetsMs:[-120000,120000],dueWorkClaimed:true,expiredCheckpointHeartbeatResultAndFailureRejected:true,reclaimedAttempts:2,assessmentCount:Number((await db.query('SELECT COUNT(*) AS count FROM sre_assessments'))[0].count)};
    } finally {await a.request('clock-offset',{ms:0});await b.request('clock-offset',{ms:0});}
  });
  await check('command-delivery-and-rollback-recovery-use-database-time-under-clock-skew',async()=>{
    await reset();const opened=await a.request('ingest',event('coordination-clocks'));
    const accepted=await a.request('accept-command',{text:'incidents'});
    const until=Number((await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now'))[0].now)+1000;
    await db.query("UPDATE sre_commands SET status='running',lease_until=? WHERE id=?",[until,accepted.eventId]);
    await db.query("INSERT INTO sre_outbox(id,incident_id,text,status,attempts,next_at,lease_owner,lease_until,created_at) VALUES('clock-delivery',?,'Synthetic pending delivery','sending',1,?,'fixture-sender',?,?)",[opened.incidentId,until-1000,until,until-1000]);
    for(const status of ['checking','dispatching'])await db.query("INSERT INTO sre_rollbacks(id,incident_id,proposal,nonce_hash,expires_at,status,lease_until,created_at) VALUES(?,?,'{}','synthetic',?,?,?,?)",['clock-'+status,opened.incidentId,until+600000,status,until,until-1000]);
    try {
      await b.request('clock-offset',{ms:120000});
      assert.equal(await b.request('command'),false);assert.equal(await b.request('outbox'),false);await b.request('rollback-recover');
      assert.equal((await db.query('SELECT status FROM sre_commands WHERE id=?',[accepted.eventId]))[0].status,'running');
      assert.equal((await db.query("SELECT status FROM sre_outbox WHERE id='clock-delivery'"))[0].status,'sending');
      assert.deepEqual((await db.query("SELECT status FROM sre_rollbacks ORDER BY id")).map(row=>row.status),['checking','dispatching']);
      await delay(Math.max(0,until-Date.now()+60));await a.request('clock-offset',{ms:-120000});
      assert.equal(await a.request('command'),true);assert.equal(await a.request('outbox'),false);await a.request('rollback-recover');
      assert.equal((await db.query('SELECT status FROM sre_commands WHERE id=?',[accepted.eventId]))[0].status,'done');
      assert.equal((await db.query("SELECT status FROM sre_outbox WHERE id='clock-delivery'"))[0].status,'unknown');
      assert.deepEqual((await db.query("SELECT status FROM sre_rollbacks ORDER BY id")).map(row=>row.status),['approved','unknown']);
      return {applicationClockOffsetsMs:[-120000,120000],liveCommandsAndWritesNotReclaimedEarly:true,expiredCommandResumed:true,expiredDeliveryAndDispatchQuarantined:true,checkingActionRequeued:true,teamsTransportConfigured:false};
    } finally {await a.request('clock-offset',{ms:0});await b.request('clock-offset',{ms:0});}
  });
  await check('approval-and-dispatch-deadlines-use-database-time-across-skewed-peers',async()=>{
    await reset();const seeded=await a.request('seed');await a.request('investigate');
    const principal={verified:true,tenant:'synthetic',conversationId:'test-conversation',userId:'local-operator'};
    try {
      await a.request('clock-offset',{ms:-120000});await b.request('clock-offset',{ms:120000});
      const startedAt=Date.now(),proposal=await a.request('propose',{incidentId:seeded.incidentId,principal});assert.equal(proposal.eligible,true);
      assert.ok(proposal.expiresAt>=startedAt+599000&&proposal.expiresAt<=Date.now()+601000);
      await b.request('approve',{id:proposal.id,nonce:proposal.text.split(' ').at(-1),principal});
      const [row]=await db.query('SELECT approved_at FROM sre_rollbacks WHERE id=?',[proposal.id]);
      assert.ok(Number(row.approved_at)>=startedAt&&Number(row.approved_at)<=Date.now());
      await a.request('execute');
      const [dispatched]=await db.query('SELECT status,lease_until FROM sre_rollbacks WHERE id=?',[proposal.id]);
      assert.equal(dispatched.status,'dispatched');assert.ok(Number(dispatched.lease_until)>Date.now()+170000);
      return {requestId:proposal.id,proposerApplicationClockOffsetMs:-120000,approverApplicationClockOffsetMs:120000,approvalAndLeaseTimesBoundToDatabase:true,dispatchTransportSynthetic:true};
    } finally {await a.request('clock-offset',{ms:0});await b.request('clock-offset',{ms:0});}
  });
  await check('lease-competition-expiry-and-stale-result-rejection',async()=>{
    await reset();await a.request('ingest',event('lease'));const claims=await Promise.all([a.request('claim',{leaseMs:1000}),b.request('claim',{leaseMs:1000})]);assert.equal(claims.filter(Boolean).length,1);
    const index=claims[0]?0:1,old=[a,b][index],replacement=[a,b][1-index],job=claims[index],until=Number((await db.query('SELECT lease_until FROM sre_jobs WHERE id=?',[job.id]))[0].lease_until);
    await delay(Math.max(0,until-Date.now()+60));const next=await replacement.request('claim');assert.equal(next.id,job.id);assert.equal(next.attempts,2);
    await assert.rejects(()=>old.request('finish',{job,analysis:analysis('obsolete result')}),/lease lost/);
    assert.equal((await db.query('SELECT analysis FROM sre_incidents WHERE id=?',[job.incident_id]))[0].analysis,null);
    return {jobId:job.id,winner:old.record.name,reclaimedBy:replacement.record.name,attempts:2};
  });
  await check('lease-expiry-while-publication-waits-for-an-incident-lock',async()=>{
    await reset();await a.request('ingest',event('blocked-publication'));const job=await a.request('claim',{leaseMs:1000});
    const blocker=new Client({connectionString:cluster.url});await blocker.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM sre_incidents WHERE id=$1 FOR UPDATE',[job.incident_id]);
    let finishing,reclaimed;
    try {
      finishing=a.request('finish',{job,analysis:analysis('must never publish after expiry'),remoteState:{sessionId:'stale-session'}}).then(value=>({value}),error=>({error}));
      await waitFor('publication blocked on the incident row',async()=>{const rows=await db.query("SELECT query FROM pg_stat_activity WHERE application_name='peer-a' AND wait_event_type='Lock'");return rows.some(row=>row.query.includes('SELECT analysis,revision'));});
      const until=Number((await db.query('SELECT lease_until FROM sre_jobs WHERE id=?',[job.id]))[0].lease_until);await delay(Math.max(0,until-Date.now()+60));
      reclaimed=b.request('claim').then(value=>({value}),error=>({error}));await delay(100);
    } finally {await blocker.query('ROLLBACK');await blocker.end();}
    const [finished,next]=await Promise.all([finishing,reclaimed]);assert.ok(finished.error,'An expired investigator published after its incident-row wait');assert.match(finished.error.message,/lease/);
    assert.equal(next.value.id,job.id);assert.equal((await db.query('SELECT analysis FROM sre_incidents WHERE id=?',[job.incident_id]))[0].analysis,null);assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM sre_outbox'))[0].count),0);
    return {jobId:job.id,expiredResultRejected:true,reclaimedSameJob:true,noStaleNotification:true};
  });
  await check('remote-session-checkpoint-is-fenced-after-lease-reclamation',async()=>{
    await reset();await a.request('ingest',event('session-fence'));const old=await a.request('claim',{leaseMs:1000});
    const until=Number((await db.query('SELECT lease_until FROM sre_jobs WHERE id=?',[old.id]))[0].lease_until);await delay(Math.max(0,until-Date.now()+60));const next=await b.request('claim');
    await b.request('checkpoint',{incidentId:next.incident_id,job:next,remoteState:{sessionId:'current-session',streamIndex:8}});
    await assert.rejects(()=>a.request('checkpoint',{incidentId:old.incident_id,job:old,remoteState:{sessionId:'stale-session',streamIndex:1}}),/lease/);
    assert.deepEqual(JSON.parse((await db.query('SELECT remote_state FROM sre_sessions WHERE incident_id=?',[old.incident_id]))[0].remote_state),{sessionId:'current-session',streamIndex:8});
    return {currentSessionPreserved:true,staleCheckpointRejected:true};
  });
  await check('lease-expiry-during-the-final-notification-write-rolls-back-every-result',async()=>{
    await reset();await a.request('ingest',event('blocked-outbox'));const job=await a.request('claim',{leaseMs:1000});
    const blocker=new Client({connectionString:cluster.url});await blocker.connect();await blocker.query('BEGIN');await blocker.query('LOCK TABLE sre_outbox IN SHARE MODE');
    let finishing;
    try {
      finishing=a.request('finish',{job,analysis:analysis('late notification must roll back'),remoteState:{sessionId:'must-rollback'}}).then(value=>({value}),error=>({error}));
      await waitFor('result publication blocked at its notification insert',async()=>{const rows=await db.query("SELECT query FROM pg_stat_activity WHERE application_name='peer-a' AND wait_event_type='Lock'");return rows.some(row=>row.query.includes('INSERT INTO sre_outbox'));});
      const until=Number((await db.query('SELECT lease_until FROM sre_jobs WHERE id=?',[job.id]))[0].lease_until);await delay(Math.max(0,until-Date.now()+60));
    } finally {await blocker.query('ROLLBACK');await blocker.end();}
    const finished=await finishing;assert.ok(finished.error,'An expired investigator committed after a late outbox lock wait');assert.match(finished.error.message,/lease/);
    assert.equal((await db.query('SELECT analysis FROM sre_incidents WHERE id=?',[job.incident_id]))[0].analysis,null);
    assert.equal((await db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'running');
    assert.deepEqual(JSON.parse((await db.query('SELECT remote_state FROM sre_sessions WHERE incident_id=?',[job.incident_id]))[0].remote_state),{});
    for(const table of ['sre_outbox','sre_assessments'])assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM '+table))[0].count),0);
    return {lateCommitRejected:true,analysisSessionAuditAndNotificationRolledBack:true};
  });
  await check('operator-retry-race-commits-one-replacement-and-audit',async()=>{
    await reset();const receipt=await a.request('ingest',event('retry')),job=(await db.query('SELECT * FROM sre_jobs'))[0];
    await db.query("UPDATE sre_jobs SET status='dead',attempts=3,error='synthetic reader outage' WHERE id=?",[job.id]);
    const input={serviceKey:'auction-local',incidentId:receipt.incidentId,jobId:job.id,requestId:'same-operator-request',reason:'Test reader restored',actor:{kind:'operator-api',id:'fixture-operator'}};
    const results=await Promise.all([a.request('retry',input),b.request('retry',input)]);
    assert.equal(results.filter(item=>item.duplicate).length,1);assert.equal(new Set(results.map(item=>item.replacementJobId)).size,1);
    assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM sre_job_retries'))[0].count),1);assert.equal(Number((await db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status='pending'"))[0].count),1);
    const [original]=await db.query('SELECT status,attempts,error FROM sre_jobs WHERE id=?',[job.id]);
    assert.equal(original.status,'retried');assert.equal(Number(original.attempts),3);assert.equal(original.error,'synthetic reader outage');
    return {replacementJobId:results[0].replacementJobId,receipts:1,auditPreserved:true};
  });
  let submitted;
  await check('competing-approved-rollback-executors-submit-once',async()=>{
    await reset();const seeded=await a.request('seed');await a.request('investigate');
    const principal={verified:true,tenant:'synthetic',conversationId:'test-conversation',userId:'local-operator'};
    const proposal=await a.request('propose',{incidentId:seeded.incidentId,principal});assert.equal(proposal.eligible,true,proposal.text);
    const command=proposal.text.match(/approve (\S+) (\S+)/);assert.ok(command);await a.request('approve',{id:command[1],nonce:command[2],principal});
    await Promise.all([a.request('execute'),b.request('execute')]);
    const dispatches=readFileSync(dispatchLog,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.requestId===proposal.id);assert.equal(dispatches.length,1);assert.equal(dispatches[0].requestId,proposal.id);
    assert.equal((await db.query('SELECT status FROM sre_rollbacks WHERE id=?',[proposal.id]))[0].status,'dispatched');
    submitted={id:proposal.id,incidentId:seeded.incidentId};
    return {requestId:proposal.id,dispatches:1,transport:'local fixture',recovered:false};
  });
  await check('concurrent-no-change-verifications-reconcile-one-request-without-closing-the-incident',async()=>{
    const [row]=await db.query('SELECT * FROM sre_rollbacks WHERE id=?',[submitted.id]),proposal=JSON.parse(row.proposal);
    const deployments=(await db.query('SELECT payload FROM sre_deployments ORDER BY occurred_at DESC')).map(item=>JSON.parse(item.payload)),current=releases(deployments)[0];
    const proof={id:'concurrent-no-change',kind:'rollback_no_change',incidentId:submitted.incidentId,rollbackRequestId:row.id,requestHash:'sha256:'+hash(proposalWorkflowRequest(proposal,{approvedAt:Number(row.approved_at),expiresAt:Number(row.expires_at)})),provider:'github',runId:'42',terminal:true,deploymentStarted:false,outcome:'blocked',reason:'Synthetic workflow rejected before deployment',observedAt:Date.now(),environment:proposal.environment,sha:current.sha,artifact:current.artifact,deploymentId:current.deploymentId??current.id??'',deploymentAt:current.at,evidenceUrl:'https://synthetic-verifier.invalid/native-pg'};
    const input={id:proof.id,source:'verification',serviceKey:proposal.serviceKey,kind:'rollback_result',incidentId:submitted.incidentId,at:proof.observedAt,payload:proof};
    const results=await Promise.all([a.request('ingest',input),b.request('ingest',input)]);assert.equal(results.filter(item=>item.duplicate).length,1);
    assert.equal((await db.query('SELECT status FROM sre_rollbacks WHERE id=?',[row.id]))[0].status,'not_executed');assert.equal((await db.query('SELECT status FROM sre_incidents WHERE id=?',[submitted.incidentId]))[0].status,'open');
    assert.equal(Number((await db.query("SELECT COUNT(*) AS count FROM sre_events WHERE kind='rollback_result'"))[0].count),1);
    assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM sre_outbox WHERE id=?',['rollback:'+row.id+':not_executed']))[0].count),1);
    assert.equal(readFileSync(dispatchLog,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.requestId===row.id).length,1);
    return {requestId:row.id,concurrentCallbacks:2,committedResultEvents:1,notices:1,incidentStillOpen:true,providerRunSynthetic:true};
  });
  await check('an-idle-database-connection-loss-does-not-crash-the-agent',async()=>{
    const idle=await db.query("SELECT pid FROM pg_stat_activity WHERE application_name='peer-a' AND state='idle' LIMIT 1");assert.equal(idle.length,1);
    await db.query('SELECT pg_terminate_backend(?::integer)',[idle[0].pid]);await delay(150);
    assert.equal(a.child.exitCode,null,'Idle PostgreSQL connection loss crashed the agent');
    assert.equal(a.child.signalCode,null);
    const response=await fetch('http://127.0.0.1:'+a.record.port+'/health');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
    return {terminatedBackendPid:idle[0].pid,agentPid:a.record.pid,healthReadRecovered:true};
  });
  await check('an-interrupted-inbox-transaction-rolls-back-and-recovers-on-identical-redelivery',async()=>{
    await reset();const input=event('connection-loss'),before=a.events.length;
    const receipt=a.request('paused-ingest',input).then(value=>({value}),error=>({error}));
    const paused=await waitFor('inbox insert paused before commit',async()=>a.events.slice(before).find(item=>item.type==='transaction-paused'));
    await db.query('SELECT pg_terminate_backend(?::integer)',[paused.backendPid]);await delay(100);
    assert.equal(a.child.exitCode,null,'An in-transaction disconnect crashed the agent');
    await a.request('release-transaction',{requestId:paused.requestId});const interrupted=await receipt;assert.ok(interrupted.error);assert.equal(interrupted.error.status,503);
    for(const table of ['sre_events','sre_incidents','sre_jobs'])assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM '+table))[0].count),0);
    const recovered=await a.request('ingest',input);assert.equal(recovered.duplicate,false);
    const replayed=await b.request('ingest',input);assert.equal(replayed.duplicate,true);assert.equal(recovered.incidentId,replayed.incidentId);
    return {terminatedBackendPid:paused.backendPid,agentSurvived:true,retryableStorageError:503,partialWrites:0,committedEventsAfterRetry:1};
  });
  await check('immediate-database-shutdown-and-WAL-recovery-preserve-only-committed-work',async()=>{
    await reset();
    const committed=event('database-committed'),uncommitted=event('database-uncommitted'),opened=await a.request('ingest',committed),job=await a.request('claim',{leaseMs:1000});
    const checkpoint={sessionId:'synthetic-persisted-before-database-outage',streamIndex:4};
    await a.request('checkpoint',{incidentId:opened.incidentId,job,remoteState:checkpoint});
    const [session]=await db.query('SELECT agent_id FROM sre_sessions WHERE incident_id=?',[opened.incidentId]);
    const settings=cluster.processes.filter(item=>item.name==='postgres').at(-1).settings;
    assert.equal(settings.fsync,'on');assert.equal(settings.synchronous_commit,'on');assert.equal(settings.full_page_writes,'on');assert.equal(settings.listen_addresses,'127.0.0.1');
    const before=a.events.length,pending=a.request('paused-ingest',uncommitted).then(value=>({value}),error=>({error}));
    const paused=await waitFor('an uncommitted inbox row before immediate shutdown',async()=>a.events.slice(before).find(item=>item.type==='transaction-paused'));
    const oldPid=cluster.processes.filter(item=>item.name==='postgres').at(-1).pid,started=Date.now();
    await cluster.immediateStop();await a.request('release-transaction',{requestId:paused.requestId});
    const interrupted=await pending;assert.ok(interrupted.error);assert.equal(interrupted.error.status,503);
    const unavailable=await fetch('http://127.0.0.1:'+a.record.port+'/health',{signal:AbortSignal.timeout(3000)});
    assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('retry-after'),'5');assert.equal((await unavailable.json()).error,'SRE storage is temporarily unavailable');
    assert.equal(a.child.exitCode,null);assert.equal(b.child.exitCode,null);
    // The actual running-job lease must expire during the outage. No synthetic
    // clock movement or fixture edit to its stored deadline is used here.
    await delay(Math.max(0,1100-(Date.now()-started)));
    const restarted=await cluster.restart();assert.notEqual(restarted.pid,oldPid);
    const recovered=await fetch('http://127.0.0.1:'+a.record.port+'/health',{signal:AbortSignal.timeout(3000)});assert.equal(recovered.status,200);
    assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM sre_events'))[0].count),1);
    assert.equal((await b.request('ingest',committed)).duplicate,true);
    assert.equal((await db.query('SELECT remote_state FROM sre_sessions WHERE incident_id=?',[opened.incidentId]))[0].remote_state,JSON.stringify(checkpoint));
    assert.equal(await b.request('investigate'),true);
    const [completed]=await db.query('SELECT status,attempts FROM sre_jobs WHERE id=?',[job.id]);assert.equal(completed.status,'done');assert.equal(Number(completed.attempts),2);
    const response=await fetch('http://127.0.0.1:'+b.record.port+'/api/incidents/'+opened.incidentId,{headers:{authorization:'Bearer '+apiToken},signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);
    const context=await response.json();assert.equal(context.session.agent_id,session.agent_id);assert.deepEqual(context.session.remote_state,checkpoint);assert.equal(context.incident.status,'open');
    const databaseLog=readFileSync(join(directory,'cluster/postgres.log'),'utf8');
    assert.match(databaseLog,/received immediate shutdown request/);assert.match(databaseLog,/database system was interrupted/);assert.match(databaseLog,/redo starts at/);assert.match(databaseLog,/redo done at/);
    return {oldPostgresPid:oldPid,restartedPostgresPid:restarted.pid,agentPids:[a.record.pid,b.record.pid],healthDuringOutage:503,healthAfterRestart:200,committedEvents:1,uncommittedEvents:0,agentId:session.agent_id,jobId:job.id,reclaimedAttempts:2,sessionCheckpointSynthetic:true,walRecoveryObserved:true,durableSettings:settings,downtimeMs:Date.now()-started};
  });
  await a.stop();await b.stop();await reset();
  a=peer('peer-a',{scheduled:true,pause:true});await a.ready;
  await check('scheduled-investigator-SIGKILL-and-durable-session-recovery',async()=>{
    const receipt=await a.request('ingest',event('crash')),started=await waitFor('first process investigation',async()=>a.events.find(item=>item.type==='investigation-started'));
    b=peer('peer-b',{scheduled:true});await b.ready;const killed=await a.stop('SIGKILL');assert.equal(killed.signal,'SIGKILL');
    const completed=await waitFor('other process reclaims and completes the interrupted job',async()=>{const rows=await db.query('SELECT * FROM sre_jobs WHERE incident_id=?',[receipt.incidentId]);return rows.find(row=>row.status==='done'&&Number(row.attempts)===2);},12000);
    const response=await fetch('http://127.0.0.1:'+b.record.port+'/api/incidents/'+receipt.incidentId,{headers:{authorization:'Bearer '+apiToken}});assert.equal(response.status,200);const context=await response.json();
    assert.equal(context.session.agent_id,started.agentId);assert.equal(context.session.remote_state.sessionId,started.remoteState.sessionId);assert.equal(context.session.remote_state.streamIndex,2);
    assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM sre_assessments'))[0].count),1);assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM sre_outbox'))[0].count),1);assert.equal(context.incident.status,'open');
    return {killedPid:a.record.pid,recoveredPid:b.record.pid,jobId:completed.id,attempts:Number(completed.attempts),agentId:started.agentId,remoteSessionSynthetic:true,onePublishedResult:true};
  });
  await a.stop();await b.stop();await reset();
  a=peer('peer-a');b=peer('peer-b');await Promise.all([a.ready,b.ready]);
  await check('shared-provider-retry-survives-process-replacement-and-application-clock-skew',async()=>{
    const limited=await a.request('retry-probe',{limited:true});assert.equal(limited.status,429);assert.equal(limited.requests,1);assert.ok(limited.hold.retryAfterMs>0);
    await b.request('clock-offset',{ms:120000});
    const other=await b.request('retry-probe');assert.equal(other.status,429);assert.equal(other.requests,0);assert.equal(other.hold.until,limited.hold.until);assert.ok(other.applicationNow-other.coordinationNow>119000);
    const oldPid=a.record.pid;assert.equal((await a.stop()).code,0);a=peer('peer-a');await a.ready;
    const replacement=await a.request('retry-probe');assert.equal(replacement.status,429);assert.equal(replacement.requests,0);assert.equal(replacement.hold.until,limited.hold.until);
    await delay(Math.max(0,limited.hold.until-Date.now())+50);
    const expired=await b.request('retry-probe');assert.equal(expired.status,200);assert.equal(expired.requests,1);assert.equal(expired.hold,null);
    return {limitedProcessPid:oldPid,replacementPid:a.record.pid,otherPeerPid:b.record.pid,deadline:limited.hold.until,observedLimitedRequests:1,blockedPeerRequests:0,blockedReplacementRequests:0,requestsAfterDatabaseDeadline:1,applicationOffsetMs:120000,realVendorCalls:0};
  });
  await a.stop();await b.stop();await reset();
  await check('reviewed-provider-facts-commit-before-concurrent-restore-release',async()=>{
    const store=await new SreStore(db).initialize(),actor={kind:'local-operator',id:'synthetic recovery operator'},now=await store.coordinationNow();
    const services=[{key:'retry-native',tenant:'retry-fixture',github:{enabled:false,base:'https://retry-native-fixture.invalid',retryScope:'snapshot-account'}}];
    await prepareRestore(store,{restoreId:'native-retry-restore',backupSha256:'a'.repeat(64),backupAt:now-60000,reason:'Prepare isolated fact-recovery test',actor,offline:true});
    const gate=providerRetryGate(store,configuredRetryDescriptor(services[0],'github','api',{allowDisabled:true}));
    const input={restoreId:'native-retry-restore',requestId:'native-retry-review',reason:'Review independent synthetic provider record',reviewedAt:await store.coordinationNow(),evidenceUrls:['https://synthetic-verifier.invalid/retry/native'],facts:[{serviceKey:'retry-native',connector:'github',kind:'api',scopeHash:gate.scopeHash,observedAt:now,until:now+60000,status:429}],actor};
    const blocker=new Client({connectionString:cluster.url,application_name:'provider-facts-blocker'});await blocker.connect();
    let importing,releasing,importSettled=false,releaseSettled=false;
    try {
      await blocker.query('BEGIN');await blocker.query('LOCK TABLE sre_provider_retries IN SHARE MODE');
      importing=restoreProviderRetries(store,services,input).then(value=>{importSettled=true;return {value};},error=>{importSettled=true;return {error};});
      await waitFor('reviewed import waiting for the retry table',async()=>{const rows=await db.query("SELECT query FROM pg_stat_activity WHERE wait_event_type='Lock'");return rows.some(row=>row.query.startsWith('INSERT INTO sre_provider_retries'));});
      releasing=releaseRestore(store,{restoreId:input.restoreId,requestId:'native-retry-release',reason:'Reviewed missing interval after provider facts',actor,observedAt:await store.coordinationNow(),evidenceUrls:input.evidenceUrls}).then(value=>{releaseSettled=true;return {value};},error=>{releaseSettled=true;return {error};});
      await waitFor('release waiting for the import-owned restore fence',async()=>{const rows=await db.query("SELECT query FROM pg_stat_activity WHERE wait_event_type='Lock'");return rows.some(row=>row.query.startsWith('SELECT value FROM sre_checkpoints')&&row.query.includes('FOR UPDATE'));});
      assert.equal(importSettled,false);assert.equal(releaseSettled,false);assert.equal((await store.restoreFence()).active,true);
    } finally {await blocker.query('ROLLBACK').catch(()=>{});await blocker.end();}
    const imported=await importing,released=await releasing;assert.ifError(imported.error);assert.ifError(released.error);
    assert.equal(imported.value.providerVerified,false);assert.equal(released.value.active,false);assert.ok(imported.value.appliedAt<=released.value.release.releasedAt);
    assert.equal((await gate.read()).until,input.facts[0].until);assert.equal((await restoreProviderRetries(store,services,input)).duplicate,true);
    const afterRelease=await store.coordinationNow();
    await assert.rejects(()=>restoreProviderRetries(store,services,{...input,requestId:'new-after-release',reviewedAt:afterRelease}),/active restore hold/);
    return {retryTableLockObserved:true,releaseFenceWaitObserved:true,receiptAndDeadlineCommittedBeforeRelease:true,originalDeadline:input.facts[0].until,appliedAt:imported.value.appliedAt,releasedAt:released.value.release.releasedAt,duplicateAfterRelease:true,newFactsAfterReleaseRejected:true,providerVerified:false,realVendorCalls:0};
  });
  await reset();a=peer('peer-a');b=peer('peer-b');await Promise.all([a.ready,b.ready]);
  await check('successful-GitHub-quota-survives-process-replacement-and-application-clock-skew',async()=>{
    const scope='successful-quota-account',accepted=await a.request('retry-probe',{scope,exhausted:true});
    assert.equal(accepted.status,200);assert.equal(accepted.requests,1);assert.equal(accepted.hold.status,200);assert.ok(accepted.hold.retryAfterMs>0);
    await b.request('clock-offset',{ms:120000});
    const other=await b.request('retry-probe',{scope});assert.equal(other.status,429);assert.equal(other.providerStatus,200);assert.equal(other.requests,0);assert.equal(other.hold.until,accepted.hold.until);assert.ok(other.applicationNow-other.coordinationNow>119000);
    const oldPid=a.record.pid;assert.equal((await a.stop()).code,0);a=peer('peer-a');await a.ready;
    const replacement=await a.request('retry-probe',{scope});assert.equal(replacement.status,429);assert.equal(replacement.providerStatus,200);assert.equal(replacement.requests,0);assert.equal(replacement.hold.until,accepted.hold.until);
    await delay(Math.max(0,accepted.hold.until-Date.now())+50);
    const expired=await b.request('retry-probe',{scope});assert.equal(expired.status,200);assert.equal(expired.requests,1);assert.equal(expired.hold,null);
    return {acceptedProcessPid:oldPid,replacementPid:a.record.pid,otherPeerPid:b.record.pid,deadline:accepted.hold.until,acceptedResponseStatus:200,storedProviderStatus:200,deferredLogicalStatus:429,acceptedRequests:1,blockedPeerRequests:0,blockedReplacementRequests:0,requestsAfterDatabaseDeadline:1,applicationOffsetMs:120000,realVendorCalls:0};
  });
  if(JSON.stringify(fingerprint())!==JSON.stringify(sources))throw new Error('Sources changed during the exercise; do not treat this as one revision');
  report.status='passed';
} catch(error){report.status='failed';report.failures.push({message:error.message,stack:error.stack});process.exitCode=1;}
finally {
  for(const instance of peers){try{await instance.stop();}catch(error){report.failures.push({cleanup:error.message});report.status='failed';process.exitCode=1;}}
  await db?.close().catch(error=>{report.failures.push({cleanup:error.message});report.status='failed';process.exitCode=1;});
  await cluster?.stop().catch(error=>{report.failures.push({cleanup:error.message});report.status='failed';process.exitCode=1;});
  report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,passed:report.cases.filter(item=>item.passed).length,failures:report.failures.length,report:reportPath}));
}
