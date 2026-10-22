import {PGlite} from '@electric-sql/pglite';
import {createSreRuntime} from '../src/sre/server.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {RulesReasoner} from '../src/sre/reasoner.mjs';
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {prepareRestore,releaseRestore} from '../src/sre/restore-recovery.mjs';

// Actual runtime/HTTP/SQL; fictional identities, source records and local sends.
// A model-mode label tests the hold gate with an injected rules stub, never CLI.
export async function restoreConsoleFixture(dialect,{path=':memory:',modelMode=false,databaseFactory}={}){
 const config=loadConfig({SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-restore-console-cli'}),service=config.services[0],rooms=['restore-bidding','restore-platform'],sent=[];
 service.teams={...service.teams,conversations:rooms,collaborationGroups:[{key:'restore-coordination',name:'Fictional restore response',conversations:rooms.map(id=>({id,name:id}))}]};
 if(modelMode)config.agentMode='claude';
 let r,sequence=0,modelCalls=0,qaCalls=0;
 const open=async()=>{
  const pg=dialect==='postgres'&&!databaseFactory?new PGlite():null,db=databaseFactory?await databaseFactory():pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined,rules=new RulesReasoner();
  r=await createSreRuntime({config,db,autoStart:false,connectors:new Map([[service.key,{}]]),reasoner:{investigate:async(context,options)=>{modelCalls++;return rules.investigate(context,options);}},sender:{send:async(ref,text)=>{const receipt='restore-local-'+ ++sequence;sent.push({receipt,room:ref.conversation.id,text,simulation:true});return{id:receipt,simulation:true};}},qaAdapter:{localOnly:true,execute:async()=>{qaCalls++;throw Error('The restore-console fixture must not execute QA');}}});
 };
 await open();
 const settle=async()=>{for(let n=0;n<100;n++){const[row]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.count))return;if(!await r.worker.runOnce())return;}throw Error('Restore console fixture did not settle');};
 const id=(await seedDemo(r.store,service)).incidentId;
 const other=(await r.store.ingest({id:'restore-other-provider',source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'restore-other-provider',status:'OPEN',at:Date.now(),payload:{synthetic:true,metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}}})).incidentId;
 const activity=(room,text,{userId='local-operator',deliveryId='restore-chat-'+ ++sequence}={})=>devActivity(text,service,{id:deliveryId,conversationId:rooms[room],conversationType:'groupChat',userId,displayName:userId==='noor'?'Noor · fictional responder':'Avery · fictional responder'});
 for(let room=0;room<2;room++){const sample=activity(room,'join '+id);await r.router.accept(sample.activity,sample.reference);await r.router.processOnce();}
 await settle();const plan=await r.casework.createPlan(id);
 const start=async()=>{if(!r.server.listening)await new Promise(resolve=>r.server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+r.server.address().port;};
 return {get r(){return r;},config,service,id,other,rooms,sent,plan,activity,settle,
  calls:()=>({reasoner:modelCalls,qa:qaCalls}),
  request:async(path,body)=>fetch(await start()+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),
  prepare:async()=>{const now=await r.store.coordinationNow();return prepareRestore(r.store,{restoreId:'fixture-console-restore',backupSha256:'c'.repeat(64),backupAt:now-1,reason:'Fictional isolated restore-console reconciliation',actor:{kind:'local-operator',id:'Fictional restore coordinator'},offline:true});},
  release:async()=>releaseRestore(r.store,{restoreId:'fixture-console-restore',requestId:'console-release',reason:'Independent fictional records were reviewed; uncertain effects remain unknown',actor:{kind:'local-operator',id:'Fictional restore coordinator'},observedAt:await r.store.coordinationNow(),evidenceUrls:['https://fixture.invalid/restore-console-evidence']}),
  restart:async()=>{if(!databaseFactory&&(dialect!=='sqlite'||path===':memory:'))throw Error('Durable storage is required for fixture reopen');await r.close();await open();},
  close:()=>r.close()};
}
