import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {postgresDatabase} from '../src/sre/database.mjs';
import {normalize} from '../src/sre/normalize.mjs';
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {createPilotQaAdapter} from '../fixtures/qa-sandbox.mjs';
import {startPostgresCluster} from '../fixtures/postgres-cluster.mjs';

const args=process.argv.slice(2);
if(![2,4].includes(args.length)||args[0]!=='--bin'||!args[1]||args.length===4&&(args[2]!=='--preview-port'||!/^\d+$/.test(args[3])||Number(args[3])<1024||Number(args[3])>65535))throw Error('Use --bin <owned PostgreSQL installation bin> [--preview-port <loopback port>]');
const directory=resolve('.local/change-tracking-runs',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));await mkdir(directory,{recursive:true,mode:0o700});
const profile=JSON.parse(await readFile('config/sre.local.json','utf8')),rooms=['bidding-change','platform-change','worker-change','bidding-provider','platform-provider'];
profile.services[0].teams={...profile.services[0].teams,conversations:rooms,captureResponderUpdates:true,collaborationGroups:[{key:'tracking',name:'Fictional tracking rehearsal',conversations:rooms.map(id=>({id,name:id}))}]};
const profilePath=join(directory,'profile.json');await writeFile(profilePath,JSON.stringify(profile,null,2)+'\n',{mode:0o600});
const config=loadConfig({SRE_CONFIG:profilePath,SRE_SQLITE_PATH:join(directory,'unused.sqlite'),SRE_CLAUDE_BIN:'/nonexistent-change-tracking-cli'}),qa=createPilotQaAdapter(join(directory,'qa'));
let runtime,cluster,blockRequest,release,entered,sequence=0;
const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
const adapter={localOnly:true,execute:async input=>{const result=await qa.execute(input);if(input.requestId===blockRequest){entered();await gate;}return result;}};
const report={at:new Date().toISOString(),directory,claudeEnabled:false,providerCalls:0,liveDeployments:0,stages:[]};
const stage=(name,evidence={})=>{report.stages.push({name,...evidence});console.log(name);};
const save=()=>writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
try{
  cluster=await startPostgresCluster({directory:join(directory,'owned-postgres'),bin:args[1]});stage('owned-native-postgres',{version:cluster.version,port:cluster.port,loopbackOnly:cluster.settings.listen_addresses==='127.0.0.1'});
  runtime=await createSreRuntime({config,db:await postgresDatabase(cluster.url),qaAdapter:adapter,autoStart:false});const service=config.services[0];
  const id=(await seedDemo(runtime.store,service)).incidentId,other=(await runtime.store.ingest({id:'independent-provider',source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'independent-provider',status:'OPEN',at:Date.now(),title:'Fictional credit provider outage on healthy code',payload:{problemId:'independent-provider',metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}}})).incidentId;
  const send=async(room,user,text)=>{const m=devActivity(text,service,{id:'native-tracking-'+ ++sequence,userId:user,displayName:user,conversationType:'groupChat',conversationId:room});await runtime.router.accept(m.activity,m.reference);await runtime.router.processOnce();};
  for(const room of rooms.slice(0,3))await send(room,'local-operator','join '+id);for(const room of rooms.slice(3))await send(room,'local-operator','join '+other);
  for(const user of ['Avery','Noor','Sam','Robin'])await send(rooms[2],user,'update BID-ONLY: '+user+' preserves the accepted-bid trace for the winning-bid regression.');
  await send(rooms[4],'Morgan','update PROVIDER-ONLY: the healthy release also loses credit-provider requests; keep this issue separate.');
  const settle=async()=>{for(let n=0;n<80;n++){const [row]=await runtime.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.count))return;await runtime.worker.runOnce();}throw Error('Native tracking did not settle');};await settle();
  const head=(await runtime.casework.createPlan(id)).payload.patch.headSha;let observedAt=Date.now();
  const mr=(sha,delivery,at=++observedAt)=>runtime.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'merge_request',object_attributes:{iid:61,state:'opened',last_commit:{id:sha},updated_at:new Date(at).toISOString(),title:'Fictional accepted-bid repair'}},service,{deliveryId:delivery}));
  await mr(head,'mr-open');const association=await runtime.casework.trackChange(id,'gitlab',61,{kind:'local-operator',id:'owned native rehearsal'});assert.equal((await runtime.casework.trackChange(id,'gitlab',61,{kind:'local-operator',id:'owned native rehearsal'})).duplicate,true);stage('operator-linked-observed-change',{change:61,evidenceId:association.evidenceId,headSha:association.headSha,idempotent:true});await settle();
  const identities={incident:(await runtime.store.context(id)).session.agent_id,other:(await runtime.store.context(other)).session.agent_id},key=conversationKey(service.teams.tenantId,rooms[0]),principal={verified:true,simulation:true,tenant:service.teams.tenantId,conversationId:rooms[0],userId:'local-operator'};
  const approve=async()=>{const plan=await runtime.casework.createPlan(id),request=await runtime.casework.proposeFix(id,plan.id,principal,key,'native-'+ ++sequence);await runtime.casework.approveFix(request.id,request.nonce,principal,key);return {plan,request};};
  const first=await approve();blockRequest=first.request.id;const otherRevision=(await runtime.store.context(other)).incident.revision;
  const running=runtime.casework.runOnce();await Promise.race([started,running.then(()=>{throw Error('QA finished before the controlled source-change window');})]);const changedAt=++observedAt;await mr('b'.repeat(40),'mr-moving-head',changedAt);await mr(head,'delayed-old-head',changedAt-1);
  await runtime.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{sha:'e'.repeat(40),status:'success',updated_at:new Date().toISOString()}},service,{deliveryId:'unrelated-ci'}));assert.equal((await runtime.store.context(other)).incident.revision,otherRevision);
  release();await running;let view=await runtime.casework.snapshot(id),old=view.qa.find(q=>q.id===first.request.id);assert.equal(old.status,'superseded');assert.equal(old.current,false);assert.equal(old.result.reproduction.exitCode,1);assert.equal(old.result.validation.exitCode,0);assert.ok(old.result.patch&&old.result.mergeRequestDraft);
  const notices=(await runtime.store.snapshot()).outbox.filter(o=>o.text.startsWith('QA '+first.request.id));assert.equal(notices.length,3);assert.ok(notices.every(o=>o.incident_id===id));stage('moving-head-quarantines-old-review',{incidentId:id,otherIncidentId:other,threeRoomsNotified:true,otherIncidentUntouched:true,requestId:first.request.id,branch:old.result.branch,commit:old.result.commit,originalExit:old.result.reproduction.exitCode,fixedExit:old.result.validation.exitCode,status:old.status});
  await settle();const fresh=await approve();await runtime.casework.runOnce();view=await runtime.casework.snapshot(id);const current=view.qa.find(q=>q.id===fresh.request.id);assert.equal(current.status,'passed');assert.equal(current.current,true);assert.ok(!(await runtime.operations.snapshot()).conditions.some(c=>c.code==='qa_superseded'));stage('explicit-fresh-pinned-source-review',{requestId:fresh.request.id,branch:current.result.branch,commit:current.result.commit,oldAuditRetained:view.qa.some(q=>q.status==='superseded'),note:'A separately approved local correction of the exact trusted source; no existing remote MR is modified or certified.'});
  for(const [name,value]of [['superseded-qa',old],['fresh-qa',current]])await writeFile(join(directory,name+'.json'),JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await writeFile(join(directory,'fix-ticket.md'),first.plan.markdown,{mode:0o600});await writeFile(join(directory,'proposed-fix.patch'),old.result.patch,{mode:0o600});await writeFile(join(directory,'merge-request-draft.md'),old.result.mergeRequestDraft,{mode:0o600});
  // Hold a real PostgreSQL transaction after saving the correction but before
  // deleting its projection. A concurrent MR update must wait, then recheck
  // the relationship rather than publishing from its earlier snapshot.
  const transaction=runtime.store.db.transaction.bind(runtime.store.db),beforeCorrection=(await runtime.store.context(id)).incident.revision;
  let correctionRelease,correctionEntered,sourcePid,armed=true,withdrawal,withdrawing,updating;
  const correctionGate=new Promise(resolve=>correctionRelease=resolve),enteredCorrection=new Promise(resolve=>correctionEntered=resolve);
  runtime.store.db.transaction=fn=>transaction(q=>fn(async(sql,parameters)=>{
    const rows=await q(sql,parameters);
    if(sql.startsWith('INSERT INTO sre_events')&&parameters?.[3]==='head-while-withdrawing')sourcePid=Number((await q('SELECT pg_backend_pid() AS pid'))[0].pid);
    if(armed&&sql.startsWith('INSERT INTO sre_checkpoints')&&String(parameters?.[0]).startsWith('change-association:')&&JSON.parse(parameters[1]).state==='withdrawn'){armed=false;correctionEntered();await correctionGate;}
    return rows;
  }));
  try{
    withdrawing=runtime.casework.withdrawChange(id,'gitlab',61,{kind:'local-operator',id:'owned native rehearsal'},{expectedEvidenceId:association.evidenceId,reason:'Fictional scope correction: this forward change belongs to a separate investigation.'});
    await Promise.race([enteredCorrection,withdrawing.then(()=>{throw Error('Correction ended before its controlled race window');})]);updating=mr('c'.repeat(40),'head-while-withdrawing');
    let observedLock=false;const deadline=Date.now()+5000;
    while(Date.now()<deadline&&!observedLock){if(sourcePid){const [activity]=await runtime.store.db.query('SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=?',[sourcePid]);observedLock=activity?.wait_event_type==='Lock'&&activity.query.startsWith('SELECT * FROM sre_incidents WHERE id=');}if(!observedLock)await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(observedLock,true,'The MR writer must be observed waiting on the incident-row lock');correctionRelease();[withdrawal]=await Promise.all([withdrawing,updating]);
    assert.equal((await runtime.store.context(id)).incident.revision,Number(beforeCorrection)+1);assert.ok(!(await runtime.casework.timeline(id)).links.some(l=>l.provider==='gitlab'&&l.change_number==='61'));const proof=await runtime.store.addEvidence(id,'gitlab','code_review',{headSha:'c'.repeat(40),comparison:{mergeRequest:{iid:61}}});assert.equal((await runtime.casework.linkChange(id,'gitlab',61,proof)).suppressed,true);
    stage('native-correction-race-fenced',{observedPostgresLock:true,sourceBackendPid:sourcePid,withdrawalEvidenceId:withdrawal.evidenceId,originalAssociationPreserved:association.evidenceId,onlyCorrectionAdvancedRevision:true,automaticRediscoverySuppressed:true});
  }finally{correctionRelease();await Promise.allSettled([withdrawing,updating].filter(Boolean));runtime.store.db.transaction=transaction;}
  await runtime.close();runtime=await createSreRuntime({config,db:await postgresDatabase(cluster.url),qaAdapter:adapter,autoStart:args.length===4});
  const restored=await runtime.store.context(id),independent=await runtime.store.context(other);assert.equal(restored.session.agent_id,identities.incident);assert.equal(independent.session.agent_id,identities.other);assert.equal(restored.collaboration.rooms.length,3);assert.equal(independent.collaboration.rooms.length,2);assert.ok(independent.evidence.filter(e=>e.kind==='responder_update').every(e=>e.content.text.includes('PROVIDER-ONLY')));assert.equal(await runtime.casework.runOnce(),false);assert.equal((await runtime.casework.snapshot(id)).qa.find(q=>q.id===first.request.id).status,'superseded');
  assert.equal(restored.changeAssociations.controls.find(c=>c.number==='61').state,'withdrawn');assert.ok(!(await runtime.casework.timeline(id)).links.some(l=>l.provider==='gitlab'&&l.change_number==='61'));await writeFile(join(directory,'withdrawal-audit.json'),JSON.stringify(restored.changeAssociations,null,2)+'\n',{mode:0o600});
  stage('restart-keeps-two-incident-boundaries',{sameAgents:true,rooms:[3,2],fictionalWorkerParticipants:4,completedRequestsNotRerun:true,artifactRecords:2});report.status='passed';report.incidentId=id;report.otherIncidentId=other;report.scope='Actual owned native PostgreSQL and trusted auction code. Teams people/messages, GitLab MR/CI, provider errors and all remote references are fictional; no model or provider transport.';await save();
  if(args.length===4){
    await runtime.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'merge_request',object_attributes:{iid:72,state:'opened',last_commit:{id:current.result.commit},updated_at:new Date().toISOString(),title:'Fictional forward-fix MR for UI association rehearsal'}},service,{deliveryId:'preview-forward-mr'}));
    report.preview={forwardMr:72,headSha:current.result.commit,note:'Fictional provider observation of the real local fixture commit. No remote MR exists.'};await save();
    await new Promise(resolve=>runtime.server.listen(Number(args[3]),'127.0.0.1',resolve));console.log('Preview: http://127.0.0.1:'+runtime.server.address().port);await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
  }
}catch(error){report.status='failed';report.error=error.message;throw error;}
finally{release();await runtime?.close();await cluster?.stop();report.finishedAt=new Date().toISOString();report.ownedPostgresStopped=cluster?cluster.processes.filter(p=>p.name==='postgres').every(p=>p.exit!==undefined):true;await save();console.log(JSON.stringify({status:report.status,report:join(directory,'report.json'),ownedPostgresStopped:report.ownedPostgresStopped}));}
