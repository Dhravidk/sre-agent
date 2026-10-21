import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ToolListChangedNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import {ApiClient,ConnectorError,tokenProvider,responseDelay} from './http-client.mjs';
import {hash,safeUrl} from './security.mjs';

// This is the user-supplied maximum access boundary, not a prefix match.
export const serviceNowReadTools=Object.freeze([
  'list_incidents','get_incident_by_number','get_incident_details',
  'list_change_requests','get_change_request_info','list_change_tasks','get_change_task',
  'list_problems','get_problem','list_problem_tasks','get_problem_task',
  'list_security_incidents','get_security_incident',
  'list_approvals','get_approval_info','get_approval_details',
  'list_requests','list_request_items','get_request_item','list_catalog_items','list_categories',
  'list_knowledge_bases','list_articles','get_article',
  'search_cis','get_ci_context','get_ci_relationships','query_cmdb_hierarchy','get_cmdb_class_info','search_cmdb_fields','list_cmdb_tasks','get_cmdb_task',
  'list_stories','get_story','list_story_dependencies','list_requirements','get_requirement','list_ideas','get_idea',
  'list_users','get_user','get_user_sn_profile','get_user_sn_groups','get_users_peers','list_groups',
]);
const allowed=new Set(serviceNowReadTools),object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bad=message=>new Error('ServiceNow MCP '+message);
const bounded=(value,limit=2*1024*1024)=>{if(Buffer.byteLength(JSON.stringify(value))>limit)throw bad('result exceeds its byte budget');return value;};
const path=value=>typeof value==='string'&&value.length<=256&&(!value||value.split('.').every(p=>/^[A-Za-z0-9_-]+$/.test(p)&&!['__proto__','constructor','prototype'].includes(p)));
const at=(value,location='')=>{for(const key of location?location.split('.'):[]){if(!object(value)&&!Array.isArray(value))return undefined;value=Object.hasOwn(value,key)?value[key]:undefined;}return value;};
const timestamp=value=>typeof value==='string'?Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)?value.replace(' ','T')+'Z':value):NaN;
const scalar=value=>object(value)?value.value:value;
function withAbort(promise,signal) {
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(bad('read cancelled'));};
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
function compile(schema) {
  if(!object(schema)||schema.type!=='object')throw bad('tool requires an object schema');
  const Type=/draft-07/.test(schema.$schema||'')?Ajv:Ajv2020;
  return new Type({strict:false,allErrors:false,validateFormats:false,addUsedSchema:false}).compile(schema);
}
const validator={getValidator(schema){const validate=compile(schema);return data=>({valid:Boolean(validate(data)),errorMessage:'MCP output schema validation failed'});}};

export function validateServiceNowMcp(config) {
  if(config.transport!==undefined&&!['rest','mcp'].includes(config.transport))throw bad('transport must be rest or mcp');
  if(config.transport!=='mcp')return;
  if(!/^[a-f0-9]{32}$/.test(config.cmdbCi||''))throw bad('requires an explicit CMDB CI sys_id');
  const m=config.mcp;
  if(!object(m))throw bad('configuration required');
  if(m.allowLoopback!==undefined&&typeof m.allowLoopback!=='boolean')throw bad('allowLoopback must be boolean');
  safeUrl(m.endpoint,m.allowLoopback===true);
  if(m.timeoutMs!==undefined&&(!Number.isInteger(m.timeoutMs)||m.timeoutMs<100||m.timeoutMs>60000))throw bad('timeoutMs must be 100–60000');
  if(!object(m.bindings))throw bad('explicit schema bindings required');
  for(const key of ['incidents','openIncidents','incident'])if(!object(m.bindings[key]))throw bad('binding required: '+key);
  if(m.enrichment!==undefined&&(!Array.isArray(m.enrichment)||m.enrichment.length>8))throw bad('enrichment must contain at most eight bindings');
  const bindings=[...Object.values(m.bindings),...(m.enrichment||[])];
  for(const binding of bindings) {
    if(!object(binding)||!allowed.has(binding.tool)||!object(binding.arguments))throw bad('binding uses an unsupported tool or arguments');
    if(['itemsPath','recordPath','nextCursorPath','completePath'].some(k=>binding[k]!==undefined&&!path(binding[k])))throw bad('invalid result path');
    // Check templates before any transport is opened.
    expand(binding.arguments,{ci:'fixture',since:'fixture',until:'fixture',id:'fixture',number:'fixture',cursor:null,limit:100});
  }
  for(const key of ['incidents','openIncidents'])for(const field of ['itemsPath','nextCursorPath','completePath'])if(typeof m.bindings[key][field]!=='string')throw bad(key+' requires explicit list completeness paths');
  if(!Array.isArray(config.closedStates)||!config.closedStates.length)throw bad('requires explicit closedStates');
  if(m.fields!==undefined&&(!object(m.fields)||Object.entries(m.fields).some(([key,value])=>!incidentFields.includes(key)||!path(value))))throw bad('invalid incident field mapping');
  if(m.schemaPins!==undefined&&(!object(m.schemaPins)||Object.entries(m.schemaPins).some(([key,value])=>!allowed.has(key)||!/^[a-f0-9]{64}$/.test(value))))throw bad('invalid schema pins');
}
function expand(template,params,depth=0) {
  if(depth>8)throw bad('argument template exceeds depth budget');
  if(object(template)) {
    if(Object.hasOwn(template,'$param')) {
      if(Object.keys(template).length!==1||!Object.hasOwn(params,template.$param))throw bad('unknown argument parameter');
      return params[template.$param];
    }
    if(Object.keys(template).some(k=>['__proto__','constructor','prototype'].includes(k)))throw bad('unsafe argument key');
    return Object.fromEntries(Object.entries(template).map(([k,v])=>[k,expand(v,params,depth+1)]));
  }
  if(Array.isArray(template))return template.map(v=>expand(v,params,depth+1));
  return template;
}
const incidentFields=['sys_id','number','short_description','description','state','priority','cmdb_ci','correlation_id','sys_created_on','sys_updated_on'];

