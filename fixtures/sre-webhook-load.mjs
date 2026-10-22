import {PGlite} from '@electric-sql/pglite';
import {createSreRuntime} from '../src/sre/server.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {normalize} from '../src/sre/normalize.mjs';

export const webhookLoadHead='a'.repeat(40);
// Fictional provider/people/source data; real runtime, SQL and local sender.
// A caller-supplied database factory supports an owned native PostgreSQL test.
export async function webhookLoadFixture(dialect,{path=':memory:',databaseFactory,initialize=true}={}){
  const config=loadConfig({SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-ci-attention-cli'}),service=config.services[0],rooms=['load-bidding','load-platform','load-provider'],sent=[];
  service.teams={...service.teams,conversations:rooms,collaborationGroups:[{key:'response',name:'Fictional pipeline response',conversations:rooms.map(id=>({id,name:id}))}]};
  service.gitlab={...service.gitlab,base:'https://gitlab.invalid',project:'17',enabled:false};
  let r,sequence=0,at=Date.now()-10000,stable;
  const open=async()=>{
    const pg=!databaseFactory&&dialect==='postgres'?new PGlite():null;
    const db=databaseFactory?await databaseFactory():pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
    r=await createSreRuntime({config,db,autoStart:false,connectors:new Map([[service.key,{}]]),sender:{send:async(ref,text)=>{const receipt='fictional-load-'+ ++sequence;sent.push({receipt,room:ref.conversation.id,text});return{id:receipt,simulation:true};}}});
    const rules=r.worker.reasoner;
    r.worker.reasoner={investigate:async(context,options)=>{stable||=(await rules.investigate(context,options)).analysis;return{analysis:structuredClone(stable)};}};
  };
  await open();
  const id=initialize?(await seedDemo(r.store,service)).incidentId:null,other=initialize?(await r.store.ingest({id:'load-separate-provider',source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'load-separate-provider',status:'OPEN',at,payload:{synthetic:true}})).incidentId:null;
  const message=async(room,text)=>{const sample=devActivity(text,service,{id:'load-chat-'+ ++sequence,conversationId:rooms[room],conversationType:'groupChat'});await r.router.accept(sample.activity,sample.reference);await r.router.processOnce();};
  if(initialize){await message(0,'join '+id);await message(1,'join '+id);await message(2,'join '+other);}
  const mr=(head=webhookLoadHead,{number=72,when=++at,state='opened'}={})=>r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'merge_request',object_attributes:{iid:number,state,last_commit:{id:head},updated_at:new Date(when).toISOString(),title:'Fictional load-test MR; never action authority'}},service,{deliveryId:'load-mr-'+ ++sequence}));
  const ci=(pipeline,status,{head=webhookLoadHead,when=++at,field='updated_at',project=17}={})=>r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{id:pipeline,project_id:project,sha:head,status,[field]:new Date(when).toISOString()}},service,{deliveryId:'load-ci-'+ ++sequence}));
  const settle=async()=>{for(let n=0;n<100;n++){const[row]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.count))return;await r.worker.runOnce();}throw Error('Fictional load fixture work did not settle');};
  if(initialize){await mr();await r.casework.trackChange(id,'gitlab',72,{kind:'local-operator',id:'Fictional lead'});await settle();}
  return{get r(){return r;},config,service,rooms,sent,id,other,mr,ci,message,settle,
    analysis:async()=>(await r.store.context(id)).incident.analysis,
    checkpoint:async()=>new Set((await r.store.db.query('SELECT id FROM sre_outbox')).map(row=>row.id)),
    notices:async since=>(await r.store.db.query('SELECT * FROM sre_outbox WHERE incident_id=? ORDER BY created_at,id',[id])).filter(row=>!since.has(row.id)),
    question:()=>r.store.ingest({id:'load-question-'+ ++sequence,source:'operator-api',serviceKey:service.key,incidentId:id,kind:'question',at:++at,payload:{text:'Restate the current evidence and the specific newly changed pipeline; this is not approval.'}}),
    restart:async()=>{if(!databaseFactory&&(dialect!=='sqlite'||path===':memory:'))throw Error('Restart requires durable fixture storage');await r.close();await open();},
    close:()=>r.close()};
}
