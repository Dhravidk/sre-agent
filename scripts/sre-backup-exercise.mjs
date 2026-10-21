import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes,randomUUID,createHash,createHmac } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync,writeFileSync,readFileSync,existsSync,openSync,closeSync,statSync,readdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { startPostgresCluster } from '../fixtures/postgres-cluster.mjs';
import { postgresDatabase } from '../src/sre/database.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { prepareRestore,releaseRestore } from '../src/sre/restore-recovery.mjs';
import { hash } from '../src/sre/security.mjs';
import { proposalWorkflowRequest } from '../src/sre/workflow-contract.mjs';
import { releases } from '../src/sre/deployments.mjs';
import { ApiClient } from '../src/sre/http-client.mjs';
import { GithubConnector } from '../src/sre/connectors.mjs';
import { providerRetryGate } from '../src/sre/provider-retry.mjs';

const args=process.argv.slice(2),binAt=args.indexOf('--bin'),bin=binAt>=0?args[binAt+1]:process.env.SRE_TEST_PG_BIN;
const allowed=args.filter((_,i)=>binAt<0||(i!==binAt&&i!==binAt+1));
if(!bin||allowed.some(arg=>arg!=='--unsafe-replay-probe'))throw new Error('Use sre:backup-exercise --bin /absolute/postgresql/bin [--unsafe-replay-probe]');
process.umask(0o077);
const directory=resolve('.local/backup-runs',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));mkdirSync(directory,{recursive:true});
const reportPath=join(directory,'report.json'),dispatchLog=join(directory,'provider-dispatches.jsonl'),sendLog=join(directory,'teams-deliveries.jsonl'),archive=join(directory,'agent.pgdump'),apiToken=randomBytes(24).toString('hex');
const proofKey=randomBytes(32).toString('hex');
const report={mode:'isolated-native-postgres-backup-restore',status:'running',startedAt:new Date().toISOString(),directory,supervisorPid:process.pid,unsafeReplayProbe:args.includes('--unsafe-replay-probe'),stages:[],clusters:[],peers:[],tools:[],failures:[],limitations:['Actual pg_dump/pg_restore into a separately initialized owned PostgreSQL cluster, real TCP/SCRAM, and separate agent processes.','Provider dispatch and Teams delivery append to independent local fixture logs; no live vendor/model or actual deployment occurs.','Logical single-database backup. No roles/tablespaces, physical WAL/PITR backup, RDS, TLS/IAM, off-host storage, or production recovery validation.']};
const save=()=>writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
const stage=(name,evidence={})=>{report.stages.push({name,at:new Date().toISOString(),...evidence});save();};
const files={};
function walk(path){for(const item of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const name=join(path,item.name);if(item.isDirectory())walk(name);else if(item.isFile())files[name]=createHash('sha256').update(readFileSync(name)).digest('hex');}}
for(const path of ['src','fixtures','scripts','config'])walk(path);
for(const name of ['package.json','pnpm-lock.yaml'])files[name]=createHash('sha256').update(readFileSync(name)).digest('hex');
report.sourceFingerprint=createHash('sha256').update(JSON.stringify(files)).digest('hex');writeFileSync(join(directory,'source-fingerprints.json'),JSON.stringify(files,null,2)+'\n');save();
const clusters=[],peers=[],databases=[];
const logRows=path=>existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const retryDescriptor=scope=>({tenant:'retry-fixture',provider:'github',endpoint:'https://retry-postgres-fixture.invalid',scope});
const retryResponse=seconds=>new Response('[]',{status:429,headers:{'content-type':'application/json','retry-after':String(seconds)}});
async function observeRetry(client,gate) {
  const originalClock=client.clock;let observedAt;
  client.clock=async()=>{observedAt=await originalClock();return observedAt;};
  await assert.rejects(()=>client.request('/read'),error=>error.status===429);
  const hold=await gate.read();assert.ok(hold?.until);return {...hold,observedAt};
}
async function nativeTool(name,cluster,extra) {
  const url=new URL(cluster.url),passwordFile=join(directory,name+'-'+report.tools.length+'.pgpass');
  writeFileSync(passwordFile,[url.hostname,url.port,url.pathname.slice(1),url.username,cluster.password].join(':')+'\n',{mode:0o600});
  const log=openSync(join(directory,name+'.log'),'a',0o600);
  const child=spawn(join(resolve(bin),name),['--host',url.hostname,'--port',url.port,'--username',url.username,'--dbname',url.pathname.slice(1),...extra],{env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',PGPASSFILE:passwordFile,PGCONNECT_TIMEOUT:'5'},stdio:['ignore',log,log]});
  const record={name,pid:child.pid,startedAt:new Date().toISOString()};report.tools.push(record);save();
  try{const [code,signal]=await once(child,'exit');record.exit={code,signal};assert.equal(code,0,name+' failed; inspect its private retained log');}
  finally{closeSync(log);save();}
}
async function recoveryTool(action,profile,cluster,attestation) {
  const log=openSync(join(directory,'retry-recovery-cli-'+report.tools.length+'.log'),'a',0o600),env={PATH:process.env.PATH||'',LANG:'C',TZ:'UTC',SRE_CONFIG:profile};
  if(cluster){const url=new URL(cluster.url);url.searchParams.set('application_name','restore-retry-facts-cli');env.DATABASE_URL=url.href;}
  const child=spawn(process.execPath,[resolve('scripts/sre-restore.mjs'),action,...(attestation?['--attestation',attestation]:[])],{env,stdio:['ignore','pipe',log]});
  const record={name:'sre:restore '+action,pid:child.pid,startedAt:new Date().toISOString()};report.tools.push(record);save();let bytes=0,expired=false;const chunks=[];
  const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},15000);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>256*1024)child.kill('SIGKILL');else chunks.push(chunk);});
  try{const [code,signal]=await once(child,'exit');record.exit={code,signal};assert.equal(code,0,'Restore administration CLI failed; inspect its private log');assert.equal(expired,false);return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  finally{clearTimeout(timer);closeSync(log);save();}
}
function peer(cluster,label) {
  const descriptor=openSync(join(directory,label+'.log'),'a',0o600),name=label==='source'?'peer-a':'peer-b';
  const child=spawn(process.execPath,[resolve('fixtures/postgres-peer.mjs')],{env:{PATH:process.env.PATH||'',LANG:'C',TZ:'UTC',SRE_FIXTURE_DATABASE:cluster.url,SRE_FIXTURE_PEER:name,SRE_FIXTURE_API_TOKEN:apiToken,SRE_FIXTURE_DISPATCH_LOG:dispatchLog,SRE_FIXTURE_SEND_LOG:sendLog,SRE_FIXTURE_PROOF_KEY:proofKey},stdio:['ignore',descriptor,descriptor,'ipc']});
  const record={label,pid:child.pid},pending=new Map();report.peers.push(record);save();
  let acceptReady,rejectReady;const ready=new Promise((accept,reject)=>{acceptReady=accept;rejectReady=reject;});
  const exit=new Promise(accept=>child.once('exit',(code,signal)=>{record.exit={code,signal};closeSync(descriptor);const error=new Error(label+' exited');rejectReady(error);for(const task of pending.values())task.reject(error);pending.clear();save();accept(record.exit);}));
  child.on('error',rejectReady);
  child.on('message',message=>{
    if(message.type==='ready'){record.port=message.port;acceptReady(message);}
    if(message.type==='result'){const task=pending.get(message.id);if(!task)return;pending.delete(message.id);message.error?task.reject(Object.assign(new Error(message.error.message),message.error)):task.accept(message.result);}
  });
  const instance={record,ready,async request(action,input={}){
    await ready;const id=randomUUID();let timer;
    try{return await Promise.race([new Promise((accept,reject)=>{pending.set(id,{accept,reject});child.send({id,action,input});}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' '+action+' timed out')),15000);})]);}
    finally{clearTimeout(timer);pending.delete(id);}
  },async stop(){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');let timer;try{return await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(label+' failed to stop'));},12000);})]);}finally{clearTimeout(timer);}}};
  peers.push(instance);return instance;
}
try {
  const source=await startPostgresCluster({directory:join(directory,'source-cluster'),bin});clusters.push(source);report.clusters.push({role:'source',port:source.port,processes:source.processes});save();
  const sourceDb=await postgresDatabase(source.url);databases.push(sourceDb);const a=peer(source,'source');await a.ready;
  const seeded=await a.request('seed');for(let i=0;i<8&&await a.request('investigate');i++);
  const principal={verified:true,tenant:'synthetic',conversationId:'test-conversation',userId:'local-operator'};
  const proposed=await a.request('propose',{incidentId:seeded.incidentId,principal});assert.equal(proposed.eligible,true);
  await a.request('approve',{id:proposed.id,nonce:proposed.text.split(' ').at(-1),principal});
  await sourceDb.query('DELETE FROM sre_outbox');
  await a.request('enqueue-message',{incidentId:seeded.incidentId,key:'snapshot-notice',text:'Snapshot notice awaiting delivery'});
  await a.request('ingest',{id:'preserved-question',source:'operator-api',serviceKey:'auction-local',kind:'question',incidentId:seeded.incidentId,at:Date.now(),payload:{text:'Inspect current evidence after recovery without repeating an earlier write.'}});
  await a.request('checkpoint',{incidentId:seeded.incidentId,remoteState:{sessionId:'synthetic-session-before-backup',streamIndex:1}});
  await a.request('accept-command',{text:'rollback '+seeded.incidentId});
  const [session]=await sourceDb.query('SELECT * FROM sre_sessions WHERE incident_id=?',[seeded.incidentId]);
  const [job]=await sourceDb.query("SELECT * FROM sre_jobs WHERE incident_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",[seeded.incidentId]);assert.ok(job);
  const running=await a.request('claim',{leaseMs:60000});assert.equal(running.id,job.id);
  const sourceRetryStore=new SreStore(sourceDb),snapshotGate=providerRetryGate(sourceRetryStore,retryDescriptor('backup-snapshot'));
  let lateEntered,completeLate;const entered=new Promise(resolve=>lateEntered=resolve),lateResponse=new Promise(resolve=>completeLate=resolve);
  const pendingClient=new ApiClient({base:retryDescriptor().endpoint,clock:()=>sourceRetryStore.coordinationNow(),retryGate:snapshotGate,fetcher:async()=>{lateEntered();return lateResponse;}});
  // This request was already in flight when the first response established a
  // hold. Its later response can legitimately extend that hold after backup.
  const pendingRetry=observeRetry(pendingClient,snapshotGate);await entered;
  const initialClient=new ApiClient({base:retryDescriptor().endpoint,clock:()=>sourceRetryStore.coordinationNow(),retryGate:snapshotGate,fetcher:async()=>retryResponse(60)});
  const snapshotRetry=await observeRetry(initialClient,snapshotGate);
  assert.equal(snapshotRetry.until-snapshotRetry.observedAt,60000);
  const backupAt=Date.now();
  await nativeTool('pg_dump',source,['--format=custom','--file',archive]);
  const archiveSha256=createHash('sha256').update(readFileSync(archive)).digest('hex');report.archive={sha256:archiveSha256,bytes:statSync(archive).size,path:archive};stage('consistent-native-backup-created',{incidentId:seeded.incidentId,agentId:session.agent_id,questionJobId:job.id,approvedRequestId:proposed.id,snapshotRetryUntil:snapshotRetry.until});
  completeLate(retryResponse(120));const extendedRetry=await pendingRetry;assert.ok(extendedRetry.until>snapshotRetry.until);
  assert.equal(extendedRetry.until-extendedRetry.observedAt,120000);
  const gapGate=providerRetryGate(sourceRetryStore,retryDescriptor('backup-gap'));
  let gapObservedAt;
  const gapClient=new GithubConnector({base:retryDescriptor().endpoint,repository:'fixture/auction',tokenEnv:'READ'},{env:{READ:'synthetic'},clock:()=>sourceRetryStore.coordinationNow(),retryGate:gapGate,fetcher:async()=>{
    gapObservedAt=await sourceRetryStore.coordinationNow();
    return new Response('[]',{headers:{'content-type':'application/json','x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.ceil(gapObservedAt/1000)+60)}});
  }});
  assert.deepEqual(await gapClient.request(gapClient.repo),[]);
  const gapRetry={...await gapGate.read(),observedAt:gapObservedAt};
  assert.equal(gapRetry.status,200);assert.ok(gapRetry.until-gapRetry.observedAt>=60000&&gapRetry.until-gapRetry.observedAt<61000);
  // Independent local fixture evidence for a reviewed recovery demonstration;
  // this is not a production/off-host durable retry journal.
  const retryLedger=join(directory,'independent-synthetic-retry-facts.jsonl');
  writeFileSync(retryLedger,[{scope:'backup-snapshot',scopeHash:snapshotGate.scopeHash,...extendedRetry},{scope:'backup-gap',scopeHash:gapGate.scopeHash,...gapRetry}].map(record=>JSON.stringify(record)).join('\n')+'\n');
  await a.request('execute');await a.request('outbox');
  assert.equal(logRows(dispatchLog).length,1);assert.equal(logRows(sendLog).length,1);
  await a.request('ingest',{id:'after-backup-only',source:'logs',serviceKey:'auction-local',kind:'log',incidentId:seeded.incidentId,at:Date.now(),payload:{message:'This committed event occurred after the logical backup'}});
  await a.request('checkpoint',{incidentId:seeded.incidentId,remoteState:{sessionId:'synthetic-session-before-backup',streamIndex:2}});
  stage('external-effects-occurred-after-backup',{providerSubmissions:1,teamsDeliveries:1,postBackupEventCommitted:true});await a.stop();
  const restored=await startPostgresCluster({directory:join(directory,'restored-cluster'),bin});clusters.push(restored);report.clusters.push({role:'restored',port:restored.port,processes:restored.processes});save();
  await nativeTool('pg_restore',restored,['--no-owner','--no-privileges','--exit-on-error','--single-transaction',archive]);
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'),archiveSha256,'The archive changed during restore');
  const restoredDb=await postgresDatabase(restored.url);databases.push(restoredDb);
  assert.equal(Number((await restoredDb.query("SELECT COUNT(*) AS count FROM sre_events WHERE external_id='after-backup-only'"))[0].count),0);
  assert.equal((await restoredDb.query('SELECT agent_id FROM sre_sessions WHERE incident_id=?',[seeded.incidentId]))[0].agent_id,session.agent_id);
  assert.equal((await restoredDb.query('SELECT status FROM sre_rollbacks WHERE id=?',[proposed.id]))[0].status,'approved');
  assert.equal((await restoredDb.query("SELECT status FROM sre_outbox WHERE id='snapshot-notice'"))[0].status,'pending');
  stage('backup-restored-to-independent-cluster',{agentIdPreserved:true,postBackupEventAbsent:true,restoredRequest:'approved',restoredNotice:'pending'});
  if(report.unsafeReplayProbe) {
    const b=peer(restored,'unfenced-restored');await b.ready;await b.request('execute');await b.request('outbox');
    report.replayProbe={providerSubmissions:logRows(dispatchLog).length,teamsDeliveries:logRows(sendLog).length};save();
    assert.equal(report.replayProbe.providerSubmissions,1,'An unfenced backup restore replayed a provider dispatch that already happened');
    assert.equal(report.replayProbe.teamsDeliveries,1,'An unfenced backup restore repeated a delivered Teams message');
  } else {
    const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),store=await new SreStore(restoredDb,{services:config.services}).initialize();
    const restoredSnapshotGate=providerRetryGate(store,retryDescriptor('backup-snapshot')),restoredGapGate=providerRetryGate(store,retryDescriptor('backup-gap'));
    assert.equal((await restoredSnapshotGate.read()).until,snapshotRetry.until);
    assert.equal(await restoredGapGate.read(),null,'A backup must not invent provider waits learned after its snapshot');
    const preparation={restoreId:'restore-'+randomUUID(),backupSha256:archiveSha256,backupAt,reason:'Reconcile post-backup effects from independent fixture provider and delivery logs',actor:{kind:'local-operator',id:'synthetic recovery operator'},offline:true};
    const fence=await prepareRestore(store,preparation);assert.equal(fence.active,true);assert.equal((await prepareRestore(store,preparation)).duplicate,true);
    assert.equal((await restoredSnapshotGate.read()).until,snapshotRetry.until,'Preparation must retain snapshot retry deadlines');
    const retryFacts=logRows(retryLedger);assert.equal(retryFacts.length,2);
    const retryProfile=join(directory,'retry-recovery-profile.json'),retryAttestation=join(directory,'reviewed-retry-facts.json');
    const retryServices=retryFacts.map(fact=>({key:'retry-'+fact.scope,name:'Synthetic retry recovery',tenant:'retry-fixture',environment:'staging',github:{enabled:false,base:'https://retry-postgres-fixture.invalid',repository:'fixture/auction',retryScope:fact.scope}}));
    writeFileSync(retryProfile,JSON.stringify({mode:'connected',agentMode:'eve',services:retryServices},null,2)+'\n');
    const inventory=await recoveryTool('retry-scopes',retryProfile);assert.equal(inventory.networkCalls,0);assert.equal(inventory.scopes.length,2);assert.ok(inventory.scopes.every(item=>item.enabled===false));
    const review={restoreId:fence.restoreId,requestId:'native-retry-facts',reason:'Review independently retained synthetic provider obligations for this restored snapshot',reviewedAt:Date.now(),evidenceUrls:['https://synthetic-verifier.invalid/retry-facts/'+fence.restoreId],facts:retryFacts.map(fact=>{
      const serviceKey='retry-'+fact.scope;assert.equal(inventory.scopes.find(item=>item.serviceKey===serviceKey).scopeHash,fact.scopeHash);
      return {serviceKey,connector:'github',kind:'api',scopeHash:fact.scopeHash,observedAt:fact.observedAt,until:fact.until,status:fact.status};
    })};
    writeFileSync(retryAttestation,JSON.stringify(review,null,2)+'\n');
    const retryReceipt=await recoveryTool('retry-facts',retryProfile,restored,retryAttestation);assert.equal(retryReceipt.duplicate,false);assert.equal(retryReceipt.providerVerified,false);assert.equal(retryReceipt.authority,'local_operator_attestation');
    assert.equal((await recoveryTool('retry-facts',retryProfile,restored,retryAttestation)).duplicate,true);assert.equal((await store.restoreFence()).active,true);
    assert.equal((await restoredDb.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'pending');
    assert.equal((await restoredDb.query('SELECT status FROM sre_rollbacks WHERE id=?',[proposed.id]))[0].status,'unknown');
    assert.equal((await restoredDb.query("SELECT status FROM sre_outbox WHERE id='snapshot-notice'"))[0].status,'unknown');
    assert.deepEqual(JSON.parse((await restoredDb.query('SELECT remote_state FROM sre_sessions WHERE incident_id=?',[seeded.incidentId]))[0].remote_state),{});
    let b=peer(restored,'fenced-restored');await b.ready;
    for(const scope of ['backup-snapshot','backup-gap']) {
      const result=await b.request('retry-probe',{scope});assert.equal(result.status,429);assert.equal(result.requests,0);
      assert.equal(result.hold.until,retryFacts.find(fact=>fact.scope===scope).until);
      if(scope==='backup-gap'){assert.equal(result.providerStatus,200);assert.equal(result.hold.status,200);}
    }
    assert.equal(await b.request('execute'),false);assert.equal(await b.request('outbox'),false);assert.equal(await b.request('command'),false);
    assert.ok((await b.request('operations')).conditions.some(item=>item.code==='database_restore_hold'));
    await b.request('investigate');
    assert.equal((await restoredDb.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'done');
    assert.equal((await restoredDb.query('SELECT agent_id FROM sre_sessions WHERE incident_id=?',[seeded.incidentId]))[0].agent_id,session.agent_id);
    assert.equal(logRows(dispatchLog).length,1);assert.equal(logRows(sendLog).length,1);
    stage('restored-investigation-resumed-with-writes-held',{originalJobId:job.id,localAgentId:session.agent_id,staleModelCursorDiscarded:true,providerSubmissions:1,teamsDeliveries:1,commandsDiscarded:fence.counts.commands});
    await b.stop();b=peer(restored,'restarted-fenced');await b.ready;
    for(const scope of ['backup-snapshot','backup-gap']) {
      const result=await b.request('retry-probe',{scope});assert.equal(result.status,429);assert.equal(result.requests,0);
      if(scope==='backup-gap'){assert.equal(result.providerStatus,200);assert.equal(result.hold.status,200);}
    }
    report.retryRecovery={snapshotWaitRetained:true,snapshotUntil:snapshotRetry.until,postBackupExtensionAbsentUntilReviewed:true,postBackupNewWaitAbsentUntilReviewed:true,reappliedFromIndependentSyntheticLedger:true,restoredExtendedUntil:(await restoredSnapshotGate.read()).until,restoredNewUntil:(await restoredGapGate.read()).until,successfulResponseWaitRestored:true,successfulResponseStatus:200,deferredLogicalStatus:429,blockedRequestsBeforeAndAfterRestart:4,providerTransportInvocations:0,reconstructionAutomatic:false,fixtureLedger:retryLedger,productionAdministrationCliUsed:true,duplicateReceiptVerified:true,configuredDisabledBuckets:2,providerVerified:false,receiptRequestId:retryReceipt.requestId,receiptOperator:retryReceipt.operator};
    stage('retry-snapshot-and-lost-interval-facts-checked-across-restore-and-restart',report.retryRecovery);
    assert.equal(await b.request('execute'),false);assert.equal(await b.request('outbox'),false);
    assert.ok((await b.request('operations')).conditions.some(item=>item.code==='database_restore_hold'));
    const attestation={restoreId:fence.restoreId,requestId:'release-'+randomUUID(),actor:preparation.actor,reason:'Independent synthetic ledgers identify the one accepted request and delivered notice; all lost-gap facts remain explicit',observedAt:Date.now(),evidenceUrls:['https://synthetic-verifier.invalid/restore/'+fence.restoreId]};
    await assert.rejects(()=>releaseRestore(store,{...attestation,restoreId:'wrong-restore'}),/current restore/);
    let entered,unblock;const preparedNotice=new Promise(resolve=>entered=resolve),publicationGate=new Promise(resolve=>unblock=resolve);
    const publishing=restoredDb.transaction(async q=>{await store.queueMessage(seeded.incidentId,'A read-only result completing during release',null,'late-held-notice',q);entered();await publicationGate;});
    await preparedNotice;let releaseSettled=false;
    const releasing=releaseRestore(store,attestation).then(value=>{releaseSettled=true;return {value};},error=>{releaseSettled=true;return {error};});
    let releaseResult;
    try {
      let blocked=false;const deadline=Date.now()+5000;
      while(Date.now()<deadline&&!releaseSettled){const rows=await restoredDb.query("SELECT query FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%sre_checkpoints%FOR UPDATE%'");if(rows.length){blocked=true;break;}await delay(20);}
      assert.ok(blocked,'Release did not serialize with an in-flight held notice');
    } finally {unblock();await publishing;releaseResult=await releasing;}
    assert.ifError(releaseResult.error);const released=releaseResult.value;
    assert.equal((await restoredDb.query("SELECT status FROM sre_outbox WHERE id='late-held-notice'"))[0].status,'discarded');
    assert.equal(released.active,false);assert.equal(released.release.healthVerified,false);assert.equal((await releaseRestore(store,attestation)).duplicate,true);
    stage('release-serialized-with-in-flight-held-notice',{lateNoticeDiscarded:true,noDeliveryAttempted:true});
    assert.equal(await b.request('execute'),false);assert.equal(await b.request('outbox'),false);
    assert.equal(logRows(dispatchLog).length,1);assert.equal(logRows(sendLog).length,1);
    const [row]=await restoredDb.query('SELECT * FROM sre_rollbacks WHERE id=?',[proposed.id]),proposal=JSON.parse(row.proposal),current=releases((await restoredDb.query('SELECT payload FROM sre_deployments')).map(item=>JSON.parse(item.payload)))[0];
    const proof={id:'restore-no-change',kind:'rollback_no_change',incidentId:seeded.incidentId,rollbackRequestId:row.id,requestHash:'sha256:'+hash(proposalWorkflowRequest(proposal,{approvedAt:Number(row.approved_at),expiresAt:Number(row.expires_at)})),provider:'github',runId:'42',terminal:true,deploymentStarted:false,outcome:'blocked',reason:'Synthetic provider accepted the request but performed no deployment',observedAt:Date.now(),environment:proposal.environment,sha:current.sha,artifact:current.artifact,deploymentId:current.deploymentId??current.id??'',deploymentAt:current.at,evidenceUrl:'https://synthetic-verifier.invalid/restore-run/42'};
    const raw=JSON.stringify(proof),timestamp=String(Date.now()),response=await fetch('http://127.0.0.1:'+b.record.port+'/webhooks/verification/auction-local',{method:'POST',headers:{'x-sre-timestamp':timestamp,'x-sre-signature':'sha256='+createHmac('sha256',proofKey).update(timestamp+'.'+raw).digest('hex')},body:raw,signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,202,await response.text());
    assert.equal((await restoredDb.query('SELECT status FROM sre_rollbacks WHERE id=?',[row.id]))[0].status,'not_executed');
    assert.equal((await restoredDb.query('SELECT status FROM sre_incidents WHERE id=?',[seeded.incidentId]))[0].status,'open');
    await b.request('investigate');
    const fresh=await b.request('propose',{incidentId:seeded.incidentId,principal});assert.equal(fresh.eligible,true,fresh.text);assert.notEqual(fresh.id,proposed.id);
    await b.request('approve',{id:fresh.id,nonce:fresh.text.split(' ').at(-1),principal});await b.request('execute');
    assert.equal(logRows(dispatchLog).filter(item=>item.requestId===proposed.id).length,1);assert.equal(logRows(dispatchLog).filter(item=>item.requestId===fresh.id).length,1);
    assert.equal(logRows(sendLog).length,1);assert.equal(Number((await restoredDb.query("SELECT COUNT(*) AS count FROM sre_events WHERE external_id='after-backup-only'"))[0].count),0);
    report.recovery={restoreId:fence.restoreId,backupArchiveVerified:true,independentTargetCluster:true,incidentAndAgentIdentityPreserved:true,unfinishedQuestionResumed:true,postBackupLossExplicit:true,oldProviderRequestSubmissions:1,oldTeamsNoticeDeliveries:1,freshRequestId:fresh.id,freshRequestSubmissions:1,operatorReleaseIsAttestation:true,applicationHealthVerified:false};
    stage('operator-release-does-not-replay-and-new-action-needs-fresh-approval',report.recovery);
  }
  report.status='passed';
} catch(error){report.status='failed';report.failures.push({message:error.message,stack:error.stack});process.exitCode=1;}
finally {
  for(const agent of peers.reverse())try{await agent.stop();}catch(error){report.failures.push({cleanup:error.message});process.exitCode=1;}
  for(const db of databases)await db.close();
  for(const cluster of clusters.reverse())try{await cluster.stop();}catch(error){report.failures.push({cleanup:error.message});process.exitCode=1;}
  for(const [name,value] of Object.entries(files))if(createHash('sha256').update(readFileSync(name)).digest('hex')!==value){report.failures.push({sourceChanged:name});report.status='failed';process.exitCode=1;break;}
  if(report.failures.length)report.status='failed';
  report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,failures:report.failures.length,report:reportPath}));
}
