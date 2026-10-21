import { setTimeout as delay } from 'node:timers/promises';
import { safeUrl } from './security.mjs';
import { RequestNotSubmittedError } from './submission.mjs';
import { selectTokenMode } from './credentials.mjs';

export class ConnectorError extends Error {
  constructor(message, {status, retryAfterMs, uncertain=false,providerStatus} = {}) { super(message); Object.assign(this,{status,retryAfterMs,uncertain});if(providerStatus!==undefined)this.providerStatus=providerStatus; }
}

function retryErrorDetails(hold,now) {
  const details={status:hold.status<400?429:hold.status,retryAfterMs:hold.until-now};
  if(hold.status<400)details.providerStatus=hold.status;
  return details;
}

const cancelled=()=>Object.assign(new Error('Connector request cancelled before submission'),{name:'AbortError',code:'ABORT_ERR'});
function withSignal(value,signal) {
  if(!signal)return Promise.resolve(value);
  return new Promise((resolve,reject)=>{
    let finished=false;
    const finish=(settle,result)=>{if(finished)return;finished=true;signal.removeEventListener('abort',abort);settle(result);};
    const abort=()=>finish(reject,cancelled());
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    // Always observe the underlying promise, including after detachment.
    Promise.resolve(value).then(result=>finish(resolve,result),error=>finish(reject,error));
  });
}

// HTTP dates start with a weekday. Date.parse also accepts malformed numeric
// delays (for example "-1") as unrelated calendar dates; reject those here.
const retryDate=value=>/^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:,|\s)/i.test(value)?Date.parse(value):NaN;
export function responseDelay(response,now,attempt) {
  if(!Number.isSafeInteger(now)||now<0)throw new Error('Provider retry clock is unavailable');
  const limited=[403,429].includes(response.status)||response.headers.get('x-ratelimit-remaining')?.trim()==='0',header=response.headers.get('retry-after');
  let wait=limited?60000:250*2**attempt;
  if(header!==null) {
    const value=header.trim(),parsed=/^\d+$/.test(value)?Number(value)*1000:retryDate(value)-now;
    wait=Number.isNaN(parsed)?60000:Math.max(0,parsed);
  }
  if(response.headers.get('x-ratelimit-remaining')==='0') {
    const reset=response.headers.get('x-ratelimit-reset');
    if(/^\d+$/.test(reset||''))wait=header===null?Math.max(0,Number(reset)*1000-now):Math.max(wait,Number(reset)*1000-now);
  }
  // An excessive provider delay fails closed instead of overflowing into a
  // negative deadline or retrying earlier than the advertised time.
  wait=Math.ceil(Math.min(Number.MAX_SAFE_INTEGER-now,wait));
  return {wait,persist:limited||header!==null};
}

function quotaObservation(response) {
  const status=response.status,header=response.headers.get('retry-after'),reset=response.headers.get('x-ratelimit-reset')?.trim(),observed=performance.now();
  let absolute=null,relative=null;
  const delay=ms=>{relative={until:Math.min(Number.MAX_SAFE_INTEGER,observed+ms),status};};
  if(header!==null) {
    const value=header.trim();
    if(/^\d+$/.test(value))delay(Number(value)*1000);
    else {const until=retryDate(value);if(Number.isNaN(until))delay(60000);else absolute={until:Math.max(0,until),status};}
  }
  if(/^\d+$/.test(reset||'')) {
    const until=Math.min(Number.MAX_SAFE_INTEGER,Number(reset)*1000);
    if(!absolute||until>absolute.until)absolute={until,status};
  } else if(header===null)delay(60000);
  return {absolute,relative};
}

async function readRetryGate(gate) {
  if(!gate)return null;
  try {
    const hold=await gate.read();
    if(hold===null)return null;
    if(!hold||!Number.isSafeInteger(hold.until)||hold.until<0||!Number.isInteger(hold.status)||hold.status<100||hold.status>599)throw new Error();
    return {until:hold.until,status:hold.status};
  } catch {throw new ConnectorError('Connector retry coordination is unavailable');}
}
async function deferRetryGate(gate,hold,uncertain=false) {
  if(!gate)return;
  try {await gate.defer(hold);}
  catch {throw new ConnectorError('Connector retry coordination is unavailable',{uncertain});}
}

