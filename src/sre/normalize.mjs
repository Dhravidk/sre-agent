import { hash } from './security.mjs';
import { githubDeploymentStatus, gitlabDeploymentStatus } from './deployments.mjs';

const time=(value,fallback)=>{
  const raw=String(value).replace(/ UTC$/,'Z');
  const parsed=typeof value==='number'?value:Date.parse(raw.replace(' ','T') + (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw)?'Z':''));
  if(Number.isFinite(parsed))return parsed;
  if(fallback!==undefined)return fallback;
  throw new Error('Missing or invalid source timestamp');
};
const envMatch=(actual,service)=>{if(actual!==service.environment)throw new Error('Deployment environment is outside this service mapping');};

export function normalize(source,payload,service,{deliveryId,eventType,now=Date.now()}={}) {
  const base={source,serviceKey:service.key,id:deliveryId||hash(payload),at:now,payload};
  if(source==='dynatrace') {
    const id=payload.ProblemID||payload.problemId||payload['event.id'];
    if(!id)throw new Error('Dynatrace problem ID required');
    const status=payload.State||payload.status||payload['event.status'];
    if(!['OPEN','CLOSED'].includes(status))throw new Error('Unsupported Dynatrace status');
    const entities=payload.EntityIds||payload.affectedEntities?.map(x=>x.entityId?.id)||payload.affected_entity_ids;
    if(service.dynatrace?.entityId && (!Array.isArray(entities)||!entities.includes(service.dynatrace.entityId)))throw new Error('Dynatrace event does not identify the configured service entity');
    const startedAt=time(payload.StartedAt??payload.startTime??payload['event.start']);
    const at=time(payload.ObservedAt??(status==='CLOSED'?payload.endTime:payload.startTime),startedAt);
    return {...base,at,startedAt,kind:'problem',issueKey:'dynatrace:'+id,status,title:payload.Title||payload.title||payload['event.name']||'Dynatrace problem '+id,payload:{...payload,problemId:id,metrics:payload.metrics||payload.LabMetrics||{}}};
  }
  if(source==='servicenow') {
    const ci=typeof payload.cmdb_ci==='object'?payload.cmdb_ci.value:payload.cmdb_ci;
    if(ci!==service.servicenow?.cmdbCi)throw new Error('ServiceNow CI is outside this service mapping');
    if(!/^[a-f0-9]{32}$/.test(payload.sys_id||''))throw new Error('ServiceNow sys_id required');
    const correlation=payload.correlation_id;
    const logKey=typeof correlation==='string'?correlation.match(/^log-monitor:([A-Za-z0-9][A-Za-z0-9_-]{0,100}):[a-f0-9]{64}$/):null;
    const linked=service.servicenow.correlateDynatrace&&/^dynatrace:[A-Za-z0-9_-]+$/.test(correlation||'')||service.servicenow.correlateLogMonitors===true&&logKey&&(service.logMonitors||[]).some(rule=>rule.id===logKey[1]);
    const at=time(payload.sys_updated_on);
    const state=typeof payload.state==='object'?payload.state?.value:payload.state;
    if(state===undefined||state===null||!/^[A-Za-z0-9_-]{1,64}$/.test(String(state)))throw new Error('ServiceNow incident state is required');
    return {...base,at,kind:'problem',issueKey:linked?correlation:'servicenow:'+payload.sys_id,status:(service.servicenow.closedStates||['6','7','8']).map(String).includes(String(state))?'CLOSED':'OPEN',startedAt:time(payload.sys_created_on),title:(payload.number||'Incident')+': '+(payload.short_description||'ServiceNow incident')};
  }
  if(source==='github') {
    if(payload.repository?.full_name!==service.github?.repository)throw new Error('GitHub repository is outside this service mapping');
    if(eventType==='ping')return null;
    if(['check_suite','check_run','workflow_run'].includes(eventType)) {
      const run=payload[eventType];
      if(!run?.head_sha)throw new Error('Check event requires a head SHA');
      return {...base,kind:'change',at:time(run.completed_at||run.updated_at||run.started_at||run.created_at),payload:{stage:'ci-update',sha:run.head_sha,ci:run,action:payload.action}};
    }
    if(eventType==='merge_group') {
      const group=payload.merge_group;
      if(!group?.head_sha||!group.base_sha)throw new Error('Merge queue event requires exact commits');
      return {...base,kind:'problem',issueKey:'review:merge-group:'+group.head_sha,status:payload.action==='destroyed'?'CLOSED':'OPEN',title:'Merge queue deployment risk review',payload:{reviewOnly:true,stage:'merge-queue',sha:group.head_sha,baseSha:group.base_sha}};
    }
    if(eventType==='pull_request') {
      const pr=payload.pull_request;
      if(!pr?.number||!pr.head?.sha)throw new Error('Invalid GitHub pull request');
      return {...base,at:time(pr.updated_at),kind:'problem',issueKey:'review:github:'+pr.number,status:payload.action==='closed'&&!pr.merged?'CLOSED':'OPEN',title:'Deployment risk review: PR #'+pr.number,payload:{reviewOnly:true,stage:pr.merged?'merge':'pre-merge',number:pr.number,sha:pr.head.sha,mergedSha:pr.merged?pr.merge_commit_sha:null,baseSha:pr.base?.sha,title:pr.title,body:pr.body,url:pr.html_url}};
    }
    if(eventType==='deployment_status') {
      const deployment=payload.deployment;const status=payload.deployment_status;
      envMatch(status?.environment||deployment?.environment,service);
      if(!deployment?.id||!status)throw new Error('Deployment and status identity required');
      if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(deployment.sha||''))throw new Error('Deployment requires a full commit SHA');
      return {...base,kind:'deployment',at:time(status.created_at),payload:{...(deployment.payload?.sre||{}),provider:'github',repository:service.github.repository,id:String(deployment.id),deploymentId:String(deployment.id),sha:deployment.sha,environment:service.environment,status:githubDeploymentStatus(status.state),providerStatus:status.state}};
    }
    throw new Error('Unsupported GitHub event');
  }
  if(source==='gitlab') {
    if(!service.gitlab?.project||String(payload.project?.id??payload.project_id)!==String(service.gitlab.project))throw new Error('GitLab project is outside this service mapping');
    if(payload.object_kind==='pipeline') {
      const pipeline=payload.object_attributes;
      if(!pipeline?.sha)throw new Error('Pipeline event requires a SHA');
      return {...base,kind:'change',at:time(pipeline.finished_at||pipeline.updated_at||pipeline.created_at,now),payload:{stage:'ci-update',sha:pipeline.sha,pipeline,builds:payload.builds}};
    }
    if(payload.object_kind==='merge_request') {
      const mr=payload.object_attributes;
      if(!mr?.iid||!mr.last_commit?.id)throw new Error('Invalid GitLab merge request');
      return {...base,at:time(mr.updated_at),kind:'problem',issueKey:'review:gitlab:'+mr.iid,status:mr.state==='closed'?'CLOSED':'OPEN',title:'Deployment risk review: MR !'+mr.iid,payload:{reviewOnly:true,stage:mr.state==='merged'?'merge':'pre-merge',number:mr.iid,sha:mr.last_commit.id,mergedSha:mr.merge_commit_sha||null,title:mr.title,body:mr.description,url:mr.url}};
    }
    if(payload.object_kind==='deployment') {
      envMatch(payload.environment,service);
      if(!payload.deployment_id||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(payload.sha||''))throw new Error('Deployment requires an identity and full commit SHA');
      return {...base,at:time(payload.status_changed_at),kind:'deployment',payload:{provider:'gitlab',project:service.gitlab.project,id:String(payload.deployment_id),deploymentId:String(payload.deployment_id),sha:payload.sha,environment:service.environment,status:gitlabDeploymentStatus(payload.status),providerStatus:payload.status}};
    }
    throw new Error('Unsupported GitLab event');
  }
  if(source==='jira') {
    const issue=payload.issue||payload;
    if(!service.jira?.projects?.includes(String(issue.key||'').replace(/-\d+$/,'')))throw new Error('Jira issue is outside configured projects');
    return {...base,kind:'ticket',at:time(payload.timestamp??issue.fields?.updated,now),payload:{key:issue.key,fields:issue.fields}};
  }
  if(source==='releases') {
    envMatch(payload.environment,service);
    if(!['github','gitlab'].includes(payload.provider)||!service[payload.provider])throw new Error('Unconfigured release provider');
    if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(payload.sha||''))throw new Error('Release metadata requires a full SHA');
    if(!/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(payload.artifact||''))throw new Error('Release metadata requires an immutable SHA256 artifact');
    if(!['success','failed'].includes(payload.status))throw new Error('Release status required');
    return {...base,kind:'deployment',at:time(payload.at),payload};
  }
  if(source==='logs') {
    if(typeof payload.message!=='string')throw new Error('Log message required');
    return {...base,kind:'log',at:time(payload.timestamp),payload};
  }
  throw new Error('Unsupported integration source');
}
