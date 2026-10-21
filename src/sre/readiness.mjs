// Offline configuration inventory. Presence is not proof of vendor access.
import { selectTokenMode } from './credentials.mjs';
import { safeUrl } from './security.mjs';
import { validateConfig } from './config.mjs';
export function assessReadiness(config,env={}) {
  let runtimeConfigurationValid=true,runtimeError;
  const working=structuredClone(config);
  try{config=validateConfig(working,env);}catch(error){config=working;runtimeConfigurationValid=false;runtimeError=error.message;}
  const checks=[];
  const placeholder=value=>!value||/REPLACE|OWNER\/REPOSITORY|ENVIRONMENT|INSTANCE|\bSITE\b|example\.com|\.invalid|^0{32}$|^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(String(value));
  const unfinishedLabel=value=>typeof value!=='string'||!value.trim()||/^REPLACE(?:[-_ ]|$)/i.test(value);
  const secret=(name,missing)=>{if(!name||!env[name])missing.push(name||'configured credential environment variable');};
  const authentication=(c,source,missing,{basic=false}={})=>{
    const credentialMode=basic?'basic':selectTokenMode(c,env);
    if(credentialMode==='oauth') {
      secret(c.oauth.clientIdEnv,missing);secret(c.oauth.clientSecretEnv,missing);
      let validUrl=true;try{safeUrl(c.oauth.tokenUrl);}catch{validUrl=false;}
      if(placeholder(c.oauth.tokenUrl)||!validUrl)missing.push(source+'.oauth.tokenUrl');
      if(c.oauth.retryScope!==undefined&&unfinishedLabel(c.oauth.retryScope))missing.push(source+'.oauth.retryScope');
    } else {
      if(c.tokenEnv)secret(c.tokenEnv,missing);else missing.push(source+'.tokenEnv');
      if(basic){if(c.emailEnv)secret(c.emailEnv,missing);else missing.push(source+'.emailEnv');}
    }
    if(c.retryScope!==undefined&&unfinishedLabel(c.retryScope))missing.push(source+'.retryScope');
    return credentialMode;
  };
  for(const service of (Array.isArray(config.services)?config.services:[]).filter(item=>item&&typeof item==='object'&&!Array.isArray(item))) {
    for(const source of ['dynatrace','dynatraceLogs','servicenow','github','gitlab','jira']) {
      const c=service[source]||{},missing=[];
      const fields={dynatrace:['base','entityId'],dynatraceLogs:['base','logField','logValue'],servicenow:['base','cmdbCi'],github:['repository'],gitlab:['base','project'],jira:['base','projects']}[source];
      for(const field of fields)if(placeholder(Array.isArray(c[field])?c[field].join(','):c[field]))missing.push(source+'.'+field);
      if(source==='servicenow'&&c.transport==='mcp'&&placeholder(c.mcp?.endpoint))missing.push('servicenow.mcp.endpoint');
      if(source==='dynatrace'&&c.mode==='grail')for(const field of ['problemQuery','openProblemQuery'])if(placeholder(c[field]))missing.push(source+'.'+field);
      const credentialMode=authentication(c,source,missing,{basic:source==='jira'&&c.auth!=='bearer'});
      if(source!=='dynatraceLogs'&&!(source==='servicenow'&&c.transport==='mcp'))secret(c.webhookSecretEnv,missing);
      checks.push({service:service.key,source,enabled:c.enabled===true,credentialMode,...(source==='servicenow'?{transport:c.transport||'rest'}:{}),configurationReady:missing.length===0,missing,liveValidated:false});
    }
    const rollback=service.rollback||{},writeMissing=[];
    const writeMode=authentication(rollback,'rollback',writeMissing);
    if(!['github','gitlab'].includes(rollback.provider))writeMissing.push('rollback.provider');
    else if(service[rollback.provider]?.enabled!==true)writeMissing.push('rollback requires an enabled '+rollback.provider+' reader');
    if(unfinishedLabel(rollback.ref))writeMissing.push('rollback.ref');
    if(rollback.provider==='github'&&unfinishedLabel(rollback.workflow))writeMissing.push('rollback.workflow');
    checks.push({service:service.key,source:'rollback',enabled:rollback.enabled===true,credentialMode:writeMode,configurationReady:writeMissing.length===0,missing:writeMissing,liveValidated:false});
    const teams=service.teams||{},missing=[];
    for(const key of ['CLIENT_ID','CLIENT_SECRET','TENANT_ID'])secret(key,missing);
    if(placeholder(teams.tenantId)||teams.tenantId==='synthetic')missing.push('teams.tenantId');
    if(!teams.conversations?.length||teams.conversations.some(id=>placeholder(id)||id==='test-conversation'))missing.push('teams.conversations');
    if(!teams.approvers?.length||teams.approvers.some(id=>placeholder(id)||id==='local-operator'))missing.push('teams.approvers');
    if(env.TENANT_ID&&teams.tenantId!==env.TENANT_ID)missing.push('Teams tenant must match TENANT_ID');
    checks.push({service:service.key,source:'teams',enabled:env.SRE_TEAMS_MODE==='live',configurationReady:missing.length===0,missing,liveValidated:false});
    for(const source of ['releases','verification']) {
      const missing=[];secret(service[source]?.webhookSecretEnv,missing);
      checks.push({service:service.key,source,enabled:Boolean(service[source]?.webhookSecretEnv),configurationReady:missing.length===0,missing,liveValidated:false});
    }
  }
  const coreMissing=[];
  if(config.mode!=='connected')coreMissing.push('Choose a connected SRE_CONFIG for live testing');
  if(!env.SRE_API_TOKEN)coreMissing.push('SRE_API_TOKEN');
  if((env.SRE_CAPABILITY_SECRET||'').length<32)coreMissing.push('SRE_CAPABILITY_SECRET (32+ characters)');
  if(!runtimeConfigurationValid)coreMissing.push('Runtime configuration: '+runtimeError);
  const agentMode=env.SRE_AGENT_MODE||config.agentMode||(config.mode==='local'?'rules':'claude');
  const modelRuntime={mode:agentMode,...(agentMode==='claude'?{command:'claude -p',cliAvailability:'unverified',authentication:'unverified',requiresOpenAI:false}:{}),liveValidated:false};
  return {mode:config.mode,modelRuntime,networkCalls:0,liveValidated:false,core:{configurationReady:coreMissing.length===0,runtimeConfigurationValid,missing:coreMissing},checks,note:'This report validates local runtime configuration and inventories credential presence only. It does not run or authenticate Claude. Run the read-only live checks after configuring each dedicated test resource.'};
}