function hasNextPage(headers,page,base) {
  const link=headers.get('link')||'',links=[];
  for(const entry of link.matchAll(/<([^>]+)>([^<>]*)/g)) {
    const rel=entry[2].match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/i);
    if((rel?.[1]||rel?.[2]||'').toLowerCase().split(/\s+/).includes('next'))links.push(entry[1]);
  }
  if(links.length>1||(!links.length&&/\brel\s*=\s*(?:"[^"]*\bnext\b|next(?:[,;\s]|$))/i.test(link)))throw new Error('Unsupported pagination continuation');
  if(links.length) {
    let next;
    try{next=new URL(links[0],base);}catch{throw new Error('Unsupported pagination continuation');}
    const pages=next.searchParams.getAll('page');
    const original=new URL(base);
    if(next.origin!==original.origin||next.username||next.password||next.hash||pages.length!==1||!/^\d+$/.test(pages[0])||Number(pages[0])!==page+1||['before','after','cursor','since'].some(key=>next.searchParams.get(key)!==original.searchParams.get(key)))throw new Error('Unsupported pagination continuation');
  }
  const advertised=headers.get('x-next-page')?.trim();
  if(advertised&&(!/^\d+$/.test(advertised)||Number(advertised)!==page+1))throw new Error('Unsupported pagination continuation');
  return links.length>0||Boolean(advertised);
}

const validToken=value=>typeof value==='string'&&value.length>0&&value.length<=16384&&/^[\x21-\x7e]+$/.test(value);
async function oauthJson(response) {
  const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(type!=='application/json'&&!/^application\/[a-z0-9.+-]+\+json$/.test(type))throw new Error('Unsupported OAuth response type');
  if(Number(response.headers.get('content-length')||0)>65536){await response.body?.cancel();throw new Error('OAuth response exceeds its byte budget');}
  const chunks=[];let bytes=0;
  for await(const chunk of response.body||[]){bytes+=chunk.byteLength;if(bytes>65536)throw new Error('OAuth response exceeds its byte budget');chunks.push(Buffer.from(chunk));}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}

