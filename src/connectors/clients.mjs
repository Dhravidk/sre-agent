import { setTimeout as delay } from 'node:timers/promises';

function validateBase(base, local) {
  const url=new URL(base);
  if(url.username || url.password || url.search || url.hash) throw new Error('Invalid connector URL');
  if(url.protocol!=='https:' && !(local && url.protocol==='http:' && ['127.0.0.1','localhost'].includes(url.hostname))) throw new Error('Connector requires HTTPS');
  return base.replace(/\/$/,'');
}
export class ReadClient {
  constructor({base,headers={},local=false,fetcher=fetch,sleep=delay}) { this.base=validateBase(base,local);this.headers=headers;this.fetcher=fetcher;this.sleep=sleep; }
  async request(path,{method='GET',body}={}) {
    if(!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid connector path');
    for(let attempt=0;attempt<3;attempt++) {
      const response=await this.fetcher(this.base+path,{method,headers:{...this.headers,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000),redirect:'error'});
      if((response.status===429 || response.status>=500) && attempt<2) { await this.sleep(Math.min(2000,Number(response.headers.get('retry-after')||0)*1000 || 200*2**attempt));continue; }
      if(!response.ok) throw new Error('Connector returned HTTP '+response.status);
      return response.json();
    }
  }
}
export class GitLabReader extends ReadClient {
  constructor(options) { super({...options,headers:{'PRIVATE-TOKEN':options.token}});this.project=String(options.project); }
  async mergeRequest(iid) {
    if(!/^\d+$/.test(String(iid))) throw new Error('Invalid merge request IID');
    const path='/api/v4/projects/'+encodeURIComponent(this.project)+'/merge_requests/'+iid;
    const [mergeRequest,diffs]=await Promise.all([this.request(path),this.request(path+'/diffs?per_page=100')]);
    return {mergeRequest,diffs,coverage:diffs.length>=100?'possibly truncated; pagination required':'first page'};
  }
  deployments() { return this.request('/api/v4/projects/'+encodeURIComponent(this.project)+'/deployments?status=success&order_by=updated_at&sort=desc&per_page=20'); }
}
export class JiraReader extends ReadClient {
  constructor(options) { super({...options,headers:{authorization:'Basic '+Buffer.from(options.email+':'+options.token).toString('base64')}});this.version=String(options.version||3);if(!['2','3'].includes(this.version))throw new Error('Invalid Jira API version'); }
  issue(key) { if(!/^[A-Z][A-Z0-9_]*-\d+$/.test(key))throw new Error('Invalid Jira issue key'); return this.request('/rest/api/'+this.version+'/issue/'+encodeURIComponent(key)+'?fields=summary,description,issuelinks,status'); }
}
export class DynatraceReader extends ReadClient {
  constructor(options) { super({...options,headers:{authorization:(options.mode==='grail'?'Bearer ':'Api-Token ')+options.token}});this.mode=options.mode||'classic'; }
  problem(id) {
    if(this.mode!=='classic') throw new Error('Use query() for Grail');
    return this.request('/api/v2/problems/'+encodeURIComponent(id));
  }
  async query(query) {
    if(this.mode!=='grail') throw new Error('Grail mode required');
    const path='/platform/storage/query/v1';
    let result=await this.request(path+'/query:execute',{method:'POST',body:{query,requestTimeoutMilliseconds:1000,maxResultRecords:50}});
    for(let i=0;result.state!=='SUCCEEDED' && result.requestToken && i<10;i++) {
      if(result.state==='FAILED' || result.state==='CANCELLED') throw new Error('DQL query failed');
      await this.sleep(250); result=await this.request(path+'/query:poll?request-token='+encodeURIComponent(result.requestToken));
    }
    if(result.state!=='SUCCEEDED') throw new Error('DQL query did not complete within the local check budget');
    return result;
  }
}
