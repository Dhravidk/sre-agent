import {readFileSync} from 'node:fs';
import {createServer,request} from 'node:http';
import {validateConfig} from './config.mjs';

const guid=/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
export function teamsTrialConfig(settings,credentials) {
  if(!guid.test(credentials.TENANT_ID||'')||!guid.test(credentials.CLIENT_ID||''))throw Error('Configure the dedicated Teams trial tenant and bot IDs');
  if(!Array.isArray(settings.rooms)||settings.rooms.length!==2||new Set(settings.rooms.map(room=>room.id)).size!==2)throw Error('Configure exactly two distinct trial channels');
  for(const room of settings.rooms)if(typeof room.id!=='string'||!/^19:[^\s;]+@thread\.tacv2$/.test(room.id)||typeof room.name!=='string')throw Error('Trial channels need exact channel IDs and names');
  if(settings.tenantId!==credentials.TENANT_ID||settings.botId!==credentials.CLIENT_ID)throw Error('Trial identities do not match the private credentials');
  const c=JSON.parse(readFileSync(new URL('../../config/sre.local.json',import.meta.url),'utf8'));
  c.mode='connected';c.agentMode='rules';
  const service=c.services[0];service.key='auction-teams-trial';service.name='Fictional Teams integration trial';service.tenant='synthetic-teams-trial';
  for(const source of ['github','gitlab','dynatrace','dynatraceLogs','servicenow','jira','releases','logs','verification'])service[source]={...service[source],enabled:false};
  if(settings.repositoryProvider!==undefined&&!['github','gitlab'].includes(settings.repositoryProvider))throw Error('Trial repositoryProvider must be github or gitlab');
  service.rollback={...service.rollback,enabled:false,provider:settings.repositoryProvider||service.rollback.provider};
  service.teams={tenantId:settings.tenantId,conversations:settings.rooms.map(room=>room.id),approvers:[],captureResponderUpdates:false,collaborationGroups:[{key:'teams-trial',name:'Fictional two-team integration trial',conversations:settings.rooms}]};
  if(settings.admission!==undefined&&!['allowlist','tenant'].includes(settings.admission))throw Error('Trial admission must be allowlist or tenant');
  if(settings.admission==='tenant')Object.assign(service.teams,{admission:'tenant',tenantSharing:{key:'teams-trial',name:'Organization incident collaboration'}});
  return validateConfig(c,{
    CLIENT_ID:credentials.CLIENT_ID,CLIENT_SECRET:credentials.CLIENT_SECRET,TENANT_ID:credentials.TENANT_ID,
    SRE_API_TOKEN:credentials.SRE_TEAMS_TRIAL_API_TOKEN,SRE_CAPABILITY_SECRET:credentials.SRE_TEAMS_TRIAL_CAPABILITY_SECRET,
    SRE_AGENT_MODE:'rules',SRE_CLAUDE_BIN:'/nonexistent-teams-trial-claude',SRE_TEAMS_MODE:'live',
    SRE_HOST:'127.0.0.1',SRE_PORT:String(settings.apiPort??3003),TEAMS_PORT:String(settings.botPort??3978),SRE_SQLITE_PATH:settings.database,
  });
}

