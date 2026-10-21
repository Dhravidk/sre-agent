import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { RulesReasoner } from '../src/sre/reasoner.mjs';

// Launched only by sre-soak.mjs. All provider methods read the supervisor's
// synthetic snapshot. No provider/model credentials or external transports.
const [statePath,databasePath]=process.argv.slice(2);
const read=()=>JSON.parse(readFileSync(statePath,'utf8'));
const initial=read(),config=loadConfig({SRE_SQLITE_PATH:databasePath});
config.mode='connected';config.agentMode='rules';config.apiToken=initial.apiToken;config.capabilitySecret=initial.capabilitySecret;
config.env={RELEASE:initial.releaseSecret,HEALTH:initial.healthSecret};config.pollIntervalMs=10000;config.activeReconcileIntervalMs=30000;
config.operations={notify:false,startupGraceSeconds:20,maxPollAgeSeconds:45,maxQueueAgeSeconds:45,maxTickDurationSeconds:20,maxPollDurationSeconds:20,maxRollbackWaitSeconds:60};
const service=config.services[0];service.key='auction-soak';service.rollback.enabled=false;
Object.assign(service.github,{enabled:true,repository:'synthetic/auction-soak'});
Object.assign(service.dynatrace,{enabled:true,mode:'classic',base:'https://dynatrace-soak.invalid'});
Object.assign(service.servicenow,{enabled:true,base:'https://servicenow-soak.invalid'});
service.releases={webhookSecretEnv:'RELEASE'};service.verification={webhookSecretEnv:'HEALTH',maxAgeSeconds:180};
const telemetry=()=>{const state=read();if(state.failDynatrace)throw new Error('Synthetic Dynatrace HTTP 401');return state;};
const clients={
  dynatrace:{config:service.dynatrace,problems:async({since,until})=>({items:telemetry().problems.filter(x=>x.ObservedAt>=since&&x.ObservedAt<=until),complete:true}),openProblems:async()=>({items:telemetry().problems.filter(x=>x.State==='OPEN'),complete:true}),problem:async id=>telemetry().problems.find(x=>x.ProblemID===id)||{missing:true}},
  servicenow:{incidents:async({since,until})=>({items:read().incidents.filter(x=>Date.parse(x.sys_updated_on)>=since&&Date.parse(x.sys_updated_on)<=until),complete:true}),openIncidents:async()=>({items:read().incidents.filter(x=>!['6','7','8'].includes(x.state)),complete:true}),incident:async id=>read().incidents.find(x=>x.sys_id===id)||{missing:true}},
  github:{deployments:async()=>({items:read().deployments,complete:true}),linkedChanges:async sha=>({items:sha===read().faultSha?[{number:42}]:[],complete:true}),pull:async()=>({pull:{number:42,base:{sha:read().baselineSha},head:{sha:read().faultSha}},files:[{filename:'src/auction/rules.mjs',patch:read().diff}],checks:{total_count:1,check_runs:[]},complete:true}),compare:async base=>({merge_base_commit:{sha:base},files:[{filename:'src/auction/rules.mjs',patch:read().diff}]}),file:async(path,sha)=>{const content=read().policySources[sha];if(path!=='src/auction/rules.mjs'||typeof content!=='string')throw new Error('Unsupported synthetic source identity');return {path,sha,content,complete:true};}},
};
const rules=new RulesReasoner();
const runtime=await createSreRuntime({config,connectors:new Map([[service.key,clients]]),reasoner:{investigate:async(...args)=>{const milliseconds=Math.min(20000,Math.max(0,read().reasonerDelayMs||0));if(milliseconds)await delay(milliseconds,undefined,{signal:args[1]?.signal});return rules.investigate(...args);}}});
runtime.worker.leaseMs=5000; // Short fixture lease makes crash recovery observable.
runtime.server.listen(0,'127.0.0.1',()=>process.send?.({type:'ready',port:runtime.server.address().port,pid:process.pid}));
const stats=setInterval(()=>process.send?.({type:'stats',pid:process.pid,at:Date.now(),...process.memoryUsage()}),10000);
let closing=false;
async function close(){if(closing)return;closing=true;clearInterval(stats);await runtime.close();process.exit(0);}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void close());
process.on('disconnect',()=>void close());
