import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hash} from '../src/sre/security.mjs';
import {StorageError} from '../src/sre/database.mjs';
import {normalize} from '../src/sre/normalize.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {seedPilot,pilotDiff,pilotPolicySource} from '../scripts/seed-pilot.mjs';
import {fictionalDirectory} from './ownership-directory.mjs';

const checkpointId='rehearsal:multi-team:v1';
const rule={id:'rehearsal-bid-order',codes:['WINNING_BID_REGRESSED'],minCount:3,windowSeconds:900};
export function rehearsalProfile(){
  const profile=JSON.parse(readFileSync(new URL('../config/sre.trial-demo.json',import.meta.url),'utf8'));
  profile.mode='local';profile.agentMode='rules';
  const service=profile.services[0];service.name='Fictional multi-team SRE rehearsal';service.logMonitors=[structuredClone(rule)];service.servicenow.correlateLogMonitors=true;
  service.teams.conversations=['rehearsal-bidding','rehearsal-platform','rehearsal-workers','rehearsal-provider-ops','rehearsal-provider-engineering'];service.teams.alertConversationId=service.teams.conversations[0];
  service.teams.collaborationGroups=[{key:'rehearsal-response',name:'Fictional response rehearsal',conversations:service.teams.conversations.map((id,i)=>({id,name:['EU Bidding','EU Platform','Worker desk','US Provider operations','US Provider engineering'][i]}))}];
  return profile;
}
function decode(row){
  try{
    const {checksum,...state}=JSON.parse(row.value),incident=id=>/^inc_[a-f0-9]{20}$/.test(id||''),sha=value=>/^[a-f0-9]{40}$/.test(value||'');
    if(state.version!==1||!['seeding','ready'].includes(state.phase)||!/^[-a-f0-9]{36}$/.test(state.runId||'')||!Number.isSafeInteger(state.startedAt)||state.startedAt<0||!/^[a-f0-9]{64}$/.test(state.configHash||'')||hash(state)!==checksum)throw Error();
    if(state.detectionAt!==undefined&&(!Number.isSafeInteger(state.detectionAt)||state.detectionAt<0))throw Error();
    if(state.phase==='ready'&&(!incident(state.primaryId)||!incident(state.providerId)||state.primaryId===state.providerId||!/^plan_[a-f0-9]+$/.test(state.planId||'')||!sha(state.baselineSha)||!sha(state.badSha)||!Number.isSafeInteger(state.readyAt)||!Number.isSafeInteger(state.detectionAt)||![state.primaryRooms,state.providerRooms].every(rooms=>Array.isArray(rooms)&&rooms.every(room=>typeof room==='string'))))throw Error();
    return state;
  }
  catch{throw new StorageError(new Error('Invalid persisted rehearsal checkpoint'));}
}
function configHash(service){return hash([service.key,service.tenant,service.environment,service.teams.tenantId,service.teams.conversations,service.github?.repository,service.gitlab?.project,service.servicenow?.cmdbCi,service.servicenow?.correlateLogMonitors,service.dynatrace?.entityId,service.logMonitors]);}
async function save(store,state){await store.db.query('UPDATE sre_checkpoints SET value=?,updated_at=? WHERE id=?',[JSON.stringify({...state,checksum:hash(state)}),await store.coordinationNow(),checkpointId]);}
export async function seedRehearsal(runtime){
  const {store,config}=runtime,service=config.services[0];
  if(config.mode!=='local'||config.agentMode!=='rules'||config.teamsMode!=='off'||config.services.length!==1||['gitlab','github','dynatrace','dynatraceLogs','servicenow','jira'].some(name=>service[name]?.enabled)||!service.logMonitors?.some(r=>hash(r)===hash(rule)))throw Error('The rehearsal requires its offline rules profile, disabled live readers and Teams off');
  let state=await store.db.transaction(async q=>{
    const [row]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[checkpointId]),fence=await store.restoreFence(q);
    if(row){const saved=decode(row);if(fence&&saved.phase!=='ready')throw Error('A restored rehearsal is incomplete; do not resume scripted setup after database restore. Inspect retained history or use a new dedicated database.');return saved;}
    if(fence)throw Error('The restored database has no completed rehearsal metadata; inspect retained history or use a new dedicated database. Scripted setup will not run.');
    const [count]=await q('SELECT COUNT(*) AS count FROM sre_events');if(Number(count.count))throw Error('Use a dedicated empty rehearsal database; existing incident history will not be reseeded');
    const body={version:1,phase:'seeding',runId:randomUUID(),startedAt:await store.coordinationNow(q),configHash:configHash(service)};
    await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?)',[checkpointId,JSON.stringify({...body,checksum:hash(body)}),body.startedAt]);return body;
  });
  if(state.configHash!==configHash(service))throw Error('Rehearsal profile changed; keep this database with its original mapping');
  if(state.phase==='ready'){
    const incidents=await store.db.query('SELECT id,service_key FROM sre_incidents WHERE id IN (?,?)',[state.primaryId,state.providerId]);
    const [plan]=await store.db.query('SELECT incident_id FROM sre_fix_plans WHERE id=?',[state.planId]);
    const thread=id=>BigInt('0x'+id.slice(4)).toString(),roots=service.teams.conversations;
    if(incidents.length!==2||incidents.some(i=>i.service_key!==service.key)||plan?.incident_id!==state.primaryId||hash(state.primaryRooms)!==hash(roots.slice(0,3).map(root=>root+';messageid='+thread(state.primaryId)))||hash(state.providerRooms)!==hash(roots.slice(3).map(root=>root+';messageid='+thread(state.providerId))))throw new StorageError(new Error('Persisted rehearsal identities are incomplete or mismatched; inspect the database instead of reseeding'));
    return state;
  }
  const manifest=seedPilot(),baseline=manifest.baseline,bad=manifest.releases['bid-race'].sha,sourceAt=state.startedAt-2000,run=state.runId;
  const compatibility={schemaVersion:1,dependencyFingerprint:'rehearsal-dependencies-v1',configurationFingerprint:'rehearsal-config-v1',featureFlagsFingerprint:'rehearsal-flags-v1'};
  for(const [i,sha] of [baseline,bad].entries())await store.ingest(normalize('releases',{...compatibility,simulationRunId:run,provider:'gitlab',environment:service.environment,sha,artifact:'sha256:'+hash(sha),status:'success',at:sourceAt-(i===0?900000:300000),healthy:i===0,healthVerifiedAt:i===0?sourceAt-870000:null,rollbackCompatible:true,dataRollbackSafe:true},service,{deliveryId:run+':release:'+i}));
  const scopeKey=hash({environment:service.environment,region:'eu-west-1',version:bad}),issueKey='log-monitor:'+rule.id+':'+scopeKey;
  let [primary]=await store.db.query('SELECT id FROM sre_incidents WHERE service_key=? AND issue_key=?',[service.key,issueKey]);
  if(!primary){
    if(!state.detectionAt||Date.now()-state.detectionAt>rule.windowSeconds*1000-10000){state.detectionAt=(await store.coordinationNow())-1000;await save(store,state);}
    const batch=rehearsalLogs(service,state.detectionAt,bad,run);
    await runtime.logDetector.observe(service,'dynatrace',{records:batch,complete:true});
    [primary]=await store.db.query('SELECT id FROM sre_incidents WHERE service_key=? AND issue_key=?',[service.key,issueKey]);if(!primary)throw Error('The scripted error threshold did not create its incident');
  }
  const at=state.detectionAt,primaryId=primary.id;
  await store.addEvidence(primaryId,'dynatrace','logs',{synthetic:true,records:rehearsalLogs(service,at,bad,run),complete:true,interpretation:'Scripted, bounded log page. Health probes are not business correctness checks.'},at);
  await store.addEvidence(primaryId,'dynatrace','problem',{synthetic:true,simulationRunId:run,problemId:'fixture-corroboration-'+run,metrics:{codes:['WINNING_BID_REGRESSED'],requests:3},interpretation:'Separate scripted metric corroboration for the generated auction defect; not a live Dynatrace observation.'},at);
  await store.ingest({id:run+':code',source:'gitlab',serviceKey:service.key,kind:'change',incidentId:primaryId,at,payload:{synthetic:true,provider:'gitlab',comparisonKind:'deployment',sha:bad,number:17,baseSha:baseline,headSha:bad,complete:true,unrecognizedPaths:[],diff:pilotDiff(bad),policySources:{path:'src/auction/rules.mjs',complete:true,base:pilotPolicySource(baseline),head:pilotPolicySource(bad)},interpretation:'Actual immutable generated local source bytes; no remote repository read or MR publication.'}});
  await store.ingest({id:run+':ticket',source:'servicenow',serviceKey:service.key,kind:'ticket',incidentId:primaryId,at,payload:{synthetic:true,sys_id:hash(run).slice(0,32),number:'INC-REHEARSAL-EU',cmdb_ci:service.servicenow.cmdbCi,correlation_id:issueKey,short_description:'Fictional EU accepted-bid ledger mismatch',description:'Inspect request eu-bid-42: an accepted higher bid was replaced by a lower concurrent bid. HTTP health probes remain green.',state:'2',sys_created_on:new Date(at-1000).toISOString(),sys_updated_on:new Date(at).toISOString()}});
  await store.ingest(normalize('gitlab',{project:{id:service.gitlab.project},object_kind:'merge_request',object_attributes:{iid:17,state:'merged',last_commit:{id:bad},merge_commit_sha:bad,updated_at:new Date(sourceAt-310000).toISOString(),title:'Fictional fast-forward concurrency-policy change',description:'Generated local bid-race commit. This is scripted MR metadata, not a remote GitLab MR.'}},service,{deliveryId:run+':mr:17'}));
  for(let i=0;i<6;i++)await store.ingest(normalize('gitlab',{project:{id:service.gitlab.project},object_kind:'pipeline',object_attributes:{id:201,project_id:Number(service.gitlab.project),sha:bad,status:'success',updated_at:new Date(sourceAt-305000).toISOString()}},service,{deliveryId:run+':ci-smoke:'+i}));
  await store.ingest(normalize('gitlab',{project:{id:service.gitlab.project},object_kind:'pipeline',object_attributes:{id:202,project_id:Number(service.gitlab.project),sha:bad,status:'failed',updated_at:new Date(at).toISOString()}},service,{deliveryId:run+':ci-business'}));
  const provider=(await store.ingest(normalize('dynatrace',{simulationRunId:'provider-'+run,ProblemID:'P-provider-'+run,State:'OPEN',Title:'Rehearsal: separate US credit-provider failures',EntityIds:[service.dynatrace.entityId],StartedAt:at-1000,ObservedAt:at,metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE'],requests:3}},service,{deliveryId:run+':provider'}))).incidentId;
  await store.addEvidence(provider,'dynatrace','logs',{synthetic:true,complete:true,records:Array.from({length:3},(_,i)=>({timestamp:new Date(at-300+i*100).toISOString(),level:'ERROR',code:'CREDIT_PROVIDER_UNAVAILABLE',environment:service.environment,region:'us-east-1',operation:'/api/credit',sha:baseline,entityId:service.dynatrace.entityId,message:'Scripted upstream credit-provider rejection on a different region/release sample',requestId:run+':us:'+i}))},at);
  const [directory]=await store.db.query('SELECT id FROM sre_directory_snapshots WHERE service_key=?',[service.key]);if(!directory)await runtime.casework.importDirectory(service.key,fictionalDirectory(state.startedAt));
  const roots=service.teams.conversations,thread=id=>BigInt('0x'+id.slice(4)).toString();
  const primaryRooms=roots.slice(0,3).map(root=>root+';messageid='+thread(primaryId)),providerRooms=roots.slice(3).map(root=>root+';messageid='+thread(provider));
  const messages=[...primaryRooms.map(room=>({room,text:'join '+primaryId,user:'local-operator'})),...providerRooms.map(room=>({room,text:'join '+provider,user:'local-operator'})),
    {room:primaryRooms[0],user:'avery',text:'report investigating EU owner Avery: accepted bid ledger is wrong despite HTTP 200. Next check is replaying eu-bid-42 at the deployed SHA.'},
    {room:primaryRooms[1],user:'noor',text:'report recovered Platform owner Noor: smoke pipeline 201 passed and health probes are green. This is my report; I have not checked the business ledger.'},
    {room:primaryRooms[0],user:'avery',text:'theory bid-race supported EU higher accepted bid was overwritten by a concurrent lower bid; compare the version guard in the exact release.'},
    {room:primaryRooms[1],user:'noor',text:'theory credit-latency proposed Is the US credit-provider alert related? Match region, release and requests before treating the incidents as one.'},
    {room:primaryRooms[0],user:'avery',text:'work eu-ledger-replay active Replaying eu-bid-42; I am collecting the accepted-bid sequence.'},
    {room:primaryRooms[1],user:'noor',text:'work eu-ledger-replay active I started replaying the same EU request; we should agree one owner.'},
    {room:primaryRooms[2],user:'sam',mentioned:false,text:'Quiet worker observation: the final winner is lower than a previously accepted bid. The /health route never checks this invariant.'},
    {room:primaryRooms[2],user:'robin',text:'update The attached drawing has not been read. Text description: two bid writes read the same version; the lower bid finishes last.',attachment:true},
    {room:providerRooms[0],user:'alex',text:'report investigating US provider failures are on a different request/region/release sample. Do not copy the EU rollback proposal into this thread.'},
    {room:providerRooms[1],user:'sam',text:'work provider-status active Checking upstream provider status; do not repeat EU ledger work here.'},
    {room:primaryRooms[2],user:'robin',text:'sync'}, {room:providerRooms[0],user:'alex',text:'sync'}];
  for(const [i,message] of messages.entries()){
    const sample=devActivity(message.text,service,{id:run+':chat:'+i,userId:message.user,displayName:message.user==='local-operator'?'Local operator · scripted fixture':message.user+' · scripted fixture',conversationId:message.room,conversationType:'channel',mentioned:message.mentioned!==false});sample.activity.timestamp=new Date(at).toISOString();if(message.attachment)sample.activity.attachments=[{name:'fictional-bid-sequence.png',contentType:'image/png',contentUrl:'https://fixture.invalid/unread-drawing.png'}];
    const accepted=await runtime.router.accept(sample.activity,sample.reference);if(accepted.ignored)throw Error('A scripted conversation was rejected: '+message.user);await runtime.commands();
  }
  await settleRehearsal(runtime);
  const primaryContext=await store.context(primaryId),providerContext=await store.context(provider);if(primaryContext.collaboration.rooms.length!==3||providerContext.collaboration.rooms.length!==2)throw Error('Rehearsal room scope did not settle');
  const plan=await runtime.casework.createPlan(primaryId);if(!plan.payload.patch)throw Error('The scripted invariant and immutable source did not produce a supported local fix plan');
  state={...state,phase:'ready',primaryId,providerId:provider,planId:plan.id,baselineSha:baseline,badSha:bad,primaryRooms,providerRooms,readyAt:await store.coordinationNow()};await save(store,state);return state;
}
function rehearsalLogs(service,at,bad,run){
  const health=Array.from({length:180},(_,i)=>({timestamp:new Date(at-2000+i*5).toISOString(),level:'INFO',statusCode:200,environment:service.environment,region:'eu-west-1',operation:'/health',sha:bad,entityId:service.dynatrace.entityId,message:'Routine HTTP health probe is green',requestId:run+':health:'+i}));
  const errors=Array.from({length:3},(_,i)=>({timestamp:new Date(at-300+i*100).toISOString(),level:'ERROR',code:'WINNING_BID_REGRESSED',statusCode:201,environment:service.environment,region:'eu-west-1',operation:'/api/bids',sha:bad,entityId:service.dynatrace.entityId,message:'Accepted higher bid replaced by a lower concurrent bid; inspect the stored version guard',requestId:run+':eu:'+i}));
  return [...health,...errors];
}
export async function settleRehearsal(runtime){
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){await runtime.tick();const [row]=await runtime.store.db.query("SELECT (SELECT COUNT(*) FROM sre_jobs WHERE status IN ('pending','running'))+(SELECT COUNT(*) FROM sre_commands WHERE status IN ('pending','running')) AS count");if(!Number(row.count))return;await delay(25);}
  throw Error('Rehearsal work did not settle before its deadline');
}
export function rehearsalGuide(state){return {title:'Persistent multi-team rehearsal',primaryId:state.primaryId,providerId:state.providerId,primaryRoot:'rehearsal-bidding',providerRoot:'rehearsal-provider-ops',note:'Start with EU Bidding, Platform and the worker desk; the US provider case is separate. Provider records, CI outcomes, people and drawing metadata are fictional. Local source code and approved QA branches are real. Use incident channel threads. Claude and live deployments are off.'};}
