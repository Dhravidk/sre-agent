import {hash,assertText} from './security.mjs';
import {rootConversation} from './collaboration.mjs';
import {rememberAlertReply} from './alert-replies.mjs';

// The vendor workflow mirrors a structured alert to this signed ingress. We do
// not trust another bot's display name, parse free-form commands, or fetch a
// service URL supplied by the alert. Replies use an installed stored reference.
export function normalizeAlert(payload,service,deliveryId) {
  if(!service.alerts?.providers?.includes(payload.provider))throw Error('Alert provider is not configured');
  for(const key of ['alertId','groupKey','title'])assertText(payload[key],'alert '+key,key==='title'?300:150);
  if(!/^[A-Za-z0-9_.:/-]+$/.test(payload.alertId)||!/^[A-Za-z0-9_.:/-]+$/.test(payload.groupKey))throw Error('Alert identity must be stable and URL-safe');
  if(payload.service!==service.key||payload.environment!==service.environment)throw Error('Alert is outside the configured service/environment');
  if(!['OPEN','CLOSED'].includes(payload.status)||!Number.isSafeInteger(payload.observedAt)||payload.observedAt<0||!Number.isSafeInteger(payload.startedAt)||payload.startedAt<0||payload.startedAt>payload.observedAt)throw Error('Invalid alert lifecycle or timestamps');
  if(payload.thread&&(!service.teams.conversations.includes(payload.thread.channelId)||!/^\d{10,20}$/.test(payload.thread.messageId||'')||payload.thread.tenantId!==service.teams.tenantId))throw Error('Alert thread is outside the explicit channel/tenant mapping');
  return {id:deliveryId,source:'alerts',serviceKey:service.key,kind:'problem',issueKey:'workflow:'+payload.provider+':'+payload.groupKey,status:payload.status,at:payload.observedAt,startedAt:payload.startedAt,title:payload.title,payload:{provider:payload.provider,alertId:payload.alertId,groupKey:payload.groupKey,title:payload.title,metrics:payload.metrics||{},synthetic:payload.synthetic===true},...(payload.thread?{alertThread:payload.thread}:{})};
}

export async function bindAlertThread(store,q,event,eventId,incidentId,now) {
  if(!event.alertThread)return;
  if(event.source!=='alerts')throw Error('Thread binding is restricted to signed workflow alert ingress');
  const service=store.services.find(s=>s.key===event.serviceKey),thread=event.alertThread;
  if(!service||thread.tenantId!==service.teams.tenantId||!service.teams.conversations.includes(thread.channelId)||!/^\d{10,20}$/.test(thread.messageId||''))throw Error('Alert thread mapping is invalid');
  const candidates=await q('SELECT * FROM sre_conversations WHERE service_key=? AND tenant_id=? AND enabled=1 ORDER BY id',[service.key,thread.tenantId]);
  const prior=candidates.find(r=>{
    if(rootConversation(r.conversation_id)!==thread.channelId)return false;
    const saved=JSON.parse(r.reference);
    return saved.conversation?.conversationType==='channel'&&rootConversation(saved.conversation.id)===thread.channelId;
  });
  if(!prior)throw Error('An installed channel reference is required before forwarding an alert');
  const reference=JSON.parse(prior.reference),installationKeys=[thread.channelId,...(reference.sreTeamId?['team:'+reference.sreTeamId]:[])].map(id=>'teams-installation:'+hash([thread.tenantId,id]).slice(0,32));
  for(const key of installationKeys){const [installation]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[key]);if(installation&&JSON.parse(installation.value).enabled===false)throw Error('Alert channel bot installation was removed');}
  const conversationId=thread.channelId+';messageid='+thread.messageId,key=hash([thread.tenantId,conversationId]).slice(0,32);
  const [existing]=await q('SELECT incident_id,enabled FROM sre_conversations WHERE id=?',[key]);
  if(existing&&(Number(existing.enabled)!==1||existing.incident_id&&existing.incident_id!==incidentId))throw Error('Alert thread already belongs to another incident or was removed');
  await store.rememberConversation({tenant:thread.tenantId,serviceKey:service.key,reference:{...reference,activityId:thread.messageId,conversation:{...reference.conversation,id:conversationId,conversationType:'channel'}}},q);
  await store.bindConversation(key,incidentId,q);
  await q('INSERT INTO sre_alert_threads(event_id,incident_id,conversation_key,provider,alert_id,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',[eventId,incidentId,key,event.payload.provider,event.payload.alertId,now]);
  if(existing?.incident_id!==incidentId)await rememberAlertReply(q,{incidentId,conversationKey:key,eventId,now});
  return {conversationKey:key,joined:existing?.incident_id!==incidentId};
}
