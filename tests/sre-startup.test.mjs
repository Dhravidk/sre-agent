import test from 'node:test';
import assert from 'node:assert/strict';
import { SreStore } from '../src/sre/store.mjs';
import { sqliteDatabase } from '../src/sre/database.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { ConnectorPoller } from '../src/sre/poller.mjs';
import { ServiceNowConnector, DynatraceConnector } from '../src/sre/connectors.mjs';
import { OperationalMonitor } from '../src/sre/operations.mjs';
import { normalize } from '../src/sre/normalize.mjs';

const response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const options=fetcher=>({fetcher,env:{TOKEN:'fixture'},sleep:async()=>{}});

async function fixture() {
  let now=Date.now();const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=config.services[0];
  config.operations={startupGraceSeconds:1};
  const store=await new SreStore(sqliteDatabase(':memory:'),{clock:()=>now,services:config.services}).initialize();
  const monitor=new OperationalMonitor({store,config,schedulerEnabled:false});
  return {config,service,store,monitor,now,setNow:value=>now=value};
}
function snowRecord(service,now,extra={}) {
  return {sys_id:'a'.repeat(32),number:'INC-OLD',state:'2',cmdb_ci:service.servicenow.cmdbCi,short_description:'Already open before agent startup',sys_created_on:new Date(now-30*86400000).toISOString(),sys_updated_on:new Date(now-10*86400000).toISOString(),...extra};
}

test('startup discovers an old ServiceNow incident and periodically repeats the active inventory',async()=>{
  const f=await fixture();let reads=0,activeReads=0,omit=false;
  Object.assign(f.service.servicenow,{enabled:true,base:'https://snow.invalid',tokenEnv:'TOKEN'});
  const record=snowRecord(f.service,f.now);
  const client=new ServiceNowConnector(f.service.servicenow,options(async url=>{
    reads++;const query=new URL(url).searchParams.get('sysparm_query');
    assert.ok(query.startsWith('cmdb_ci='+f.service.servicenow.cmdbCi));
    if(query.includes('state!=')){activeReads++;assert.ok(query.includes('state!=6^state!=7^state!=8'));assert.equal(query.includes('sys_updated_on>='),false);return response({result:omit?[]:[record]});}
    return response({result:[]});
  }));
  const poller=new ConnectorPoller({store:f.store,services:[f.service],connectors:new Map([[f.service.key,{servicenow:client}]])});
  try {
    await poller.runOnce();let snapshot=await f.store.snapshot();
    assert.equal(snapshot.incidents.length,1);assert.equal(Number(snapshot.incidents[0].started_at),Date.parse(record.sys_created_on));
    assert.equal(snapshot.incidents[0].status,'open');assert.equal(activeReads,1);
    await poller.runOnce();assert.equal(activeReads,1);assert.equal(reads,3);
    omit=true;f.setNow(f.now+300001);await poller.runOnce();
    assert.equal(activeReads,2);assert.equal((await f.store.snapshot()).incidents[0].status,'open','Absence from inventory must not invent source closure');
    assert.equal((await f.store.checkpoint('servicenow:'+f.service.key)).activeReconciledAt,f.store.clock());
  } finally {await f.store.db.close();}
});

test('incomplete active reconciliation retains the checkpoint while recent incidents still enter the inbox',async()=>{
  const f=await fixture();Object.assign(f.service.servicenow,{enabled:true});
  const recent=snowRecord(f.service,f.now,{sys_created_on:new Date(f.now-1000).toISOString(),sys_updated_on:new Date(f.now).toISOString()});
  const clients={servicenow:{incidents:async()=>({items:[recent],complete:true}),openIncidents:async()=>({items:[],complete:false})}};
  const poller=new ConnectorPoller({store:f.store,services:[f.service],connectors:new Map([[f.service.key,clients]])});
  try {
    await poller.runOnce();assert.equal((await f.store.snapshot()).incidents.length,1);
    const checkpoint=await f.store.checkpoint('servicenow:'+f.service.key);
    assert.equal(checkpoint.until,undefined);assert.equal(checkpoint.activeReconciledAt,undefined);assert.match(checkpoint.error,/incomplete/);
    assert.equal((await f.monitor.snapshot()).state,'needs-attention');
  } finally {await f.store.db.close();}
});

