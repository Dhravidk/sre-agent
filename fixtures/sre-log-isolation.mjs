import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {createSreRuntime} from '../src/sre/server.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {rehearsalProfile} from './sre-rehearsal.mjs';
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {seedPilot} from '../scripts/seed-pilot.mjs';
import {fictionalDirectory} from './ownership-directory.mjs';
import {LogScopeLimitError} from '../src/sre/log-detection.mjs';

export function logIsolationProfile({noisyFirst=false}={}){
 const raw=rehearsalProfile(),quiet=raw.services[0],noisy=structuredClone(quiet);
 noisy.key='preview-cache-fixture';noisy.name='Fictional preview cache';noisy.dynatrace.entityId='SERVICE-PREVIEW-CACHE';noisy.gitlab.project='fixture/preview-cache';noisy.github.repository='fixture/preview-cache';noisy.servicenow.cmdbCi='PREVIEW-CACHE-CI';
 noisy.teams.conversations=['preview-cache-ops','preview-cache-engineering'];noisy.teams.alertConversationId=noisy.teams.conversations[0];noisy.teams.collaborationGroups=[{key:'preview-cache',name:'Fictional cache response',conversations:noisy.teams.conversations.map(id=>({id,name:id}))}];
 noisy.logMonitors=[{id:'preview-cache',codes:['CACHE_UNAVAILABLE'],minCount:3,windowSeconds:900},{id:'cache-auth',codes:['CACHE_TOKEN_EXPIRED'],minCount:3,windowSeconds:900}];
 quiet.logMonitors=[{id:'quiet-ledger',codes:['WINNING_BID_REGRESSED'],minCount:3,windowSeconds:900}];raw.services=noisyFirst?[noisy,quiet]:[quiet,noisy];return raw;
}

