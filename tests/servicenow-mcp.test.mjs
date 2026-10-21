import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ServiceNowMcpConnector,serviceNowReadTools,validateServiceNowMcp} from '../src/sre/servicenow-mcp.mjs';
import {startServiceNowMcpMock,mockServiceNowConfig,mockServiceNowTools} from '../fixtures/servicenow-mcp.mjs';
import {checkReadAccess} from '../src/sre/access-checks.mjs';
import {createConnectors} from '../src/sre/connectors.mjs';
import {loadConfig,validateConfig} from '../src/sre/config.mjs';
import {assessReadiness} from '../src/sre/readiness.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {seedDemo} from '../src/sre/demo.mjs';
import {pollScopeHash} from '../src/sre/poll-scope.mjs';

const ci='1'.repeat(32),now=Date.now();
const incident=(id='a',extra={})=>({sys_id:id.repeat(32),number:'INC-MOCK-'+id,cmdb_ci:ci,short_description:'Fictional bid regression',state:'2',sys_created_on:new Date(now-3600000).toISOString(),sys_updated_on:new Date(now-1000).toISOString(),...extra});
async function setup(options={}) {
  const rows=options.rows||[incident()],mock=await startServiceNowMcpMock({...options,records:options.records||(()=>rows)}),config=mockServiceNowConfig(mock.endpoint),env={SERVICENOW_MCP_TOKEN:mock.controls.token};
  const client=new ServiceNowMcpConnector(config,{env});
  return {mock,config,env,client,rows,async close(){await client.close();await mock.close();}};
}
for(const sse of [false,true])test('official MCP '+(sse?'SSE':'JSON')+' transport discovers and validates all 45 reads, with no extra tool authority',async()=>{
  const f=await setup({sse,toolPageSize:13});
  try {
    assert.equal(serviceNowReadTools.length,45);assert.equal(new Set(serviceNowReadTools).size,45);
    assert.equal((await f.client.inventory()).available.length,45);
    for(const name of serviceNowReadTools) {
      const args=name==='list_incidents'?{cmdb_ci:ci,updated_to:new Date(now).toISOString(),active:null,cursor:null,limit:100}:name==='get_incident_details'?{sys_id:'a'.repeat(32)}:name==='get_incident_by_number'?{number:'INC-MOCK-a'}:{cmdb_ci:ci,limit:1};
      const result=await f.client.readTool(name,args);assert.equal(result.provenance.tool,name);assert.match(result.provenance.schemaHash,/^[a-f0-9]{64}$/);
    }
    assert.equal(f.mock.calls.length,45);assert.ok(f.mock.protocolCalls.every(method=>['initialize','notifications/initialized','tools/list','tools/call'].includes(method)));
    for(const name of ['create_incident','update_incident','delete_incident','execute_workflow','get_arbitrary_table'])await assert.rejects(()=>f.client.readTool(name,{}),/45-tool/);
    await assert.rejects(()=>f.client.readTool('get_user',{execute:'bad'}),/arguments/);assert.equal(f.mock.calls.length,45);
  } finally {await f.close();}
});

test('incident reads discover old open work, follow short pages and retain explicit incomplete results',async()=>{
  const f=await setup({pageSize:1,rows:[incident('a'),incident('b'),incident('c',{sys_updated_on:new Date(now-600000).toISOString()})]});
  try {
    assert.equal((await f.client.incidents({since:now-10000,until:now})).items.length,2);
    assert.equal((await f.client.openIncidents({until:now})).items.length,3);
    assert.equal((await f.client.openIncidents({until:now,maxPages:1})).complete,false);
    f.mock.controls.partial=true;assert.equal((await f.client.openIncidents({until:now})).complete,false);
    f.mock.controls.wrongCi=true;await assert.rejects(()=>f.client.openIncidents({until:now}),/scope/);
  } finally {await f.close();}
});

