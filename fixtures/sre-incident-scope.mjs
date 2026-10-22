import {PGlite} from '@electric-sql/pglite';
import {createSreRuntime} from '../src/sre/server.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {rehearsalProfile,seedRehearsal,settleRehearsal} from './sre-rehearsal.mjs';
import {devActivity} from '../src/sre/demo.mjs';

// Fictional people/provider scopes around actual generated local fixture code.
// Native PostgreSQL callers may supply a private owned database factory.
export async function incidentScopeFixture(dialect,{path=':memory:',databaseFactory,initialize=true}={}){
 const config=validateConfig(rehearsalProfile(),{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-incident-scope-cli',SRE_TEAMS_MODE:'off'}),service=config.services[0],sent=[];let r,state,sequence=0;
 const open=async()=>{const pg=!databaseFactory&&dialect==='postgres'?new PGlite():null,db=databaseFactory?await databaseFactory():pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;r=await createSreRuntime({config,db,autoStart:false,connectors:new Map([[service.key,{}]]),sender:{send:async(ref,text)=>{sent.push({room:ref.conversation.id,text});return{id:'fictional-scope-'+ ++sequence,simulation:true};}}});state=initialize?await seedRehearsal(r):null;};await open();
 const question=async(id=state.primaryId,text='Compare the reported incident scope, other source observations and the exact code; do not infer recovery.')=>r.store.ingest({id:'scope-question-'+ ++sequence,source:'operator-api',serviceKey:service.key,incidentId:id,kind:'question',at:await r.store.coordinationNow(),payload:{text}});
 const message=async(id,room,text,user='avery')=>{const a=devActivity(text,service,{id:'scope-message-'+ ++sequence,conversationId:room,conversationType:'channel',userId:user,displayName:user+' · fictional scope drill'});await r.router.accept(a.activity,a.reference);await r.router.processOnce();};
 const deliver=async()=>{for(let n=0;n<100;n++){await r.deliver();await r.outbox.drainSettled();const[row]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_outbox WHERE status IN ('pending','sending') AND conversation_key IS NOT NULL");if(!Number(row.count))return;}throw Error('The fictional scope sender did not drain joined destinations');};
 return{get r(){return r;},get state(){return state;},config,service,sent,question,message,deliver,settle:()=>settleRehearsal(r),
  foreign:async({count=3,extra={},id=state.primaryId,source='dynatrace'}={})=>{const at=await r.store.coordinationNow(),records=Array.from({length:count},(_,n)=>({timestamp:at-100+n,level:'CRITICAL',code:'CREDIT_PROVIDER_UNAVAILABLE',environment:service.environment,region:'us-east-1',sha:state.baselineSha,operation:'/api/credit',entityId:service.dynatrace.entityId,message:'Fictional US provider failure; compare dependencies before relating to EU ledger',requestId:'scope-us-'+ ++sequence,...extra}));return r.store.addEvidence(id,source,'logs',{records,complete:true},at);},
  restart:async()=>{if(!databaseFactory&&(dialect!=='sqlite'||path===':memory:'))throw Error('A durable scope fixture is required for reopen');await r.close();await open();},close:()=>r.close()};
}
