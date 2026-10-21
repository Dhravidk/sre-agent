import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {ServiceNowMcpConnector} from '../src/sre/servicenow-mcp.mjs';
import {startServiceNowMcpMock,mockServiceNowConfig} from '../fixtures/servicenow-mcp.mjs';
import {createPilotQaAdapter} from '../fixtures/qa-sandbox.mjs';
import {rehearsalProfile,seedRehearsal,rehearsalGuide} from '../fixtures/sre-rehearsal.mjs';

process.chdir(fileURLToPath(new URL('../',import.meta.url)));
const args=process.argv.slice(2);let directory=resolve('.local/sre-rehearsal'),port=3004;
for(let i=0;i<args.length;i+=2){if(args[i]==='--directory'&&args[i+1])directory=resolve(args[i+1]);else if(args[i]==='--port'&&/^\d+$/.test(args[i+1]||'')&&Number(args[i+1])>=1024&&Number(args[i+1])<=65535)port=Number(args[i+1]);else throw Error('Use [--directory <private rehearsal folder>] [--port <loopback port>]');}
await mkdir(directory,{recursive:true,mode:0o700});const profilePath=join(directory,'profile.json');
try{await writeFile(profilePath,JSON.stringify(rehearsalProfile(),null,2)+'\n',{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
const profile=JSON.parse(await readFile(profilePath,'utf8'));
const config=validateConfig({...profile,mode:'local',agentMode:'rules'},{SRE_CONFIG:profilePath,SRE_AGENT_MODE:'rules',SRE_CLAUDE_BIN:'/nonexistent-rehearsal-model',SRE_HOST:'127.0.0.1',SRE_PORT:String(port),SRE_TEAMS_MODE:'off',SRE_SQLITE_PATH:join(directory,'agent.sqlite')});
let runtime,snow;
const mock=await startServiceNowMcpMock({records:async()=>{
  if(!runtime)return [];
  const rows=await runtime.store.db.query("SELECT payload FROM sre_events WHERE source='servicenow' AND service_key=? ORDER BY occurred_at DESC,id DESC LIMIT 1000",[config.services[0].key]);const records=new Map();
  for(const row of rows){const value=JSON.parse(row.payload).payload;if(value?.sys_id&&!records.has(value.sys_id))records.set(value.sys_id,value);}return [...records.values()];
}});
const service=config.services[0];service.servicenow={...service.servicenow,...mockServiceNowConfig(mock.endpoint),cmdbCi:service.servicenow.cmdbCi,enabled:false};config.env.SERVICENOW_MCP_TOKEN=mock.controls.token;config.simulationMcp=true;
try{
  snow=new ServiceNowMcpConnector(service.servicenow,{env:config.env});
  const sender={send:async(reference,text)=>{const id='rehearsal-inbox:'+randomUUID();await appendFile(join(directory,'inbox.jsonl'),JSON.stringify({id,at:Date.now(),conversationId:reference.conversation.id,text})+'\n',{mode:0o600});return {id,simulation:true};}};
  runtime=await createSreRuntime({config,connectors:new Map([[service.key,{servicenow:snow}]]),sender,qaAdapter:createPilotQaAdapter(join(directory,'qa'))});
  console.log('Preparing or reopening the persisted fictional multi-team rehearsal. Claude, live Teams and live deployments are off.');
  const state=await seedRehearsal(runtime);config.simulationGuide=rehearsalGuide(state);
  await writeFile(join(directory,'ready.json'),JSON.stringify({at:new Date().toISOString(),console:'http://127.0.0.1:'+port,primaryId:state.primaryId,providerId:state.providerId,planId:state.planId,claudeEnabled:false,liveTeams:false,liveDeployments:false},null,2)+'\n',{mode:0o600});
  await new Promise((done,failed)=>{runtime.server.once('error',failed);runtime.server.listen(port,'127.0.0.1',done);});
  console.log(JSON.stringify({status:'ready',console:'http://127.0.0.1:'+port,database:config.sqlitePath,primaryId:state.primaryId,providerId:state.providerId,planId:state.planId,scope:'Fictional provider/Teams data and unread drawing metadata; actual generated source and approval-gated local QA. No native Microsoft or external repository transport.'}));
}catch(error){await runtime?.close();await snow?.close();await mock.close();throw error;}
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{if(closing)return;closing=true;await runtime.close();await snow.close();await mock.close();});
