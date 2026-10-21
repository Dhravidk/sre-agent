import { ApiClient, tokenProvider, tokenAuth } from './http-client.mjs';
import { assertText } from './security.mjs';
import { githubDeploymentStatus, gitlabDeploymentStatus } from './deployments.mjs';
import { approvalWindow } from './workflow-contract.mjs';
import { RequestNotSubmittedError } from './submission.mjs';
import { configuredRetryDescriptor } from './provider-retry.mjs';
import { ServiceNowMcpConnector } from './servicenow-mcp.mjs';
import {providerChangeSnapshot,providerPipelineObservation} from './change-read.mjs';
import {hash} from './security.mjs';

const enc=encodeURIComponent;
const iso=(time)=>new Date(time).toISOString();
const fullSha=(sha)=>{if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))throw new Error('Full commit SHA required');return sha;};
const repositoryPath=path=>{
  if(typeof path!=='string'||path.length>512||!path.split('/').every(part=>part&&part!=='.'&&part!=='..'&&/^[A-Za-z0-9_.-]+$/.test(part)))throw new Error('Invalid repository file path');
  return path;
};
function sourceFile(data,path,sha,provider) {
  if((provider==='github'&&(data.type!=='file'||data.path!==path))||(provider==='gitlab'&&(data.file_path!==path||data.commit_id!==sha))||data.encoding!=='base64'||typeof data.content!=='string'||!Number.isSafeInteger(data.size)||data.size>65536||data.size<0)throw new Error('Unsupported or out-of-scope repository source file');
  const encoded=data.content.replace(/[ \t\r\n]/g,'');
  if(data.content.length>100000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new Error('Invalid repository source encoding');
  const decoded=Buffer.from(encoded,'base64');
  if(decoded.toString('base64')!==encoded)throw new Error('Noncanonical repository source encoding');
  if(decoded.length!==data.size||decoded.length>65536)throw new Error('Repository source byte count does not match metadata');
  return {path,sha,content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(decoded),complete:true};
}
const expectedDeployment=proposal=>{
  const current=proposal?.current,id=current?.deploymentId??current?.id;
  if(!current||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(current.sha||'')||!/^(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(current.artifact||'')||!Number.isSafeInteger(current.at)||current.at<0||(id!==undefined&&id!==null&&!['string','number'].includes(typeof id)))throw new RequestNotSubmittedError('Rollback dispatch requires the exact current artifact and deployment timestamp/identity');
  return {sha:current.sha,artifact:current.artifact,id:id===undefined||id===null?'':String(id),at:String(current.at)};
};
async function dispatchApproval(approval,clock) {
  let now;
  try {now=await clock();}
  catch {throw new RequestNotSubmittedError('Rollback request was not submitted; approval clock is unavailable');}
  return approvalWindow(approval,now);
}

export class GithubConnector extends ApiClient {
  constructor(config,options={}) {
    const token=tokenProvider(config,options.env,options.fetcher,{clock:options.clock,retryGate:options.oauthRetryGate});
    super({...options,successQuotaReset:'epoch-seconds',base:config.base||'https://api.github.com',auth:tokenAuth(token),headers:{accept:'application/vnd.github+json','x-github-api-version':config.apiVersion||'2026-03-10'}});
    if(!/^[\w.-]+\/[\w.-]+$/.test(config.repository))throw new Error('GitHub owner/repository required');
    this.repo='/repos/'+config.repository;this.config=config;this.clock=options.clock||Date.now;
  }
  async pull(number,{signal,expectedSha}={}) {
    if(!/^\d+$/.test(String(number)))throw new Error('Invalid pull request number');
    const [pull,files]=await Promise.all([this.request(this.repo+'/pulls/'+number,{signal}),this.pages(this.repo+'/pulls/'+number+'/files',{signal})]);
    if(expectedSha&&pull.head.sha!==expectedSha)throw new Error('Pull request head changed since the review event; await the current SHA-bound review');
    const confirmed=await this.request(this.repo+'/pulls/'+number,{signal});
    if(confirmed.head.sha!==pull.head.sha)throw new Error('Pull request head changed while collecting its diff');
    if(confirmed.base?.sha!==pull.base?.sha)throw new Error('Pull request base changed while collecting its diff');
    const checks=await this.request(this.repo+'/commits/'+fullSha(pull.head.sha)+'/check-runs?per_page=100',{signal}).catch(error=>({unavailable:error.message}));
    const status=await this.request(this.repo+'/commits/'+fullSha(pull.head.sha)+'/status',{signal}).catch(error=>({unavailable:error.message}));
    return {pull,files:files.items,checks,status,complete:files.complete&&files.items.length===pull.changed_files&&files.items.every(x=>typeof x.patch==='string'),checksComplete:!checks.unavailable&&checks.total_count<=100&&!status.unavailable};
  }
  async change(number,{signal}={}) {
    const n=String(number);if(!/^[1-9]\d*$/.test(n)||!Number.isSafeInteger(Number(n)))throw Error('Invalid pull request number');
    const first=providerChangeSnapshot('github',await this.request(this.repo+'/pulls/'+n,{signal}),this.config,n);
    const snapshot=providerChangeSnapshot('github',await this.request(this.repo+'/pulls/'+n,{signal}),this.config,n);
    if(hash(first)!==hash(snapshot))throw Error('Pull request metadata changed while reading; await a stable current observation');
    return {snapshot,ci:providerPipelineObservation(snapshot)};
  }
  async compare(base,head,{signal}={}) {return this.request(this.repo+'/compare/'+fullSha(base)+'...'+fullSha(head),{signal});}
  async file(path,sha,{signal}={}) {repositoryPath(path);fullSha(sha);return sourceFile(await this.request(this.repo+'/contents/'+path.split('/').map(enc).join('/')+'?ref='+sha,{signal}),path,sha,'github');}
  async linkedChanges(sha,{signal}={}) {return this.pages(this.repo+'/commits/'+fullSha(sha)+'/pulls',{signal,maxPages:2});}
  async deployments(environment,{signal}={}) {
    const result=await this.pages(this.repo+'/deployments?environment='+enc(environment),{maxPages:2,pageSize:30,signal});
    const items=[];
    for(const deployment of result.items) {
      const statuses=await this.request(this.repo+'/deployments/'+deployment.id+'/statuses?per_page=20',{signal});
      if(!Array.isArray(statuses))throw new Error('Invalid deployment statuses');
      const status=statuses[0];
      const metadata=typeof deployment.payload==='object'?deployment.payload?.sre||{}:{};
      if((status?.environment||deployment.environment)!==environment)throw new Error('GitHub returned an out-of-scope deployment environment');
      items.push({...metadata,provider:'github',repository:this.config.repository,id:String(deployment.id),deploymentId:String(deployment.id),sha:fullSha(deployment.sha),environment:status?.environment||deployment.environment,status:githubDeploymentStatus(status?.state),providerStatus:status?.state||'missing',at:Date.parse(status?.created_at||deployment.created_at),url:status?.log_url});
      // Auto-inactivation retires the running deployment, not its immutable
      // artifact. Retain a bounded, actually observed prior success for targets.
      if(status?.state==='inactive') {
        const success=statuses.find(x=>x.state==='success'&&(x.environment||deployment.environment)===environment);
        if(success)items.push({...metadata,provider:'github',repository:this.config.repository,id:String(deployment.id),deploymentId:String(deployment.id),sha:deployment.sha,environment,status:'success',providerStatus:'success',at:Date.parse(success.created_at),url:success.log_url});
      }
    }
    return {items,complete:result.complete};
  }
  async dispatch(proposal,{signal}={}) {
    const c=this.config;
    if(!c.workflow || !c.ref)throw new RequestNotSubmittedError('GitHub rollback workflow/ref are not configured');
    const expected=expectedDeployment(proposal);
    const approval=await dispatchApproval(proposal.approval,this.clock);
    const result=await this.response(this.repo+'/actions/workflows/'+enc(c.workflow)+'/dispatches',{method:'POST',mutating:true,signal,beforeSend:()=>dispatchApproval(approval,this.clock),body:{ref:c.ref,inputs:{target_sha:proposal.target.sha,artifact_digest:proposal.target.artifact,environment:proposal.environment,request_id:proposal.id,expected_current_sha:expected.sha,expected_current_artifact:expected.artifact,expected_current_deployment_id:expected.id,expected_current_deployment_at:expected.at,approved_at:String(approval.approvedAt),approval_expires_at:String(approval.expiresAt)}}});
    return {provider:'github',status:'dispatched',requestId:proposal.id,workflowRunId:result.data?.workflow_run_id??null,runUrl:result.data?.run_url||null,url:result.data?.html_url||((c.base||'https://api.github.com')==='https://api.github.com'?'https://github.com/'+c.repository+'/actions':null),httpStatus:result.status};
  }
}

export class GitlabConnector extends ApiClient {
  constructor(config,options={}) {
    const token=tokenProvider(config,options.env,options.fetcher,{clock:options.clock,retryGate:options.oauthRetryGate});
    super({...options,base:config.base,auth:tokenAuth(token,{header:'private-token',prefix:''})});
    this.project='/api/v4/projects/'+enc(String(config.project));this.config=config;this.clock=options.clock||Date.now;
  }
  async mergeRequest(iid,{signal,expectedSha}={}) {
    if(!/^\d+$/.test(String(iid)))throw new Error('Invalid merge request IID');
    const [mergeRequest,diffs]=await Promise.all([this.request(this.project+'/merge_requests/'+iid,{signal}),this.pages(this.project+'/merge_requests/'+iid+'/diffs',{signal})]);
    const head=mergeRequest.diff_refs?.head_sha||mergeRequest.sha;
    if(expectedSha&&head!==expectedSha)throw new Error('Merge request head changed since the review event');
    const confirmed=await this.request(this.project+'/merge_requests/'+iid,{signal});
    if((confirmed.diff_refs?.head_sha||confirmed.sha)!==head)throw new Error('Merge request head changed while collecting its diff');
    if(confirmed.diff_refs?.base_sha!==mergeRequest.diff_refs?.base_sha||confirmed.diff_refs?.start_sha!==mergeRequest.diff_refs?.start_sha)throw new Error('Merge request base changed while collecting its diff');
    const count=String(mergeRequest.changes_count??'');
    return {mergeRequest,diffs:diffs.items,complete:diffs.complete&&/^\d+$/.test(count)&&Number.isSafeInteger(Number(count))&&Number(count)===diffs.items.length&&diffs.items.every(x=>!x.too_large&&!x.collapsed&&typeof x.diff==='string')};
  }
  async change(iid,{signal}={}) {
    const n=String(iid);if(!/^[1-9]\d*$/.test(n)||!Number.isSafeInteger(Number(n)))throw Error('Invalid merge request IID');
    const first=providerChangeSnapshot('gitlab',await this.request(this.project+'/merge_requests/'+n,{signal}),this.config,n);
    const raw=await this.request(this.project+'/merge_requests/'+n,{signal}),snapshot=providerChangeSnapshot('gitlab',raw,this.config,n);
    if(hash(first)!==hash(snapshot))throw Error('Merge request metadata changed while reading; await a stable current observation');
    return {snapshot,ci:providerPipelineObservation(snapshot,raw.head_pipeline)};
  }
  async compare(base,head,{signal}={}) {return this.request(this.project+'/repository/compare?from='+fullSha(base)+'&to='+fullSha(head)+'&straight=true',{signal});}
  async file(path,sha,{signal}={}) {repositoryPath(path);fullSha(sha);return sourceFile(await this.request(this.project+'/repository/files/'+enc(path)+'?ref='+sha,{signal}),path,sha,'gitlab');}
  async linkedChanges(sha,{signal}={}) {return this.pages(this.project+'/repository/commits/'+fullSha(sha)+'/merge_requests',{signal,maxPages:2});}
  async deployments(environment,{signal}={}) {
    const result=await this.pages(this.project+'/deployments?environment='+enc(environment)+'&order_by=updated_at&sort=desc',{pageSize:30,maxPages:2,signal});
    return {items:result.items.map(x=>{
      if(x.environment?.name!==environment)throw new Error('GitLab returned an out-of-scope deployment environment');
      return {id:String(x.id),deploymentId:String(x.id),provider:'gitlab',project:this.config.project,sha:fullSha(x.sha||x.deployable?.commit?.id),environment:x.environment.name,status:gitlabDeploymentStatus(x.status),providerStatus:x.status,at:Date.parse(x.updated_at||x.created_at)};
    }),complete:result.complete};
  }
  async dispatch(proposal,{signal}={}) {
    if(!this.config.ref)throw new RequestNotSubmittedError('GitLab rollback ref is not configured');
    const expected=expectedDeployment(proposal);
    const approval=await dispatchApproval(proposal.approval,this.clock);
    const variables={SRE_ACTION:'rollback',TARGET_SHA:proposal.target.sha,ARTIFACT_DIGEST:proposal.target.artifact,DEPLOY_ENVIRONMENT:proposal.environment,SRE_REQUEST_ID:proposal.id,EXPECTED_CURRENT_SHA:expected.sha,EXPECTED_CURRENT_ARTIFACT:expected.artifact,EXPECTED_CURRENT_DEPLOYMENT_ID:expected.id,EXPECTED_CURRENT_DEPLOYMENT_AT:expected.at,APPROVED_AT:String(approval.approvedAt),APPROVAL_EXPIRES_AT:String(approval.expiresAt)};
    const result=await this.request(this.project+'/pipeline',{method:'POST',mutating:true,signal,beforeSend:()=>dispatchApproval(approval,this.clock),body:{ref:this.config.ref,variables:Object.entries(variables).map(([key,value])=>({key,value,variable_type:'env_var'}))}});
    return {provider:'gitlab',status:'dispatched',requestId:proposal.id,pipelineId:result.id,url:result.web_url};
  }
}

export class JiraConnector extends ApiClient {
  constructor(config,options={}) {
    const env=options.env||process.env;
    const token=tokenProvider(config,env,options.fetcher,{clock:options.clock,retryGate:options.oauthRetryGate});
    super({...options,base:config.base,auth:config.auth==='bearer'?tokenAuth(token):async()=>({authorization:'Basic '+Buffer.from((env[config.emailEnv]||'')+':'+(env[config.tokenEnv]||'')).toString('base64')})});
    this.config=config;
  }
  issue(key,{signal}={}) {
    if(!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !this.config.projects.includes(key.replace(/-\d+$/,'')))throw new Error('Jira key is outside configured projects');
    return this.request('/rest/api/'+(this.config.apiVersion||3)+'/issue/'+enc(key)+'?fields=summary,description,issuelinks,status,updated',{signal});
  }
}

export class ServiceNowConnector extends ApiClient {
  constructor(config,options={}) {
    const token=tokenProvider(config,options.env,options.fetcher,{clock:options.clock,retryGate:options.oauthRetryGate});
    super({...options,base:config.base,auth:tokenAuth(token)});
    if(!/^[a-f0-9]{32}$/.test(config.cmdbCi))throw new Error('ServiceNow requires an explicit CMDB CI sys_id');
    this.config=config;
  }
  async incidents({since,until,maxPages=10,signal}={}) {
    const time=(t)=>iso(t).slice(0,19).replace('T',' ');
    const query='cmdb_ci='+this.config.cmdbCi+'^sys_updated_on>='+time(since)+'^sys_updated_on<='+time(until)+'^ORDERBYsys_updated_on^ORDERBYsys_id';
    return this.listIncidents(query,{maxPages,signal});
  }
  async openIncidents({until,maxPages=10,signal}={}) {
    const closed=this.config.closedStates||['6','7','8'];
    if(!Array.isArray(closed)||!closed.length||closed.some(value=>!/^[A-Za-z0-9_-]{1,64}$/.test(String(value))))throw new Error('Configure valid ServiceNow closed-state values');
    const query='cmdb_ci='+this.config.cmdbCi+closed.map(value=>'^state!='+value).join('')+'^sys_updated_on<='+iso(until).slice(0,19).replace('T',' ')+'^ORDERBYsys_updated_on^ORDERBYsys_id';
    return this.listIncidents(query,{maxPages,signal});
  }
  async listIncidents(query,{maxPages=10,signal}={}) {
    const fields='sys_id,number,short_description,description,state,priority,cmdb_ci,correlation_id,sys_created_on,sys_updated_on';
    const items=[];
    for(let page=0;page<maxPages;page++) {
      const result=await this.response('/api/now/table/incident?'+new URLSearchParams({sysparm_query:query,sysparm_fields:fields,sysparm_limit:'100',sysparm_offset:String(page*100),sysparm_display_value:'false',sysparm_exclude_reference_link:'true'}),{signal});
      if(!Array.isArray(result.data?.result))throw new Error('Invalid ServiceNow Table API result');
      const rows=result.data.result;
      for(const row of rows) {
        const ci=typeof row.cmdb_ci==='object'?row.cmdb_ci.value:row.cmdb_ci;
        if(ci!==this.config.cmdbCi)throw new Error('ServiceNow returned an out-of-scope CI');
      }
      items.push(...rows);
      // A short page can be ACL-filtered. The Link header controls continuation.
      const next=/<[^>]+>;\s*rel="?next"?/i.test(result.headers.get('link')||'');
      if(!next && rows.length<100)return {items,complete:true};
    }
    return {items,complete:false};
  }
  async incident(sysId,{signal}={}) {
    if(!/^[a-f0-9]{32}$/.test(sysId))throw new Error('Invalid ServiceNow sys_id');
    const data=await this.request('/api/now/table/incident/'+sysId+'?sysparm_fields=sys_id,number,short_description,description,state,cmdb_ci,correlation_id,sys_updated_on&sysparm_display_value=false',{signal});
    if((data.result?.cmdb_ci?.value||data.result?.cmdb_ci)!==this.config.cmdbCi)throw new Error('ServiceNow returned an out-of-scope CI');
    return data;
  }
}

export class DynatraceConnector extends ApiClient {
  constructor(config,options={}) {
    const token=tokenProvider(config,options.env,options.fetcher,{clock:options.clock,retryGate:options.oauthRetryGate});
    super({...options,base:config.base,auth:tokenAuth(token,{prefix:config.mode==='grail'?'Bearer ':'Api-Token '})});
    this.config=config;
  }
  problem(id,{signal}={}) {return this.request('/api/v2/problems/'+enc(assertText(id,'problem ID')),{signal});}
  metrics(selector,{from,to,signal}={}) {
    if(this.config.mode!=='classic'||!this.config.entityId)throw new Error('Classic metrics require an explicit service entity');
    return this.request('/api/v2/metrics/query?'+new URLSearchParams({metricSelector:selector,entitySelector:'entityId('+JSON.stringify(this.config.entityId)+')',from:iso(from),to:iso(to),resolution:'1m'}),{signal});
  }
  async query(query,{from,to,signal}={}) {
    if(this.config.mode!=='grail')throw new Error('Grail log queries require the Grail connector');
    let result=await this.request('/platform/storage/query/v1/query:execute',{method:'POST',body:{query,defaultTimeframeStart:iso(from),defaultTimeframeEnd:iso(to),maxResultRecords:200,maxResultBytes:500000,requestTimeoutMilliseconds:1000,defaultScanLimitGbytes:1,fetchTimeoutSeconds:30,enforceQueryConsumptionLimit:true},signal});
    for(let i=0;result.state!=='SUCCEEDED'&&i<30;i++) {
      if(!result.requestToken||['FAILED','CANCELLED'].includes(result.state))throw new Error('Dynatrace query failed');
      await this.sleep(250);
      result=await this.request('/platform/storage/query/v1/query:poll?request-token='+enc(result.requestToken),{signal});
    }
    if(result.state!=='SUCCEEDED')throw new Error('Dynatrace query timed out');
    if(!Array.isArray(result.result?.records))throw new Error('Dynatrace query did not return a record array');
    const records=result.result.records,metadata=result.result.metadata||{},grail=metadata.grail;
    if(typeof metadata!=='object'||Array.isArray(metadata)||grail!==undefined&&(!grail||typeof grail!=='object'||Array.isArray(grail)))throw new Error('Invalid Dynatrace query metadata');
    if(grail?.sampled!==undefined&&typeof grail.sampled!=='boolean')throw new Error('Invalid Dynatrace sampling metadata');
    if(grail?.notifications!==undefined&&!Array.isArray(grail.notifications))throw new Error('Invalid Dynatrace query notifications');
    const partial=grail?.sampled===true||(grail?.notifications||[]).some(note=>note?.severity!=='INFO');
    return {records,metadata,complete:records.length<200&&!partial};
  }
  logs({from,to,signal}={}) {
    if(!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(this.config.logField||''))throw new Error('Configure a Dynatrace service log field');
    return this.query('fetch logs | filter '+this.config.logField+' == '+JSON.stringify(this.config.logValue)+' | sort timestamp desc | limit 200',{from,to,signal});
  }
  async problems({since,until,signal}={}) {
    if(this.config.mode==='grail') {
      if(!this.config.problemQuery)throw new Error('Grail problem polling requires a verified, entity-scoped problemQuery in configuration');
      const result=await this.query(this.config.problemQuery,{from:since,to:until,signal});
      return {items:result.records,complete:result.complete};
    }
    return this.listClassicProblems({from:iso(since),to:iso(until),signal});
  }
  async openProblems({until,signal}={}) {
    if(this.config.mode==='grail') {
      if(!this.config.openProblemQuery)throw new Error('Grail active reconciliation requires a verified entity-scoped openProblemQuery');
      const result=await this.query(this.config.openProblemQuery,{from:0,to:until,signal});
      if(result.records.some(item=>(item.State||item.status||item['event.status'])!=='OPEN'))throw new Error('Grail openProblemQuery returned a record without explicit OPEN state');
      return {items:result.records,complete:result.complete};
    }
    return this.listClassicProblems({from:'0',to:iso(until),openOnly:true,signal});
  }
  async listClassicProblems({from,to,openOnly=false,signal}={}) {
    assertText(this.config.entityId,'Dynatrace service entity');
    const items=[];let next;
    for(let page=0;page<10;page++) {
      const path='/api/v2/problems?'+(next?'nextPageKey='+enc(next):new URLSearchParams({from,to,pageSize:'100',entitySelector:'entityId('+JSON.stringify(this.config.entityId)+')',...(openOnly?{problemSelector:'status("open")'}:{})}));
      const result=await this.request(path,{signal});
      if(!Array.isArray(result.problems))throw new Error('Invalid Dynatrace problems result');
      if(openOnly&&result.problems.some(item=>item.status!=='OPEN'))throw new Error('Dynatrace open-problem query returned an unexpected state');
      items.push(...result.problems);next=result.nextPageKey;
      if(result.warnings?.length)return {items,complete:false};
      if(!next)return {items,complete:true};
    }
    return {items,complete:false};
  }
}

export function createConnectors(service,options={}) {
  const connectors={};
  const scopedOptions=(config,source)=>({...options,
    retryGate:config.retryScope===undefined||!options.retryGateFactory?options.retryGate:options.retryGateFactory(configuredRetryDescriptor(service,source,'api')),
    oauthRetryGate:config.oauth?.retryScope===undefined||!options.retryGateFactory?options.oauthRetryGate:options.retryGateFactory(configuredRetryDescriptor(service,source,'oauth')),
  });
  for(const [name,Type] of Object.entries({github:GithubConnector,gitlab:GitlabConnector,jira:JiraConnector,servicenow:ServiceNowConnector,dynatrace:DynatraceConnector})) {
    if(service[name]?.enabled)connectors[name]=new (name==='servicenow'&&service[name].transport==='mcp'?ServiceNowMcpConnector:Type)(service[name],scopedOptions(service[name],name));
  }
  if(service.dynatraceLogs?.enabled)connectors.dynatraceLogs=new DynatraceConnector(service.dynatraceLogs,scopedOptions(service.dynatraceLogs,'dynatraceLogs'));
  if(service.rollback?.enabled && service[service.rollback.provider]?.enabled) {
    const provider=service.rollback.provider;
    const Type=provider==='github'?GithubConnector:GitlabConnector;
    const config={...service[provider],...service.rollback,tokenEnv:service.rollback.tokenEnv,oauth:service.rollback.oauth,retryScope:service.rollback.retryScope};
    connectors.rollback=new Type(config,scopedOptions(config,'rollback'));
  }
  return connectors;
}
