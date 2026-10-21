import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { postgresDatabase, sqliteDatabase, StorageError } from './database.mjs';
import { SreStore,conversationKey } from './store.mjs';
import { createConnectors } from './connectors.mjs';
import { providerRetryGate } from './provider-retry.mjs';
import { RulesReasoner, EveReasoner, boundedContext } from './reasoner.mjs';
import { ClaudeReasoner } from './claude-reasoner.mjs';
import { IncidentWorker } from './worker.mjs';
import { Rollbacks, assessRollback } from './rollback.mjs';
import { TeamsRouter, TeamsOutbox, startSreTeams,incidentConversation } from './teams.mjs';
import { ConnectorPoller } from './poller.mjs';
import { normalize } from './normalize.mjs';
import { equalSecret, verifyGithub, verifySigned, readEvidenceCapability, redact, assertText, hash } from './security.mjs';
import { seedDemo, devActivity } from './demo.mjs';
import { riskScope } from './analytic-risk.mjs';
import { OperationalMonitor,connectionReadHealth } from './operations.mjs';
import { isSimulationMode } from './runtime-mode.mjs';
import { IncidentCollaboration,roomScope } from './collaboration.mjs';
import {Casework} from './casework.mjs';
import {normalizeAlert} from './alert-intake.mjs';
import {LogDetector} from './log-detection.mjs';
import {DeliveryInspections} from './delivery-inspections.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
async function body(req) {
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw fail(413,'Request exceeds 1 MiB');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
const decode=(raw)=>{try{return JSON.parse(raw.toString('utf8'));}catch{throw fail(400,'Invalid JSON');}};
const bearer=(req)=>String(req.headers.authorization||'').replace(/^Bearer /,'');

export async function createSreRuntime({config=loadConfig(),db,connectors,reasoner,sender,qaAdapter,deliveryOptions,autoStart=true}={}) {
  const simulation=isSimulationMode(config.mode);
  const store=await new SreStore(db||(config.databaseUrl?await postgresDatabase(config.databaseUrl):sqliteDatabase(config.sqlitePath)),{simulation,services:config.services}).initialize();
  const secret=config.capabilitySecret||randomBytes(32).toString('hex');
  connectors ||= new Map(config.services.map(service=>[service.key,simulation?{}:createConnectors(service,{env:config.env,clock:()=>store.coordinationNow(),retryGateFactory:descriptor=>providerRetryGate(store,descriptor)})]));
  reasoner ||= config.agentMode==='claude'?new ClaudeReasoner({config,env:config.env}):config.agentMode==='eve'?new EveReasoner({host:config.env.EVE_URL,token:config.env.EVE_TOKEN,capabilitySecret:secret}):new RulesReasoner();
  const casework=new Casework({store,services:config.services,qaAdapter});
  const inspections=new DeliveryInspections({store,services:config.services});
  const logDetector=new LogDetector({store,services:config.services});
  const worker=new IncidentWorker({store,services:config.services,connectors,reasoner,casework,restoreReadOnly:config.agentMode==='rules'});
  const rollbacks=new Rollbacks({store,services:config.services,connectors,mode:config.mode});
  const coordination=new IncidentCollaboration({store,services:config.services});
  const router=new TeamsRouter({store,services:config.services,rollbacks,coordination,casework,mode:simulation?'playground':'live'});
  const poller=new ConnectorPoller({store,services:config.services,connectors,logDetector,concurrency:config.pollConcurrency??4,activeReconcileIntervalMs:config.activeReconcileIntervalMs??300000,changeReadMaxAgeMs:(config.operations?.maxPollAgeSeconds??Math.max(180,(config.pollIntervalMs||60000)*3/1000))*1000});
  let bridge;
  if(config.teamsMode!=='off') {
    bridge=await startSreTeams({router,store,mode:config.teamsMode,env:config.env,host:config.host,port:Number(config.env.TEAMS_PORT||3978)});sender=bridge.sender;
  }
  const outbox=new TeamsOutbox({store,services:config.services,sender,casework,...deliveryOptions});
  const operations=new OperationalMonitor({store,config,poller,outbox,schedulerEnabled:autoStart});
  const activeDeliveries=new Set();let deliveryError;
  let activeTick,activePoll,activeCommands,closePromise;let stopped=false;
  // A slow read-only model turn must not delay durable command acknowledgements.
  // Deployment execution still follows investigation and revalidation in tick().
  function commands() {
    if(stopped)return Promise.resolve();
    if(!activeCommands)activeCommands=(async()=>{
      operations.begin('commands');let error;
      try {for(let i=0;i<50&&await router.processOnce();i++);await coordination.runOnce();await casework.runContactUpdates();void deliver().catch(error=>console.error('SRE delivery:',redact(error.message)));}
      catch(caught){error=caught;throw caught;}
      finally {operations.end('commands',error);}
    })().finally(()=>{activeCommands=undefined;});
    return activeCommands;
  }
  function tick() {
    if(stopped)return Promise.resolve();
    if(activeTick)return activeTick;
    activeTick=(async()=>{
      operations.begin('tick');let error;
      try {
      await commands();
      await logDetector.runOnce();await worker.runOnce();await casework.runOnce();await rollbacks.recoverInterrupted();await rollbacks.executeNext();await commands();
      } catch(caught){error=caught;throw caught;}
      finally {operations.end('tick',error);}
    })().finally(()=>{activeTick=undefined;});
    return activeTick;
  }
  function poll() {
    if(stopped)return Promise.resolve();
    if(!activePoll) {
      operations.begin('poll');
      activePoll=poller.runOnce().then(value=>{operations.end('poll');return value;},error=>{operations.end('poll',error);throw error;}).finally(()=>{activePoll=undefined;});
    }
    return activePoll;
  }
  function deliver(){
    if(stopped)return Promise.resolve(false);
    const capacity=outbox.capacity(),tasks=[];
    if(!activeDeliveries.size){operations.begin('delivery');deliveryError=undefined;}
    for(let i=0;i<capacity;i++){
      const task=outbox.runOnce();activeDeliveries.add(task);tasks.push(task);
      const finish=error=>{if(error)deliveryError=error;activeDeliveries.delete(task);if(!activeDeliveries.size)operations.end('delivery',deliveryError);};task.then(()=>finish(),finish);
    }
    if(!tasks.length&&!activeDeliveries.size)operations.end('delivery');
    return Promise.all([...activeDeliveries]);
  }
  function launchTick(){void tick().catch(error=>console.error('SRE worker:',redact(error.message)));}
  function launchCommands(){void commands().catch(error=>console.error('SRE commands:',redact(error.message)));}
  function launchPoll(){void poll().catch(error=>console.error('SRE polling:',redact(error.message)));}
  function launchObserve(){if(!stopped)void operations.observe().catch(error=>console.error('SRE operational checks:',redact(error.message)));}
  function launchDelivery(){void deliver().catch(error=>console.error('SRE delivery:',redact(error.message)));}
  let interval,pollInterval,observeInterval,commandInterval,deliveryInterval;
  if(autoStart){interval=setInterval(launchTick,1000);commandInterval=setInterval(launchCommands,1000);deliveryInterval=setInterval(launchDelivery,1000);pollInterval=setInterval(launchPoll,Math.max(10000,config.pollIntervalMs||60000));observeInterval=setInterval(launchObserve,10000);launchPoll();}

  const server=createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
    try {
      const url=new URL(req.url,'http://localhost');const path=url.pathname;
      if(req.method==='GET'&&path==='/health'){await store.db.query('SELECT 1');return send(200,{ok:true,mode:config.mode,agentMode:config.agentMode});}
      if(req.method==='GET'&&path==='/') {
        const html=await readFile(new URL('../sre-web/index.html',import.meta.url));
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"});return res.end(html);
      }
      if(req.method==='GET'&&['/app.js','/incident-view.js','/delivery-inspection.js','/style.css'].includes(path)) {
        const asset=await readFile(new URL('../sre-web'+path,import.meta.url));
        res.writeHead(200,{'content-type':path.endsWith('.js')?'text/javascript':'text/css','x-content-type-options':'nosniff'});return res.end(asset);
      }
      if(req.method==='GET'&&path==='/internal/evidence') {
        const claims=readEvidenceCapability(bearer(req),secret,await store.coordinationNow());if(!claims)throw fail(401,'Invalid incident capability');
        const context=await store.context(claims.incidentId);context.riskScope=riskScope(context,config.services.find(x=>x.key===context.incident.service_key),await store.coordinationNow());
        return send(200,boundedContext(context));
      }
      const hook=path.match(/^\/webhooks\/([a-z]+)\/([a-z0-9_-]+)$/);
      if(req.method==='POST'&&hook) {
        if(simulation)throw fail(403,'Vendor webhooks require connected mode; use the isolated simulator locally');
        const [,source,key]=hook;const service=config.services.find(x=>x.key===key);const connector=service?.[source];
        if(!connector?.webhookSecretEnv || connector.enabled===false)throw fail(404,'Webhook is not enabled');
        const raw=await body(req);const webhookSecret=config.env[connector.webhookSecretEnv];
        const valid=source==='github'?verifyGithub(raw,req.headers['x-hub-signature-256'],webhookSecret):source==='gitlab'?equalSecret(req.headers['x-gitlab-token'],webhookSecret):['releases','logs','verification','alerts'].includes(source)?verifySigned(raw,req.headers,webhookSecret,await store.coordinationNow()):equalSecret(bearer(req),webhookSecret);
        if(!valid)throw fail(401,'Invalid webhook authentication');
        const payload=decode(raw);
        if(source==='verification') {
          // Validate deployment identity and source closure inside ingestion's
          // transaction, after its duplicate-delivery boundary.
          if(payload.kind!==undefined&&!['recovery','rollback_no_change'].includes(payload.kind))throw fail(400,'Invalid verification kind');
          return send(202,await store.ingest({id:assertText(payload.id,'verification ID'),source,serviceKey:key,kind:payload.kind==='rollback_no_change'?'rollback_result':'verification',incidentId:payload.incidentId,at:payload.observedAt,payload}));
        }
        const deliveryId=req.headers['x-github-delivery']||req.headers['x-gitlab-event-uuid']||req.headers['x-sre-event-id']||hash(payload);
        if(source==='alerts')return send(202,await store.ingest(normalizeAlert(payload,service,deliveryId)));
        const [prior]=await store.db.query('SELECT occurred_at FROM sre_events WHERE source=? AND service_key=? AND external_id=?',[source,key,deliveryId]);
        // Some CI/merge queue events have no source timestamp. Retain their first
        // receipt time on replay so normalization cannot defeat idempotency.
        const event=normalize(source,payload,service,{deliveryId,eventType:req.headers['x-github-event'],now:prior?Number(prior.occurred_at):await store.coordinationNow()});
        const result=event?await store.ingest(event):{ignored:true};
        if(event&&source==='logs')await logDetector.observe(service,'logs-webhook',{records:[payload],complete:true});
        return send(202,result);
      }
      // Local UI has no credentials: reject cross-site requests and DNS rebinding.
      if(simulation) {
        if(!['127.0.0.1','localhost'].includes(String(req.headers.host||'').split(':')[0]))throw fail(403,'Loopback Host required');
        if(req.headers.origin&&!['http://'+req.headers.host].includes(req.headers.origin))throw fail(403,'Cross-origin access denied');
        if(req.headers['sec-fetch-site']==='cross-site')throw fail(403,'Cross-site access denied');
      } else if(!equalSecret(bearer(req),config.apiToken))throw fail(401,'SRE API token required');
      if(req.method==='GET'&&path==='/api/operations')return send(200,await operations.snapshot());
      const inspectionRoute=path.match(/^\/api\/deliveries\/([^/]+)\/inspection$/);
      if(inspectionRoute){
        let id;try{id=decodeURIComponent(inspectionRoute[1]);}catch{throw fail(400,'Invalid delivery identity');}
        if(req.method==='GET')return send(200,await inspections.view(id));
        if(req.method==='POST')return send(201,await inspections.record(id,decode(await body(req)),{kind:simulation?'local-operator':'operator-api',id:simulation?'loopback operator':'SRE_API_TOKEN'}));
      }
      const directoryRoute=path.match(/^\/api\/services\/([a-z0-9_-]+)\/directory$/);
      if(req.method==='POST'&&directoryRoute)return send(201,await casework.importDirectory(directoryRoute[1],decode(await body(req))));
      if(req.method==='GET'&&path==='/api/status') {
        const snapshot=await store.snapshot();
        const connectionSources=['dynatrace','dynatraceLogs','github','gitlab','jira','servicenow'],connectionIds=config.services.flatMap(service=>connectionSources.map(source=>source+':'+service.key));
        const checkpoints=connectionIds.length?await store.db.query('SELECT id,value FROM sre_checkpoints WHERE id IN ('+connectionIds.map(()=>'?').join(',')+')',connectionIds):[];
        const operationReport=await operations.snapshot();
        const connections=config.services.flatMap(service=>connectionSources.map(source=>({service:service.key,source,enabled:Boolean(service[source]?.enabled),...(source==='servicenow'?{transport:simulation&&config.simulationMcp?'mcp-mock':service.servicenow?.transport||'rest'}:{}),checkpoint:checkpoints.find(x=>x.id===source+':'+service.key)?.value||null})));
        for(const connection of connections)connection.health=connectionReadHealth(connection,operationReport);
        const simulationConversations=simulation?config.services[0].teams.conversations.map(id=>({id,name:roomScope(config.services[0],id).name})):[];
        const conversations=await store.db.query('SELECT id,tenant_id,conversation_id,service_key,incident_id,enabled FROM sre_conversations');
        return send(200,{...snapshot,operations:operationReport,connections,conversations:conversations.map(room=>({...room,name:roomScope(config.services.find(service=>service.key===room.service_key)||config.services[0],room.conversation_id).name})),mode:config.mode,agentMode:config.agentMode,teamsMode:config.teamsMode,services:config.services.map(s=>({key:s.key,name:s.name,environment:s.environment})),simulation,simulationGuide:simulation?config.simulationGuide||null:null,simulationConversations,simulationConversationId:simulation?config.services[0].teams.conversations[0]:null});
      }
      const incidentRoute=path.match(/^\/api\/incidents\/(inc_[a-f0-9]+)(\/questions)?$/);
      if(incidentRoute) {
        const context=await store.context(incidentRoute[1]);const service=config.services.find(x=>x.key===context.incident.service_key);
        if(req.method==='GET'&&!incidentRoute[2])return send(200,{...context,casework:await casework.snapshot(context.incident.id,context),conversation:await store.conversation(context.incident.id),rollback:assessRollback(context,service,await store.coordinationNow())});
        if(req.method==='POST'&&incidentRoute[2]) {
          const input=decode(await body(req));const text=assertText(input.text,'question',4000);
          return send(202,await store.ingest({id:randomUUID(),source:'operator-api',serviceKey:service.key,incidentId:context.incident.id,kind:'question',at:await store.coordinationNow(),payload:{text}}));
        }
      }
      const correctionRoute=path.match(/^\/api\/incidents\/(inc_[a-f0-9]+)\/changes\/(withdraw|reconsider)$/);
      if(req.method==='POST'&&correctionRoute){
        const input=decode(await body(req)),actor={kind:simulation?'local-operator':'operator-api',id:simulation?'loopback operator':'SRE_API_TOKEN'},[,id,action]=correctionRoute;
        if(action==='withdraw')return send(200,await casework.withdrawChange(id,input.provider,input.number,actor,{expectedEvidenceId:input.expectedEvidenceId,reason:input.reason}));
        return send(200,await casework.trackChange(id,input.provider,input.number,actor,{reconsiderEvidenceId:input.reconsiderEvidenceId,reason:input.reason}));
      }
      const caseRoute=path.match(/^\/api\/incidents\/(inc_[a-f0-9]+)\/(plans|contacts|changes)(?:\/(plan_[a-f0-9]+)\.md)?$/);
      if(caseRoute){
        const [,id,kind,planId]=caseRoute;
        if(req.method==='POST'&&kind==='plans'&&!planId)return send(201,await casework.createPlan(id));
        if(req.method==='GET'&&kind==='contacts')return send(200,await casework.contacts(id));
        if(req.method==='GET'&&kind==='changes')return send(200,await casework.timeline(id));
        if(req.method==='POST'&&kind==='changes'&&!planId){
          const input=decode(await body(req)),actor={kind:simulation?'local-operator':'operator-api',id:simulation?'loopback operator':'SRE_API_TOKEN'};
          if(input.action&&input.action!=='track')throw fail(400,'Use the explicit withdrawal or reconsideration endpoint');
          return send(200,await casework.trackChange(id,input.provider,input.number,actor));
        }
        if(req.method==='GET'&&kind==='plans'){
          if(!planId)return send(200,await casework.plans(id));
          const plan=await casework.getPlan(planId,id);res.writeHead(200,{'content-type':'text/markdown; charset=utf-8','content-disposition':'attachment; filename="'+planId+'.md"','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(plan.markdown);
        }
      }
      const retryRoute=path.match(/^\/api\/incidents\/(inc_[a-f0-9]+)\/jobs\/([a-f0-9]{64})\/retry$/);
      if(retryRoute&&req.method==='POST') {
        const context=await store.context(retryRoute[1]);
        const service=config.services.find(item=>item.key===context.incident.service_key);
        if(!service)throw fail(404,'Incident service is no longer configured');
        const input=decode(await body(req));
        return send(202,await store.retryInvestigation({serviceKey:service.key,incidentId:context.incident.id,jobId:retryRoute[2],requestId:input.requestId,reason:input.reason,actor:{kind:simulation?'local-operator':'operator-api',id:simulation?'loopback operator':'SRE_API_TOKEN'}}));
      }
      if(simulation&&req.method==='POST'&&path==='/api/dev/seed') {
        const input=decode(await body(req));return send(202,await seedDemo(store,config.services[0],input.scenario));
      }
      if(simulation&&req.method==='POST'&&path==='/api/dev/teams') {
        const input=decode(await body(req));const sample=devActivity(assertText(input.text,'Teams request',4000),config.services[0],{userId:input.userId||'local-operator',displayName:input.displayName||'Local operator',conversationType:input.conversationType||'personal',conversationId:input.conversationId||config.services[0].teams.conversations[0],mentioned:input.mentioned!==false,replyToId:input.replyToId});
        if(input.expectedIncidentId){
          const expected=await store.context(input.expectedIncidentId);if(expected.incident.service_key!==config.services[0].key)throw fail(409,'The selected incident is outside this simulator service');
          const key=conversationKey(config.services[0].teams.tenantId,incidentConversation(sample.activity).id),[joined]=await store.db.query('SELECT incident_id FROM sre_conversations WHERE id=? AND enabled=1',[key]);
          if(joined?.incident_id&&joined.incident_id!==input.expectedIncidentId)throw fail(409,'This conversation follows '+joined.incident_id+'. Select that incident or use a separate thread/chat before sending this message.');
          const join=input.text.trim().match(/^join\s+(\S+)/i);if(join&&join[1]!==input.expectedIncidentId)throw fail(409,'Join the selected incident or select the incident you intend to join.');
        }
        return send(202,{...await router.accept(sample.activity,sample.reference),simulation:true});
      }
      throw fail(404,'Not found');
    }catch(error){
      if(res.headersSent)res.destroy();
      else {if(error instanceof StorageError)res.setHeader('retry-after','5');send(error.status||400,{error:redact(error.message)});}
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  return {server,store,worker,rollbacks,router,outbox,coordination,casework,inspections,logDetector,poller,operations,tick,poll,commands,deliver,config,teamsAddress:bridge?.server.address(),close(){
    if(!closePromise) {
      stopped=true;clearInterval(interval);clearInterval(pollInterval);clearInterval(observeInterval);clearInterval(commandInterval);clearInterval(deliveryInterval);operations.stop();
      closePromise=(async()=>{
        if(server.listening)await new Promise(r=>server.close(r));
        await outbox.close();
        await Promise.allSettled([activeTick,activePoll,activeCommands,...activeDeliveries,operations.drain()]);
        await bridge?.close();await worker.close();
        await Promise.allSettled([...new Set([...connectors.values()].flatMap(clients=>Object.values(clients)))].map(client=>client.close?.()));
        await store.db.close();
      })();
    }
    return closePromise;
  }};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const runtime=await createSreRuntime();
  runtime.server.listen(runtime.config.port,runtime.config.host,()=>console.log('SRE integrations: http://'+runtime.config.host+':'+runtime.server.address().port+' ('+runtime.config.mode+', '+runtime.config.agentMode+')'));
  let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await runtime.close();process.exit(0);});
}
