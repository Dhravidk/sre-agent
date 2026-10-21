import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { postgresDatabase } from '../src/sre/database.mjs';
import { RulesReasoner } from '../src/sre/reasoner.mjs';
import { seedDemo,devActivity } from '../src/sre/demo.mjs';
import { pilotPolicySource } from '../scripts/seed-pilot.mjs';
import { GithubConnector } from '../src/sre/connectors.mjs';
import { ApiClient } from '../src/sre/http-client.mjs';
import { providerRetryGate } from '../src/sre/provider-retry.mjs';

// Private fault injection changes this process's application wall clock only.
// PostgreSQL and the supervisor keep their real clocks; timers remain real.
const actualNow=Date.now;let applicationClockOffset=0;
Date.now=()=>actualNow()+applicationClockOffset;

// Private IPC-only driver for the isolated PostgreSQL exercise. The HTTP server
// uses the production routes; provider/model transports are local fixtures.
const config=loadConfig({});
config.mode='connected';config.databaseUrl=process.env.SRE_FIXTURE_DATABASE;
config.apiToken=process.env.SRE_FIXTURE_API_TOKEN;config.capabilitySecret='fixture-postgres-capability-secret-32';
config.env={};config.operations={notify:false};
if(process.env.SRE_FIXTURE_PROOF_KEY){config.env.RESTORE_PROOF_KEY=process.env.SRE_FIXTURE_PROOF_KEY;config.services[0].verification={webhookSecretEnv:'RESTORE_PROOF_KEY'};}
const scheduled=process.env.SRE_FIXTURE_SCHEDULED==='true',name=process.env.SRE_FIXTURE_PEER;
config.instanceId=name;
if(!config.databaseUrl||!/^peer-[ab]$/.test(name||''))throw new Error('PostgreSQL exercise supervisor required');
const rules=new RulesReasoner(),db=await postgresDatabase(config.databaseUrl);
let runtime;
let pollAuthDenied=false,pollAuthRequests=0;
let retryProbeRequests=0;
const sender=process.env.SRE_FIXTURE_SEND_LOG?{send:async(reference,text)=>{
  if(reference.serviceUrl!=='https://teams-postgres-fixture.invalid')throw new Error('Only the private fixture sender is allowed');
  const id='synthetic-message-'+actualNow();
  appendFileSync(process.env.SRE_FIXTURE_SEND_LOG,JSON.stringify({peer:name,pid:process.pid,id,text})+'\n');return {id};
}}:undefined;
const clients={
  github:{
    deployments:async()=>({items:(await db.query('SELECT payload FROM sre_deployments WHERE service_key=?',[config.services[0].key])).map(row=>JSON.parse(row.payload)),complete:true}),
    linkedChanges:async()=>({items:[],complete:true}),
    compare:async(base,head)=>({merge_base_commit:{sha:base},files:[{filename:'src/auction/rules.mjs',patch:base+' -> '+head}]}),
    file:async(path,sha)=>({path,sha,complete:true,content:pilotPolicySource(sha)}),
  },
  rollback:{dispatch:async proposal=>{
    appendFileSync(process.env.SRE_FIXTURE_DISPATCH_LOG,JSON.stringify({peer:name,pid:process.pid,requestId:proposal.id,at:Date.now()})+'\n');
    await delay(200);
    return {provider:'github',status:'dispatched',requestId:proposal.id,synthetic:true};
  }},
};
runtime=await createSreRuntime({
  config,db,autoStart:scheduled,sender,
  connectors:new Map([[config.services[0].key,clients]]),
  reasoner:{investigate:async(context,options)=>{
    if(scheduled) {
      const state={sessionId:context.session.remote_state.sessionId||'synthetic-'+context.session.agent_id,streamIndex:1};
      await options.persistRemote(state);
      process.send?.({type:'investigation-started',peer:name,incidentId:context.incident.id,agentId:context.session.agent_id,remoteState:state});
      if(process.env.SRE_FIXTURE_PAUSE==='true')await delay(30000,undefined,{signal:options.signal});
      return {...await rules.investigate(context,options),remoteState:{...state,streamIndex:2}};
    }
    return rules.investigate(context,options);
  }},
});
runtime.worker.leaseMs=2000;
runtime.server.listen(0,'127.0.0.1',()=>process.send?.({type:'ready',peer:name,pid:process.pid,port:runtime.server.address().port,owner:runtime.worker.owner}));
let closing=false;
const pausedTransactions=new Map();
const originalPollConnectors=runtime.poller.connectors;
async function close(){if(closing)return;closing=true;await runtime.close();process.exit(0);}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void close());
process.on('disconnect',()=>void close());
process.on('message',async request=>{
  if(!request?.id||!request.action)return;
  try {
    let result;
    const input=request.input||{};
    switch(request.action) {
      case 'retry-probe':{
        const scope=input.scope??'shared-synthetic-account';
        if(!['shared-synthetic-account','successful-quota-account','backup-snapshot','backup-gap'].includes(scope))throw new Error('Unknown private retry fixture scope');
        const gate=providerRetryGate(runtime.store,{tenant:'retry-fixture',provider:'github',endpoint:'https://retry-postgres-fixture.invalid',scope});
        const options={clock:()=>runtime.store.coordinationNow(),retryGate:gate,fetcher:async()=>{
          retryProbeRequests++;
          const headers={'content-type':'application/json',...(input.limited?{'retry-after':'10'}:{})};
          if(scope==='successful-quota-account'&&input.exhausted)Object.assign(headers,{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.ceil(await runtime.store.coordinationNow()/1000)+10)});
          return new Response('[]',{status:input.limited?429:200,headers});
        }};
        const client=scope==='successful-quota-account'
          ?new GithubConnector({base:'https://retry-postgres-fixture.invalid',repository:'fixture/auction',tokenEnv:'READ'},{...options,env:{READ:'synthetic'}})
          :new ApiClient({base:'https://retry-postgres-fixture.invalid',...options});
        try{await client.request(client.repo||'/read');result={status:200};}
        catch(error){result={status:error.status,providerStatus:error.providerStatus,retryAfterMs:error.retryAfterMs,error:error.message};}
        result={...result,requests:retryProbeRequests,pid:process.pid,hold:await gate.read(),coordinationNow:await runtime.store.coordinationNow(),applicationNow:Date.now()};break;
      }
      case 'clock-offset':{
        if(!Number.isSafeInteger(input.ms)||Math.abs(input.ms)>300000)throw new Error('Invalid fixture clock offset');
        applicationClockOffset=input.ms;result={offsetMs:applicationClockOffset,applicationNow:Date.now(),actualNow:actualNow()};break;
      }
      case 'ingest':result=await runtime.store.ingest(input);break;
      case 'paused-ingest':{
        const transaction=db.transaction.bind(db);
        let released;
        const waiting=new Promise(accept=>{released=accept;});pausedTransactions.set(request.id,released);
        db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{
          const rows=await q(sql,args);
          if(sql.startsWith('INSERT INTO sre_events')) {
            const [backend]=await q('SELECT pg_backend_pid() AS pid');
            process.send?.({type:'transaction-paused',requestId:request.id,backendPid:backend.pid});
            await waiting;
          }
          return rows;
        }));
        try{result=await runtime.store.ingest(input);}
        finally{db.transaction=transaction;pausedTransactions.delete(request.id);}
        break;
      }
      case 'release-transaction':pausedTransactions.get(input.requestId)?.();result={released:true};break;
      case 'claim':result=await runtime.store.claim(runtime.worker.owner,input.leaseMs||5000);break;
      case 'heartbeat':result=await runtime.store.heartbeat(runtime.worker.owner,input.jobId,input.leaseMs||5000);break;
      case 'fail':result=await runtime.store.fail(input.job,new Error(input.message||'Synthetic late failure'));break;
      case 'accept-command':{
        const sample=devActivity(input.text,config.services[0],{serviceUrl:'https://teams-postgres-fixture.invalid'});
        result=await runtime.router.accept(sample.activity,sample.reference);break;
      }
      case 'enqueue-message':{
        const service=config.services[0],conversation=await runtime.store.rememberConversation({tenant:service.teams.tenantId,serviceKey:service.key,reference:{serviceUrl:'https://teams-postgres-fixture.invalid',conversation:{id:service.teams.conversations[0],conversationType:'personal'}}});
        await runtime.store.queueMessage(input.incidentId,input.text,conversation,input.key);result={queued:true};break;
      }
      case 'command':result=await runtime.router.processOnce();break;
      case 'outbox':result=await runtime.outbox.runOnce();break;
      case 'rollback-recover':result=await runtime.rollbacks.recoverInterrupted();break;
      case 'operations':result=await runtime.operations.snapshot();break;
      case 'operations-notices':{
        config.teamsMode=input.enabled?'live':'off';runtime.operations.limits.notify=Boolean(input.enabled);
        config.services[0].github.enabled=false;runtime.operations.end('tick');
        if(input.enabled) {
          const service=config.services[0];
          await runtime.store.rememberConversation({tenant:service.teams.tenantId,serviceKey:service.key,reference:{serviceUrl:'https://teams-postgres-fixture.invalid',conversation:{id:service.teams.conversations[0],conversationType:'personal'}}});
        }
        result={runtimeId:runtime.operations.runtimeId,instanceId:runtime.operations.instanceId};break;
      }
      case 'operations-fault':runtime.operations.end('tick',input.message?new Error(input.message):undefined);result={updated:true};break;
      case 'operations-source':{
        const service=config.services[0];service.github.enabled=true;
        const { pollScopeHash }=await import('../src/sre/poll-scope.mjs'),now=await runtime.store.coordinationNow();
        await runtime.store.checkpoint('github:'+service.key,{scopeHash:pollScopeHash(service,'github'),complete:!input.error,...(input.error?{error:input.error,failedAt:now}:{successAt:now})});result={updated:true};break;
      }
      case 'observe-operations':result=await runtime.operations.observe();break;
      case 'poll-auth':{
        const service=config.services[0];service.github.enabled=Boolean(input.enabled);
        if(input.enabled) {
          pollAuthDenied=Boolean(input.denied);
          runtime.poller.connectors=new Map([[service.key,{github:new GithubConnector({...service.github,tokenEnv:'FIXTURE_READ'},{env:{FIXTURE_READ:'synthetic'},fetcher:async(url,options)=>{
            if(new URL(url).origin!=='https://api.github.com'||options.method!=='GET')throw new Error('Only a synthetic GitHub read is allowed');
            pollAuthRequests++;return new Response(JSON.stringify(pollAuthDenied?{message:'Unauthorized'}:[]),{status:pollAuthDenied?401:200});
          }})}]]);
        } else {runtime.poller.connectors=originalPollConnectors;runtime.poller.localReads.clear();}
        result={requests:pollAuthRequests};break;
      }
      case 'poll-source':await runtime.poller.runOnce();result={requests:pollAuthRequests};break;
      case 'finish':result=await runtime.store.finish(input.job,input.analysis,input.remoteState,input.expectedRevision);break;
      case 'checkpoint':result=await runtime.store.setRemoteState(input.incidentId,input.remoteState,input.job);break;
      case 'retry':result=await runtime.store.retryInvestigation(input);break;
      case 'seed':result=await seedDemo(runtime.store,config.services[0]);break;
      case 'investigate':result=await runtime.worker.runOnce();break;
      case 'propose':result=await runtime.rollbacks.propose(input.incidentId,input.principal);break;
      case 'approve':result=await runtime.rollbacks.approve(input.id,input.nonce,input.principal);break;
      case 'execute':result=await runtime.rollbacks.executeNext();break;
      default:throw new Error('Unsupported PostgreSQL exercise operation');
    }
    process.send?.({type:'result',id:request.id,result});
  } catch(error){process.send?.({type:'result',id:request.id,error:{name:error.name,message:error.message,cause:error.cause?.message,status:error.status}});}
});
