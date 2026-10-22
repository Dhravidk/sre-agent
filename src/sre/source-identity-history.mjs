import {hash} from './security.mjs';
import {sourcePath,sourceInspectionLimits,retainedRequestedSource} from './source-evidence.mjs';
import {retainedDiscovery} from './source-discovery.mjs';
import {verifiedHistory} from './source-history.mjs';

export const sourceIdentityHistoryLimits=Object.freeze({identities:8,versionsPerIdentity:2,witnessBytes:262144});
const revision=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const key=value=>JSON.stringify([value.project,value.sha,value.path]);
export function validSourceVersion(file){
 return file?.state==='available'&&revision(file.sha)&&sourcePath(file.path)&&typeof file.content==='string'&&Buffer.byteLength(file.content,'utf8')<=sourceInspectionLimits.bytesPerFile&&hash(file.content)===file.contentHash&&digest(file.sourceContentHash)&&(file.redacted===true||file.sourceContentHash===file.contentHash)&&file.content.split(/\r?\n/).length===file.lineCount;
}

// Identity evidence can establish disagreement without its original log parent
// occupying the current display window. It cannot establish a positive quote,
// log reference, runtime mapping or permission to inspect another resource.
export function retainedSourceVersions(context,row){
 if(row?.source!=='gitlab'||hash([context.incident.id,row.source,row.kind,row.content])!==row.id)return [];
 const scope=context.sourceScope,proof=row.content,files=[];
 const add=(file,project)=>{if(validSourceVersion(file))files.push({project,sha:file.sha,path:file.path,sourceContentHash:file.sourceContentHash});};
 const withHistory=(file,project)=>{add(file,project);const history=verifiedHistory(file,project,scope?.discovery);if(history){add(history.head,project);for(const parent of history.parents)if(parent.state==='available')add(parent.source,project);}};
 if(['code_review','release_diff','change'].includes(row.kind)){
  const inspection=proof?.sourceInspection;if(!scope?.project||proof?.provider!=='gitlab'||inspection?.version!==1||inspection.provider!=='gitlab'||inspection.project!==scope.project||inspection.baseSha!==proof.baseSha||inspection.headSha!==proof.headSha||!revision(proof.baseSha)||!revision(proof.headSha))return [];
  for(const pair of (Array.isArray(inspection.files)?inspection.files:[]).slice(0,4))for(const side of ['base','head']){const file=pair?.[side];if(file?.sha===proof[side+'Sha']&&file.path===pair[side==='base'?'oldPath':'newPath'])add(file,scope.project);}
 }else if(row.kind==='source_locations'){
  const source=proof?.logSource;if(!scope?.project||!scope.logLocations||source?.version!==1||source.provider!=='gitlab'||source.project!==scope.project||source.environment!==scope.logEnvironment||JSON.stringify(source.mapping)!==JSON.stringify(scope.logLocations))return [];
  for(const file of (Array.isArray(source.files)?source.files:[]).slice(0,2))add(file,scope.project);
 }else if(row.kind==='source_requested'){
  const retained=retainedRequestedSource(row,{...context,evidence:[]});if(retained)withHistory(retained.source.file,retained.source.project);
 }else if(row.kind==='source_discovery'){
  const packet=retainedDiscovery({...context,evidence:[]},row);if(!packet)return [];
  for(const probe of packet.probes){if(!probe||!scope.discovery.projects.includes(probe.project)||probe.revision?.project!==probe.project||probe.revision.reportedRef!==probe.reportedRef||!revision(probe.revision.sha)||!['sha','tag'].includes(probe.revision.kind)||probe.revision.kind==='sha'&&probe.revision.sha!==probe.reportedRef||probe.revision.kind==='tag'&&(!scope.discovery.allowTags||revision(probe.reportedRef)))continue;for(const file of (Array.isArray(probe.files)?probe.files:[]).slice(0,2))if(file?.sha===probe.revision.sha)withHistory(file,probe.project);}
 }
 return files;
}

