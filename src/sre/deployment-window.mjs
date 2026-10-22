import {isDeepStrictEqual} from 'node:util';
import {hash} from './security.mjs';
import {StorageError} from './database.mjs';
import {deploymentKey,deploymentHistory} from './deployments.mjs';

export const deploymentWindowLimits=Object.freeze({identities:50,variantsPerIdentity:20,facts:200});
const epoch=n=>Number.isSafeInteger(n)&&n>=0;
const sha=s=>typeof s==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s);
const invalid=()=>new StorageError(Error('Invalid retained deployment source or projection'));
const scopeId=x=>typeof x==='string'||typeof x==='number'?String(x):null;

export function orderDeploymentEvidence(rows){
 const priority=row=>Math.min(4,...(Array.isArray(row.historyRoles)?row.historyRoles:[]).map(role=>({current:0,unsettled:0,'incident-start':1,health:2,'latest-observation':3})[role]??4)),recent=(a,b)=>b.at-a.at||String(b.recordId||'').localeCompare(String(a.recordId||'')),buckets=new Map();
 for(const row of [...rows].sort((a,b)=>priority(a)-priority(b)||recent(a,b))){const key=deploymentKey(row),bucket=buckets.get(key)||[];bucket.push(row);buckets.set(key,bucket);}
 const ordered=[...buckets.values()].sort((a,b)=>priority(a[0])-priority(b[0])||recent(a[0],b[0])),result=[];
 while(ordered.some(bucket=>bucket.length))for(const bucket of ordered)if(bucket.length)result.push(bucket.shift());
 return result;
}

async function simulationScope(store,q,incident){
 if(!store.simulation)return {run:null,ambiguous:false};
 const field=store.db.dialect==='postgres'?"content::jsonb->>'simulationRunId'":"json_extract(content,'$.simulationRunId')";
 const type=store.db.dialect==='postgres'?"jsonb_typeof(content::jsonb->'simulationRunId')":"json_type(content,'$.simulationRunId')";
 const rows=await q("SELECT DISTINCT "+field+" AS run,"+type+" AS run_type FROM sre_evidence WHERE incident_id=? AND kind='problem' AND source NOT IN ('github','gitlab') AND "+field+" IS NOT NULL LIMIT 2",[incident.id]);
 return rows.length===1&&['string','text'].includes(rows[0].run_type)&&typeof rows[0].run==='string'&&rows[0].run.length>0&&rows[0].run.length<=256?{run:rows[0].run,ambiguous:false}:{run:null,ambiguous:rows.length>0};
}

