import {AsyncLocalStorage} from 'node:async_hooks';
import {teamsDeliveryDefaults} from './teams-outbox.mjs';
import {changeTimelineText} from './change-timeline.mjs';
import { App, ExpressAdapter, toThreadedConversationId } from '@microsoft/teams.apps';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { conversationKey } from './store.mjs';
import { StorageError } from './database.mjs';
import {rootConversation,roomScope,reportedStates,IncidentCollaboration,collaborationText,parseCoordinationItem} from './collaboration.mjs';
import {teamsConversationAllowed,teamsActivityAllowed,tenantAdmission,requireTenantMember,activityTeamId} from './teams-access.mjs';
import {teamsMessage} from './teams-format.mjs';
import {signalDigestText} from './signal-digest.mjs';
import {contactsText,ticketIndexText} from './casework.mjs';
import {assessmentBrief} from './assessment-brief.mjs';

export {rootConversation};
const help='Use: incidents; join <incident-id>; name <room name>; leave; update <responder update>; report <investigating|mitigating|monitoring|recovered|blocked> <details>; theory <key> <proposed|supported|ruled-out> <details>; work <shared-key> <planned|active|blocked|done|cancelled|released> <scope and next check>; sync; brief; signals; contacts; changes; track-change <github|gitlab> <change-number>; untrack-change <provider> <number> <link-reference> <reason>; retrack-change <provider> <number> <withdrawal-reference> <reason>; plan; tickets; ticket <plan-id>; fix <plan-id>; approve-fix <request-id> <nonce>; ack <briefing-number>; status; investigate <incident-id> <question>; retry <incident-id> <job-id> <reason>; rollback <incident-id>; approve <proposal-id> <nonce>. In a channel or group chat, @mention me to instruct me. Use a separate thread/chat for each incident.';

// Channel replies can arrive with either a threaded conversation ID or replyToId.
export function incidentConversation(activity) {
  if(activity.conversation?.conversationType!=='channel'||activity.conversation.id.includes(';messageid='))return activity.conversation;
  return {...activity.conversation,id:toThreadedConversationId(activity.conversation.id,activity.replyToId||activity.id)};
}
export function isAddressed(activity) {
  return activity.conversation?.conversationType==='personal'||(activity.entities||[]).some(e=>e.type==='mention'&&typeof e.mentioned?.id==='string'&&e.mentioned.id.toLowerCase()===String(activity.recipient?.id||'').toLowerCase());
}