// Select at most two distinct original-byte hashes per requested immutable
// identity before hydrating packets. Repeated receipts cannot evict a different
// hash. These are result/hydration bounds, not a SQL scan or capacity guarantee.
export function sourceIdentityHistorySql(dialect){
 const pg=dialect==='postgres';
 const get=(value,path)=>pg?value+"#>'{"+path.join(',')+"}'":"json_extract("+value+",'$."+path.join('.')+"')";
 const text=(value,path)=>pg?value+"#>>'{"+path.join(',')+"}'":"CAST("+get(value,path)+' AS TEXT)';
 const each=(value,alias)=>pg?"jsonb_array_elements(CASE WHEN jsonb_typeof("+value+")='array' THEN "+value+" ELSE '[]'::jsonb END) "+alias+'(value)':"json_each(CASE WHEN json_type("+value+")='array' THEN "+value+" ELSE '[]' END) "+alias;
 const object=alias=>pg?alias+'.value':"CASE WHEN "+alias+".type='object' THEN "+alias+".value ELSE '{}' END";
 const doc='d.document',pair=object('pair'),probe=object('probe'),file=object('file'),parent=object('parent');
 const versionHash=text('v.file',['sourceContentHash']),target=object('target');
 const objectArray=pg?'jsonb_build_array':'json_array';
 const bytes=pg?'octet_length(e.content)':'length(CAST(e.content AS BLOB))';
 return "WITH documents AS MATERIALIZED (SELECT id,kind,"+(pg?'content::jsonb':'jsonb(content)')+" AS document FROM sre_evidence WHERE incident_id=? AND source='gitlab' AND kind IN ('code_review','release_diff','change','source_locations','source_requested','source_discovery')), primary_files AS ("+
  "SELECT d.id,"+text(doc,['sourceInspection','project'])+' AS project,'+file+' AS file FROM documents d,'+each(get(doc,['sourceInspection','files']),'pair')+','+each(objectArray+'('+get(pair,['base'])+','+get(pair,['head'])+')','file')+" WHERE d.kind IN ('code_review','release_diff','change') UNION ALL "+
  "SELECT d.id,"+text(doc,['logSource','project'])+','+file+' FROM documents d,'+each(get(doc,['logSource','files']),'file')+" WHERE d.kind='source_locations' UNION ALL "+
  "SELECT d.id,"+text(doc,['requestedSource','project'])+','+get(doc,['requestedSource','file'])+" FROM documents d WHERE d.kind='source_requested' UNION ALL "+
  "SELECT d.id,"+text(probe,['project'])+','+file+' FROM documents d,'+each(get(doc,['sourceDiscovery','probes']),'probe')+','+each(get(probe,['files']),'file')+" WHERE d.kind='source_discovery'), versions AS (SELECT id,project,file FROM primary_files UNION ALL SELECT id,project,"+get('file',['history','head'])+' FROM primary_files UNION ALL SELECT p.id,p.project,'+get(parent,['source'])+' FROM primary_files p,'+each(get('p.file',['history','parents']),'parent')+"), requested AS (SELECT "+(pg?'?::jsonb':'?')+" AS document), targets AS (SELECT "+text(target,['project'])+' AS project,'+text(target,['sha'])+' AS sha,'+text(target,['path'])+' AS path FROM requested,'+each('requested.document','target')+"), distinct_versions AS (SELECT t.project,t.sha,t.path,"+versionHash+" AS version_hash,MIN(v.id) AS evidence_id FROM versions v JOIN targets t ON t.project=v.project AND t.sha="+text('v.file',['sha'])+' AND t.path='+text('v.file',['path'])+" WHERE "+text('v.file',['state'])+"='available' GROUP BY t.project,t.sha,t.path,"+versionHash+"), ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY project,sha,path ORDER BY version_hash,evidence_id) AS version_rank,COUNT(*) OVER (PARTITION BY project,sha,path) AS versions_available FROM distinct_versions) SELECT r.*,e.source,e.kind,e.observed_at,CASE WHEN "+bytes+'<=? THEN e.content ELSE NULL END AS content FROM ranked r JOIN sre_evidence e ON e.id=r.evidence_id WHERE r.version_rank<=? ORDER BY r.project,r.sha,r.path,r.version_rank';
}

export async function readSourceIdentityHistory(store,context,files,query=store.db.query){
 const selected=[...new Map(files.map(file=>[key(file),{project:file.project,sha:file.sha,path:file.path}])).values()];
 if(selected.length>sourceIdentityHistoryLimits.identities||selected.some(file=>!revision(file.sha)||!sourcePath(file.path)||!((context.sourceScope?.project===file.project)||context.sourceScope?.discovery?.projects.includes(file.project))))throw Error('Source identity history requires bounded currently scoped file identities');
 if(!selected.length)return{version:1,identities:[],coverage:{identitiesChecked:0,witnessesRead:0,unverifiedIdentities:0,conflictingIdentities:0,additionalVersions:false,completeHistory:false}};
 const rows=await query(sourceIdentityHistorySql(store.db.dialect),[context.incident.id,JSON.stringify(selected),sourceIdentityHistoryLimits.witnessBytes,sourceIdentityHistoryLimits.versionsPerIdentity]);
 if(rows.length>selected.length*sourceIdentityHistoryLimits.versionsPerIdentity)throw Error('Source identity history exceeded its witness budget');
 const identities=selected.map(identity=>{
  const candidates=rows.filter(row=>key(row)===key(identity)),hashes=new Set(),witnesses=[];let unverified=!candidates.length;
  for(const row of candidates){let versions=[];try{const parsed={...row,id:row.evidence_id,content:JSON.parse(row.content)};versions=retainedSourceVersions(context,parsed);}catch{unverified=true;}
   const matching=versions.find(file=>key(file)===key(identity)&&file.sourceContentHash===row.version_hash);if(!matching)unverified=true;else hashes.add(matching.sourceContentHash);
   witnesses.push({evidenceId:row.evidence_id,sourceContentHash:matching?.sourceContentHash||null,verified:Boolean(matching)});
  }
  return{...identity,state:hashes.size>1?'conflicting':unverified?'unverified':'consistent',sourceContentHashes:[...hashes].sort(),witnesses,additionalVersions:candidates.some(row=>Number(row.versions_available)>candidates.length)};
 });
 return{version:1,identities,coverage:{identitiesChecked:identities.length,witnessesRead:rows.length,unverifiedIdentities:identities.filter(row=>row.state==='unverified').length,conflictingIdentities:identities.filter(row=>row.state==='conflicting').length,additionalVersions:identities.some(row=>row.additionalVersions),completeHistory:false}};
}

export function sourceIdentityState(context,file){
 if(!context.sourceIdentityHistory)return undefined;
 const identity=context.sourceIdentityHistory.identities?.find(identity=>key(identity)===key(file));
 return identity?.state==='conflicting'?'conflicting':identity?.state==='consistent'&&identity.sourceContentHashes?.includes(file.sourceContentHash)?'consistent':'unverified';
}

export function sourceIdentityHistoryWarning(context){
 const coverage=context.sourceIdentityHistory?.coverage;
 return coverage?.conflictingIdentities?'Retained source responses disagree at an immutable file identity. Affected location citations are withheld pending reconciliation.':coverage?.unverifiedIdentities?'Some stored source identity witnesses could not be verified. Affected citations remain unavailable; inspect the retained source reads.':null;
}