// Reserve native identities before delivery counts, then retain bounded semantic
// versions of each identity. Raw deliveries stay in SQL. Omitted versions of a
// selected identity must not certify its runtime identity or recovery authority.
export async function readDeploymentWindow(store,incident,service,query=store.db.query){
 if(!incident||typeof incident.service_key!=='string'||!epoch(Number(incident.started_at)))throw invalid();
 const dialect=store.db.dialect,pg=dialect==='postgres',scope=await simulationScope(store,query,incident),at=Number(incident.started_at),env=service?.environment??null,now=await store.coordinationNow(query),targetCutoff=now-Number(service?.rollback?.maxTargetAgeHours||24)*3600000;
 const field=path=>pg?"p::jsonb#>>'{"+path.split('.').join(',')+"}'":"json_extract(p,'$."+path+"')",array=parts=>pg?'jsonb_build_array('+parts.join(',')+')::text':'json_array('+parts.join(',')+')',truth=x=>pg?x+"='true'":x+'=1';
 const p=field('provider'),environment=field('environment'),native="COALESCE("+field('deploymentId')+','+field('id')+')',text=x=>'CAST('+x+' AS TEXT)',identity=array([p,environment,"CASE WHEN "+native+" IS NULL THEN 'release' ELSE 'deployment' END","CASE WHEN "+native+" IS NULL THEN "+text(field('sha'))+' ELSE '+text(native)+' END',"CASE WHEN "+native+' IS NULL THEN occurred_at ELSE NULL END']);
 const versionFields=['sha','artifact','status','healthy','healthVerifiedAt','rollbackCompatible','dataRollbackSafe','schemaVersion','dependencyFingerprint','configurationFingerprint','featureFlagsFingerprint','rollbackRequestId','repository','project'];
 const typed=path=>pg?["jsonb_typeof(p::jsonb#>'{"+path+"}')","p::jsonb#>'{"+path+"}'"]:["json_type(p,'$."+path+"')",field(path)];
 const semantic=array([...versionFields.flatMap(typed),'CASE WHEN occurred_at<='+at+' THEN 0 ELSE 1 END']);
 const sourcePayload=pg?"e.payload::jsonb->'payload'":"json_extract(e.payload,'$.payload')";
 const environmentKnown=pg?"jsonb_typeof(p::jsonb->'environment')='string' AND length("+environment+")>0":"json_type(p,'$.environment')='text' AND length("+environment+")>0";
 const healthTime=pg?"CASE WHEN jsonb_typeof(p::jsonb->'healthVerifiedAt')='number' AND "+field('healthVerifiedAt')+" ~ '^[0-9]{1,16}$' THEN CAST("+field('healthVerifiedAt')+" AS NUMERIC) ELSE NULL END":"CASE WHEN json_type(p,'$.healthVerifiedAt')='integer' THEN "+field('healthVerifiedAt')+" ELSE NULL END";
 const parameter=pg?'?::text':'?';
 const materialized=' AS MATERIALIZED ';
 const sql=`WITH source_rows${materialized}(
  SELECT d.*,e.payload AS source_event,e.body_hash,e.source AS event_source,e.external_id,e.kind AS event_kind,COALESCE(${sourcePayload},${pg?'d.payload::jsonb':'d.payload'}) AS p
  FROM sre_deployments d LEFT JOIN sre_events e ON e.id=d.id WHERE d.service_key=?
 ), scoped${materialized}(
  SELECT *,${identity} AS native_key,${semantic} AS semantic_key,${p} AS provider,${field('status')} AS status,${field('sha')} AS sha,${field('artifact')} AS artifact,${field('healthy')} AS healthy,${healthTime} AS health_verified_at
  FROM source_rows WHERE (${parameter} IS NULL OR ${environment}=${parameter} OR NOT COALESCE((${environmentKnown}),false)) AND (${parameter} IS NULL OR ${field('simulationRunId')}=${parameter} OR ${field('simulationRunId')} IS NULL)
 ), keys${materialized}(
  SELECT native_key,provider,MAX(occurred_at) AS last_at,
   MAX(CASE WHEN status='success' AND sha IS NOT NULL THEN occurred_at END) AS success_at,
   MAX(CASE WHEN status='success' AND sha IS NOT NULL AND occurred_at<=${at} THEN occurred_at END) AS before_at,
   MAX(CASE WHEN status='success' AND ${truth('healthy')} AND health_verified_at>=occurred_at AND health_verified_at<=${at} AND health_verified_at>=${targetCutoff} AND occurred_at>=${targetCutoff} THEN occurred_at END) AS healthy_at,
   MAX(CASE WHEN status IS NULL OR status NOT IN ('success','inactive') OR sha IS NULL THEN occurred_at END) AS uncertain_at
  FROM scoped GROUP BY native_key,provider
 ), ranked_keys${materialized}(
  SELECT *,ROW_NUMBER() OVER(PARTITION BY provider ORDER BY COALESCE(success_at,-1) DESC,native_key) AS success_rank,
   ROW_NUMBER() OVER(PARTITION BY provider ORDER BY COALESCE(before_at,-1) DESC,native_key) AS before_rank,
   ROW_NUMBER() OVER(PARTITION BY provider ORDER BY COALESCE(healthy_at,-1) DESC,native_key) AS healthy_rank,
   ROW_NUMBER() OVER(PARTITION BY provider ORDER BY COALESCE(uncertain_at,-1) DESC,native_key) AS uncertain_rank,
   MAX(success_at) OVER(PARTITION BY provider) AS latest_success_at
  FROM keys
 ), priorities${materialized}(
  SELECT *,CASE WHEN success_at IS NOT NULL AND success_rank<=2 OR uncertain_at IS NOT NULL AND uncertain_rank=1 THEN 0 WHEN before_at IS NOT NULL AND before_rank<=2 THEN 1 WHEN healthy_at IS NOT NULL AND healthy_rank<=3 THEN 2 ELSE 3 END AS priority FROM ranked_keys
 ), selected_keys${materialized}(
  SELECT * FROM priorities ORDER BY priority,last_at DESC,native_key LIMIT ${deploymentWindowLimits.identities}
 ), deliveries${materialized}(
  SELECT r.*,k.priority,k.last_at,k.success_at,k.before_at,k.healthy_at,k.uncertain_at,k.success_rank,k.before_rank,k.healthy_rank,k.uncertain_rank,k.latest_success_at,ROW_NUMBER() OVER(PARTITION BY r.native_key,r.semantic_key ORDER BY r.occurred_at DESC,r.id DESC) AS delivery_rank
  FROM scoped r JOIN selected_keys k ON k.native_key=r.native_key
 ), versions${materialized}(
  SELECT *,COUNT(*) OVER(PARTITION BY native_key) AS version_count,
   ROW_NUMBER() OVER(PARTITION BY native_key ORDER BY CASE WHEN occurred_at=success_at OR occurred_at=before_at OR occurred_at=last_at THEN 0 WHEN occurred_at=healthy_at THEN 1 ELSE 2 END,occurred_at DESC,id DESC) AS version_rank
  FROM deliveries WHERE delivery_rank=1
 ), facts${materialized}(
  SELECT * FROM versions WHERE version_rank<=${deploymentWindowLimits.variantsPerIdentity} ORDER BY version_rank,priority,last_at DESC,native_key LIMIT ${deploymentWindowLimits.facts}
 ), summary AS (
  SELECT (SELECT COUNT(*) FROM source_rows) AS total_records,(SELECT COUNT(*) FROM scoped) AS scoped_records,(SELECT COUNT(*) FROM keys) AS identities,
   (SELECT COUNT(*) FROM selected_keys) AS selected_identities,
   (SELECT COUNT(*) FROM ranked_keys k WHERE k.success_at=k.latest_success_at AND NOT EXISTS(SELECT 1 FROM selected_keys s WHERE s.native_key=k.native_key)) AS missing_current_ties
 ) SELECT facts.*,summary.* FROM summary LEFT JOIN facts ON TRUE ORDER BY facts.version_rank,facts.priority,facts.last_at DESC,facts.native_key`;
 const rows=await query(sql,[incident.service_key,env,env,scope.run,scope.run]),summary=rows[0]||{},facts=rows.filter(r=>r.id),selected=new Map();
 for(const row of facts)selected.set(row.native_key,(selected.get(row.native_key)||0)+1);
 const deployments=facts.map(row=>{
  try{
   const event=JSON.parse(row.source_event),payload=JSON.parse(row.payload),expected={...event.payload,at:event.at,source:event.source};
   if(!event||event.kind!=='deployment'||event.serviceKey!==incident.service_key||event.source!==row.event_source||event.id!==row.external_id||row.event_kind!=='deployment'||hash(event)!==row.body_hash||hash([event.source,event.serviceKey,event.id])!==row.id||Number(row.occurred_at)!==event.at||!epoch(event.at)||!isDeepStrictEqual(payload,expected))throw invalid();
   const native=payload.deploymentId??payload.id,provider=payload.provider,repository=service?.[provider],mismatched=payload.repository!==undefined&&repository?.repository&&String(payload.repository).toLowerCase()!==repository.repository.toLowerCase()||payload.project!==undefined&&repository?.project&&String(payload.project)!==String(repository.project);
   const incomplete=scope.ambiguous||Number(summary.missing_current_ties)>0||Number(row.version_count)>selected.get(row.native_key)||!['github','gitlab'].includes(provider)||typeof payload.environment!=='string'||!payload.environment||native!==undefined&&native!==null&&(!scopeId(native)||!['string','number'].includes(typeof native))||!sha(payload.sha)||Boolean(mismatched);
   const roles=[];if(payload.status==='success'&&row.occurred_at==row.success_at&&row.success_at==row.latest_success_at)roles.push('current');if(payload.status==='success'&&row.occurred_at==row.before_at&&Number(row.before_rank)<=2)roles.push('incident-start');if(row.occurred_at==row.uncertain_at&&Number(row.uncertain_rank)===1)roles.push('unsettled');if(payload.healthy===true&&row.occurred_at==row.healthy_at&&Number(row.healthy_rank)<=3)roles.push('health');if(row.occurred_at==row.last_at)roles.push('latest-observation');
   const {historyIncomplete,historyRoles,statusConflict,attestationConflicts,latestStoredStatus,latestObservationAt,...clean}=payload;return {...clean,recordId:row.id,historyRoles:roles,...(incomplete?{historyIncomplete:true}:{})};
  }catch(error){if(error instanceof StorageError)throw error;throw invalid();}
 });
 const history=deploymentHistory(deployments),latest=new Map(history.map(r=>[deploymentKey(r),r])),conflicts=new Set(history.filter(r=>r.identityConflict).map(deploymentKey));
 for(const row of deployments){const current=latest.get(deploymentKey(row));if(conflicts.has(deploymentKey(row)))row.identityConflict=true;if(current.statusConflict)row.statusConflict=true;if(current.attestationConflicts)row.attestationConflicts=current.attestationConflicts;row.latestStoredStatus=current.statusConflict?'conflicting':current.status;row.latestObservationAt=current.at;}
 deployments.sort((a,b)=>b.at-a.at||b.recordId.localeCompare(a.recordId));
 const coverage={totalRecords:Number(summary.total_records||0),scopedRecords:Number(summary.scoped_records||0),identitiesAvailable:Number(summary.identities||0),identitiesSelected:Number(summary.selected_identities||0),factsSelected:deployments.length,identityWindowLimited:Number(summary.identities)>Number(summary.selected_identities),incompleteIdentities:new Set(deployments.filter(r=>r.historyIncomplete).map(deploymentKey)).size,conflictingIdentities:conflicts.size,statusConflictingIdentities:history.filter(r=>r.statusConflict).length,attestationConflictingIdentities:history.filter(r=>r.attestationConflicts?.length).length,currentBoundaryLimited:Number(summary.missing_current_ties)>0,simulationScopeAmbiguous:scope.ambiguous,simulationRunId:scope.run,interpretation:'Bounded stored deployment history, not live provider completeness. Native identities precede replay counts; current, incident-start, health and unsettled witnesses have reserved lanes. Missing identity versions, current-boundary witnesses and unresolved field attestations remain uncertain and cannot authorize recovery.'};
 return {deployments,coverage};
}