const pages={
  '/trial':['SRE Agent Trial','Private two-team integration rehearsal. Microsoft Teams transport is real; incident evidence is fictional, Claude is off, and deployment execution is disabled. Only the two explicitly configured test channels are accepted.'],
  '/trial/privacy':['Trial data handling','Use fictional test data only. The trial stores messages explicitly addressed to the bot, their sender and timestamp, and incident evidence in a local SQLite database on the development computer. It does not request background chat reading, import earlier history, process attachments, call a model, or send evidence to incident/deployment providers. Replies and cross-team briefings are sent to the configured Teams test channels through Microsoft. The operator can stop the trial and remove its local database after retaining the test evidence they need. Do not enter customer, production, credential or other sensitive information.'],
  '/trial/terms':['Internal trial information','This page describes an internal integration rehearsal, not a service contract or a production service. Use only the dedicated test channels and fictional incident data. All work, theory and recovery reports are unverified claims. Deployment execution is disabled. Claude is off. A temporary development tunnel may stop or change address; this trial makes no availability commitment.'],
};
const page=([title,body])=>'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+title+'</title><style>body{font:18px/1.6 system-ui;max-width:760px;margin:70px auto;padding:20px;color:#183a2f}a{color:inherit}</style><h1>'+title+'</h1><p>'+body+'</p><nav><a href="/trial">Trial</a> · <a href="/trial/privacy">Data handling</a> · <a href="/trial/terms">Trial information</a></nav></html>';

// This gateway exposes static, non-sensitive trial notices. Webhook forwarding
// is closed by default; the SDK still validates Microsoft's JWT when opened.
// The incident console, operator APIs and simulator are never proxied.
export function teamsTrialGateway({upstream,enabled=()=>false,maxBodyBytes=128*1024,organizationAccess=false}) {
  const target=new URL(upstream);
  if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.pathname!=='/api/messages'||target.search||target.hash||target.username||target.password)throw Error('The trial gateway must target only the loopback Teams webhook');
  const server=createServer(async(req,res)=>{
    const reply=(status,text,type='text/plain; charset=utf-8')=>{if(res.headersSent)return;res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"});res.end(text);};
    try {
      if(req.method==='GET'&&Object.hasOwn(pages,req.url)) {
        const content=organizationAccess?{
          '/trial':['SRE Agent Trial','Organization Teams integration rehearsal. Members of the configured Microsoft tenant can add this mention-only bot to team channels or group chats. Use incidents, then join <incident-id> in each conversation that should share that incident. Claude is off and deployments are disabled. Use fictional data only.'],
          '/trial/privacy':['Trial data handling','Use fictional test data only. Explicit mentions, sender and time are stored in a local incident database. A thread or group chat that joins an incident shares its submitted context and briefings with other conversations in this tenant that join the same incident. Bot Connector membership is checked before accepting org-wide mentions. Ordinary chat, earlier history and attachments are not read. No model or incident/deployment provider receives this evidence. Leaving an incident stops future briefings here; prior Teams posts remain. The organization operator controls retention.'],
          '/trial/terms':['Internal trial information','Fictional organization integration rehearsal, hosted on the development computer through a temporary tunnel. Claude and deployment execution are disabled. Bot availability depends on that computer and the explicitly enabled forwarding window. Responder reports remain unverified. Use separate threads/chats for separate incidents; only conversations that join the same incident share its context.'],
        }[req.url]:pages[req.url];
        return reply(200,page(content),'text/html; charset=utf-8');
      }
      if(req.method!=='POST'||req.url!=='/api/messages')return reply(404,'Not found');
      if(!enabled())return reply(503,'The trial webhook is not enabled');
      if(!/^Bearer [^\s]{1,8192}$/.test(req.headers.authorization||''))return reply(401,'A Microsoft bot-service token is required');
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return reply(415,'JSON required');
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>maxBodyBytes)return reply(413,'Activity is too large');chunks.push(chunk);}
      const body=Buffer.concat(chunks);
      await new Promise(resolve=>{
        const outgoing=request(target,{method:'POST',headers:{authorization:req.headers.authorization,'content-type':'application/json','content-length':body.length},timeout:30000},incoming=>{
          const chunks=[];let size=0;
          incoming.on('data',chunk=>{size+=chunk.length;if(size<=65536)chunks.push(chunk);else incoming.destroy();});
          incoming.on('end',()=>{reply(incoming.statusCode||502,Buffer.concat(chunks),'application/json; charset=utf-8');resolve();});
          incoming.on('error',()=>{reply(502,'Webhook response was interrupted');resolve();});
        });
        outgoing.on('timeout',()=>outgoing.destroy());outgoing.on('error',()=>{reply(502,'Webhook is unavailable');resolve();});outgoing.end(body);
      });
    } catch {reply(400,'Invalid activity');}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}

export function trialForwardingAllowed(path,settings,now=Date.now()) {
  try {
    const grant=JSON.parse(readFileSync(path,'utf8'));
    const admission=settings.admission||'allowlist';
    const scope=(grant.admission||'allowlist')===admission&&(admission==='tenant'?Array.isArray(grant.channelIds)&&grant.channelIds.length===0:Array.isArray(grant.channelIds)&&JSON.stringify(grant.channelIds.toSorted())===JSON.stringify(settings.rooms.map(room=>room.id).toSorted()));
    return scope&&grant.enabled===true&&grant.tenantId===settings.tenantId&&grant.botId===settings.botId&&Number.isSafeInteger(grant.expiresAt)&&grant.expiresAt>now&&grant.expiresAt-now<=8*3600000;
  } catch {return false;}
}

// Keep queued briefings durable while the test is closed. Checking before the
// delivery lease prevents a closed/expired grant from consuming retry attempts
// or turning an intentionally paused send into an ambiguous remote outcome.
export function gateTrialDeliveries(outbox,enabled=()=>false) {
  const deliver=outbox.runOnce.bind(outbox);
  outbox.runOnce=async()=>enabled()===true?deliver():false;
}

export function trialNoticeSender(sender){
  return {send:(reference,text,options)=>sender.send(reference,'[Fictional SRE Teams trial · Claude off · deployments disabled]\n'+text,options)};
}