export function tokenProvider(config, env = process.env, fetcher = fetch,{clock=Date.now,retryGate}={}) {
  let cached,flight,identity,generation=0;const cooldowns=new Map();
  function snapshot() {
    if(selectTokenMode(config,env)==='static-token'&&config.tokenEnv&&env[config.tokenEnv]) {
      const token=env[config.tokenEnv];if(!validToken(token))throw new Error('Connector token is invalid');
      return {key:JSON.stringify(['static',token]),token};
    }
    const oauth=config.oauth;
    if(!oauth)throw new Error('Connector token is not configured');
    const clientId=env[oauth.clientIdEnv],clientSecret=env[oauth.clientSecretEnv];
    if(typeof clientId!=='string'||!clientId||typeof clientSecret!=='string'||!clientSecret)throw new Error('OAuth credentials are not configured');
    const url=safeUrl(oauth.tokenUrl),scope=oauth.scope||'',resource=oauth.resource||'';
    if(typeof scope!=='string'||typeof resource!=='string')throw new Error('OAuth configuration is invalid');
    return {key:JSON.stringify([url,clientId,clientSecret,scope,resource]),quotaKey:JSON.stringify([url,clientId]),url,clientId,clientSecret,scope,resource};
  }
  function reset(key) {generation++;identity=key;cached=null;flight?.controller.abort();flight=null;}
  const now=async()=>{const value=await clock();if(!Number.isSafeInteger(value)||value<0)throw new Error('OAuth clock is unavailable');return value;};
  const current=entry=>{if(entry.controller.signal.aborted||generation!==entry.generation||snapshot().key!==entry.scope.key)throw new Error('OAuth configuration changed during token acquisition');};
  const subscribe=(entry,signal)=>{
    entry.waiters++;
    return withSignal(entry.promise,signal).finally(()=>{
      entry.waiters--;
      if(!entry.waiters&&!entry.settled){entry.controller.abort();if(flight===entry)flight=null;}
    });
  };
  const get=async({signal}={})=>{
    if(signal?.aborted)throw cancelled();
    let scope;
    try{scope=snapshot();}catch(error){reset(null);throw error;}
    if(scope.key!==identity)reset(scope.key);
    if(scope.token)return scope.token;
    if(flight)return subscribe(flight,signal);
    const entry={scope,generation,controller:new AbortController(),waiters:0,settled:false};
    entry.promise=(async()=>{
      try {
        const before=await now();current(entry);
        if(cached&&cached.until>before)return cached.token;
        for(const [key,value] of cooldowns)if(value.until<=before)cooldowns.delete(key);
        const shared=await readRetryGate(retryGate);current(entry);
        const local=cooldowns.get(scope.quotaKey),cooldown=shared&&(!local||shared.until>local.until)?shared:local;
        const checked=await now();current(entry);
        if(cooldown&&cooldown.until>checked)throw new ConnectorError('OAuth token endpoint retry delay active',retryErrorDetails(cooldown,checked));
        cached=null;
        const body=new URLSearchParams({grant_type:'client_credentials',client_id:scope.clientId,client_secret:scope.clientSecret});
        if(scope.scope)body.set('scope',scope.scope);if(scope.resource)body.set('resource',scope.resource);
        const began=performance.now();
        const response=await fetcher(scope.url,{method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body,redirect:'error',signal:AbortSignal.any([entry.controller.signal,AbortSignal.timeout(10000)])});
        if(!response.ok) {
          const observed=await now(),{wait,persist}=responseDelay(response,observed,0);
          const prior=cooldowns.get(scope.quotaKey);
          if(persist&&wait>0&&(!prior||prior.until<observed+wait))cooldowns.set(scope.quotaKey,{until:observed+wait,status:response.status});
          try {if(persist&&wait>0)await deferRetryGate(retryGate,{until:observed+wait,status:response.status});}
          finally {await response.body?.cancel();}
          throw new ConnectorError('OAuth token request failed',{status:response.status,retryAfterMs:persist?wait:undefined});
        }
        const data=await oauthJson(response);current(entry);
        if(!data||typeof data!=='object'||Array.isArray(data)||!validToken(data.access_token)||typeof data.token_type!=='string'||data.token_type.toLowerCase()!=='bearer')throw new Error('Invalid OAuth token response');
        if(data.expires_in!==undefined) {
          const seconds=typeof data.expires_in==='number'?data.expires_in:typeof data.expires_in==='string'&&/^\d+$/.test(data.expires_in)?Number(data.expires_in):NaN;
          if(!Number.isSafeInteger(seconds)||seconds<1)throw new Error('Invalid OAuth token lifetime');
          const duration=Math.min(86400,seconds)*1000,observed=await now();current(entry);
          const until=observed+duration-Math.ceil(performance.now()-began)-Math.min(60000,duration/10);
          if(until<=observed)throw new Error('OAuth token lifetime elapsed during acquisition');
          cached={token:data.access_token,until};
        }
        return data.access_token;
      } catch(error) {
        const status=Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?error.status:undefined;
        const retryAfterMs=Number.isSafeInteger(error?.retryAfterMs)&&error.retryAfterMs>=0?error.retryAfterMs:undefined;
        // Neither identity-provider response text nor transport exception text
        // is safe to put into operational evidence or a deployment error.
        throw new ConnectorError('OAuth token acquisition failed'+(status?' (HTTP '+status+')':''),{status,retryAfterMs});
      }
    })().finally(()=>{entry.settled=true;if(flight===entry)flight=null;});
    flight=entry;return subscribe(entry,signal);
  };
  get.invalidate=value=>{if(!value||cached?.token===value)cached=null;};
  return get;
}

