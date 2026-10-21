import { randomUUID } from 'node:crypto';
import { normalize } from './normalize.mjs';
import { hash } from './security.mjs';
import { seedPilot, pilotDiff,pilotPolicySource } from '../../scripts/seed-pilot.mjs';
import { scenarios } from '../scenarios.mjs';

export async function seedDemo(store,service,scenario='recent-regression') {
  if(!['recent-regression','old-feature','schema-change','dependency-outage'].includes(scenario))throw new Error('Unknown demo scenario');
  const manifest=seedPilot();const now=store.clock();const run=randomUUID().slice(0,8);
  const release=manifest.releases[scenario==='schema-change'?'schema-break':'bid-race'];
  const description=scenarios.find(item=>item.id===(scenario==='schema-change'?'schema-break':scenario==='dependency-outage'?'dependency-outage':'bid-race'));
  const age=scenario==='old-feature'?180*86400000:300000;
  const compatibility={schemaVersion:1,dependencyFingerprint:'fixture-dependencies-v1',configurationFingerprint:'fixture-config-v1',featureFlagsFingerprint:'fixture-flags-v1'};
  for(const [index,sha] of [manifest.baseline,release.sha].entries()) {
    const at=now-age-(index===0?600000:0);
    await store.ingest(normalize('releases',{...compatibility,simulationRunId:run,provider:service.rollback.provider,environment:service.environment,sha,artifact:'sha256:'+hash(sha),status:'success',at,healthy:index===0,healthVerifiedAt:index===0?at+30000:null,rollbackCompatible:scenario!=='schema-change',dataRollbackSafe:scenario!=='schema-change',ticket:release.ticket,schemaVersion:scenario==='schema-change'&&index===1?2:1},service,{deliveryId:run+':release:'+index}));
  }
  const problem={simulationRunId:run,ProblemID:'P-'+run,State:'OPEN',Title:'Auction bidding: '+scenario,EntityIds:[service.dynatrace.entityId],StartedAt:now-60000,ObservedAt:now-60000,metrics:{violations:['dependency-outage','schema-change'].includes(scenario)?[]:['WINNING_BID_REGRESSED'],codes:scenario==='dependency-outage'?['CREDIT_PROVIDER_UNAVAILABLE']:scenario==='schema-change'?['SCHEMA_MISMATCH']:[],requests:12}};
  const result=await store.ingest(normalize('dynatrace',problem,service));
  const sysId=hash(run).slice(0,32);
  await store.ingest(normalize('servicenow',{sys_id:sysId,number:'INC-DEMO-'+run,cmdb_ci:service.servicenow.cmdbCi,correlation_id:'dynatrace:'+problem.ProblemID,short_description:'Dealers report inconsistent winning bids',state:'2',sys_created_on:new Date(now-60000).toISOString(),sys_updated_on:new Date(now-30000).toISOString()},service));
  await store.ingest(normalize('jira',{key:release.ticket,fields:{summary:description.title,description:description.description,updated:new Date(now).toISOString()}},service,{deliveryId:run+':jira'}));
  await store.ingest(normalize('logs',{timestamp:new Date(now).toISOString(),message:'Synthetic bidding signal: '+scenario,traceId:run,sha:release.sha},service));
  for(const source of ['github','gitlab'])await store.ingest({id:run+':'+source,source,serviceKey:service.key,kind:'change',incidentId:result.incidentId,at:now,payload:{synthetic:true,provider:source,comparisonKind:'deployment',complete:true,unrecognizedPaths:scenario==='schema-change'?['migrations/002-reserve.sql']:[],baseSha:manifest.baseline,headSha:release.sha,ticket:release.ticket,sha:release.sha,number:source==='github'?42:17,diff:pilotDiff(release.sha),policySources:{path:'src/auction/rules.mjs',complete:true,base:pilotPolicySource(manifest.baseline),head:pilotPolicySource(release.sha)}}});
  return {...result,scenario,simulation:true};
}

export function devActivity(text,service,{id=randomUUID(),userId='local-operator',displayName='Local operator',serviceUrl='http://127.0.0.1:1',conversationId=service.teams.conversations[0],conversationType='personal',mentioned=true,replyToId}={}) {
  if(!['personal','groupChat','channel'].includes(conversationType))throw new Error('Invalid simulated conversation type');
  const conversation={id:conversationId,conversationType};
  const activity={type:'message',id,timestamp:new Date().toISOString(),channelId:'msteams',serviceUrl,from:{id:userId,aadObjectId:userId,name:displayName},recipient:{id:'local-sre',name:'SRE'},conversation,channelData:{tenant:{id:service.teams.tenantId}},text,...(replyToId?{replyToId}:{})};
  if(mentioned&&conversationType!=='personal')activity.entities=[{type:'mention',mentioned:activity.recipient,text:'<at>SRE</at>'}];
  return {activity,reference:{serviceUrl,channelId:'msteams',bot:activity.recipient,user:activity.from,conversation}};
}