test('changed source scope cannot inherit the prior CI cursor or successful health result',async()=>{
  const f=await fixture();Object.assign(f.service.servicenow,{enabled:true});
  const clients=new Map([[f.service.key,{servicenow:{incidents:async()=>({items:[],complete:true}),openIncidents:async()=>({items:[],complete:true})}}]]);
  const poller=new ConnectorPoller({store:f.store,services:[f.service],connectors:clients});
  try {
    await poller.runOnce();const old=await f.store.checkpoint('servicenow:'+f.service.key);
    f.service.servicenow.cmdbCi='b'.repeat(32);f.setNow(f.now+2000);
    assert.ok((await f.monitor.snapshot()).conditions.some(x=>x.code==='poll_scope'));
    let seenSince;
    clients.get(f.service.key).servicenow={incidents:async({since})=>{seenSince=since;throw new Error('new CI access denied');},openIncidents:async()=>({items:[],complete:true})};
    await poller.runOnce();const changed=await f.store.checkpoint('servicenow:'+f.service.key);
    assert.notEqual(changed.scopeHash,old.scopeHash);assert.equal(changed.successAt,undefined);assert.equal(changed.until,undefined);
    assert.equal(seenSince,f.store.clock()-360000);assert.match(changed.error,/access denied/);
  } finally {await f.store.db.close();}
});

test('Dynatrace startup reads old open problems with an explicit entity-scoped epoch query',async()=>{
  const f=await fixture();Object.assign(f.service.dynatrace,{enabled:true,mode:'classic',base:'https://dt.invalid',tokenEnv:'TOKEN'});
  const old={problemId:'P-OLD',status:'OPEN',title:'Old problem',startTime:f.now-30*86400000,endTime:-1,affectedEntities:[{entityId:{id:f.service.dynatrace.entityId}}]};let active=0;
  const client=new DynatraceConnector(f.service.dynatrace,options(async url=>{
    const query=new URL(url).searchParams;assert.ok(query.get('entitySelector').includes(f.service.dynatrace.entityId));
    if(query.get('from')==='0'){active++;assert.equal(query.get('problemSelector'),'status("open")');return response({problems:[old]});}
    return response({problems:[]});
  }));
  const poller=new ConnectorPoller({store:f.store,services:[f.service],connectors:new Map([[f.service.key,{dynatrace:client}]])});
  try {
    await poller.runOnce();assert.equal(active,1);
    const incident=(await f.store.snapshot()).incidents[0];assert.equal(Number(incident.started_at),old.startTime);assert.equal(incident.status,'open');
    const health=await f.monitor.snapshot();assert.equal(health.state,'starting');assert.equal(health.conditions.length,0);assert.ok(health.pendingSources.some(item=>item.source==='incident assessment'&&item.incidentId===incident.id));
    assert.equal((await f.store.checkpoint('dynatrace:'+f.service.key)).complete,true,'A successful source inventory still awaits its incident review');
  } finally {await f.store.db.close();}
});

test('Grail keeps recent incidents while missing active-query configuration remains visible',async()=>{
  const f=await fixture();Object.assign(f.service.dynatrace,{enabled:true,mode:'grail',base:'https://dt.invalid',tokenEnv:'TOKEN',problemQuery:'verified fixture query'});
  const record={'event.id':'P-GRAIL','event.status':'OPEN','event.start':f.now-1000,affected_entity_ids:[f.service.dynatrace.entityId]};
  const client=new DynatraceConnector(f.service.dynatrace,options(async()=>response({state:'SUCCEEDED',result:{records:[record]}})));
  const poller=new ConnectorPoller({store:f.store,services:[f.service],connectors:new Map([[f.service.key,{dynatrace:client}]])});
  try {
    await poller.runOnce();assert.equal((await f.store.snapshot()).incidents.length,1);
    assert.match((await f.store.checkpoint('dynatrace:'+f.service.key)).error,/openProblemQuery/);
    assert.equal((await f.monitor.snapshot()).state,'needs-attention');
  } finally {await f.store.db.close();}
});

test('warning/partial problem inventories never become complete checkpoints',async()=>{
  const f=await fixture();Object.assign(f.service.dynatrace,{enabled:true,mode:'classic',base:'https://dt.invalid',tokenEnv:'TOKEN'});
  const client=new DynatraceConnector(f.service.dynatrace,options(async()=>response({problems:[],warnings:['limited result']})));
  const poller=new ConnectorPoller({store:f.store,services:[f.service],connectors:new Map([[f.service.key,{dynatrace:client}]])});
  try {
    await poller.runOnce();const checkpoint=await f.store.checkpoint('dynatrace:'+f.service.key);
    assert.equal(checkpoint.until,undefined);assert.ok(checkpoint.error);
  } finally {await f.store.db.close();}
});

test('incident normalizers require source state and original creation time',()=>{
  const service=loadConfig({}).services[0],now=Date.now(),record=snowRecord(service,now);
  assert.throws(()=>normalize('servicenow',{...record,state:undefined},service),/state/);
  assert.throws(()=>normalize('servicenow',{...record,sys_created_on:undefined},service),/timestamp/);
  assert.equal(normalize('servicenow',{...record,state:{value:'2'}},service).status,'OPEN');
  service.servicenow.closedStates=[6,7,8];assert.equal(normalize('servicenow',{...record,state:'6'},service).status,'CLOSED');
  assert.throws(()=>normalize('dynatrace',{ProblemID:'P1',EntityIds:[service.dynatrace.entityId],StartedAt:now},service),/status/);
});