export function tokenAuth(get,{header='authorization',prefix='Bearer '}={}) {
  const auth=async({signal}={})=>({[header]:prefix+await get({signal})});
  auth.invalidate=headers=>{const value=headers[header];if(typeof value==='string'&&value.startsWith(prefix))get.invalidate(value.slice(prefix.length));};
  return auth;
}

export class ApiClient {
  constructor({base,local=false,headers={},auth,fetcher=fetch,sleep=delay,maxBytes=2*1024*1024,clock=Date.now,retryGate,successQuotaReset='none'}) {
    if(!['none','epoch-seconds'].includes(successQuotaReset))throw new Error('Unsupported success-quota reset contract');
    this.base=safeUrl(base,local); Object.assign(this,{headers,auth,fetcher,sleep,maxBytes,clock,retryGate,successQuotaReset});
    this.cooldown=null;this.pendingQuota=null;
  }
  rememberQuota(response) {
    const observed=quotaObservation(response),previous=this.pendingQuota;
    // Two maximum windows keep concurrent/clock-deferred observations bounded.
    // Absolute provider reset time and monotonic relative delay stay separate.
    this.pendingQuota={
      absolute:!previous?.absolute||(observed.absolute&&observed.absolute.until>previous.absolute.until)?observed.absolute:previous.absolute,
      relative:!previous?.relative||(observed.relative&&observed.relative.until>previous.relative.until)?observed.relative:previous.relative,
    };
  }
  async flushQuota(uncertain=false) {
    const pending=this.pendingQuota;if(!pending)return;
    try {
      const now=await this.clock();if(!Number.isSafeInteger(now)||now<0)throw new Error();
      let hold=pending.absolute;
      if(pending.relative) {
        const remaining=Math.max(0,Math.ceil(pending.relative.until-performance.now()));
        const until=now+Math.min(Number.MAX_SAFE_INTEGER-now,remaining);
        if(!hold||until>hold.until)hold={until,status:pending.relative.status};
      }
      if(hold&&hold.until>now&&(!this.cooldown||hold.until>this.cooldown.until))this.cooldown=hold;
      if(this.cooldown?.until>now)await deferRetryGate(this.retryGate,this.cooldown,uncertain);
      if(this.pendingQuota===pending)this.pendingQuota=null;
    } catch {throw new ConnectorError('Connector quota observation could not be retained',{uncertain});}
  }
  async checkCooldown() {
    await this.flushQuota();
    const shared=await readRetryGate(this.retryGate);
    if(shared&&(!this.cooldown||shared.until>this.cooldown.until))this.cooldown=shared;
    if(!this.cooldown)return;
    let now;
    try {now=await this.clock();}catch {throw new ConnectorError('Connector retry clock is unavailable');}
    if(!Number.isSafeInteger(now)||now<0)throw new ConnectorError('Connector retry clock is unavailable');
    const remaining=this.cooldown.until-now;
    if(remaining>0)throw new ConnectorError('Connector provider retry delay active (observed HTTP '+this.cooldown.status+')',retryErrorDetails(this.cooldown,now));
  }
  async response(path,{method='GET',body,mutating=false,signal,beforeSend}={}) {
    let submitted=false,stage='request validation';
    try {
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
      signal?.throwIfAborted();
      stage='provider retry delay';await this.checkCooldown();
      signal?.throwIfAborted();
      stage='authentication';
      const headers={accept:'application/json',...this.headers,...(this.auth?await withSignal(this.auth({signal}),signal):{})};
      stage='request preparation';
      if (body !== undefined) headers['content-type']='application/json';
      const encoded=body===undefined?undefined:JSON.stringify(body);
      for(let attempt=0;attempt<(mutating?1:3);attempt++) {
        const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
        requestSignal.throwIfAborted();
        stage='provider retry delay';await this.checkCooldown();
        stage='final preflight';
        await beforeSend?.();
        requestSignal.throwIfAborted();
        let response;
        // From this point, neither an exception's class nor an absent receipt
        // proves that the remote deployment request was never accepted.
        submitted=true;
        try {
          response=await this.fetcher(this.base+path,{method,headers,body:encoded,redirect:'error',signal:requestSignal});
        } catch { throw new ConnectorError('Connector transport failed',{uncertain:mutating}); }
        if(response.status===401)this.auth?.invalidate?.(headers);
        if(this.successQuotaReset==='epoch-seconds'&&response.headers.get('x-ratelimit-remaining')?.trim()==='0') {
          this.rememberQuota(response);
          try {await this.flushQuota(mutating);}catch(error){await response.body?.cancel();throw error;}
        }
        if ([403,429].includes(response.status)||response.status>=500) {
          const now=await this.clock(),{wait,persist}=responseDelay(response,now,attempt);
          if(persist&&wait>0&&(!this.cooldown||this.cooldown.until<now+wait))this.cooldown={until:now+wait,status:response.status};
          try {if(persist&&wait>0)await deferRetryGate(this.retryGate,{until:now+wait,status:response.status},mutating);}
          finally {await response.body?.cancel();}
          if(!mutating&&response.status!==403&&attempt<2) {
            if(wait>3000)throw new ConnectorError('Connector provider retry delay exceeds this attempt budget',{status:response.status,retryAfterMs:wait});
            await this.sleep(wait,undefined,{signal});continue;
          }
          throw new ConnectorError('Connector returned HTTP '+response.status,{status:response.status,retryAfterMs:wait,uncertain:mutating});
        }
        if (!response.ok) { await response.body?.cancel(); throw new ConnectorError('Connector returned HTTP '+response.status,{status:response.status,uncertain:mutating}); }
        if (response.status===204) return {data:null,headers:response.headers,status:response.status};
        if (Number(response.headers.get('content-length')||0)>this.maxBytes) {await response.body?.cancel();throw new Error('Connector response is too large');}
        const chunks=[];let size=0;
        for await(const chunk of response.body || []) { size+=chunk.byteLength; if(size>this.maxBytes)throw new Error('Connector response is too large');chunks.push(Buffer.from(chunk)); }
        const raw=Buffer.concat(chunks).toString('utf8');
        return {data:raw?JSON.parse(raw):null,headers:response.headers,status:response.status};
      }
    } catch(error) {
      if(!mutating) {
        if(!submitted&&signal?.aborted)throw cancelled();
        if(!submitted&&stage==='authentication') {
          const status=Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?error.status:undefined;
          const retryAfterMs=Number.isSafeInteger(error?.retryAfterMs)&&error.retryAfterMs>=0?error.retryAfterMs:undefined;
          throw new ConnectorError('Connector authentication failed'+(status?' (HTTP '+status+')':''),{status,retryAfterMs});
        }
        if(submitted&&!(error instanceof ConnectorError))throw new ConnectorError('Connector response could not be read');
        throw error;
      }
      if(!submitted) {
        if(stage==='final preflight'&&error instanceof RequestNotSubmittedError)throw error;
        // Authentication may contain provider-controlled text or credentials.
        throw new RequestNotSubmittedError('Connector request was not submitted; '+stage+' failed');
      }
      if(error instanceof ConnectorError)throw error;
      throw new ConnectorError('Connector response failed after submission',{uncertain:true});
    }
  }
  async request(path,options) {return (await this.response(path,options)).data;}
  async pages(path,{maxPages=5,pageSize=100,field,signal}={}) {
    if(!Number.isInteger(maxPages)||maxPages<1||maxPages>100||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new Error('Invalid pagination budget');
    const items=[];
    for(let page=1;page<=maxPages;page++) {
      const result=await this.response(path+(path.includes('?')?'&':'?')+'per_page='+pageSize+'&page='+page,{signal}),data=result.data;
      const rows=field?data[field]:data;
      if(!Array.isArray(rows))throw new Error('Unexpected paginated connector response');
      items.push(...rows);
      // Keep the original configured route/filter. Provider links may use a
      // canonical repository-ID alias; they never become credentialed URLs.
      const next=hasNextPage(result.headers,page,this.base+path);
      if(!next&&rows.length<pageSize)return {items,complete:true};
    }
    return {items,complete:false};
  }
}
