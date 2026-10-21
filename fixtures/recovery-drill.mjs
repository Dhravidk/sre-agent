import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auction } from '../src/auction/service.mjs';
import { seedPilot, loadRelease,pilotPolicySource } from '../scripts/seed-pilot.mjs';
import { scenarios } from '../src/scenarios.mjs';
import { GithubConnector } from '../src/sre/connectors.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { devActivity } from '../src/sre/demo.mjs';
import { hash } from '../src/sre/security.mjs';
import { assessRollback, releases } from '../src/sre/rollback.mjs';

// Trusted generated revisions only. This is a protocol/behavior fixture, never
// a runner for external PR code, a real GitHub workflow, or a production repair.
export async function runRecoveryDrill({scenario='bid-race',directory=mkdtempSync(join(tmpdir(),'sre-drill-'))}={}) {
  if(!scenarios.some(x=>x.id===scenario))throw new Error('Unknown drill scenario');
  mkdirSync(directory,{recursive:true});
  const manifest=seedPilot(),release=manifest.releases[scenario],run=randomUUID().slice(0,8);
  let now=Date.now(),runtime,base;
  const config=loadConfig({SRE_SQLITE_PATH:join(directory,'sre.sqlite')});
  config.mode='connected';config.agentMode='rules';config.apiToken='offline-drill-api';config.env={READ:'offline-read',WRITE:'offline-write',GH_HOOK:'offline-github',DT_HOOK:'offline-dynatrace',SN_HOOK:'offline-servicenow',RELEASE_HOOK:'offline-release',HEALTH_HOOK:'offline-health'};
  const service=config.services[0];
  Object.assign(service.github,{enabled:true,repository:'synthetic/auction-drill',base:'https://github-drill.invalid',tokenEnv:'READ',webhookSecretEnv:'GH_HOOK'});
  Object.assign(service.dynatrace,{enabled:true,webhookSecretEnv:'DT_HOOK'});
  Object.assign(service.servicenow,{enabled:true,webhookSecretEnv:'SN_HOOK'});
  service.releases={webhookSecretEnv:'RELEASE_HOOK'};service.verification={webhookSecretEnv:'HEALTH_HOOK'};
  Object.assign(service.rollback,{workflow:'sre-rollback.yml',ref:'main',tokenEnv:'WRITE'});
  const digest=sha=> 'sha256:'+hash(['server.mjs','src/auction/service.mjs','src/auction/rules.mjs'].map(path=>[path,execFileSync('git',['-C',manifest.repository,'show',sha+':'+path],{encoding:'utf8'})]));
  const compatibility={schemaVersion:1,dependencyFingerprint:'fixture-deps-1',configurationFingerprint:'fixture-config-1',featureFlagsFingerprint:'fixture-flags-1',rollbackCompatible:true,dataRollbackSafe:true};
  const deployments=[],calls=[],dispatches=[];
  function deployment(id,sha,at,extra={}) {
    const metadata={...compatibility,deploymentId:String(id),artifact:digest(sha),...extra};
    const item={id,sha,environment:service.environment,created_at:new Date(at).toISOString(),payload:{sre:metadata},statuses:[{state:'success',environment:service.environment,created_at:new Date(at).toISOString()}]};
    deployments.push(item);return item;
  }
  const baseline=deployment(1,manifest.baseline,now-1800000,{healthy:true,healthVerifiedAt:now-1790000});
  const files=execFileSync('git',['-C',manifest.repository,'diff','--name-only',manifest.baseline,release.sha],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(filename=>({filename,patch:execFileSync('git',['-C',manifest.repository,'diff',manifest.baseline,release.sha,'--',filename],{encoding:'utf8'})}));
  const fetcher=async(url,options={})=>{
    const path=new URL(url).pathname;calls.push({method:options.method||'GET',path});
    assert.equal(new URL(url).origin,service.github.base);
    const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
    if(path.endsWith('/dispatches')) {
      assert.equal(options.headers.authorization,'Bearer offline-write');
      const input=JSON.parse(options.body);
      assert.equal(input.ref,'main');assert.equal(input.inputs.environment,service.environment);
      assert.equal(input.inputs.expected_current_sha,release.sha);
      assert.equal(input.inputs.target_sha,manifest.baseline);assert.equal(input.inputs.artifact_digest,baseline.payload.sre.artifact);
      assert.equal(dispatches.some(x=>x.inputs.request_id===input.inputs.request_id),false);
      dispatches.push(input);return new Response(null,{status:204});
    }
    assert.equal(options.headers.authorization,'Bearer offline-read');
    if(path.endsWith('/pulls/42/files'))return response(files);
    if(path.endsWith('/pulls/42'))return response({number:42,head:{sha:release.sha},base:{sha:manifest.baseline},title:release.ticket+' fixture change',changed_files:files.length});
    if(path.endsWith('/check-runs'))return response({total_count:1,check_runs:[{head_sha:release.sha,conclusion:'success'}]});
    if(path.endsWith('/status'))return response({state:'success',sha:release.sha});
    if(path.endsWith('/contents/src/auction/rules.mjs')) {const sha=new URL(url).searchParams.get('ref'),content=pilotPolicySource(sha);return response({type:'file',path:'src/auction/rules.mjs',encoding:'base64',size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64')});}
    if(path.includes('/commits/')&&path.endsWith('/pulls'))return response(path.includes('/'+release.sha+'/')?[{number:42}]:[]);
    if(path.includes('/compare/'))return response({files,base_commit:{sha:manifest.baseline},merge_base_commit:{sha:manifest.baseline},commits:[{sha:release.sha}]});
    if(path.endsWith('/deployments'))return response([...deployments].reverse().map(({statuses,...item})=>item));
    const status=path.match(/\/deployments\/(\d+)\/statuses$/);
    if(status)return response(deployments.find(x=>x.id===Number(status[1])).statuses);
    throw new Error('Unexpected fixture GitHub resource: '+path);
  };
  const options={fetcher,env:config.env,sleep:async()=>{},clock:()=>now};
  const connectors=new Map([[service.key,{github:new GithubConnector(service.github,options),rollback:new GithubConnector({...service.github,...service.rollback},options)}]]);
  const live=new Auction({clock:()=>now,rules:await loadRelease(manifest.baseline)});
  const result={mode:'offline-contract-drill',scenario,repository:manifest.repository,baselineSha:manifest.baseline,changeSha:release.sha,artifactType:'synthetic source bundle digest',directory,stages:[],limitations:['GitHub, Dynatrace, ServiceNow, and Teams identities/transports are fixtures. No live vendor access is established.','Rules recognize documented fixture signatures; model reasoning quality is not evaluated.','Source digests are fixture artifacts, not built production container images.']};
  const stage=(name,data={})=>result.stages.push({name,at:now,...data});
  const start=async()=>{
    runtime=await createSreRuntime({config,connectors,autoStart:false});runtime.store.clock=()=>now;
    await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+runtime.server.address().port;
  };
  const hook=async(source,payload,{eventType,deliveryId=randomUUID(),expected=202}={})=>{
    const body=JSON.stringify(payload),secret=config.env[service[source].webhookSecretEnv];
    const headers=source==='github'?{'x-github-event':eventType,'x-github-delivery':deliveryId,'x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(body).digest('hex')}:['releases','verification'].includes(source)?{'x-sre-timestamp':String(now),'x-sre-event-id':deliveryId,'x-sre-signature':'sha256='+createHmac('sha256',secret).update(String(now)+'.'+body).digest('hex')}:{authorization:'Bearer '+secret};
    const response=await fetch(base+'/webhooks/'+source+'/'+service.key,{method:'POST',headers,body});
    const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
  };
  const recordDeployment=async item=>{
    await hook('github',{repository:{full_name:service.github.repository},deployment:item,deployment_status:item.statuses[0]},{eventType:'deployment_status'});
    await hook('releases',{...item.payload.sre,provider:'github',environment:service.environment,sha:item.sha,status:'success',at:Date.parse(item.statuses[0].created_at)});
  };
  const drain=async()=>{for(let i=0;i<10&&await runtime.worker.runOnce();i++);};
  const command=async text=>{
    const sample=devActivity(text,service,{serviceUrl:'https://teams-drill.invalid'});
    await runtime.router.accept(sample.activity,sample.reference);await runtime.router.processOnce();
  };
  const traffic=async(auction,kind)=>{
    const lot=auction.lots[0];
    if(kind==='bid-race')await Promise.all([auction.bid(lot.id,lot.currentBidCents+30000,'High bidder',randomUUID(),5),auction.bid(lot.id,lot.currentBidCents+20000,'Slow bidder',randomUUID(),40)]);
    else if(kind==='late-bid'){now=lot.endsAt+1;await auction.bid(lot.id,lot.currentBidCents+10000,'Late bidder',randomUUID());}
    else if(['catalog-latency','healthy-release'].includes(kind))for(let i=0;i<3;i++)await auction.catalog();
    else for(let i=0;i<3;i++)await auction.bid(lot.id,lot.currentBidCents+10000,'Dealer',randomUUID());
    return auction.telemetry();
  };
  try {
    await start();await recordDeployment(baseline);
    const review=await hook('github',{repository:{full_name:service.github.repository},action:'opened',pull_request:{number:42,head:{sha:release.sha},base:{sha:manifest.baseline},updated_at:new Date(now-360000).toISOString(),title:release.ticket+' '+scenario}},{eventType:'pull_request'});
    await drain();
    const reviewContext=await runtime.store.context(review.incidentId);
    result.codeFindings=reviewContext.incident.analysis.codeReview.findings;
    stage('pre-merge-review',{headSha:reviewContext.incident.analysis.risk.scope.headSha,findings:result.codeFindings.length,rollbackEligible:reviewContext.incident.analysis.rollback.eligible});
    if(scenario!=='dependency-outage') {
      live.rules=await loadRelease(release.sha);
      const changed=deployment(2,release.sha,now-300000,{healthy:false,healthVerifiedAt:null,...(scenario==='schema-break'?{schemaVersion:2,rollbackCompatible:false,dataRollbackSafe:false}:{})});
      baseline.statuses.unshift({state:'inactive',environment:service.environment,created_at:new Date(now-299999).toISOString()});
      await recordDeployment(changed);stage('faulty-fixture-deployed',{sha:release.sha});
    } else live.creditDown=true;
    const metrics=await traffic(live,scenario);result.before={requests:metrics.requests,p95Ms:metrics.p95Ms,codes:metrics.codes,violations:metrics.violations};
    if(scenario==='healthy-release') {assert.equal(metrics.errors,0);assert.equal(metrics.violations.length,0);assert.ok(metrics.p95Ms<=250);stage('healthy-traffic',{metrics:result.before});result.outcome='healthy-no-runtime-incident';return result;}
    now+=10;
    const problem={ProblemID:'P-DRILL-'+run,State:'OPEN',Title:'Measured auction failure',EntityIds:[service.dynatrace.entityId],StartedAt:now,ObservedAt:now,metrics};
    const event=await hook('dynatrace',problem);result.incidentId=event.incidentId;
    assert.equal((await hook('dynatrace',problem)).duplicate,true);
    stage('duplicate-alert-deduplicated',{incidentId:event.incidentId});
    const snow={sys_id:hash(run).slice(0,32),number:'INC-DRILL-'+run,cmdb_ci:service.servicenow.cmdbCi,correlation_id:'dynatrace:'+problem.ProblemID,state:'2',short_description:'Measured auction failure',sys_created_on:new Date(now).toISOString(),sys_updated_on:new Date(now).toISOString()};
    await hook('servicenow',snow);await drain();
    const context=await runtime.store.context(event.incidentId),assessment=assessRollback(context,service,now);
    result.changeAssessment=context.incident.analysis.changeAssessment;
    stage('incident-investigated',{candidateSha:context.incident.analysis.candidateSha,rollbackEligible:assessment.eligible,reasons:assessment.reasons});
    if(!assessment.eligible) {result.outcome='rollback-blocked';result.rollbackReasons=assessment.reasons;return result;}
    await command('rollback '+event.incidentId);
    const proposal=(await runtime.store.snapshot()).rollbacks[0];
    await command(proposal.proposal.approvalText.split('\n').at(-1).replace('An authorized approver must send: ',''));
    assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'approved');
    await runtime.rollbacks.executeNext();assert.equal(dispatches.length,1);
    assert.equal((await runtime.store.context(event.incidentId)).incident.status,'open');
    stage('approved-workflow-dispatched',{requestId:proposal.id,incidentStatus:'open'});
    const session=context.session.agent_id;
    await runtime.close();runtime=null;await start();
    assert.equal((await runtime.store.context(event.incidentId)).session.agent_id,session);
    assert.equal(await runtime.rollbacks.executeNext(),false);
    stage('service-restarted',{pendingDispatches:dispatches.length,sessionPreserved:true});
    live.rules=await loadRelease(proposal.proposal.target.sha);live.samples=[];now+=1000;
    const recovered=deployment(3,proposal.proposal.target.sha,now,{healthy:false,rollbackRequestId:proposal.id});
    await recordDeployment(recovered);stage('rollback-deployment-completed',{sha:recovered.sha});
    const probe=new Auction({clock:()=>now,rules:live.rules});
    await traffic(probe,'bid-race');await probe.catalog();
    const technical=probe.telemetry();
    result.afterRollback={technicalErrors:technical.errors,newTrafficViolations:technical.violations,historicalViolations:live.telemetry().violations};
    if(live.telemetry().violations.includes('BID_ACCEPTED_AFTER_CLOSE')) {
      result.outcome='needs-transaction-reconciliation';stage('recovery-withheld',{reason:'Historical accepted late bids require a separate operator/data recovery procedure.'});return result;
    }
    if(live.telemetry().violations.includes('WINNING_BID_REGRESSED')) {
      const affected=live.lots.filter(lot=>lot.bids.some(bid=>bid.amountCents>lot.currentBidCents));
      // Explicit synthetic operator action, outside the agent/executor. Preserve
      // the bid history; this does not model settlement or a real data repair.
      for(const lot of affected)lot.currentBidCents=Math.max(lot.currentBidCents,...lot.bids.map(bid=>bid.amountCents));
      result.reconciliation={actor:'synthetic operator fixture',affectedLots:affected.length,bidHistoryPreserved:true,productionRecoveryValidated:false};
      stage('synthetic-operator-reconciliation',result.reconciliation);
    }
    now+=10;
    await hook('servicenow',{...snow,state:'6',sys_updated_on:new Date(now).toISOString()});
    assert.equal((await runtime.store.context(event.incidentId)).incident.status,'open');
    await hook('dynatrace',{...problem,State:'CLOSED',ObservedAt:now});
    assert.equal((await runtime.store.context(event.incidentId)).incident.status,'verifying');
    const current=releases((await runtime.store.context(event.incidentId)).deployments)[0];
    const proof={id:'health-'+run,incidentId:event.incidentId,environment:service.environment,healthy:true,sha:current.sha,artifact:current.artifact,deploymentId:current.deploymentId??current.id,deploymentAt:current.at,rollbackRequestId:proposal.id,observedAt:now,evidenceUrl:'https://verifier-drill.invalid/'+run,checks:{technical:technical.requests>0&&technical.errors===0&&technical.p95Ms<=250,businessInvariants:technical.violations.length===0&&live.telemetry().violations.length===0}};
    await hook('verification',proof);await drain();
    assert.equal((await runtime.store.context(event.incidentId)).incident.status,'resolved');
    assert.equal((await runtime.store.snapshot()).rollbacks[0].status,'verified');
    result.outcome='recovery-verified';result.rollbackRequestId=proposal.id;result.dispatchCount=dispatches.length;
    stage('independent-recovery-verified',{incidentStatus:'resolved',rollbackStatus:'verified',checks:proof.checks});return result;
  } finally {
    result.githubRequests=calls;result.dispatchCount=dispatches.length;
    await runtime?.close();
  }
}
