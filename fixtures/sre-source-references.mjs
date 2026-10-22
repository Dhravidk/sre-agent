import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createSreRuntime} from '../src/sre/server.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {GitlabConnector} from '../src/sre/connectors.mjs';
import {rehearsalProfile} from './sre-rehearsal.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {normalize} from '../src/sre/normalize.mjs';

export const ledgerSourcePath='src/ledger/repository.py';
export const amountSourcePath='src/ledger/amounts.py';
export const amountSource=`"""Fictional ledger wire adapter. The upstream amount contract needs review."""

class InvalidAmount(ValueError):
    pass


def parse_minor_units(raw):
    if not isinstance(raw, str):
        raise InvalidAmount("Expected a string amount")
    if not raw.strip():
        raise InvalidAmount("Amount is required")
    return int(raw.strip())
`;
export const amountSourceLine=amountSource.split('\n').findIndex(line=>line.includes('return int('))+1;
const initial=`from dataclasses import dataclass

@dataclass(frozen=True)
class AcceptedBid:
    auction_id: str
    amount: int
    expected_version: int

def save_bid(connection, bid):
    if bid.amount <= 0:
        raise ValueError("A bid must be positive")
    statement = (
        "UPDATE auction_ledger SET amount = ?, version = version + 1 "
        "WHERE auction_id = ? AND version = ?"
    )
    parameters = (bid.amount, bid.auction_id, bid.expected_version)
    changed = connection.execute(statement, parameters).rowcount
    if changed != 1:
        raise RuntimeError("Concurrent auction update; retry from a fresh ledger")
    return changed
`;
const faulty=initial.replace('WHERE auction_id = ? AND version = ?','WHERE auction_id = ?').replace('parameters = (bid.amount, bid.auction_id, bid.expected_version)','parameters = (bid.amount, bid.auction_id)');