for(const [name,override] of [
  ['missing-completeness',{records:[],nextCursor:null}],
  ['conflicting-completeness',{records:[],nextCursor:'next',complete:true}],
  ['missing-cursor',{records:[],complete:true}],
  ['future-record',{records:[incident('a',{sys_updated_on:new Date(now+60000).toISOString()})],nextCursor:null,complete:true}],
  ['missing-original-time',{records:[incident('a',{sys_created_on:undefined})],nextCursor:null,complete:true}],
  ['missing-state',{records:[incident('a',{state:undefined})],nextCursor:null,complete:true}],
  ['closed-active-record',{records:[incident('a',{state:'6'})],nextCursor:null,complete:true}],
])test('MCP '+name+' cannot certify an active incident inventory',async()=>{
  const f=await setup({onCall:name=>name==='list_incidents'?{structuredContent:override,content:[]}:undefined});
  try {await assert.rejects(()=>f.client.openIncidents({until:now}));} finally {await f.close();}
});

test('tool errors, unstructured content, output schema mismatch and identity substitution fail safely',async()=>{
  let override={isError:true,content:[{type:'text',text:'PRIVATE_RECORD_SECRET'}]};
  const f=await setup({onCall:()=>override});
  try {
    await assert.rejects(()=>f.client.readTool('get_user',{}),e=>/read failed/.test(e.message)&&!e.message.includes('PRIVATE_'));
    override={content:[{type:'text',text:'not JSON PRIVATE_RECORD_SECRET'}]};await assert.rejects(()=>f.client.readTool('get_user',{}),/read failed/);
    override={structuredContent:{record:incident('b')},content:[]};await assert.rejects(()=>f.client.incident('a'.repeat(32)),/identity/);
    f.mock.controls.tools.find(t=>t.name==='get_user').outputSchema={type:'object',required:['requiredField']};f.client.dirty=true;
    await assert.rejects(()=>f.client.inventory(),/discovery failed/);
  } finally {await f.close();}
});

test('an advertised write is ignored, revoked tools and contradictory declarations are rejected',async()=>{
  const tools=mockServiceNowTools();tools.push({...tools[0],name:'create_incident',annotations:{readOnlyHint:true}});
  const f=await setup({tools});
  try {
    assert.equal((await f.client.inventory()).available.length,45);
    f.mock.controls.tools=tools.filter(t=>t.name!=='get_incident_details');f.client.dirty=true;
    await assert.rejects(()=>f.client.incident('a'.repeat(32)),/discovery failed/);
  } finally {await f.close();}
  const g=await setup({tools:mockServiceNowTools().map(t=>t.name==='get_user'?{...t,annotations:{readOnlyHint:false}}:t)});
  try {await assert.rejects(()=>g.client.inventory(),/discovery failed/);} finally {await g.close();}
});

test('schema pins and schema drift across reconnect require review before another tool call',async()=>{
  const f=await setup();
  try {
    const inventory=await f.client.inventory();const config=structuredClone(f.config);config.mcp.schemaPins={get_user:'0'.repeat(64)};
    const other=new ServiceNowMcpConnector(config,{env:f.env});try{await assert.rejects(()=>other.inventory(),/discovery failed/);}finally{await other.close();}
    f.mock.controls.tools.find(t=>t.name==='get_user').inputSchema.properties.newField={type:'string'};f.client.dirty=true;
    await assert.rejects(()=>f.client.readTool('get_user',{}),/discovery failed/);assert.equal(f.mock.calls.length,0);assert.equal(inventory.available.length,45);
  } finally {await f.close();}
});

test('credential removal/rotation, caller cancellation, deadlines and endpoint containment apply to MCP',async()=>{
  const f=await setup();
  try {
    await f.client.inventory();delete f.env.SERVICENOW_MCP_TOKEN;await assert.rejects(()=>f.client.readTool('get_user',{}));assert.equal(f.mock.calls.length,0);
    f.env.SERVICENOW_MCP_TOKEN='rotated-fictional-token';f.mock.controls.token=f.env.SERVICENOW_MCP_TOKEN;
    await f.client.readTool('get_user',{});assert.equal(f.mock.calls.length,1);
    await assert.rejects(()=>f.client.readTool('get_user',{}, {signal:AbortSignal.abort()}));assert.equal(f.mock.calls.length,1);
    await assert.rejects(()=>f.client.fetch('https://other.invalid/mcp'),/endpoint/);
    await assert.rejects(()=>f.client.fetch(f.mock.endpoint,{method:'POST',body:JSON.stringify({method:'resources/read'})}),/denied/);
    f.mock.controls.delayMs=300;f.client.config.mcp.timeoutMs=100;
    await assert.rejects(()=>f.client.readTool('get_user',{}),/read failed/);
  } finally {await f.close();}
});

