import {loadConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {importInvestigationCase} from '../fixtures/agent-investigations.mjs';

const defaults=!process.env.SRE_CONFIG;
const env={...process.env,SRE_CONFIG:process.env.SRE_CONFIG||'config/sre.agent.json',SRE_SQLITE_PATH:process.env.SRE_SQLITE_PATH||(defaults?'.local/sre-agent.sqlite':'.local/sre.sqlite'),SRE_PORT:process.env.SRE_PORT||(defaults?'3010':'3001')};
const config=loadConfig(env);
if(config.agentMode!=='claude')throw Error('The agent development command requires Claude. Use sre:lab explicitly for the offline rules fixtures.');
const runtime=await createSreRuntime({config});
const caseArg=process.argv.indexOf('--case');
try{
  if(caseArg>=0)await importInvestigationCase(runtime.store,config.services[0],process.argv[caseArg+1]);
  await new Promise((resolve,reject)=>{runtime.server.once('error',reject);runtime.server.listen(config.port,config.host,resolve);});
}catch(error){await runtime.close();throw error;}
let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await runtime.close();process.exit(0);});
console.log(JSON.stringify({agent:'Claude',console:'http://'+config.host+':'+runtime.server.address().port,database:config.sqlitePath,seeded:caseArg>=0,scope:defaults?'Supplied development evidence; connectors and external delivery disabled.':'Configured service scope',rulesFallback:false}));
