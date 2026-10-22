import {discoveryConfiguration} from './source-discovery-config.mjs';
import { createConnectors } from './connectors.mjs';
import { normalize } from './normalize.mjs';
import { metricWindow } from './monitors.mjs';
import { comparisonComplete } from './policy-evidence.mjs';

const sources=['github','gitlab','jira','servicenow','dynatrace','dynatraceLogs'];
const fullSha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
class ProbeIssue extends Error {
  constructor(status,code,message){super(message);Object.assign(this,{status,code});}
}
const requireProbe=(condition,fields)=>{if(!condition)throw new ProbeIssue('unverified','probe-configuration','Configure '+fields+' for this read probe.');};
const shape=(condition)=>{if(!condition)throw new ProbeIssue('failed','response-contract','The response does not satisfy the configured reader contract.');};
const complete=value=>{if(value!==true)throw new ProbeIssue('incomplete','incomplete-result','The bounded reader did not return a complete result.');};

function list(result,source,service,now,{active=false}={}) {
  shape(Array.isArray(result?.items));
  for(const item of result.items) {
    let event;try{event=normalize(source,item,service,{now});}catch{throw new ProbeIssue('failed','response-scope','A response record does not satisfy the configured source schema or service scope.');}
    shape(event&&(!active||event.status==='OPEN'));
  }
  complete(result.complete);return result.items;
}

