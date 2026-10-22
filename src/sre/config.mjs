import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { assertText } from './security.mjs';
import { validateMonitor } from './monitors.mjs';
import {validateLogMonitor} from './log-detection.mjs';
import { operationalLimits } from './operations.mjs';
import { validateRetryScope } from './provider-retry.mjs';
import { claudeOptions } from './claude-config.mjs';
import {logInvestigationOptions} from './dynatrace-log-investigation.mjs';
import { validateServiceNowMcp } from './servicenow-mcp.mjs';
import { isSimulationMode } from './runtime-mode.mjs';
import { validateCollaboration } from './collaboration.mjs';
import { validateTeamsAdmission,tenantAdmission } from './teams-access.mjs';
import {investigatorLimit} from './investigation-scheduler.mjs';

export function loadConfig(env=process.env) {
  const path=env.SRE_CONFIG||'config/sre.local.json';
  const config=JSON.parse(readFileSync(path,'utf8'));
  return validateConfig(config,env);
}

export function validateConfig(config,env=process.env) {
  return normalizeConfig(config,env,true);
}

// Database administration validates the same mappings and structural rules.
// It starts no HTTP/model/Teams service and needs none of their credentials.
export function loadAdministrationConfig(env=process.env) {
  const config=JSON.parse(readFileSync(env.SRE_CONFIG||'config/sre.local.json','utf8'));
  return normalizeConfig(config,env,false);
}