// Actual generated Git history and file bytes; API payloads and the incident
// are fictional. Retrieved source is never imported, compiled or executed.
export async function sourceReferenceFixture(dialect,{databasePath=':memory:',databaseFactory,directory,seed=true,reasoner,logLocations=false,followUp=false,logReader}={}){
 const ownedDirectory=!directory;directory??=await mkdtemp(join(tmpdir(),'sre-source-reference-'));await mkdir(directory,{recursive:true});
 const repository=join(directory,'repository'),manifestPath=join(directory,'source-manifest.json'),git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8'}).trim();let manifest;
 try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch(error){
  if(error.code!=='ENOENT')throw error;
  await mkdir(join(repository,'src/ledger'),{recursive:true});git('init','--initial-branch=main');git('config','user.name','Fictional source fixture');git('config','user.email','source-fixture@example.invalid');
  await writeFile(join(repository,ledgerSourcePath),initial);await writeFile(join(repository,'src/ledger/retry.py'),'def retryable(error):\n    return isinstance(error, RuntimeError)\n');if(logLocations)await writeFile(join(repository,amountSourcePath),amountSource);git('add','.');git('commit','-qm','Ledger: protect accepted bids with optimistic version checks');const base=git('rev-parse','HEAD');
  git('switch','-c','codex/fixture-ledger-regression');await writeFile(join(repository,ledgerSourcePath),faulty);git('add','.');git('commit','-qm','Ledger: simplify update predicate (fictional regression)');const head=git('rev-parse','HEAD');manifest={base,head,path:ledgerSourcePath,observedAt:Date.now()-1000};await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
 }
 const raw=rehearsalProfile(),service=raw.services[0];service.key='source-ledger-fixture';service.name='Fictional ledger API';service.environment='testing';service.logMonitors=[];service.dynatrace.entityId='SERVICE-SOURCE-LEDGER';service.gitlab={...service.gitlab,enabled:false,base:'https://gitlab-source-fixture.invalid',project:'fixture/ledger',tokenEnv:'SOURCE_FIXTURE_TOKEN',sourceInspection:{enabled:true}};
 if(logLocations)service.gitlab.sourceInspection.logLocations={pathField:'code.file.path',lineField:'code.line.number',revisionField:'service.version',pathPrefix:'/srv/ledger/'};
 if(followUp)service.investigation={followUp:{enabled:true}};
 const config=validateConfig(raw,{SRE_SQLITE_PATH:databasePath,SRE_CLAUDE_BIN:'/nonexistent-source-reference-model',SRE_TEAMS_MODE:'off'}),calls=[],sent=[],rooms=service.teams.conversations.slice(0,2).map((root,n)=>root+';messageid='+String(9000000000001+n));let r,sequence=0,problemId;
 if(!Number.isSafeInteger(manifest.observedAt)){manifest.observedAt=Date.now()-1000;await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});}
 const at=manifest.observedAt,diff=git('diff','--no-ext-diff',manifest.base,manifest.head,'--',ledgerSourcePath),reply=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 const logReply={records:[{timestamp:new Date(at).toISOString(),'deployment.environment':service.environment,'cloud.region':'fictional-eu','service.version':manifest.head,loglevel:'ERROR','error.code':'AMOUNT_PARSE','exception.type':'ValueError','code.file.path':'/srv/ledger/'+amountSourcePath,'code.line.number':amountSourceLine,content:"Invalid literal for int(): '1,250.00'; the producer and ledger wire contract disagree."}],complete:true};
 const logCalls=[];
 const client=new GitlabConnector(service.gitlab,{env:{SOURCE_FIXTURE_TOKEN:'fictional-source-reader'},fetcher:async(url,options)=>{
  if(options.method!=='GET')throw Error('The source fixture permits reads only');const parsed=new URL(url);calls.push({path:parsed.pathname,query:parsed.search,method:options.method});const root='/api/v4/projects/'+encodeURIComponent(service.gitlab.project);
  if(parsed.pathname===root+'/deployments')return reply([manifest.base,manifest.head].map((sha,n)=>({id:100+n,sha,environment:{name:service.environment},status:'success',created_at:new Date(at-(n?300000:900000)).toISOString(),updated_at:new Date(at-(n?300000:900000)).toISOString()})));
  if(parsed.pathname===root+'/repository/compare'){
   if(parsed.searchParams.get('from')!==manifest.base||parsed.searchParams.get('to')!==manifest.head)throw Error('The source fixture requires its exact immutable comparison');
   return reply({commit:{id:manifest.head},compare_timeout:false,diffs:[{old_path:ledgerSourcePath,new_path:ledgerSourcePath,new_file:false,deleted_file:false,renamed_file:false,too_large:false,collapsed:false,diff}]});
  }
  if(parsed.pathname.startsWith(root+'/repository/files/')){
   const path=decodeURIComponent(parsed.pathname.slice((root+'/repository/files/').length)),sha=parsed.searchParams.get('ref');
   if(![ledgerSourcePath,...(logLocations?[amountSourcePath]:[]),...(followUp?['src/ledger/retry.py']:[])].includes(path)||![manifest.base,manifest.head].includes(sha))throw Error('The source fixture rejected a foreign file or revision');const bytes=execFileSync('git',['-C',repository,'show',sha+':'+path]);return reply({file_path:path,commit_id:sha,encoding:'base64',size:bytes.length,content:bytes.toString('base64')});
  }
  if(parsed.pathname.endsWith('/merge_requests')&&parsed.pathname.includes('/repository/commits/'))return reply([]);
  throw Error('Unexpected source-fixture endpoint');
 }});
 const open=async()=>{const pg=!databaseFactory&&dialect==='postgres'?new PGlite():null,db=databaseFactory?await databaseFactory():pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;r=await createSreRuntime({config,db,reasoner,autoStart:false,connectors:new Map([[service.key,{gitlab:client,...(logLocations||logReader?{dynatraceLogs:{logs:async options=>{logCalls.push({from:options.from,to:options.to});return logReader?logReader(options,logReply):structuredClone(logReply);}}}:{})}]]),sender:{send:async(ref,text)=>{sent.push({room:ref.conversation.id,text});return{id:'fictional-source-send-'+randomUUID(),simulation:true};}}});};await open();
 const settle=async()=>{for(let n=0;n<100;n++){const[row]=await r.store.db.query("SELECT COUNT(*) AS n FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.n))return;await r.worker.runOnce();}throw Error('Source fixture work did not settle');};
 const message=async(room,text,user='local-operator')=>{const a=devActivity(text,service,{id:'source-message-'+ ++sequence,conversationId:room,conversationType:'channel',userId:user,displayName:user+' · fictional source drill'});await r.router.accept(a.activity,a.reference);await r.router.processOnce();};
 try{if(seed){await r.casework.importDirectory(service.key,{source:'Fictional source ownership directory',observedAt:at,expiresAt:at+86400000,entries:[{id:'ledger-owner',name:'Avery Chen',team:'Ledger Engineering',contact:'ledger-owner@example.invalid',role:'component-owner',paths:[ledgerSourcePath,...(logLocations?[amountSourcePath]:[]),...(followUp?['src/ledger/retry.py']:[])]},{id:'ledger-escalation',name:'Noor Patel',team:'Platform',contact:'ledger-platform@example.invalid',role:'service-owner',paths:[]}]});const result=await r.store.ingest(normalize('dynatrace',{ProblemID:'SOURCE-LEDGER-1',State:'OPEN',EntityIds:[service.dynatrace.entityId],StartedAt:at,ObservedAt:at,Title:logLocations?'Fictional wire amount parse failure':'Fictional accepted bid lost after a concurrent write',metrics:{codes:[logLocations?'AMOUNT_PARSE':'LEDGER_UPDATE_LOST'],requests:7}},service,{deliveryId:'source-fixture-problem'}));problemId=result.incidentId;for(const [n,root]of service.teams.conversations.slice(0,2).entries()){const a=devActivity('help',service,{conversationId:root,conversationType:'channel'});await r.store.rememberConversation({tenant:service.teams.tenantId,serviceKey:service.key,reference:a.reference});await message(rooms[n],'join '+problemId);}await settle();}}catch(error){await r.close();if(ownedDirectory)await rm(directory,{recursive:true,force:true});throw error;}
 return{get r(){return r;},get id(){return problemId;},set id(value){problemId=value;},config,service,manifest,calls,sent,rooms,repository,directory,settle,message,client,logReply,logCalls,
  deliver:async()=>{for(let n=0;n<100;n++){await r.deliver();await r.outbox.drainSettled();const[row]=await r.store.db.query("SELECT COUNT(*) AS n FROM sre_outbox WHERE status IN ('pending','sending') AND conversation_key IS NOT NULL");if(!Number(row.n))return;}throw Error('Source fixture messages did not drain');},
  question:async(text='Inspect the exact ledger source and explain competing explanations before attributing the failure.')=>r.store.ingest({id:'source-question-'+ ++sequence,source:'operator-api',serviceKey:service.key,incidentId:problemId,kind:'question',at:await r.store.coordinationNow(),payload:{text}}),
  restart:async()=>{if(!databaseFactory&&(dialect!=='sqlite'||databasePath===':memory:'))throw Error('A durable source fixture is required');await r.close();await open();},
  close:async()=>{await r.close();if(ownedDirectory)await rm(directory,{recursive:true,force:true});},
 };
}