// Executes only the listed read/query methods, without a store, model, sender,
// or rollback client. Results project counts/status, never provider payloads.
export async function checkReadAccess(config,{env=config.env||{},connectorFactory=createConnectors,clock=Date.now,timeoutMs=60000,signal}={}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw new Error('Invalid access-probe timeout');
  const checks=[],owned=[];let enabledReaders=0;
  try {
  for(const service of config.services) {
    const clients={};
    const add=(source,operation,status,code,summary,extra={})=>checks.push({service:service.key,source,operation,status,code,summary,...extra});
    const run=async(source,operation,read)=>{
      const controller=new AbortController(),deadline=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
      try {
        deadline.throwIfAborted();const now=await clock();shape(Number.isSafeInteger(now)&&now>=0);
        const evidence=await read({signal:deadline,now});
        deadline.throwIfAborted();
        add(source,operation,'passed','read-contract-passed','The configured resource read satisfied this operation contract.',evidence||{});
      } catch(error) {
        if(error instanceof ProbeIssue)add(source,operation,error.status,error.code,error.message);
        else {
          const httpStatus=Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?error.status:undefined;
          const retryAfterMs=Number.isSafeInteger(error?.retryAfterMs)&&error.retryAfterMs>=0?error.retryAfterMs:undefined;
          add(source,operation,'failed',deadline.aborted?'probe-deadline':'read-error',deadline.aborted?'The read was cancelled or exceeded its deadline.':'The read failed or was deferred; inspect permissions, resource configuration and provider availability.',{...(httpStatus?{httpStatus}:{}),...(retryAfterMs!==undefined?{retryAfterMs}:{})});
        }
      } finally {controller.abort();}
    };
    for(const source of sources) {
      if(service[source]?.enabled!==true){add(source,'reader','disabled','reader-disabled','Reader disabled.');continue;}
      enabledReaders++;
      const isolated={...service,...Object.fromEntries(sources.map(name=>[name,{...service[name],enabled:name===source}])),rollback:{enabled:false}};
      try{clients[source]=connectorFactory(isolated,{env,clock})[source];shape(Boolean(clients[source]));owned.push(clients[source]);}
      catch{add(source,'reader-initialization','failed','reader-configuration','The reader could not initialize; inspect its local configuration.');}
    }
    for(const provider of ['github','gitlab']) {
      const client=clients[provider],settings=service[provider];if(!client)continue;
      if(provider==='gitlab'&&discoveryConfiguration(service)){
        for(const project of discoveryConfiguration(service).projects)await run(provider,'discovery-project-metadata:'+project,async({signal})=>{const value=await client.discoveryMetadata(project,{signal});shape(value?.project===project);return{records:1};});
        if(!settings.project){add(provider,'runtime-project-mapping','unverified','mapping-unverified','Approved discovery projects do not establish the runtime repository. Deployment, review and fixed-source probes need a verified fixed mapping.');continue;}
      }
      let deployments=[],review;
      await run(provider,'repository-metadata',async({signal})=>{
        const data=await client.request(provider==='github'?client.repo:client.project,{signal});
        const matches=provider==='github'?typeof data?.full_name==='string'&&data.full_name.toLowerCase()===settings.repository.toLowerCase():/^\d+$/.test(String(settings.project))?String(data?.id)===String(settings.project):data?.path_with_namespace===settings.project;
        if(!matches)throw new ProbeIssue('failed','response-scope','Repository metadata does not match the configured repository/project.');return {records:1};
      });
      await run(provider,'deployment-history',async({signal,now})=>{
        const result=await client.deployments(service.environment,{signal});shape(Array.isArray(result?.items));
        shape(result.items.every(item=>item.environment===service.environment&&fullSha(item.sha)&&Number.isSafeInteger(item.at)&&item.at>=0&&item.at<=now));complete(result.complete);deployments=result.items;return {records:deployments.length};
      });
      if(provider==='github')await run(provider,'deployment-statuses',async()=>{
        requireProbe(deployments.length>0,'a deployment in the configured test environment');return {records:deployments.length};
      });
      await run(provider,'review-diff',async({signal})=>{
        const number=provider==='github'?settings.smokePull:settings.smokeMergeRequest;
        requireProbe(/^\d+$/.test(String(number))&&Number.isSafeInteger(Number(number))&&Number(number)>0,provider+(provider==='github'?'.smokePull':'.smokeMergeRequest'));
        review=provider==='github'?await client.pull(number,{signal}):await client.mergeRequest(number,{signal});
        const refs=provider==='github'?{head:review?.pull?.head?.sha,base:review?.pull?.base?.sha}:{head:review?.mergeRequest?.diff_refs?.head_sha||review?.mergeRequest?.sha,base:review?.mergeRequest?.diff_refs?.base_sha};
        shape(fullSha(refs.head)&&fullSha(refs.base));
        shape(Array.isArray(provider==='github'?review?.files:review?.diffs));complete(review.complete);return {records:(provider==='github'?review.files:review.diffs).length};
      });
      const head=settings.smokeSha||(provider==='github'?review?.pull?.head?.sha:review?.mergeRequest?.diff_refs?.head_sha||review?.mergeRequest?.sha)||deployments[0]?.sha;
      const base=settings.smokeBaseSha||(provider==='github'?review?.pull?.base?.sha:review?.mergeRequest?.diff_refs?.base_sha);
      await run(provider,'ci-status',async()=>{
        requireProbe(Boolean(review),'the configured smoke review');
        if(provider==='github') {
          complete(review.checksComplete);const commit=review.pull?.head?.sha,total=review.checks?.total_count,runs=review.checks?.check_runs;
          shape(fullSha(commit)&&Number.isSafeInteger(total)&&total>=0&&Array.isArray(runs)&&runs.length===total&&runs.every(item=>item.head_sha===commit)&&review.status?.sha===commit&&typeof review.status?.state==='string');
        } else {const pipeline=review.mergeRequest?.head_pipeline,commit=review.mergeRequest?.diff_refs?.head_sha||review.mergeRequest?.sha;requireProbe(Boolean(pipeline),'a head pipeline on the smoke merge request');shape(fullSha(commit)&&pipeline.sha===commit&&typeof pipeline.status==='string'&&pipeline.status.length>0);}
        return {records:provider==='github'?Number(review.checks?.total_count||0):1};
      });
      await run(provider,'linked-changes',async({signal})=>{
        requireProbe(fullSha(head),provider+'.smokeSha or a smoke review/deployment with an immutable head');const data=await client.linkedChanges(head,{signal});shape(Array.isArray(data?.items));complete(data.complete);return {records:data.items.length};
      });
      await run(provider,'immutable-source',async({signal})=>{
        requireProbe(Boolean(settings.smokePath)&&fullSha(head),provider+'.smokePath and an immutable smoke head');
        const data=await client.file(settings.smokePath,head,{signal});shape(data?.path===settings.smokePath&&data.sha===head&&typeof data.content==='string');complete(data.complete);return {bytes:Buffer.byteLength(data.content)};
      });
      await run(provider,'immutable-comparison',async({signal})=>{
        requireProbe(fullSha(base)&&fullSha(head),provider+'.smokeBaseSha/.smokeSha or exact smoke review commits');
        let common=base,data=await client.compare(common,head,{signal});
        if(provider==='github'&&fullSha(data?.merge_base_commit?.sha)&&data.merge_base_commit.sha!==common){common=data.merge_base_commit.sha;data=await client.compare(common,head,{signal});}
        complete(comparisonComplete(provider,data,common,head));return {records:(provider==='github'?data.files:data.diffs).length};
      });
    }
    const snow=clients.servicenow;
    if(snow) {
      let records=[];
      if(snow.inventory)await run('servicenow','mcp-tool-inventory',async({signal})=>{const inventory=await snow.inventory({signal});shape(inventory.allowedTools===45&&Array.isArray(inventory.available));return {records:inventory.available.length};});
      await run('servicenow','recent-incidents',async({signal,now})=>{const items=list(await snow.incidents({since:now-300000,until:now,signal}),'servicenow',service,now);records.push(...items);return {records:items.length};});
      await run('servicenow','active-inventory',async({signal,now})=>{const items=list(await snow.openIncidents({until:now,signal}),'servicenow',service,now,{active:true});records.push(...items);return {records:items.length};});
      await run('servicenow','incident-details',async({signal,now})=>{
        const id=service.servicenow.smokeIncident||records[0]?.sys_id;requireProbe(Boolean(id),'servicenow.smokeIncident or a scoped incident');
        const data=await snow.incident(id,{signal});list({items:[data?.result],complete:true},'servicenow',service,now);return {records:1};
      });
    }
    const dt=clients.dynatrace;
    if(dt) {
      let records=[];
      await run('dynatrace','recent-problems',async({signal,now})=>{const items=list(await dt.problems({since:now-300000,until:now,signal}),'dynatrace',service,now);records.push(...items);return {records:items.length};});
      await run('dynatrace','active-inventory',async({signal,now})=>{const items=list(await dt.openProblems({until:now,signal}),'dynatrace',service,now,{active:true});records.push(...items);return {records:items.length};});
      if(service.dynatrace.mode==='classic')await run('dynatrace','problem-details',async({signal,now})=>{
        const item=records[0],id=service.dynatrace.smokeProblemId||item?.ProblemID||item?.problemId||item?.['event.id'];requireProbe(Boolean(id),'dynatrace.smokeProblemId or a scoped problem');
        list({items:[await dt.problem(id,{signal})],complete:true},'dynatrace',service,now);return {records:1};
      });
    }
    for(const monitor of service.monitors||[])await run('dynatrace','metric:'+monitor.id,async({signal,now})=>{
      if(!dt)throw new ProbeIssue('failed','reader-configuration','A configured metric monitor requires an enabled Dynatrace reader.');
      const data=await dt.metrics(monitor.selector,{from:now-900000,to:now,signal});let sample;
      try{sample=metricWindow(data,monitor,now);}catch{throw new ProbeIssue('failed','metric-contract','Metric samples do not satisfy the configured aggregation, freshness and numeric-window contract.');}
      return {records:sample.values.length};
    });
    const logs=clients.dynatraceLogs||(service.dynatrace?.mode==='grail'?dt:null);
    if(logs)await run(clients.dynatraceLogs?'dynatraceLogs':'dynatrace','log-query',async({signal,now})=>{
      const data=await logs.logs({from:now-60000,to:now,signal});shape(Array.isArray(data?.records));complete(data.complete);return {records:data.records.length};
    });
    if(clients.jira)await run('jira','smoke-issue',async({signal})=>{
      const key=service.jira.smokeIssue;requireProbe(Boolean(key),'jira.smokeIssue');const data=await clients.jira.issue(key,{signal});shape(data?.key===key);return {records:1};
    });
  }
  const required=checks.filter(item=>item.status!=='disabled'),allRequiredReadsPassed=required.length>0&&required.every(item=>item.status==='passed');
  const state=required.some(item=>item.status==='failed')?'failed':allRequiredReadsPassed?'passed':required.length?'incomplete':'not-configured';
  return {state,enabledReaders,allRequiredReadsPassed,endToEndValidated:false,deploymentWritesAttempted:0,externalMessagesSent:0,checks,note:'Only the listed configured-resource read/query contracts were tested. Empty inventories do not prove complete tenant visibility; Teams, webhooks, deployment execution, recovery and model behavior require separate acceptance.'};
  } finally {await Promise.allSettled(owned.map(client=>client.close?.()));}
}
