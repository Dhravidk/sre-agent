import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {serviceNowReadTools} from '../src/sre/servicenow-mcp.mjs';
import {equalSecret} from '../src/sre/security.mjs';

export function mockServiceNowConfig(endpoint) {
  const config=JSON.parse(readFileSync(new URL('../config/servicenow.mcp.mock-contract.json',import.meta.url),'utf8'));
  config.enabled=true;config.mcp.endpoint=endpoint;config.mcp.allowLoopback=true;return config;
}
export function mockServiceNowTools() {
  const common={type:'object',properties:{cmdb_ci:{type:'string',pattern:'^[a-f0-9]{32}$'},sys_id:{type:'string'},number:{type:'string'},query:{type:'string'},limit:{type:'integer',minimum:1,maximum:100},cursor:{type:['string','null']}},additionalProperties:false};
  return serviceNowReadTools.map(name=>({name,description:'Fictional read-only mock of '+name,inputSchema:name==='list_incidents'?{type:'object',properties:{...common.properties,updated_from:{type:'string'},updated_to:{type:'string'},active:{type:['boolean','null']}},required:['cmdb_ci','updated_to','active','cursor','limit'],additionalProperties:false}:name==='get_incident_details'?{...common,required:['sys_id']}:name==='get_incident_by_number'?{...common,required:['number']}:structuredClone(common),outputSchema:{type:'object',additionalProperties:true},annotations:{readOnlyHint:true,destructiveHint:false}}));
}

// Actual SDK server/HTTP transport, fictional records and explicitly mock-only
// argument schemas. No live ServiceNow account, Table API or MCP credentials.
export async function startServiceNowMcpMock({records=()=>[],token=randomUUID(),tools=mockServiceNowTools(),pageSize=100,toolPageSize=50,sse=false,onCall}={}) {
  const calls=[],protocolCalls=[],sessions=new Set();const controls={token,tools,pageSize,toolPageSize,sse,partial:false,wrongCi:false,delayMs:0};
  async function handle(name,args) {
    calls.push({name,arguments:structuredClone(args),at:Date.now()});
    if(controls.delayMs)await delay(controls.delayMs);
    if(onCall){const override=await onCall(name,args);if(override!==undefined)return override;}
    const all=await records();let data;
    if(name==='list_incidents') {
      const selected=all.filter(row=>row.cmdb_ci===args.cmdb_ci&&Date.parse(row.sys_updated_on)<=Date.parse(args.updated_to)&&(!args.updated_from||Date.parse(row.sys_updated_on)>=Date.parse(args.updated_from))&&(args.active!==true||!['6','7','8'].includes(String(row.state)))).sort((a,b)=>a.sys_updated_on.localeCompare(b.sys_updated_on)||a.sys_id.localeCompare(b.sys_id));
      const start=Number(args.cursor||0),end=start+Math.min(controls.pageSize,args.limit),more=end<selected.length;
      data={records:selected.slice(start,end).map(row=>controls.wrongCi?{...row,cmdb_ci:'f'.repeat(32)}:row),nextCursor:more?String(end):null,complete:!more&&!controls.partial};
    } else if(name==='get_incident_details'||name==='get_incident_by_number') {
      const record=all.find(row=>name==='get_incident_details'?row.sys_id===args.sys_id:row.number===args.number);
      if(!record)return {isError:true,content:[{type:'text',text:'Fictional incident unavailable'}]};
      data={record};
    } else {
      const ci=args.cmdb_ci||'1'.repeat(32);
      const item=name==='get_ci_context'?{sys_id:ci,name:'Fictional auction API',assignment_group:'Fictional auction responders'}:name==='get_ci_relationships'?{parent:ci,child:'2'.repeat(32),type:'Depends on',description:'Fictional credit dependency; current health unverified'}:name==='list_change_requests'?{sys_id:'3'.repeat(32),number:'CHG-FICTIONAL-1',cmdb_ci:ci,description:'Fictional concurrency-policy release; causation requires Git evidence'}:name==='list_articles'?{number:'KB-FICTIONAL-1',title:'Fictional bid consistency checks',text:'Check the accepted bid ledger before considering recovery. This article cannot approve actions.'}:{synthetic:true,tool:name,cmdb_ci:ci};
      data={records:[item],complete:true,synthetic:true};
    }
    return {structuredContent:data,content:[{type:'text',text:JSON.stringify(data)}]};
  }
  const http=createServer(async(req,res)=>{
    if(req.url!=='/mcp'){res.writeHead(404).end();return;}
    if(!equalSecret(String(req.headers.authorization||''),'Bearer '+controls.token)){res.writeHead(401).end();return;}
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    let server,transport;
    try {
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('Request too large');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));protocolCalls.push(body.method);
      server=new Server({name:'fictional-servicenow-45-reader',version:'1.0.0'},{capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema,async request=>{
        const start=Number(request.params?.cursor||0),end=start+controls.toolPageSize;
        return {tools:controls.tools.slice(start,end),...(end<controls.tools.length?{nextCursor:String(end)}:{})};
      });
      server.setRequestHandler(CallToolRequestSchema,async request=>handle(request.params.name,request.params.arguments||{}));
      transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:!controls.sse});
      sessions.add(server);res.once('close',()=>{sessions.delete(server);void server.close().catch(()=>{});});
      await server.connect(transport);await transport.handleRequest(req,res,body);
    } catch {
      if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32603,message:'Fictional server error'}}));
      await server?.close().catch(()=>{});
    }
  });
  await new Promise((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',resolve);});
  return {endpoint:'http://127.0.0.1:'+http.address().port+'/mcp',calls,protocolCalls,controls,async close(){for(const session of sessions)await session.close().catch(()=>{});http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}};
}