export class TeamsRouter {
  constructor({store,services,rollbacks,coordination=new IncidentCollaboration({store,services}),casework,mode='live'}) {Object.assign(this,{store,services,rollbacks,coordination,casework,mode});}
  serviceFor(activity) {
    const tenant=activity.channelData?.tenant?.id;
    const matches=this.services.filter(s=>s.teams.tenantId===tenant&&teamsActivityAllowed(s.teams,activity));
    if(matches.length!==1)throw new Error('Teams conversation must map to exactly one service and tenant');
    if(this.mode==='playground') {
      const url=new URL(activity.serviceUrl);
      if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Playground callbacks must stay on loopback');
    } else if(new URL(activity.serviceUrl).protocol!=='https:')throw new Error('Live Teams requires HTTPS service URLs');
    return matches[0];
  }
  async installation(activity,reference,enabled) {
    const service=this.serviceFor(activity),tenant=service.teams.tenantId,root=rootConversation(activity.conversation.id);
    const teamId=activityTeamId(activity),teamKey=teamId?'teams-installation:'+conversationKey(tenant,'team:'+teamId):null;
    const at=Date.parse(activity.timestamp),id=activity.id,key='teams-installation:'+conversationKey(tenant,root);
    if(!Number.isSafeInteger(at)||at<0||typeof id!=='string'||!id)throw new Error('Teams installation needs an activity ID and timestamp');
    return this.store.db.transaction(async q=>{
      const now=await this.store.coordinationNow(q);
      // Always lock the team before its channels, including a channel first
      // mentioned while an uninstall is being applied to the whole team.
      const keys=[...new Set([teamKey,key].filter(Boolean))],priors=[];
      for(const installationKey of keys) {
        await q("INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,'{}',?) ON CONFLICT DO NOTHING",[installationKey,now]);
        const [row]=await q('SELECT value FROM sre_checkpoints WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[installationKey]);priors.push(JSON.parse(row.value));
      }
      // A delayed install cannot resurrect an uninstalled bot. Removal wins a
      // timestamp tie; only a later install can restore that authorization.
      if(priors.some(prior=>prior.id===id||prior.at>at||(prior.at===at&&(!prior.enabled||enabled))))return {ignored:true};
      const all=await q('SELECT * FROM sre_conversations WHERE tenant_id=? AND service_key=? ORDER BY incident_id,id',[tenant,service.key]);
      const rooms=all.filter(room=>rootConversation(room.conversation_id)===root||teamId&&JSON.parse(room.reference).sreTeamId===teamId);
      if(!enabled)for(const room of rooms)await q('UPDATE sre_conversations SET enabled=0 WHERE id=?',[room.id]);
      else {
        await this.store.rememberConversation({tenant,reference:{...reference,...(teamId?{sreTeamId:teamId}:{}),conversation:{...reference.conversation,id:root}},serviceKey:service.key},q);
        for(const room of rooms.filter(room=>Number(room.enabled)===0)) {
          let incidentId=room.incident_id;
          if(incidentId) {
            await q('SELECT id FROM sre_incidents WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[incidentId]);
            const [active]=await q('SELECT COUNT(*) AS count FROM sre_conversations WHERE incident_id=? AND enabled=1 AND id<>?',[incidentId,room.id]);
            // Keep the thread reachable if other groups filled its old slot.
            // An explicit join will explain the existing eight-room boundary.
            if(Number(active.count)>=8)incidentId=null;
          }
          await q('UPDATE sre_conversations SET enabled=1,incident_id=?,updated_at=? WHERE id=?',[incidentId,now,room.id]);
        }
      }
      const affected=new Set([...keys,...rooms.map(room=>'teams-installation:'+conversationKey(tenant,rootConversation(room.conversation_id)))]);
      for(const installationKey of [...affected].sort())await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[installationKey,JSON.stringify({id,at,enabled}),now]);
      return {enabled};
    });
  }
  async accept(activity,reference,{getMember}={}) {
    if(activity.from?.role==='bot'||activity.from?.id===activity.recipient?.id)return {ignored:true};
    const addressed=isAddressed(activity);
    // RSC delivers a whole team's channels; discard unconfigured background traffic.
    if(!addressed&&!this.services.some(s=>s.teams.tenantId===activity.channelData?.tenant?.id&&teamsActivityAllowed(s.teams,activity)))return {ignored:true};
    const service=this.serviceFor(activity);
    if(!addressed&&tenantAdmission(service.teams))return {ignored:true};
    if(tenantAdmission(service.teams)) {
      if(typeof getMember!=='function')throw Error('Teams tenant membership could not be verified');
      requireTenantMember(activity,await getMember(),service.teams.tenantId);
    }
    const conversation=incidentConversation(activity);
    const key=conversationKey(service.teams.tenantId,conversation.id);
    const [saved]=await this.store.db.query('SELECT * FROM sre_conversations WHERE id=?',[key]);
    if(saved&&Number(saved.enabled)!==1)return {ignored:true,reason:'Conversation installation was removed; a new install event is required'};
    if(!addressed) {
      if(!service.teams.captureResponderUpdates||!saved?.incident_id)return {ignored:true};
      const context=await this.store.context(saved.incident_id);
      if(context.incident.status==='resolved')return {ignored:true};
    }
    const principal={verified:true,simulation:this.mode==='playground',tenant:service.teams.tenantId,conversationId:conversation.id,rootConversationId:rootConversation(conversation.id),userId:activity.from?.aadObjectId||''};
    let text=String(activity.text||'');
    for(const entity of activity.entities||[])if(entity.type==='mention'&&String(entity.mentioned?.id||'').toLowerCase()===String(activity.recipient?.id||'').toLowerCase()&&entity.text)text=text.replaceAll(entity.text,'');
    text=text.replace(/<at>(.*?)<\/at>/g,'$1').trim();
    // Teams repeats an ordinary message body as a nameless inline HTML part.
    // It is already represented by activity.text, not a drawing/file to fetch.
    const unreadAttachments=(activity.attachments||[]).filter(a=>!(text&&String(a.contentType||'').split(';')[0].toLowerCase()==='text/html'&&!a.name&&!a.contentUrl)).slice(0,10).map((a,i)=>({name:String(a.name||'Attachment '+(i+1)).slice(0,150),contentType:String(a.contentType||'unknown').slice(0,100),contentRead:false}));
    if(!text&&unreadAttachments.length)text='update Attachment received but its contents were not read. Ask a responder to describe important diagram, image or file details in text.';
    if(!text)return {ignored:true};
    if(!text||text.length>4000)throw new Error('Teams message must contain 1–4000 characters');
    if(typeof activity.id!=='string'||!activity.id)throw new Error('Teams activity ID is required');
    const teamId=activityTeamId(activity),tenant=service.teams.tenantId;
    const remembered=await this.store.db.transaction(async q=>{
      const keys=[...(teamId?['team:'+teamId]:[]),rootConversation(conversation.id)].map(root=>'teams-installation:'+conversationKey(tenant,root));
      for(const installationKey of keys) {
        await q("INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,'{}',?) ON CONFLICT DO NOTHING",[installationKey,await this.store.coordinationNow(q)]);
        const [row]=await q('SELECT value FROM sre_checkpoints WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[installationKey]);
        if(JSON.parse(row.value).enabled===false)return false;
      }
      const [current]=await q('SELECT enabled FROM sre_conversations WHERE id=?',[key]);if(current&&Number(current.enabled)!==1)return false;
      const roomName=activity.conversation?.name||activity.channelData?.channel?.name||activity.channelData?.team?.name;
      await this.store.rememberConversation({tenant,reference:{...reference,conversation,...(teamId?{sreTeamId:teamId}:{}),...(roomName?{sreRoomName:String(roomName).slice(0,80)}:{})},serviceKey:service.key},q);return true;
    });
    if(!remembered)return {ignored:true,reason:'Conversation installation was removed; a new install event is required'};
    const deliveryId=key+':'+activity.id;
    const [prior]=await this.store.db.query("SELECT payload FROM sre_events WHERE source='teams' AND service_key=? AND external_id=?",[service.key,deliveryId]);
    const incidentId=prior?JSON.parse(prior.payload).payload.incidentId:saved?.incident_id||null;
    // Bind context at receipt, so a delayed message cannot move to a different issue.
    return this.store.ingest({id:deliveryId,source:'teams',serviceKey:service.key,kind:'teams',at:Date.parse(activity.timestamp),payload:{text,principal,addressed,incidentId,displayName:String(activity.from?.name||'Responder').slice(0,200),conversationKey:key,serviceKey:service.key,at:Date.parse(activity.timestamp),...(unreadAttachments.length?{unreadAttachments}:{})}});
  }
  async processOnce() {
    const command=await this.store.db.transaction(async(q)=>{
      if((await this.store.restoreFence(q))?.active)return null;
      const [row]=await q("SELECT * FROM sre_commands WHERE status='pending' OR (status='running' AND lease_until<=?) ORDER BY created_at LIMIT 1"+(this.store.db.dialect==='postgres'?' FOR UPDATE SKIP LOCKED':''),[await this.store.coordinationNow(q)]);
      if(!row)return null;
      const until=await this.store.coordinationNow(q)+30000;
      await q("UPDATE sre_commands SET status='running',lease_until=? WHERE id=?",[until,row.id]);return {...row,lease_until:until};
    });
    if(!command)return false;
    if((await this.store.restoreFence())?.active)return false;
    const message=JSON.parse(command.payload);let response;let incidentId;let responseIncidentId;let responseContacts;let responseContactFormat='full';
    try {
      const text=message.text;const [verb,id,...rest]=text.split(/\s+/);
      const [conversation]=await this.store.db.query('SELECT * FROM sre_conversations WHERE id=? AND enabled=1',[message.conversationKey]);
      const discard=async(reason)=>{
        await this.store.db.transaction(async q=>{
          const [current]=await q('SELECT status,lease_until FROM sre_commands WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[command.id]);
          if(current?.status!=='running'||Number(current.lease_until)!==command.lease_until)return;
          if(command.lease_until<=await this.store.coordinationNow(q))throw new Error('Teams command lease expired');
          await q("UPDATE sre_commands SET status='discarded',error=?,lease_until=NULL WHERE id=?",[reason,command.id]);
          if(command.lease_until<=await this.store.coordinationNow(q))throw new Error('Teams command lease expired during discard');
        });return true;
      };
      if(!conversation&&message.addressed===false)return discard('Conversation access was removed');
      if(!conversation)throw new Error('The bot is no longer installed in this conversation');
      const service=this.services.find(s=>s.key===message.serviceKey);
      if(message.addressed===false) {
        try {this.rollbacks.authorize(message.principal,service);}
        catch {return discard('Conversation authorization was revoked');}
      } else this.rollbacks.authorize(message.principal,service);
      const record=async(kind,target,text,fields={})=>{await this.store.authorizeIncidentConversation(message.conversationKey,target);return this.store.ingest({id:command.id+':'+kind,source:kind==='question'?'teams-question':'teams-context',serviceKey:message.serviceKey,incidentId:target,kind,at:message.at,conversationKey:message.conversationKey,payload:{text,userId:message.principal.userId,displayName:message.displayName||'Responder',conversationId:message.principal.conversationId,authority:kind==='question'?'operator_request':'responder_report',addressed:message.addressed!==false,...(message.unreadAttachments?{unreadAttachments:message.unreadAttachments}:{}),...fields}});};
      if(message.addressed===false) {
        // Observed conversation is evidence, never an approval or an instruction.
        if(service.teams.captureResponderUpdates&&message.incidentId&&conversation.incident_id===message.incidentId) {
          incidentId=message.incidentId;
          try {await this.store.authorizeIncidentConversation(message.conversationKey,incidentId);}
          catch(error){if(error instanceof StorageError)throw error;return discard('Incident sharing access was revoked');}
          const context=await this.store.context(incidentId);
          if(context.incident.status!=='resolved')await record('responder_update',incidentId,text);
        }
      } else if(verb.toLowerCase()==='help') {
        response=help;
      } else if(verb.toLowerCase()==='name') {
        const name=text.slice(verb.length).trim();
        await this.store.setConversationName({id:message.conversationKey,tenant:message.principal.tenant,serviceKey:message.serviceKey,name});
        incidentId=conversation.incident_id||undefined;
        response='This conversation will appear as “'+name+'” in shared briefings. Its incident link and sharing access are unchanged.';
      } else if(verb.toLowerCase()==='leave') {
        if(!conversation.incident_id)response='This conversation is not following an incident.';
        else {
          await this.store.unbindConversation(message.conversationKey,conversation.incident_id);
          response='Stopped following '+conversation.incident_id+' in this conversation. Pending incident updates here were discarded; other linked groups keep their context. Use join <incident-id> to follow another incident.';
        }
      } else if(verb.toLowerCase()==='incidents') {
        const rows=await this.store.db.query("SELECT id,title,status FROM sre_incidents WHERE service_key=? ORDER BY updated_at DESC LIMIT 20",[message.serviceKey]);
        response=rows.map(x=>x.id+' ['+x.status+'] '+x.title).join('\n')||'No incidents in this service.';
      } else if(verb.toLowerCase()==='approve') {
        if(rest.length!==1)throw new Error('Use the exact approval command from the proposal');
        response=(await this.rollbacks.approve(id,rest[0],message.principal)).text;
      } else if(['join','investigate','rollback','retry'].includes(verb.toLowerCase())) {
        if(verb.toLowerCase()!=='join'&&conversation.incident_id&&conversation.incident_id!==id)throw new Error('Use a separate thread/chat for each incident; this conversation already follows '+conversation.incident_id);
        const context=await this.store.context(id);
        if(context.incident.service_key!==message.serviceKey)throw new Error('This incident is outside this Teams conversation scope');
        if(verb.toLowerCase()!=='join')await this.store.authorizeIncidentConversation(message.conversationKey,id);
        incidentId=id;
        if(verb.toLowerCase()==='join') {
          if(conversation.incident_id&&conversation.incident_id!==id)throw new Error('Use a separate thread/chat for each incident; this conversation already follows '+conversation.incident_id);
          await this.store.bindConversation(message.conversationKey,id);
          const scope=roomScope(service,message.principal.conversationId);
          response='This conversation is now linked to '+id+'. '+(scope.groupName?'Shared context: '+scope.groupName+'. Only conversations that join this incident receive its briefings. ':'Context stays in this configured conversation scope. ')+(service.teams.captureResponderUpdates?'I will retain new responder messages delivered here while the incident is active. Unmentioned messages require Teams RSC consent. ':'@mention me with update <text> to record responder progress. ')+'Use status for an investigation, signals for grouped logs and code history, sync for a shared briefing, ack <briefing-number> after reading it, or leave to stop following. Use a separate thread/chat and join <incident-id> for each incident. I have not fetched earlier chat history.';
          if(this.casework)response+='\n'+ticketIndexText(await this.casework.ticketIndex(id,{conversationKey:message.conversationKey}));
        }
        if(verb.toLowerCase()==='rollback')response=(await this.rollbacks.propose(id,message.principal,{requestId:command.id})).text;
        if(verb.toLowerCase()==='investigate') {
          if(conversation.incident_id!==id)throw new Error('Join this incident before asking for an investigation in this conversation');
          await record('question',id,rest.join(' ')||'Investigate this incident');
          response='Investigation queued for '+id+'. I will post the result here.';
        }
        if(verb.toLowerCase()==='retry') {
          if(conversation.incident_id!==id)throw new Error('Join this incident before retrying its investigation');
          const result=await this.store.retryInvestigation({serviceKey:message.serviceKey,incidentId:id,jobId:rest[0],reason:rest.slice(1).join(' '),requestId:command.id,actor:{kind:'teams',id:message.principal.userId,tenant:message.principal.tenant,conversationId:message.principal.conversationId},conversationKey:message.conversationKey});
          response='Fresh investigation queued for '+id+' as '+result.replacementJobId+'. The failed attempt and your reason remain in the audit. No deployment or delivery is retried.';
        }
      } else if(message.incidentId||(!Object.hasOwn(message,'incidentId')&&conversation.incident_id)) {
        incidentId=message.incidentId||conversation.incident_id;
        if(conversation.incident_id!==incidentId)throw new Error('This conversation no longer follows that incident; join it again before sending a new request');
        await this.store.authorizeIncidentConversation(message.conversationKey,incidentId);
        if(verb.toLowerCase()==='brief') {
          if(id)throw Error('Use brief alone in the joined incident conversation');
          const context=await this.store.context(incidentId);responseContacts=this.casework?await this.casework.contacts(incidentId,context):undefined;responseContactFormat='brief';response=assessmentBrief(context,context.incident.analysis,{contacts:responseContacts});
        } else if(verb.toLowerCase()==='signals') {
          const context=await this.store.context(incidentId);
          response=signalDigestText(context.signalDigest);
        } else if(['contacts','changes','track-change','untrack-change','retrack-change','plan','ticket','tickets','fix','approve-fix','yes'].includes(verb.toLowerCase())&&this.casework) {
          const action=verb.toLowerCase();
          if(action==='contacts'){responseContacts=await this.casework.contacts(incidentId);response=contactsText(responseContacts);}
          if(action==='tickets'){if(id)throw Error('Use tickets alone in the joined incident conversation');response=ticketIndexText(await this.casework.ticketIndex(incidentId,{conversationKey:message.conversationKey}));}
          if(action==='changes'){const view=await this.casework.timeline(incidentId);response='Tracked change history for '+incidentId+'\n'+view.links.slice(0,12).map(l=>'Linked '+l.provider+' #'+l.change_number+(l.association?' by '+(l.association.label||l.association.id):' through provider/reader evidence')+(l.historicalAfterRestore?' · historical after restore; fresh reaffirmation needed':'')+' · link reference '+l.evidence_id+'.').join('\n')+'\n'+view.withdrawals.slice(0,4).map(c=>'Withdrawn '+c.provider+' #'+c.number+' by '+c.actor.label+': '+c.reason.slice(0,240)+' · reconsider reference '+c.evidenceId+'.').join('\n')+'\n'+changeTimelineText(view,{limit:8})+'\n'+view.interpretation+(view.limited?'\nHistory window is limited.':'');}
          if(action==='track-change'){if(rest.length!==1)throw Error('Use track-change <github|gitlab> <change number>');const linked=await this.casework.trackChange(incidentId,id,rest[0],{kind:'teams',principal:message.principal,displayName:message.displayName,conversationKey:message.conversationKey});response=(linked.duplicate?'Already tracking ':'Tracking ')+linked.provider+' #'+linked.number+' for '+incidentId+' at observed head '+linked.headSha+'. Future observed updates follow this incident. This association is context, not cause, QA approval or verified recovery.';}
          if(['untrack-change','retrack-change'].includes(action)){
            if(rest.length<3)throw Error('Use '+action+' <github|gitlab> <number> <reviewed reference> <reason>');
            const actor={kind:'teams',principal:message.principal,displayName:message.displayName,conversationKey:message.conversationKey},reason=rest.slice(2).join(' '),result=action==='untrack-change'?await this.casework.withdrawChange(incidentId,id,rest[0],actor,{expectedEvidenceId:rest[1],reason}):await this.casework.trackChange(incidentId,id,rest[0],actor,{reconsiderEvidenceId:rest[1],reason});
            response=(result.duplicate?'Already recorded: ':'Recorded: ')+result.provider+' #'+result.number+' association '+result.status+' for '+incidentId+'. Reference '+result.evidenceId+'. The audit and provider facts are retained. This does not delete a provider record, approve QA or establish recovery.';
          }
          if(['plan','ticket'].includes(action)){
            if(rest.length||(action==='plan'&&id))throw Error('Use plan alone to draft, or ticket <plan-id> to read a saved ticket');
            const plan=action==='ticket'&&id?await this.casework.getPlan(id,incidentId):await this.casework.createPlan(incidentId,{originConversationKey:message.conversationKey});
            const current=await this.store.context(incidentId),historical=Number(plan.payload.revision)!==Number(current.incident.revision)||current.assessmentStatus?.state!=='current'||current.recoveryFence?.active===true;
            response='Fix ticket '+plan.id+' · evidence snapshot revision '+plan.payload.revision+'. '+(historical?'Historical snapshot: the current evidence/review has changed. Draft a fresh ticket with plan before requesting QA.':'Saved proposal for human review; no action is approved.')+' Recheck contacts before using its ownership snapshot. Download full Markdown from the incident console.\n'+plan.markdown.slice(0,10000)+(plan.markdown.length>10000?'\n[Preview shortened; full Markdown retained.]':'');
          }
          if(action==='fix'){if(!id||rest.length)throw Error('Use fix <plan-id> after reviewing its Markdown ticket');response=(await this.casework.proposeFix(incidentId,id,message.principal,message.conversationKey,command.id)).text;}
          if(action==='approve-fix'){if(rest.length!==1)throw Error('Use the exact approve-fix command from the reviewed proposal');response=(await this.casework.approveFix(id,rest[0],message.principal,message.conversationKey,{command:{id:command.id,leaseUntil:command.lease_until}})).text;}
          if(action==='yes'){if(id)throw Error('Use yes alone only for one pending local QA request, or the exact approve-fix command');response=(await this.casework.approveFix(null,null,message.principal,message.conversationKey,{bareYes:true,command:{id:command.id,leaseUntil:command.lease_until}})).text;}
        } else if(verb.toLowerCase()==='sync') {
          const view=await this.coordination.snapshot(incidentId);
          if(view.rooms.length>1) {await this.coordination.publish(incidentId,{requestId:command.id});response='Shared coordination briefing queued for '+view.rooms.length+' linked conversations. '+view.nextStep;}
          else response=collaborationText(view)+'\nAsk the other team to add the bot and join '+incidentId+' in its configured collaboration conversation.';
        } else if(verb.toLowerCase()==='ack') {
          if(rest.length||!/^\d+$/.test(id||''))throw new Error('Use ack <briefing-number> after reading that shared briefing.');
          response=await this.coordination.acknowledge(incidentId,message.conversationKey,Number(id),{userId:message.principal.userId,displayName:message.displayName});
        } else if(['theory','work'].includes(verb.toLowerCase())) {
          const item=parseCoordinationItem(text);
          await record('responder_update',incidentId,item.text,{coordinationItem:item.coordinationItem});
          response='Recorded '+item.coordinationItem.kind+' '+item.coordinationItem.key+' as '+item.coordinationItem.state+' for this group, reported by '+message.displayName+'. It stays in shared briefings across routine chatter and restarts. '+(item.coordinationItem.kind==='work'?'Use the same key only for the same task and scope; agree one owner if work overlaps. ':'Different theories need a discriminating check using the same scope. ')+'This is a team report; it does not execute an action or verify recovery.';
        } else if(verb.toLowerCase()==='report') {
          if(!reportedStates.includes(id)||!rest.length)throw new Error('Use report <investigating|mitigating|monitoring|recovered|blocked> <owner, action and next check>. This records a report, not verified recovery.');
          await record('responder_update',incidentId,rest.join(' '),{reportedStatus:id});
          response='Recorded this team’s reported state as '+id+'. Linked groups will receive an attributed briefing. Recovery still requires independent verification.';
        } else if(['update','note'].includes(verb.toLowerCase())) {
          const note=[id,...rest].filter(Boolean).join(' ');
          if(!note)throw new Error('Use update <what you tried, observed, or plan to do>');
          await record('responder_update',incidentId,note);
          response='Recorded your update for '+incidentId+'. It will inform the investigation; recovery still requires telemetry verification.';
        } else {
          await record('question',incidentId,text.toLowerCase()==='status'?'Summarize the current incident, responder actions and reported results, conflicting evidence, and next checks.':text);
          response='Your request is queued for '+incidentId+'.';
        }
      } else response=help;
      responseIncidentId=conversation.incident_id===incidentId||verb.toLowerCase()==='join'?incidentId||null:null;
    } catch(error) {
      if(message.addressed===false||error instanceof StorageError)throw error; // Keep storage failures retryable through the durable command lease.
      response='Request could not be completed: '+error.message;
    }
    if(response&&message.unreadAttachments?.length)response+='\nAttachment contents were not read. Please describe the relevant drawing or file details in text; a link or filename is not evidence of its contents.';
    await this.store.db.transaction(async(q)=>{
      if((await this.store.restoreFence(q))?.active)return;
      const [current]=await q('SELECT status,lease_until FROM sre_commands WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[command.id]);
      if(current?.status!=='running'||Number(current.lease_until)!==command.lease_until)return;
      const now=await this.store.coordinationNow(q);
      if(command.lease_until<=now)throw new Error('Teams command lease expired');
      if(response)await this.store.queueMessage(responseIncidentId||null,response,message.conversationKey,'command:'+command.id,q,{contacts:responseContacts,contactFormat:responseContactFormat});
      await q("UPDATE sre_commands SET status='done' WHERE id=?",[command.id]);
      if(command.lease_until<=await this.store.coordinationNow(q))throw new Error('Teams command lease expired while saving its response');
    });
    return true;
  }
}

export {TeamsOutbox} from './teams-outbox.mjs';

export async function startSreTeams({router,store,mode,env=process.env,port=3978,host='127.0.0.1'}) {
  if(!['playground','live'].includes(mode))throw new Error('Select live or playground Teams mode');
  if(mode==='playground'&&(env.CLIENT_ID||env.CLIENT_SECRET||env.TENANT_ID||host!=='127.0.0.1'))throw new Error('Playground requires loopback and no live credentials');
  if(mode==='live')for(const name of ['CLIENT_ID','CLIENT_SECRET','TENANT_ID'])if(!env[name])throw new Error('Teams live mode requires '+name);
  const server=createServer(),sendContext=new AsyncLocalStorage();
  class Adapter extends ExpressAdapter {async start(listenPort){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port===0?0:listenPort,host,resolve);});}}
  class SreApp extends App {sendReference(reference,text,{signal}={}){const {sreTeamId,sreRoomName,...nativeReference}=reference;return sendContext.run(signal,()=>this.activitySender.send(teamsMessage(text),nativeReference));}}
  const app=new SreApp({clientId:env.CLIENT_ID,clientSecret:env.CLIENT_SECRET,tenantId:env.TENANT_ID,dangerouslyAllowUnauthenticatedRequests:mode==='playground',httpServerAdapter:new Adapter(server),client:{timeout:teamsDeliveryDefaults.timeoutMs,middlewares:[{invoke(context,next){const signal=sendContext.getStore();if(signal){signal.throwIfAborted();context.config.signal=signal;}return next();}}]},telemetry:{agent365:false}});
  app.on('message',async({activity,ref,api})=>{await router.accept(activity,ref,{getMember:()=>api.conversations.getMemberById(rootConversation(activity.conversation.id),activity.from.id)});});
  app.on('install.add',async({activity,ref})=>{await router.installation(activity,ref,true);});
  app.on('install.remove',async({activity,ref})=>{await router.installation(activity,ref,false);});
  await app.start(port);if(!server.listening)throw new Error('Teams listener failed to start');
  return {server,app,sender:{send:(ref,text,options)=>app.sendReference(ref,text,options)},close:()=>app.stop()};
}
