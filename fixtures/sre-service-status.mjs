import {logIsolationFixture} from './sre-log-isolation.mjs';
import {normalize} from '../src/sre/normalize.mjs';
import {hash} from '../src/sre/security.mjs';

// Fictional source records and reader outcomes around the actual HTTP/store.
// The providers, tenant permissions, MCP and real model are not exercised here.
export async function serviceStatusFixture(dialect,{path=':memory:',databaseFactory,seed=true}={}){
 const f=await logIsolationFixture(dialect,{path,databaseFactory,seed:false}),controls={failLedger:true},pages=[];
 f.quiet.name='Ledger API';f.noisy.name='Preview Cache';f.noisy.environment='preview';f.config.simulationMcp=true;
 for(const service of [f.quiet,f.noisy])service.dynatraceLogs={enabled:true,base:'https://status-fixture.invalid',mode:'grail',logField:'service.name',logValue:service.key};
 let state=await f.r.store.checkpoint('fixture:service-status:v1');
 if(seed&&!state){
  const now=await f.r.store.coordinationNow(),logPage=(service,key,size)=>({serviceKey:service.key,logs:{records:Array.from({length:size},(_,n)=>({timestamp:now-1000+n,level:'INFO',environment:service.environment,'service.name':service.key,message:'Fictional '+key+' record '+n})),complete:true},until:now});
  pages.push(logPage(f.quiet,'ledger',200));for(let n=0;n<3;n++)pages.push(logPage(f.noisy,'preview-'+n,n+1));for(const page of pages)await f.r.store.ingestLogRead(page);
  await f.r.store.ingest(normalize('dynatrace',{ProblemID:'status-cache',State:'OPEN',Title:'Fictional preview cache startup error',EntityIds:[f.noisy.dynatrace.entityId],StartedAt:now-60000,ObservedAt:now},f.noisy,{deliveryId:'status-cache'}));
  for(const [service,count]of[[f.quiet,1],[f.noisy,2]])for(let n=0;n<count;n++)await f.r.store.ingest(normalize('gitlab',{project:{id:service.gitlab.project},object_kind:'merge_request',object_attributes:{iid:70+n,state:'opened',last_commit:{id:'a'.repeat(40)},updated_at:new Date(now).toISOString(),title:'Fictional '+service.name+' change '+n}},service,{deliveryId:'status-'+service.key+'-'+n}));
  for(let n=0;n<2;n++)await f.r.store.ingest(normalize('servicenow',{sys_id:hash('status-ticket-'+n).slice(0,32),number:'INC-STATUS-'+n,cmdb_ci:f.quiet.servicenow.cmdbCi,state:'2',short_description:'Fictional ledger report '+n,sys_created_on:new Date(now-60000).toISOString(),sys_updated_on:new Date(now).toISOString()},f.quiet,{deliveryId:'status-ticket-'+n}));
  state={version:1,seededAt:now,pages};await f.r.store.checkpoint('fixture:service-status:v1',state);
 }
 if(state)pages.push(...(pages.length?[]:state.pages));
 const readers=()=>{for(const service of [f.quiet,f.noisy])f.r.poller.connectors.get(service.key).dynatraceLogs={logs:async()=>{if(service.key===f.quiet.key&&controls.failLedger)throw Error('Fictional HTTP 403 for the ledger reader');return{records:[],complete:true};}};};readers();let port;
 const serve=async()=>{await new Promise((resolve,reject)=>{f.r.server.once('error',reject);f.r.server.listen(port||0,'127.0.0.1',resolve);});port=f.r.server.address().port;};
 return{get r(){return f.r;},get state(){return state;},config:f.config,quiet:f.quiet,noisy:f.noisy,controls,pages,
  serve:async()=>{await serve();return'http://127.0.0.1:'+port;},
  status:async()=>{if(!port)await serve();const response=await fetch('http://127.0.0.1:'+port+'/api/status');if(response.status!==200)throw Object.assign(Error('Status returned HTTP '+response.status),{status:response.status});return response.json();},
  poll:()=>f.r.poller.runOnce(),
  retire:async()=>{const service=structuredClone(f.noisy);service.key='retired-reader-fixture';service.name='Retired reader fixture';service.environment='retired';f.config.services.push(service);try{const now=await f.r.store.coordinationNow();for(let n=0;n<3;n++)await f.r.store.ingestLogRead({serviceKey:service.key,logs:{records:[{timestamp:now-86400000+n,level:'INFO',environment:service.environment,message:'Fictional historical source '+n}],complete:true},until:now});}finally{f.config.services.pop();}return service.key;},
  restart:async()=>{await f.restart();readers();if(port)await serve();},close:()=>f.close()};
}