test('MCP bindings are explicit, config scope changes invalidate checkpoints and read-only probes close transports',async()=>{
  const f=await setup();
  try {
    const invalid=structuredClone(f.config);delete invalid.mcp.bindings.incidents.completePath;assert.throws(()=>validateServiceNowMcp(invalid),/completeness/);
    const write=structuredClone(f.config);write.mcp.bindings.incident.tool='create_incident';assert.throws(()=>validateServiceNowMcp(write),/unsupported/);
    const cfg=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=cfg.services[0];cfg.mode='connected';cfg.agentMode='rules';service.rollback.enabled=false;service.servicenow=f.config;service.servicenow.base='https://snow.trial.test';
    const env={...f.env,SRE_API_TOKEN:'fixture',SRE_CAPABILITY_SECRET:'s'.repeat(32)};validateConfig(cfg,env);
    const before=pollScopeHash(service,'servicenow');service.servicenow.mcp.bindings.incidents.arguments.limit=50;assert.notEqual(pollScopeHash(service,'servicenow'),before);
    assert.equal(assessReadiness(cfg,env).checks.find(c=>c.source==='servicenow').configurationReady,true);
    const clients=[];const report=await checkReadAccess(cfg,{env,connectorFactory:(s,options)=>{const result=createConnectors(s,options);if(result.servicenow)clients.push(result.servicenow);return result;}});
    assert.equal(report.state,'passed');assert.equal(report.endToEndValidated,false);assert.equal(report.checks.find(c=>c.operation==='mcp-tool-inventory').records,45);assert.ok(clients.every(c=>c.closed));
  } finally {await f.close();}
});

test('the production worker gathers MCP incident, CMDB, change, problem and knowledge evidence',async()=>{
  const rows=[];const f=await setup({rows});let runtime;
  try {
    const cfg=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=cfg.services[0];cfg.mode='connected';cfg.agentMode='rules';cfg.teamsMode='off';cfg.apiToken='fixture';cfg.capabilitySecret='s'.repeat(32);cfg.env=f.env;service.rollback.enabled=false;service.servicenow=f.config;
    runtime=await createSreRuntime({config:cfg,connectors:new Map([[service.key,{servicenow:f.client}]]),autoStart:false});
    const seeded=await seedDemo(runtime.store,service),context=await runtime.store.context(seeded.incidentId);
    rows.push(context.evidence.find(e=>e.kind==='problem'&&e.source==='servicenow').content);
    await runtime.poll();await runtime.worker.runOnce();
    const collected=await runtime.store.context(seeded.incidentId),enrichment=collected.evidence.find(e=>e.kind==='incident_context');
    assert.equal(collected.incident.status,'open');assert.equal(enrichment.content.records.length,5);assert.ok(enrichment.content.records.every(r=>r.provenance.schemaHash));
    assert.ok(f.mock.calls.some(c=>c.name==='get_ci_relationships'));assert.ok(f.mock.calls.some(c=>c.name==='list_articles'));
    await runtime.close();runtime=null;assert.equal(f.client.closed,true);
  } finally {await runtime?.close();await f.close();}
});
test('MCP persists valid and malformed Retry-After waits and a peer honors the same hold without transport',async()=>{
  for(const header of ['7','-1']) {
    const f=await setup();let calls=0,hold=null;const retryGate={read:async()=>hold,defer:async value=>{hold=value;}};
    const options={env:f.env,clock:()=>now,retryGate,fetcher:async()=>{calls++;return new Response('PRIVATE_PROVIDER_TEXT',{status:429,headers:{'retry-after':header}});}};
    const first=new ServiceNowMcpConnector(f.config,options),peer=new ServiceNowMcpConnector(f.config,options);
    try {
      await assert.rejects(()=>first.inventory(),error=>!error.message.includes('PRIVATE_'));assert.equal(hold.until,now+(header==='7'?7000:60000));
      await assert.rejects(()=>peer.inventory());assert.equal(calls,1);
    } finally {await first.close();await peer.close();await f.close();}
  }
});
