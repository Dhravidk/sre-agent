import assert from 'node:assert/strict';
import { randomUUID,createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync,mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { seedPilot,pilotPolicySource } from '../scripts/seed-pilot.mjs';
import { scenarios } from '../src/scenarios.mjs';
import { GithubConnector } from '../src/sre/connectors.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { devActivity } from '../src/sre/demo.mjs';
import { hash } from '../src/sre/security.mjs';
import { assessRollback,releases } from '../src/sre/rollback.mjs';
import { buildArtifact } from './deployment/artifacts.mjs';
import { LocalAuctionSandbox } from './deployment/sandbox.mjs';
import {ServiceNowMcpConnector} from '../src/sre/servicenow-mcp.mjs';
import {startServiceNowMcpMock,mockServiceNowConfig} from './servicenow-mcp.mjs';

export async function runProcessRecoveryDrill({scenario='credit-timeout',directory=mkdtempSync(join(tmpdir(),'sre-process-drill-')),lostDispatchResponse=false,sameShaRace=false,expiredApproval=false,credentialRotation=false,serviceNowMcp=false}={}) {
  const variants=[lostDispatchResponse,sameShaRace,expiredApproval,credentialRotation];
  if(!scenarios.some(item=>item.id===scenario)||(variants.some(Boolean)&&scenario!=='credit-timeout')||variants.filter(Boolean).length>1)throw new Error('Choose a known process scenario; dispatch fault variants use credit-timeout');
  mkdirSync(directory,{recursive:true});
  const pilot=seedPilot(),release=pilot.releases[scenario],run=randomUUID().slice(0,8);
  const baseline=await buildArtifact(join(directory,'artifacts'),pilot.baseline),fault=await buildArtifact(join(directory,'artifacts'),release.sha);
  const sandbox=new LocalAuctionSandbox(join(directory,'auction'),[baseline,fault],scenario==='late-bid'?{initialDurationMs:1500}:{});
  const config=loadConfig({SRE_SQLITE_PATH:join(directory,'sre.sqlite')});
  config.mode='connected';config.environment=sandbox.environment;config.agentMode='rules';config.apiToken='offline-process-api';config.capabilitySecret='offline-process-capability-secret-32-characters';
  config.env={READ:'offline-process-read',WRITE:'offline-process-write',GH_HOOK:'offline-process-github',DT_HOOK:'offline-process-dynatrace',SN_HOOK:'offline-process-servicenow',RELEASE_HOOK:'offline-process-release',HEALTH_HOOK:'offline-process-health'};
  if(credentialRotation)delete config.env.WRITE;
  const service=config.services[0];service.environment=sandbox.environment;
  Object.assign(service.github,{enabled:true,base:'https://github-process-fixture.invalid',repository:'synthetic/auction-process-drill',tokenEnv:'READ',webhookSecretEnv:'GH_HOOK'});
  Object.assign(service.dynatrace,{enabled:true,webhookSecretEnv:'DT_HOOK'});Object.assign(service.servicenow,{enabled:true,webhookSecretEnv:'SN_HOOK'});
  service.releases={webhookSecretEnv:'RELEASE_HOOK'};service.verification={webhookSecretEnv:'HEALTH_HOOK'};Object.assign(service.rollback,{workflow:'local-process-rollback.yml',ref:'main',tokenEnv:'WRITE'});
  const result={mode:'local-process-recovery-drill',scenario,lostDispatchResponse,sameShaRace,expiredApproval,credentialRotation,directory,baselineSha:baseline.sha,changeSha:fault.sha,artifacts:[{sha:baseline.sha,artifact:baseline.artifact},{sha:fault.sha,artifact:fault.artifact}],stages:[],limitations:['Auction HTTP/SQLite, retained source artifacts, OS process replacement, and measured business behavior are real local execution.','GitHub/Dynatrace/ServiceNow transports and Teams identities are synthetic. No real provider workflow or tenant access is established.','The investigator uses known-signature rules; this is not model accuracy or a production settlement/data-repair procedure.','The local deployer has one controller; distributed CI/environment serialization remains deployment-specific acceptance work.']};
  const stage=(name,data={})=>result.stages.push({name,at:Date.now(),...data});
  const dispatches=[],githubRequests=[],snowRecords=new Map();let runtime,base,pipelineResult,snowMock;
  const files=execFileSync('git',['-C',pilot.repository,'diff','--name-only',baseline.sha,fault.sha],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(filename=>({filename,patch:execFileSync('git',['-C',pilot.repository,'diff',baseline.sha,fault.sha,'--',filename],{encoding:'utf8'})}));
  const nativeDeployments=()=>{
    const records=sandbox.history(),latest=records.at(-1);
    return records.map(record=>({id:record.deploymentId,sha:record.sha,environment:service.environment,created_at:new Date(record.at).toISOString(),payload:{sre:record},statuses:[...(record.deploymentId!==latest.deploymentId?[{state:'inactive',environment:service.environment,created_at:new Date(latest.at).toISOString()}]:[]),{state:record.status==='success'?'success':record.status==='failed'?'failure':'in_progress',environment:service.environment,created_at:new Date(record.at).toISOString()}]}));
  };
  const fetcher=async(url,options={})=>{
    assert.equal(new URL(url).origin,service.github.base);const path=new URL(url).pathname;githubRequests.push({method:options.method||'GET',path});
    const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
    if(path.endsWith('/dispatches')) {
      assert.equal(options.headers.authorization,'Bearer offline-process-write');const body=JSON.parse(options.body),input=body.inputs;
      assert.equal(body.ref,'main');assert.equal(input.environment,service.environment);dispatches.push(body);
      if(sameShaRace)await sandbox.deployFixture(fault);
      if(expiredApproval&&dispatches.length===1)await delay(Math.max(0,Number(input.approval_expires_at)-Date.now()+15));
      try {
        pipelineResult=await sandbox.rollback({requestId:input.request_id,environment:input.environment,expected:{sha:input.expected_current_sha,artifact:input.expected_current_artifact,deploymentId:input.expected_current_deployment_id,deploymentAt:Number(input.expected_current_deployment_at)},target:{sha:input.target_sha,artifact:input.artifact_digest},approval:{approvedAt:Number(input.approved_at),expiresAt:Number(input.approval_expires_at)}});
      } catch(cause){pipelineResult={status:'blocked',error:cause.message};}
      if(lostDispatchResponse&&pipelineResult.status==='complete')throw new Error('Synthetic workflow receipt lost after actual local deployment committed');
      return response({workflow_run_id:1000+dispatches.length,run_url:'https://github-process-fixture.invalid/runs/'+dispatches.length,html_url:'https://github-process-fixture.invalid/runs/'+dispatches.length});
    }
    assert.equal(options.headers.authorization,'Bearer offline-process-read');
    if(path.endsWith('/pulls/42/files'))return response(files);
    if(path.endsWith('/pulls/42'))return response({number:42,head:{sha:fault.sha},base:{sha:baseline.sha},title:release.ticket+' '+scenario,changed_files:files.length});
    if(path.endsWith('/check-runs'))return response({total_count:1,check_runs:[{head_sha:fault.sha,conclusion:'success'}]});
    if(path.endsWith('/status'))return response({state:'success',sha:fault.sha});
    if(path.endsWith('/contents/src/auction/rules.mjs')){const sha=new URL(url).searchParams.get('ref'),content=pilotPolicySource(sha);return response({type:'file',path:'src/auction/rules.mjs',encoding:'base64',size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64')});}
    if(path.includes('/commits/')&&path.endsWith('/pulls'))return response(path.includes('/'+fault.sha+'/')?[{number:42}]:[]);
    if(path.includes('/compare/'))return response({files,merge_base_commit:{sha:baseline.sha}});
    if(path.endsWith('/deployments'))return response(nativeDeployments().reverse().map(({statuses,...item})=>item));
    const status=path.match(/\/deployments\/(\d+)\/statuses$/);if(status)return response(nativeDeployments().find(item=>item.id===status[1]).statuses);
    throw new Error('Unexpected synthetic GitHub resource '+path);
  };
  const options={fetcher,env:config.env,sleep:async()=>{}};
  const connectors=new Map([[service.key,{github:new GithubConnector(service.github,options),rollback:new GithubConnector({...service.github,...service.rollback},options)}]]);
  const start=async()=>{
    if(serviceNowMcp) {
      snowMock??=await startServiceNowMcpMock({records:()=>[...snowRecords.values()]});
      service.servicenow={...mockServiceNowConfig(snowMock.endpoint),webhookSecretEnv:'SN_HOOK'};config.env.SERVICENOW_MCP_TOKEN=snowMock.controls.token;
      connectors.get(service.key).servicenow=new ServiceNowMcpConnector(service.servicenow,{env:config.env});
    }
    runtime=await createSreRuntime({config,connectors,autoStart:false});await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+runtime.server.address().port;
  };
  const hook=async(source,payload,{eventType,expected=202,deliveryId=randomUUID()}={})=>{
    const body=JSON.stringify(payload),secret=config.env[service[source].webhookSecretEnv],timestamp=String(Date.now());
    const headers=source==='github'?{'x-github-event':eventType,'x-github-delivery':deliveryId,'x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(body).digest('hex')}:['releases','verification'].includes(source)?{'x-sre-timestamp':timestamp,'x-sre-event-id':deliveryId,'x-sre-signature':'sha256='+createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex')}:{authorization:'Bearer '+secret};
    const response=await fetch(base+'/webhooks/'+source+'/'+service.key,{method:'POST',headers,body,signal:AbortSignal.timeout(5000)});const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));if(serviceNowMcp&&source==='servicenow'&&response.status===202)snowRecords.set(payload.sys_id,payload);return data;
  };
  const publish=async record=>{const item=nativeDeployments().find(row=>row.id===record.deploymentId);await hook('github',{repository:{full_name:service.github.repository},deployment:item,deployment_status:{state:'success',environment:service.environment,created_at:new Date(record.at).toISOString()}},{eventType:'deployment_status'});await hook('releases',{...record,provider:'github'});};
  const drain=async()=>{for(let i=0;i<20&&await runtime.worker.runOnce();i++);};
  const command=async text=>{const sample=devActivity(text,service,{serviceUrl:'https://teams-process-fixture.invalid'});await runtime.router.accept(sample.activity,sample.reference);await runtime.router.processOnce();};
  const lots=async()=>(await sandbox.json('/api/lots')).data;
  const bid=(lot,amount,extra={})=>sandbox.json('/api/lots/'+lot.id+'/bids',{method:'POST',headers:{'content-type':'application/json','idempotency-key':extra.requestId||randomUUID()},body:JSON.stringify({amountCents:amount,dealer:extra.dealer||'Synthetic dealer',processingMs:extra.processingMs??15})});
  try {
    await sandbox.deployFixture(baseline);let list=await lots();const originalRequestId='baseline-'+run;
    const accepted=await bid(list[0],list[0].currentBidCents+10000,{requestId:originalRequestId});assert.equal(accepted.status,201);
    const healthy=await sandbox.markHealthyTarget();await start();await publish(healthy);stage('measured-baseline',{pid:(await sandbox.identity()).pid,bidCount:accepted.data.lot.bids.length,sha:healthy.sha,artifact:healthy.artifact});
    const review=await hook('github',{repository:{full_name:service.github.repository},action:'opened',pull_request:{number:42,head:{sha:fault.sha},base:{sha:baseline.sha},updated_at:new Date().toISOString(),title:release.ticket+' '+scenario}},{eventType:'pull_request'});await drain();
    const reviewed=await runtime.store.context(review.incidentId);result.codeFindings=reviewed.incident.analysis.codeReview.findings;stage('pre-merge-review',{findings:result.codeFindings.length,rollbackEligible:reviewed.incident.analysis.rollback.eligible});
    if(scenario==='dependency-outage')await sandbox.control('dependency-state',{down:true});else await publish(await sandbox.deployFixture(fault));
    list=await lots();assert.equal(list[0].bids.length,1,'Accepted baseline data must survive fault deployment');
    if(scenario==='bid-race')await Promise.all([bid(list[0],list[0].currentBidCents+30000,{processingMs:5,dealer:'High bidder'}),bid(list[0],list[0].currentBidCents+20000,{processingMs:60,dealer:'Slow bidder'})]);
    else if(scenario==='late-bid'){await delay(Math.max(0,list[0].endsAt-Date.now()+10));await bid(list[0],list[0].currentBidCents+10000);}
    else if(scenario==='catalog-latency')for(let i=0;i<3;i++)await lots();
    else for(let i=0;i<3;i++){list=await lots();await bid(list[0],list[0].currentBidCents+10000);}
    const before=(await sandbox.json('/metrics')).data;result.before=before;stage('measured-runtime',{pid:before.pid,sha:before.sha,errors:before.errors,violations:before.violations,p95Ms:before.p95Ms});
    if(scenario==='healthy-release'){assert.equal(before.errors,0);assert.equal(before.violations.length,0);result.outcome='healthy-no-runtime-incident';return result;}
    const problem={ProblemID:'P-PROCESS-'+run,State:'OPEN',Title:'Measured local auction failure',EntityIds:[service.dynatrace.entityId],StartedAt:Date.now(),ObservedAt:Date.now(),metrics:before};
    const opened=await hook('dynatrace',problem);result.incidentId=opened.incidentId;
    const snow={sys_id:hash(run).slice(0,32),number:'INC-PROCESS-'+run,cmdb_ci:service.servicenow.cmdbCi,correlation_id:'dynatrace:'+problem.ProblemID,state:'2',short_description:'Measured local auction failure',sys_created_on:new Date(problem.StartedAt).toISOString(),sys_updated_on:new Date().toISOString()};
    await hook('servicenow',snow);await drain();
    const context=await runtime.store.context(opened.incidentId),assessment=assessRollback(context,service);result.changeAssessment=context.incident.analysis.changeAssessment;
    stage('incident-investigated',{eligible:assessment.eligible,candidateSha:context.incident.analysis.candidateSha,reasons:assessment.reasons});
    if(!assessment.eligible){assert.ok(['schema-break','dependency-outage'].includes(scenario));result.outcome='rollback-blocked';return result;}
    if(expiredApproval)service.rollback.approvalMinutes=.05; // Three real seconds, including a deliberately queued workflow.
    await command('rollback '+opened.incidentId);let proposal=(await runtime.store.snapshot()).rollbacks[0];
    await command(proposal.proposal.approvalText.split('\n').at(-1).replace('An authorized approver must send: ',''));
    assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'approved');await runtime.rollbacks.executeNext();
    const dispatched=(await runtime.store.snapshot()).rollbacks[0];result.dispatchStatus=dispatched.status;result.pipelineResult=pipelineResult;
    if(credentialRotation) {
      const blockedId=proposal.id,identity=await sandbox.identity(),session=context.session.agent_id;
      assert.equal(dispatched.status,'blocked');assert.match(dispatched.error,/not submitted; authentication failed/);
      assert.equal(dispatches.length,0);assert.equal(sandbox.requests().length,0);assert.equal(sandbox.history().length,2);assert.equal(identity.pid,before.pid);
      stage('credentials-blocked-before-submission',{requestId:blockedId,pid:identity.pid,deployments:2,dispatches:0});
      await runtime.close();runtime=null;await start();
      assert.equal((await runtime.store.context(opened.incidentId)).session.agent_id,session);
      assert.equal((await runtime.store.snapshot()).rollbacks.find(item=>item.id===blockedId).status,'blocked');
      config.env.WRITE='offline-process-write';
      assert.equal(await runtime.rollbacks.executeNext(),false);assert.equal(dispatches.length,0);assert.equal((await sandbox.identity()).pid,identity.pid);
      stage('credentials-restored-without-replay',{requestId:blockedId,sessionPreserved:true,dispatches:0});
      await command('rollback '+opened.incidentId);
      proposal=(await runtime.store.snapshot()).rollbacks.find(item=>item.id!==blockedId);assert.ok(proposal);assert.equal(proposal.status,'pending');
      await command(proposal.proposal.approvalText.split('\n').at(-1).replace('An authorized approver must send: ',''));
      await runtime.rollbacks.executeNext();assert.equal(dispatches.length,1);
      const rows=(await runtime.store.snapshot()).rollbacks;
      assert.equal(rows.find(item=>item.id===blockedId).status,'blocked');assert.equal(rows.find(item=>item.id===proposal.id).status,'dispatched');
      result.credentialRecovery={blockedRequestId:blockedId,freshRequestId:proposal.id,requiredFreshApproval:true};
      result.pipelineResult=pipelineResult;stage('fresh-approval-after-credential-restoration',{requestId:proposal.id,dispatches:1});
    } else {
      assert.equal(dispatched.status,lostDispatchResponse?'unknown':'dispatched');assert.equal(dispatches.length,1);
    }
    if(expiredApproval) {
      assert.equal(pipelineResult.status,'blocked');assert.match(pipelineResult.error,/approval.*expired/i);
      const identity=await sandbox.identity();assert.equal(identity.sha,fault.sha);assert.equal(sandbox.history().length,2);
      result.expiredPipelineResult=pipelineResult;result.expiredRollbackId=proposal.id;
      stage('queued-approval-expired',{pid:identity.pid,requestId:proposal.id,deployments:sandbox.history().length});
      const proof={id:'no-change-'+run,kind:'rollback_no_change',incidentId:opened.incidentId,rollbackRequestId:proposal.id,requestHash:sandbox.requests()[0].body_hash,provider:'github',runId:String(1000+dispatches.length),terminal:true,deploymentStarted:false,outcome:'blocked',reason:'Approval expired in the workflow queue',observedAt:Date.now(),environment:service.environment,sha:identity.sha,artifact:identity.artifact,deploymentId:identity.deploymentId,deploymentAt:identity.deploymentAt,evidenceUrl:'https://synthetic-verifier.invalid/workflow/'+run};
      await hook('verification',{...proof,id:proof.id+'-wrong-deployment',deploymentId:'not-current'},{expected:400});
      assert.equal((await runtime.store.snapshot()).rollbacks.find(item=>item.id===proposal.id).status,'dispatched');
      await hook('verification',proof);await hook('verification',proof);
      assert.equal((await runtime.store.snapshot()).rollbacks.find(item=>item.id===proposal.id).status,'not_executed');
      assert.equal((await runtime.store.context(opened.incidentId)).incident.status,'open');
      stage('no-change-independently-reconciled',{requestId:proposal.id,incidentStillOpen:true});
      const waiting=assessRollback(await runtime.store.context(opened.incidentId),service);assert.equal(waiting.eligible,false);assert.ok(waiting.reasons.some(reason=>/current.*assessment/i.test(reason)));
      await drain();assert.equal((await runtime.store.context(opened.incidentId)).assessmentStatus.state,'current');stage('reconciled-incident-reassessed',{requestId:proposal.id,dispatches:dispatches.length});
      await command('rollback '+opened.incidentId);
      proposal=(await runtime.store.snapshot()).rollbacks.find(item=>item.id!==result.expiredRollbackId);assert.ok(proposal);assert.equal(proposal.status,'pending');
      await command(proposal.proposal.approvalText.split('\n').at(-1).replace('An authorized approver must send: ',''));
      await runtime.rollbacks.executeNext();assert.equal(dispatches.length,2);assert.equal((await runtime.store.snapshot()).rollbacks.find(item=>item.id===proposal.id).status,'dispatched');
      assert.notEqual(proposal.id,result.expiredRollbackId);result.pipelineResult=pipelineResult;stage('fresh-approval-dispatched',{requestId:proposal.id,dispatches:2});
    }
    if(sameShaRace){assert.equal(pipelineResult.status,'blocked');assert.match(pipelineResult.error,/Actual deployment changed/);assert.equal((await sandbox.identity()).sha,fault.sha);result.outcome='deployment-race-blocked';return result;}
    assert.equal(pipelineResult.status,'complete');assert.equal((await sandbox.identity()).sha,baseline.sha);
    const session=context.session.agent_id;await runtime.close();runtime=null;await start();assert.equal((await runtime.store.context(opened.incidentId)).session.agent_id,session);assert.equal(await runtime.rollbacks.executeNext(),false);stage('agent-restarted',{scope:'HTTP/store instance in the same supervisor process',supervisorPid:process.pid,sessionPreserved:true,dispatchCount:dispatches.length});
    const recovered=pipelineResult.deployment;await publish(recovered);
    const retained=await lots();result.retainedBids=retained[0].bids;result.historicalViolations=(await sandbox.json('/metrics')).data.violations;
    const count=retained[0].bids.length;const repeated=await bid(retained[0],accepted.data.lot.currentBidCents,{requestId:originalRequestId});assert.equal(repeated.status,201);assert.equal((await lots())[0].bids.length,count);stage('durable-bid-and-idempotency-retained',{count,version:retained[0].version,historicalViolations:result.historicalViolations});
    // Probe another lot so fresh traffic cannot accidentally repair the corrupt winner.
    let probeStatus;
    if(scenario!=='late-bid'){const probe=(await lots())[1];probeStatus=(await bid(probe,probe.currentBidCents+10000)).status;}
    await lots();
    await hook('servicenow',{...snow,state:'6',sys_updated_on:new Date().toISOString()});await hook('dynatrace',{...problem,State:'CLOSED',ObservedAt:Date.now()});
    assert.equal((await runtime.store.context(opened.incidentId)).incident.status,'verifying');
    const verify=async(expected=202)=>{
      const metrics=(await sandbox.json('/metrics')).data,business=sandbox.inspectStore(),current=releases((await runtime.store.context(opened.incidentId)).deployments)[0];
      const identity=await sandbox.identity();assert.equal(identity.deploymentId,current.deploymentId);assert.equal(identity.artifact,current.artifact);
      const proof={id:'process-health-'+randomUUID(),incidentId:opened.incidentId,environment:service.environment,healthy:true,sha:identity.sha,artifact:identity.artifact,deploymentId:identity.deploymentId,deploymentAt:identity.deploymentAt,rollbackRequestId:proposal.id,observedAt:Date.now(),checks:{technical:metrics.requests>0&&metrics.errors===0&&metrics.p95Ms<=250&&(scenario==='late-bid'||probeStatus===201),businessInvariants:business.violations.length===0},evidenceUrl:'https://synthetic-verifier.invalid/process/'+run};
      await hook('verification',proof,{expected});result.after=metrics;result.independentBusinessAudit=business;return proof;
    };
    if(result.historicalViolations.length){await verify(400);stage('business-recovery-withheld',{violations:result.historicalViolations});}
    if(scenario==='late-bid'){result.outcome='needs-transaction-reconciliation';return result;}
    if(scenario==='bid-race') {
      const prior=(await lots())[0],repair=await sandbox.control('reconcile-winners'),after=(await lots())[0];assert.deepEqual(after.bids,prior.bids);assert.equal(repair.changed.length,1);
      result.reconciliation={actor:'synthetic operator fixture',bidHistoryPreserved:true,changed:repair.changed,productionRecoveryValidated:false};stage('synthetic-operator-reconciliation',result.reconciliation);
    }
    await verify();await drain();assert.equal((await runtime.store.context(opened.incidentId)).incident.status,'resolved');assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'verified');
    result.outcome='recovery-verified';result.rollbackRequestId=proposal.id;stage('independent-recovery-verified',{sha:recovered.sha,artifact:recovered.artifact,deploymentId:recovered.deploymentId,rollbackStatus:'verified'});return result;
  } catch(cause){result.outcome='failed';result.error={message:cause.message,stack:cause.stack};throw cause;}
  finally {
    result.dispatchCount=dispatches.length;result.githubRequests=githubRequests;result.workflowRequests=sandbox.requests();result.deployments=sandbox.history();
    try{await runtime?.close();}finally{await snowMock?.close();result.serviceNowMcp={enabled:serviceNowMcp,calls:snowMock?.calls||[],protocol:'Official SDK Streamable HTTP against fictional schemas/records; no Ally access'};await sandbox.close();result.processes=sandbox.processes;result.finishedAt=new Date().toISOString();writeFileSync(join(directory,'report.json'),JSON.stringify(result,null,2)+'\n');}
  }
}