function normalizeConfig(config,env,requireRuntimeCredentials) {
  const instanceId=env.SRE_INSTANCE_ID??config.instanceId??hostname();
  if(typeof instanceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(instanceId))throw new Error('SRE_INSTANCE_ID/instanceId must be a 1–128 character instance label using letters, digits, dot, underscore, colon or hyphen');
  if(!['local','trial','connected'].includes(config.mode))throw new Error('Choose local, trial or connected mode');
  if(!Array.isArray(config.services)||!config.services.length)throw new Error('At least one service is required');
  const keys=new Set();
  operationalLimits(config);
  if(config.agentDevelopment!==undefined&&typeof config.agentDevelopment!=='boolean')throw Error('agentDevelopment must be a boolean');
  if(config.pollConcurrency!==undefined&&(!Number.isInteger(config.pollConcurrency)||config.pollConcurrency<1||config.pollConcurrency>8))throw new Error('pollConcurrency must be between 1 and 8');
  if(config.activeReconcileIntervalMs!==undefined&&(!Number.isFinite(config.activeReconcileIntervalMs)||config.activeReconcileIntervalMs<10000||config.activeReconcileIntervalMs>86400000))throw new Error('activeReconcileIntervalMs must be between 10 seconds and one day');
  for(const service of config.services) {
    for(const key of ['key','name','tenant','environment'])assertText(service[key],key);
    if(!/^[a-z0-9][a-z0-9_-]+$/.test(service.key)||keys.has(service.key))throw new Error('Service keys must be unique URL-safe names');
    keys.add(service.key);
    for(const source of ['github','gitlab','jira','servicenow','dynatrace','dynatraceLogs','rollback']) {
      validateRetryScope(service[source]?.retryScope,source+'.retryScope');
      validateRetryScope(service[source]?.oauth?.retryScope,source+'.oauth.retryScope');
    }
    for(const source of ['github','gitlab','jira','servicenow','dynatrace','dynatraceLogs','releases','logs','verification','rollback'])if(service[source]?.enabled!==undefined&&typeof service[source].enabled!=='boolean')throw new Error(source+'.enabled must be a boolean');
    for(const source of ['dynatrace','dynatraceLogs'])if(service[source]?.logInvestigation!==undefined)logInvestigationOptions(service[source]);
    if(service.servicenow?.closedStates!==undefined&&(!Array.isArray(service.servicenow.closedStates)||!service.servicenow.closedStates.length||service.servicenow.closedStates.some(value=>!/^[A-Za-z0-9_-]{1,64}$/.test(String(value)))))throw new Error('ServiceNow closedStates must be a nonempty list of state values');
    if(service.servicenow?.correlateLogMonitors!==undefined&&typeof service.servicenow.correlateLogMonitors!=='boolean')throw new Error('ServiceNow correlateLogMonitors must be a boolean');
    if(service.servicenow)validateServiceNowMcp(service.servicenow);
    service.teams={...service.teams,tenantId:service.teams?.tenantId||env.TENANT_ID,conversations:service.teams?.conversations||[],approvers:service.teams?.approvers||[]};
    validateTeamsAdmission(service.teams);
    validateCollaboration(service.teams);
    if(service.alerts){
      if(typeof service.alerts.enabled!=='boolean'||!Array.isArray(service.alerts.providers)||!service.alerts.providers.length||service.alerts.providers.some(p=>!['datadog','dynatrace'].includes(p)))throw new Error('Configure explicit workflow alert providers');
      if(service.alerts.enabled&&!service.alerts.webhookSecretEnv)throw new Error('Workflow alerts require a separate signing secret');
      if(isSimulationMode(config.mode)&&service.alerts.enabled)throw new Error('Live alert workflow ingress requires connected mode');
    }
    if(service.teams.operationsConversationId&&!service.teams.conversations.includes(service.teams.operationsConversationId))throw new Error('teams.operationsConversationId must be allowlisted');
    if(service.teams.captureResponderUpdates!==undefined&&typeof service.teams.captureResponderUpdates!=='boolean')throw new Error('teams.captureResponderUpdates must be a boolean');
    if(service.verification?.maxAgeSeconds!==undefined&&(!Number.isFinite(service.verification.maxAgeSeconds)||service.verification.maxAgeSeconds<1||service.verification.maxAgeSeconds>3600))throw new Error('verification.maxAgeSeconds must be between 1 and 3600');
    const monitorIds=new Set();
    if(service.logMonitors!==undefined&&(!Array.isArray(service.logMonitors)||service.logMonitors.length>20))throw Error('Configure up to 20 log monitors per service');
    const logIds=new Set();for(const rule of service.logMonitors||[]){validateLogMonitor(rule);if(logIds.has(rule.id))throw Error('Log monitor IDs must be unique');logIds.add(rule.id);}
    if(service.monitors!==undefined&&!Array.isArray(service.monitors))throw new Error('monitors must be an array');
    for(const monitor of service.monitors||[]) {validateMonitor(monitor);if(monitorIds.has(monitor.id))throw new Error('Metric monitor ids must be unique per service');monitorIds.add(monitor.id);}
    if(config.mode==='local'&&['github','gitlab','jira','servicenow','dynatrace','dynatraceLogs'].some(key=>service[key]?.enabled))throw new Error('Local mode is offline. Use connected mode for vendor API calls.');
    if(config.mode==='trial'&&(['github','gitlab','jira','servicenow','dynatrace','dynatraceLogs','releases','logs','verification'].some(key=>service[key]?.enabled||service[key]?.webhookSecretEnv)||service.monitors?.length))throw new Error('Trial mode accepts mock evidence only; live readers, webhooks and metric monitors require connected mode');
    if(service.rollback?.enabled) {
      if(!['github','gitlab'].includes(service.rollback.provider))throw new Error('Invalid rollback provider');
      if(config.mode==='connected') {
        if(!service[service.rollback.provider]?.enabled)throw new Error('Rollback needs an enabled repository connector');
        if(!service.rollback.tokenEnv||!service.rollback.ref||service.rollback.tokenEnv===service[service.rollback.provider].tokenEnv)throw new Error('Rollback requires a separate write token and configured protected ref');
        if(service.rollback.oauth) {
          const reader=service[service.rollback.provider].oauth,writer=service.rollback.oauth;
          if(!writer.clientIdEnv||!writer.clientSecretEnv||[reader?.clientIdEnv,reader?.clientSecretEnv].filter(Boolean).some(name=>[writer.clientIdEnv,writer.clientSecretEnv].includes(name)))throw new Error('Rollback OAuth requires separate write credential environment names');
        }
        if(service.rollback.provider==='github'&&!service.rollback.workflow)throw new Error('Configure a GitHub rollback workflow');
      }
    }
  }
  for(const service of config.services)if(tenantAdmission(service.teams)&&config.services.some(other=>other!==service&&other.teams.tenantId===service.teams.tenantId))throw Error('Tenant-wide Teams admission must map to exactly one service per tenant');
  const agentMode=env.SRE_AGENT_MODE||config.agentMode||(config.mode==='local'?'rules':'claude');
  const investigationConcurrency=investigatorLimit(config.investigationConcurrency??1);
  if(investigationConcurrency>1&&agentMode!=='claude')throw Error('Concurrent investigation requires the host-owned Claude mode');
  if(!['rules','claude','eve'].includes(agentMode))throw new Error('Invalid agent mode');
  if(agentMode==='claude')claudeOptions(config,env);
  if(requireRuntimeCredentials&&config.mode==='connected'&&!env.SRE_API_TOKEN)throw new Error('Connected mode requires SRE_API_TOKEN');
  if(requireRuntimeCredentials&&config.mode==='connected'&&(!env.SRE_CAPABILITY_SECRET||env.SRE_CAPABILITY_SECRET.length<32))throw new Error('Connected mode requires a stable SRE_CAPABILITY_SECRET of at least 32 characters');
  if(config.mode==='local'&&env.SRE_HOST&&env.SRE_HOST!=='127.0.0.1')throw new Error('Offline development mode must bind to loopback');
  if(config.mode==='trial'&&env.SRE_HOST&&env.SRE_HOST!=='127.0.0.1')throw new Error('Trial mode must bind to loopback');
  if(config.mode==='trial'&&env.DATABASE_URL)throw new Error('Trial mode requires a local SQLite database');
  if(!['off','playground','live'].includes(env.SRE_TEAMS_MODE||'off'))throw new Error('Invalid Teams mode');
  if(config.mode==='connected'&&env.SRE_TEAMS_MODE==='playground')throw new Error('Connected mode cannot trust Playground identities');
  if(isSimulationMode(config.mode)&&env.SRE_TEAMS_MODE==='live')throw new Error('Live Teams requires connected mode');
  if(config.mode==='local'&&agentMode!=='rules')throw new Error('Local mode is offline; select trial mode for Claude with mock connectors or connected mode for live access');
  if(config.mode==='trial'&&agentMode!=='claude')throw new Error('Trial mode uses Claude; choose local mode for offline rules');
  if(requireRuntimeCredentials&&agentMode==='eve'&&(!env.EVE_URL||!env.EVE_TOKEN))throw new Error('Eve mode requires EVE_URL and EVE_TOKEN');
  return {...config,instanceId,agentMode,investigationConcurrency,port:Number(env.SRE_PORT||3001),host:env.SRE_HOST||'127.0.0.1',databaseUrl:env.DATABASE_URL,sqlitePath:env.SRE_SQLITE_PATH||'.local/sre.sqlite',apiToken:env.SRE_API_TOKEN,capabilitySecret:env.SRE_CAPABILITY_SECRET,teamsMode:env.SRE_TEAMS_MODE||'off',env};
}
