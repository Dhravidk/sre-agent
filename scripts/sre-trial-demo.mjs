import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {appendFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ServiceNowMcpConnector} from '../src/sre/servicenow-mcp.mjs';
import {startServiceNowMcpMock,mockServiceNowConfig} from '../fixtures/servicenow-mcp.mjs';
import { validateConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import {createPilotQaAdapter} from '../fixtures/qa-sandbox.mjs';
import {fictionalDirectory} from '../fixtures/ownership-directory.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
process.chdir(root);
const agentMode=process.env.SRE_TRIAL_DEMO_AGENT_MODE||'rules';
if(!['claude','rules'].includes(agentMode))throw new Error('SRE_TRIAL_DEMO_AGENT_MODE must be claude or rules');
const profile=JSON.parse(readFileSync(resolve(root,'config/sre.trial-demo.json'),'utf8'));
const config=validateConfig({...profile,mode:agentMode==='claude'?'trial':'local',agentMode},{
  ...process.env,
  SRE_CONFIG:resolve(root,'config/sre.trial-demo.json'),
  SRE_AGENT_MODE:agentMode,
  SRE_HOST:'127.0.0.1',
  SRE_PORT:process.env.SRE_TRIAL_DEMO_PORT||'3002',
  SRE_TEAMS_MODE:'off',
  SRE_SQLITE_PATH:process.env.SRE_TRIAL_DEMO_DATABASE||resolve(root,'.local/sre-trial-demo.sqlite'),
  DATABASE_URL:undefined,
});
let runtime;
const mock=await startServiceNowMcpMock({records:async()=>{
  if(!runtime)return [];
  const events=await runtime.store.db.query("SELECT payload FROM sre_events WHERE source='servicenow' AND service_key=? ORDER BY occurred_at DESC,id DESC LIMIT 1000",[config.services[0].key]);
  const records=new Map();for(const event of events){const record=JSON.parse(event.payload).payload;if(record?.sys_id&&!records.has(record.sys_id))records.set(record.sys_id,record);}return [...records.values()];
}});
const service=config.services[0];service.servicenow={...mockServiceNowConfig(mock.endpoint),enabled:false};
config.env={...config.env,SERVICENOW_MCP_TOKEN:mock.controls.token};config.simulationMcp=true;
const snow=new ServiceNowMcpConnector(service.servicenow,{env:config.env});
try {
  // The offline UI needs a real local delivery boundary so receipt tests do
  // not confuse a queued outbox entry with a delivered message. This private
  // fictional inbox never contacts Teams and is labelled simulated in the UI.
  const sender={send:async(reference,text)=>{
    const id='local-inbox:'+randomUUID();
    await appendFile(config.sqlitePath+'.teams.jsonl',JSON.stringify({id,at:Date.now(),conversationId:reference.conversation.id,text})+'\n',{mode:0o600});
    return {id,simulation:true};
  }};
  runtime=await createSreRuntime({config,connectors:new Map([[service.key,{servicenow:snow}]]),sender,qaAdapter:createPilotQaAdapter(resolve(root,'.local/qa-sandboxes'))});
  const [directory]=await runtime.store.db.query('SELECT id FROM sre_directory_snapshots WHERE service_key=? LIMIT 1',[service.key]);
  if(!directory&&!await runtime.store.restoreFence())await runtime.casework.importDirectory(service.key,fictionalDirectory());
  await new Promise((done,failed)=>{
    runtime.server.once('error',failed);
    runtime.server.listen(config.port,config.host,done);
  });
} catch(error) {
  await runtime?.close();await snow.close();await mock.close();
  throw error;
}
console.log('SRE trial demo: http://127.0.0.1:'+runtime.server.address().port);
console.log('Fictional provider records, simulated Teams identities and rollback dispatch; no live vendor calls.');
console.log('Mock Teams deliveries are saved in a private local inbox beside the demo database; they are not Teams service receipts.');
console.log('ServiceNow uses a loopback MCP mock exposing exactly 45 read-only tools. Ally schemas and permissions remain unverified.');
console.log(agentMode==='claude'?'Investigations and questions use real Claude Code claude -p with your configured CLI authentication. No rules fallback.':'Offline rules analysis selected explicitly; no model calls.');
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{
  if(closing)return;
  closing=true;
  await runtime.close();await mock.close();
});
