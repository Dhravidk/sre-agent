import { App, ExpressAdapter } from '@microsoft/teams.apps';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/core/store.mjs';

export function teamsConfig({mode,env=process.env}) {
  if(!['playground','live'].includes(mode))throw new Error('Choose --playground or --live');
  if(mode==='playground' && (env.CLIENT_ID||env.CLIENT_SECRET||env.TENANT_ID))throw new Error('Playground mode must use a credential-free environment');
  if(mode==='live')for(const key of ['CLIENT_ID','CLIENT_SECRET','TENANT_ID','TEAMS_ALLOWED_CONVERSATIONS'])if(!env[key])throw new Error('Live Teams requires '+key);
  return {dangerouslyAllowUnauthenticatedRequests:mode==='playground',clientId:env.CLIENT_ID,clientSecret:env.CLIENT_SECRET,tenantId:env.TENANT_ID};
}

export async function startTeams({mode,port=3978,env=process.env,store=new Store('.local/teams.sqlite')}={}) {
  const config=teamsConfig({mode,env});
  const rawServer=createServer();
  class LoopbackAdapter extends ExpressAdapter {
    async start(listenPort) { await new Promise((resolve,reject)=>{rawServer.once('error',reject);rawServer.listen(port===0?0:listenPort,'127.0.0.1',resolve);}); }
  }
  const adapter=new LoopbackAdapter(rawServer);
  const app=new App({...config,httpServerAdapter:adapter,telemetry:{agent365:false}});
  const base=env.SRE_LAB_URL||'http://127.0.0.1:3000';
  if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw new Error('Test bridge requires a loopback lab URL');
  const allowed=new Set((env.TEAMS_ALLOWED_CONVERSATIONS||'').split(',').filter(Boolean));
  function authorized(activity) {
    if(mode==='playground') {
      try { const url=new URL(activity.serviceUrl); return ['http:','https:'].includes(url.protocol) && ['127.0.0.1','localhost'].includes(url.hostname); }
      catch { return false; }
    }
    return activity.channelData?.tenant?.id===env.TENANT_ID && allowed.has(activity.conversation?.id);
  }
  function remember(activity) {
    store.update(state=>{state.teamsReferences??={};state.teamsReferences[activity.conversation.id]={tenant:activity.channelData?.tenant?.id,conversationId:activity.conversation.id,serviceUrl:activity.serviceUrl};return state;});
  }
  app.on('message',async({activity,send})=>{
    if(!authorized(activity))return;
    remember(activity);
    const text=(activity.text||'').replace(/<at>.*?<\/at>/g,'').trim();
    if(!text)return;
    const response=await fetch(base+'/api/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('Lab request failed');
    const result=await response.json();
    await send(result.text);
  });
  app.on('install.add',async({activity})=>{if(authorized(activity))remember(activity);});
  await app.start(port);
  if(!rawServer.listening)throw new Error('Teams bridge did not start');
  console.log('Teams '+mode+' bridge: http://127.0.0.1:'+rawServer.address().port+'/api/messages');
  return {app,server:rawServer,store,async close(){await app.stop();store.close();}};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const mode=process.argv.includes('--playground')?'playground':process.argv.includes('--live')?'live':'';
  const bridge=await startTeams({mode,port:Number(process.env.TEAMS_PORT||3978)});
  process.on('SIGTERM',async()=>{await bridge.close();process.exit(0);});
  process.on('SIGINT',async()=>{await bridge.close();process.exit(0);});
}
