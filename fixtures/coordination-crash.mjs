// Isolated process fixture: killed by its parent after a synthetic recipient
// has persisted a message but before the outbox can persist the receipt.
import {appendFile} from 'node:fs/promises';
import {loadConfig,validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';

const [path,deliveryLog]=process.argv.slice(2);
if(!path||!deliveryLog||!process.send)throw Error('This fixture requires an isolated database, delivery log and parent IPC');
const env={SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-coordination-crash-cli'};
const c=loadConfig(env),rooms=[{id:'group-0',name:'Bidding responders'},{id:'group-1',name:'Platform responders'}];
c.services[0].teams={...c.services[0].teams,conversations:[...rooms.map(room=>room.id),'private-group'],alertConversationId:'group-0',collaborationGroups:[{key:'auction',name:'Auction response',conversations:rooms}]};
validateConfig(c,env);
let r,now=Date.now(),sequence=0,armed=false,incidentId,agentId;
r=await createSreRuntime({config:c,autoStart:false,sender:{send:async(ref,text)=>{
  await appendFile(deliveryLog,JSON.stringify({room:ref.conversation.id,text})+'\n');
  if(armed&&ref.conversation.id==='group-1'&&text.startsWith('Shared incident coordination')) {
    process.send({event:'delivery-in-flight',incidentId,agentId,now});
    await new Promise(()=>{});
  }
  return {id:'fixture-'+sequence};
}}});
r.store.clock=()=>now;
async function message(room,text,{processCommand=true}={}) {
  now+=10;
  const sample=devActivity(text,c.services[0],{id:'crash-'+(++sequence),conversationType:'groupChat',conversationId:room,userId:room==='group-0'?'alex':'sam',displayName:room==='group-0'?'Alex':'Sam'});
  sample.activity.timestamp=new Date(now).toISOString();
  await r.router.accept(sample.activity,sample.reference);
  if(processCommand)await r.router.processOnce();
}
incidentId=(await r.store.ingest({id:'crash-incident',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'crash-incident',status:'OPEN',at:now-1000,payload:{title:'Bidding and platform disagree during shift change'}})).incidentId;
agentId=(await r.store.context(incidentId)).session.agent_id;
await message('group-0','join '+incidentId);await message('group-1','join '+incidentId);
await message('group-0','theory bid-order supported The accepted bid comparison fails after the deployment.');
await message('group-1','theory credit-pool proposed Credit traces need correlation with the same affected IDs.');
await message('group-0','work traces released Shift ending; the platform team must accept the check.');
for(let i=0;i<20&&await r.outbox.runOnce();i++);
await r.coordination.runOnce();
// Delay only this synthetic recipient so the other group receives its copy.
await r.store.db.query("UPDATE sre_outbox SET next_at=? WHERE id LIKE 'coordination:%' AND conversation_key=?",[now+1000,conversationKey('synthetic','group-1')]);
for(let i=0;i<20&&await r.outbox.runOnce();i++);
await message('group-0','ack 1',{processCommand:false});
now+=2000;armed=true;
await r.outbox.runOnce();
throw Error('Parent did not kill the in-flight fixture');