export class ServiceNowMcpConnector {
  constructor(config,options={}) {
    validateServiceNowMcp(config);this.config=structuredClone(config);this.options=options;this.clock=options.clock||Date.now;
    this.tools=new Map();this.schemaHashes=new Map();this.dirty=true;this.closed=false;this.generation=0;
    this.lifetime=new AbortController();
    this.endpoint=safeUrl(config.mcp.endpoint,config.mcp.allowLoopback===true);
    this.getToken=tokenProvider(config,options.env,options.fetcher,{clock:this.clock,retryGate:options.oauthRetryGate});
    this.gate=new ApiClient({base:this.endpoint,local:config.mcp.allowLoopback===true,retryGate:options.retryGate,clock:this.clock});
  }
  async fetch(input,init={}) {
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(safeUrl(url.href,this.config.mcp.allowLoopback===true)!==this.endpoint)throw bad('transport URL is outside its configured endpoint');
    const method=init.method||'GET';
    // Session negotiation and cancellation are MCP control messages. No
    // resource, prompt, sampling, roots, elicitation or arbitrary RPC surface.
    if(method==='POST') {
      let message;try{message=JSON.parse(init.body);}catch{throw bad('invalid protocol request');}
      if(!['initialize','notifications/initialized','tools/list','tools/call','notifications/cancelled','ping'].includes(message.method)||(message.method==='tools/call'&&!allowed.has(message.params?.name)))throw bad('protocol request denied');
    } else if(method!=='GET')throw bad('HTTP method denied');
    const signal=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(this.config.mcp.timeoutMs||15000),...(init.signal?[init.signal]:[])]);
    await this.gate.checkCooldown();signal.throwIfAborted();
    const token=await this.getToken({signal}),headers=new Headers(init.headers);headers.set('authorization','Bearer '+token);
    let response;try{response=await (this.options.fetcher||fetch)(url.href,{...init,method,headers,signal,redirect:'error'});}catch{throw bad('transport failed');}
    if(response.status===401)this.getToken.invalidate(token);
    if([403,429].includes(response.status)||response.status>=500) {
      const now=await this.clock(),{wait,persist}=responseDelay(response,now,0);
      if(persist&&wait>0){const hold={until:now+wait,status:response.status};this.gate.cooldown=hold;await this.options.retryGate?.defer(hold);}
    }
    if(!response.ok&&response.status!==405){await response.body?.cancel();throw new ConnectorError('ServiceNow MCP returned HTTP '+response.status,{status:response.status});}
    if(!response.body)return response;
    if(Number(response.headers.get('content-length')||0)>2*1024*1024){await response.body.cancel();throw bad('response exceeds its byte budget');}
    const reader=response.body.getReader();let size=0;
    return new Response(new ReadableStream({async pull(controller){try{const chunk=await reader.read();if(chunk.done){controller.close();return;}size+=chunk.value.byteLength;if(size>2*1024*1024){await reader.cancel();throw bad('response exceeds its byte budget');}controller.enqueue(chunk.value);}catch{controller.error(bad('response could not be read'));}},cancel:reason=>reader.cancel(reason)}),{status:response.status,headers:response.headers});
  }
  async ready(signal) {
    if(this.closed)throw bad('connector is closed');
    signal?.throwIfAborted();
    if(!this.flight) {
      this.flight=(async()=>{
        const discoverySignal=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(this.config.mcp.timeoutMs||15000)]);
        try {
          if(!this.client) {
            this.client=new Client({name:'sre-servicenow-reader',version:'1.0.0'},{capabilities:{},jsonSchemaValidator:validator});
            this.client.onerror=()=>{};
            this.client.setNotificationHandler(ToolListChangedNotificationSchema,()=>{this.dirty=true;this.generation++;});
            this.transport=new StreamableHTTPClientTransport(new URL(this.endpoint),{fetch:(...args)=>this.fetch(...args),requestInit:{redirect:'error'},reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
            await this.client.connect(this.transport,{signal:discoverySignal,timeout:this.config.mcp.timeoutMs||15000});
            this.dirty=true;
          }
          if(performance.now()-(this.discoveredAt||0)>60000)this.dirty=true;
          if(!this.dirty)return;
          const tools=new Map(),seen=new Set();let cursor;const generation=this.generation;
          for(let page=0;page<10;page++) {
            const result=bounded(await this.client.listTools(cursor?{cursor}:undefined,{signal:discoverySignal,timeout:this.config.mcp.timeoutMs||15000}));
            for(const tool of result.tools) {
              if(seen.has(tool.name))throw bad('duplicate tool definition');seen.add(tool.name);
              if(!allowed.has(tool.name))continue;
              if(tool.annotations?.readOnlyHint===false||tool.annotations?.destructiveHint===true)throw bad('tool contradicts its read-only contract');
              const fingerprint=hash({name:tool.name,inputSchema:tool.inputSchema,outputSchema:tool.outputSchema||null});
              const expected=this.config.mcp.schemaPins?.[tool.name]||this.schemaHashes.get(tool.name);
              if(expected&&fingerprint!==expected)throw bad('tool schema changed; review its binding and pin');
              tools.set(tool.name,{validate:compile(tool.inputSchema),output:tool.outputSchema?compile(tool.outputSchema):null,fingerprint});
            }
            if(result.nextCursor===undefined)break;
            if(page===9||typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>2048||result.nextCursor===cursor)throw bad('tool discovery is incomplete');
            cursor=result.nextCursor;
          }
          for(const binding of [...Object.values(this.config.mcp.bindings),...(this.config.mcp.enrichment||[])])if(!tools.has(binding.tool))throw bad('configured tool is unavailable');
          if(generation!==this.generation)throw bad('tool list changed during discovery');
          this.tools=tools;for(const [name,tool] of tools)this.schemaHashes.set(name,tool.fingerprint);this.dirty=false;this.discoveredAt=performance.now();
        } catch(error){await this.client?.close().catch(()=>{});this.client=null;this.dirty=true;throw error instanceof ConnectorError?error:bad('discovery failed; check schemas, permissions and server availability');}
      })().finally(()=>{this.flight=null;});
    }
    await withAbort(this.flight,signal);signal?.throwIfAborted();
  }
  async readTool(name,args,{signal}={}) {
    if(!allowed.has(name))throw bad('tool is outside the 45-tool read-only allowlist');
    bounded(args,32768);await this.ready(signal);const definition=this.tools.get(name);
    if(!definition||!object(args)||!definition.validate(args))throw bad('tool arguments do not satisfy its discovered schema');
    const generation=this.generation;
    try {
      const result=bounded(await this.client.callTool({name,arguments:args},undefined,{signal:AbortSignal.any([this.lifetime.signal,...(signal?[signal]:[])]),timeout:this.config.mcp.timeoutMs||15000}));
      if(result.isError===true)throw bad('tool reported an error');
      if(this.dirty||generation!==this.generation)throw bad('tool list changed during a read');
      let data=result.structuredContent;
      if(data===undefined) {
        if(result.content?.length!==1||result.content[0].type!=='text')throw bad('tool must return structured data or one JSON text result');
        data=JSON.parse(result.content[0].text);
      }
      if(!object(data)||definition.output&&!definition.output(data))throw bad('tool output does not satisfy its schema');
      return {data,provenance:{tool:name,schemaHash:definition.fingerprint,retrievedAt:await this.clock(),authority:'untrusted_read_only_evidence'}};
    } catch(error){throw error instanceof ConnectorError?error:bad('read failed; result is unavailable or invalid');}
  }
  async inventory({signal}={}) {await this.ready(signal);return {allowedTools:serviceNowReadTools.length,available:[...this.tools].map(([name,tool])=>({name,schemaHash:tool.fingerprint})),liveValidated:false};}
  canonical(row) {
    if(!object(row))throw bad('incident record is invalid');
    const result=Object.fromEntries(incidentFields.filter(key=>at(row,this.config.mcp.fields?.[key]||key)!==undefined).map(key=>[key,at(row,this.config.mcp.fields?.[key]||key)]));
    result.cmdb_ci=scalar(result.cmdb_ci);result.state=scalar(result.state);
    if(result.cmdb_ci!==this.config.cmdbCi||!/^[a-f0-9]{32}$/.test(result.sys_id||''))throw bad('incident is outside its CI or identity scope');
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(result.state??''))||!Number.isFinite(timestamp(result.sys_created_on))||!Number.isFinite(timestamp(result.sys_updated_on))||timestamp(result.sys_created_on)>timestamp(result.sys_updated_on))throw bad('incident state or lifecycle timestamps are missing or invalid');
    return result;
  }
  async list(bindingKey,{since,until,maxPages=10,signal}={}) {
    if(!Number.isSafeInteger(until)||until<0||(bindingKey==='incidents'&&(!Number.isSafeInteger(since)||since<0||since>until))||!Number.isInteger(maxPages)||maxPages<1||maxPages>100)throw bad('invalid incident query window or page budget');
    const binding=this.config.mcp.bindings[bindingKey],items=[],cursors=new Set(),identities=new Set();let cursor=null;
    for(let page=0;page<maxPages;page++) {
      const {data}=await this.readTool(binding.tool,expand(binding.arguments,{ci:this.config.cmdbCi,since:since===undefined?null:new Date(since).toISOString(),until:new Date(until).toISOString(),cursor,limit:100}),{signal});
      const rows=at(data,binding.itemsPath),complete=at(data,binding.completePath),next=at(data,binding.nextCursorPath);
      if(!Array.isArray(rows)||rows.length>100||typeof complete!=='boolean'||!(next===null||typeof next==='string'&&next.length>0&&next.length<=2048)||(complete&&next!==null))throw bad('list completeness contract is invalid');
      for(const row of rows) {
        const item=this.canonical(row),updated=timestamp(item.sys_updated_on);
        if(updated>until||(bindingKey==='incidents'&&updated<since)||(bindingKey==='openIncidents'&&this.config.closedStates.map(String).includes(String(item.state)))||identities.has(item.sys_id))throw bad('list returned an out-of-window, closed or duplicate incident');
        identities.add(item.sys_id);items.push(item);
      }
      if(complete)return {items,complete:true};
      if(next===null)return {items,complete:false};
      if(cursors.has(next))throw bad('list cursor repeated');cursors.add(next);cursor=next;
    }
    return {items,complete:false};
  }
  incidents(options){return this.list('incidents',options);}
  openIncidents(options){return this.list('openIncidents',options);}
  async incident(id,{signal}={}) {
    if(!/^[a-f0-9]{32}$/.test(id||''))throw bad('invalid incident sys_id');
    const binding=this.config.mcp.bindings.incident;
    const result=await this.readTool(binding.tool,expand(binding.arguments,{ci:this.config.cmdbCi,id}),{signal});
    const record=this.canonical(at(result.data,binding.recordPath));if(record.sys_id!==id)throw bad('incident identity does not match its request');
    return {result:record,provenance:result.provenance};
  }
  async enrich(id,{signal}={}) {
    const {result:incident}=await this.incident(id,{signal}),records=[];
    for(const binding of this.config.mcp.enrichment||[]) {
      const result=await this.readTool(binding.tool,expand(binding.arguments,{ci:this.config.cmdbCi,id,number:incident.number}),{signal});
      // Enrichment arguments are fixed reviewed templates, not arbitrary text
      // returned by a ticket, article or model. Missing permissions stay visible.
      records.push({...result,coverage:'Only the configured query and visible records; no completeness or health inference.'});
    }
    return {incidentId:id,cmdbCi:this.config.cmdbCi,records,complete:records.every(record=>record.data.complete===true),coverage:'Bounded configured reads only. Missing completeness metadata remains unverified.'};
  }
  async close(){if(this.closed)return;this.closed=true;this.lifetime.abort();await this.flight?.catch(()=>{});await this.client?.close().catch(()=>{});this.client=null;}
}