// Actual generated Git source, durable SQL and the host rules. All provider,
// people and Teams records are fictional. No source or action executor is used.
export async function logIsolationFixture(dialect,{path=':memory:',databaseFactory,seed=true,autoStart=false,noisyFirst=false}={}){
 const config=validateConfig(logIsolationProfile({noisyFirst}),{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-log-isolation-model',SRE_TEAMS_MODE:'off'}),noisy=config.services.find(service=>service.key==='preview-cache-fixture'),quiet=config.services.find(service=>service.key!=='preview-cache-fixture'),sent=[];let r,state;
 const open=async()=>{
  const pg=!databaseFactory&&dialect==='postgres'?new PGlite():null,db=databaseFactory?await databaseFactory():pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
  r=await createSreRuntime({config,db,autoStart,connectors:new Map(config.services.map(service=>[service.key,{}])),sender:{send:async(ref,text)=>{sent.push({room:ref.conversation.id,text});return{id:randomUUID(),simulation:true};}}});
  const saved=await r.store.checkpoint('fixture:log-isolation:v1');state=saved||null;
 };
 await open();
 const message=async(room,text,user='avery',{mentioned=true}={})=>{const sample=devActivity(text,quiet,{id:randomUUID(),conversationId:room,conversationType:'channel',userId:user,displayName:user+' · fictional isolation drill',mentioned});const receipt=await r.router.accept(sample.activity,sample.reference);if(!receipt.ignored)await r.router.processOnce();return receipt;};
 const samples=async(service,{scopes=1,code=service.logMonitors[0].codes[0],version='fixture-release',at}={})=>{at??=await r.store.coordinationNow();return Array.from({length:scopes},(_,scope)=>Array.from({length:3},(_,n)=>({timestamp:at-100+n,level:'ERROR',environment:service.environment,region:'eu-west-1',sha:scopes===1?version:version+'-'+scope,code,requestId:randomUUID(),message:'Fictional '+code+' in a preview or business check'}))).flat();};
 if(seed&&!state){
  if(autoStart)throw Error('Seed this supervised fixture before enabling its existing automatic scheduler');
  const id=(await seedDemo(r.store,quiet)).incidentId,now=await r.store.coordinationNow(),sha=seedPilot().releases['bid-race'].sha,thread=BigInt('0x'+id.slice(4)).toString(),rooms=quiet.teams.conversations.slice(0,3).map(root=>root+';messageid='+thread);
  await r.casework.importDirectory(quiet.key,fictionalDirectory(now));
  await r.casework.importDirectory(noisy.key,{source:'Fictional cache ownership roster',observedAt:now,expiresAt:now+86400000,entries:[{id:'morgan-cache',name:'Morgan Lee',team:'Preview Cache',role:'service-owner',paths:[],contact:'preview-cache@example.invalid'}]});
  for(const room of rooms)await message(room,'join '+id,'local-operator');
  await message(rooms[0],'report blocked ISOLATION-AVERY: the accepted high bid was overwritten; I am checking the exact release.');
  await message(rooms[1],'report recovered ISOLATION-NOOR: health probes passed; business validation is pending.','noor');
  await message(rooms[0],'work accepted-bid-replay active ISOLATION-AVERY-WORK: replaying the affected EU request.');
  await message(rooms[1],'work accepted-bid-replay active ISOLATION-NOOR-WORK: also replaying it; agree one owner.','noor');
  await message(rooms[2],'ISOLATION-SAM: the worker saw a lower final winner despite an accepted higher bid.','sam',{mentioned:false});
  const pageAt=await r.store.coordinationNow(),hot=await samples(noisy,{scopes:101,at:pageAt}),auth=await samples(noisy,{code:'CACHE_TOKEN_EXPIRED',at:pageAt}),page={records:[...hot,...auth],complete:true};await r.store.ingestLogRead({serviceKey:noisy.key,logs:page,until:pageAt});
  try{await r.logDetector.observe(noisy,'dynatrace-logs',page);throw Error('Expected the fictional source scope limit');}catch(error){if(!(error instanceof LogScopeLimitError))throw error;}
  const ledgerAt=await r.store.coordinationNow(),ledger=await samples(quiet,{version:sha,at:ledgerAt}),health=Array.from({length:180},(_,n)=>({timestamp:ledgerAt-1000+n,level:'INFO',environment:quiet.environment,region:'eu-west-1',sha,operation:'/health',statusCode:200,message:'Routine green probe'})),logs={records:[...health,...ledger],complete:true};await r.store.ingestLogRead({serviceKey:quiet.key,logs,until:ledgerAt});
  // Faithful recovery boundary: admission commits, then the process stops
  // before evaluation. The accepted sample IDs survive; no fake incident does.
  const evaluate=r.logDetector.evaluate;let interrupted=false;r.logDetector.evaluate=async service=>{if(service.key===quiet.key){interrupted=true;throw Error('Controlled fixture stop after admission');}return evaluate.call(r.logDetector,service);};
  try{await r.logDetector.observe(quiet,'dynatrace-logs',logs);}catch(error){if(error.message!=='Controlled fixture stop after admission')throw error;}finally{r.logDetector.evaluate=evaluate;}if(!interrupted)throw Error('Admission did not reach its recovery boundary');
  state={version:1,id,rooms,sha,seededAt:now};await r.store.checkpoint('fixture:log-isolation:v1',state);
 }
 return{get r(){return r;},get state(){return state;},config,noisy,quiet,sent,samples,message,
  advance:async()=>{let failure;try{await r.investigate();}catch(error){if(!(error instanceof LogScopeLimitError))throw error;failure=error;}return failure;},
  deliver:async()=>{for(let n=0;n<100;n++){await r.deliver();await r.outbox.drainSettled();const[row]=await r.store.db.query("SELECT COUNT(*) AS n FROM sre_outbox WHERE status IN ('pending','sending') AND conversation_key IS NOT NULL");if(!Number(row.n))return;}throw Error('The mock isolation sender did not drain');},
  restart:async()=>{if(!databaseFactory&&(dialect!=='sqlite'||path===':memory:'))throw Error('Use durable SQL for a restart');await r.close();await open();},close:()=>r.close()};
}
