import { assertText,hash,safeUrl } from './security.mjs';

export function validateRetryScope(value,name='retryScope') {
  if(value!==undefined&&(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)))throw new Error(name+' must be a 1–128 character account label using letters, digits, dot, underscore, colon or hyphen');
}

export const retryConnectors=['github','gitlab','jira','servicenow','dynatrace','dynatraceLogs','rollback'];
export function configuredRetryDescriptor(service,connector,kind='api',{allowDisabled=false}={}) {
  if(!retryConnectors.includes(connector)||!['api','oauth'].includes(kind))throw new Error('Unknown configured retry source');
  let config=service[connector],provider=connector==='dynatraceLogs'?'dynatrace':connector;
  if(!config||(!config.enabled&&!allowDisabled))throw new Error('Retry source must be configured and enabled');
  if(connector==='rollback') {
    const writer=config;provider=writer.provider;
    if(!['github','gitlab'].includes(provider)||!service[provider]||(!service[provider].enabled&&!allowDisabled))throw new Error('Rollback retry source requires its configured repository reader');
    config={...service[provider],...writer,oauth:writer.oauth,retryScope:writer.retryScope};
  }
  if(kind==='oauth')return {tenant:service.tenant,provider:'oauth',endpoint:config.oauth?.tokenUrl,scope:config.oauth?.retryScope};
  return {tenant:service.tenant,provider,endpoint:config.transport==='mcp'?config.mcp?.endpoint:config.base||(provider==='github'?'https://api.github.com':undefined),scope:config.retryScope};
}

export function configuredRetryScopes(store,services,{includeDisabled=false}={}) {
  const scopes=[];
  for(const service of services)for(const connector of retryConnectors) {
    const config=service[connector];if(!config||(!config.enabled&&!includeDisabled))continue;
    for(const kind of ['api','oauth']) {
      if((kind==='api'?config.retryScope:config.oauth?.retryScope)===undefined)continue;
      const gate=providerRetryGate(store,configuredRetryDescriptor(service,connector,kind,{allowDisabled:includeDisabled}));
      scopes.push({serviceKey:service.key,connector,kind,scopeHash:gate.scopeHash,enabled:config.enabled===true});
    }
  }
  return scopes;
}

// Account sharing is explicit. Opaque credentials are neither inspected nor
// persisted to guess which independently configured clients share a quota.
export function providerRetryGate(store,{tenant,provider,endpoint,scope}) {
  if(scope===undefined)return undefined;
  validateRetryScope(scope);assertText(tenant,'retry tenant');
  if(!['github','gitlab','jira','servicenow','dynatrace','oauth'].includes(provider))throw new Error('Invalid retry provider');
  let canonical;try{canonical=safeUrl(endpoint);}catch{throw new Error('Configured retry endpoint is invalid');}
  const scopeHash=hash(['provider-retry:v1',tenant,provider,canonical,scope]);
  return {scopeHash,read:()=>store.providerRetry(scopeHash),defer:({until,status})=>store.deferProviderRetry(scopeHash,until,status)};
}
