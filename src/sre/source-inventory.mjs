import {hash} from './security.mjs';
import {sourcePath} from './source-evidence.mjs';
import {discoverySha} from './source-discovery-config.mjs';
import {validateEvidenceRequests} from './evidence-request.mjs';

export const sourceInventoryLimits=Object.freeze({pages:2,pageSize:100,directories:4,displayEntries:40,displayBytes:12000});
export const sourceDirectoryPath=value=>value===''||sourcePath(value);
const identity=value=>JSON.stringify([value.project,value.sha,value.path]);
const entryIdentity=value=>JSON.stringify([value.id,value.type,value.mode]);
export function validatedSourceInventory(value,{project,sha,path}){
 if(!sourceDirectoryPath(path)||!discoverySha(sha)||value?.project!==project||value.sha!==sha||value.path!==path||value.recursive!==false||typeof value.complete!=='boolean'||!Array.isArray(value.entries)||value.entries.length>sourceInventoryLimits.pages*sourceInventoryLimits.pageSize||!Number.isSafeInteger(value.invalidEntries)||value.invalidEntries<0)throw Error('Directory inventory scope, identity or coverage is unverified');
 let invalidEntries=value.invalidEntries;const entries=[],seen=new Set();
 for(const entry of value.entries){
  if(!entry||!sourcePath(entry.path)||!discoverySha(entry.id)||entry.name!==entry.path.split('/').at(-1)||entry.path!==[path,entry.name].filter(Boolean).join('/')||!(entry.type==='tree'&&entry.mode==='040000'||entry.type==='blob'&&['100644','100755'].includes(entry.mode))||seen.has(entry.path)){invalidEntries++;continue;}
  seen.add(entry.path);entries.push({id:entry.id,type:entry.type,mode:entry.mode,path:entry.path,name:entry.name});
 }
 return{project,sha,path,recursive:false,entries,invalidEntries,limitReached:value.limitReached===true||value.entries.length===sourceInventoryLimits.pages*sourceInventoryLimits.pageSize,complete:value.complete&&invalidEntries===0&&value.entries.length<sourceInventoryLimits.pages*sourceInventoryLimits.pageSize};
}
export function retainedSourceInventory(row,context){
 const source=row.content?.sourceInventory,scope=context.sourceScope,host=source?.hostRead;
 if(row.source!=='gitlab'||row.kind!=='source_inventory'||scope?.provider!=='gitlab'||source?.version!==1||!host||!/^[a-f0-9]{64}$/.test(host.requestId||'')||!/^[a-f0-9]{64}$/.test(host.jobId||'')||!Number.isSafeInteger(host.attempt)||host.attempt<1||!Number.isSafeInteger(Number(row.observed_at))||Number(row.observed_at)<0)return null;
 if(context.incident?.id&&hash([context.incident.id,row.source,row.kind,row.content])!==row.id)return null;
 let request,value;try{[request]=validateEvidenceRequests([source.request]);if(request.kind!=='gitlab_tree')return null;const candidate=Boolean(request.project&&scope.discovery?.projects.includes(request.project)&&source.discoveryScopeKey===scope.discovery.scopeKey);if(request.project?source.project!==request.project||!candidate:!scope.project||source.project!==scope.project)return null;value=validatedSourceInventory(source,{project:source.project,sha:request.sha,path:request.path});}catch{return null;}
 const parent=(context.evidence||[]).find(item=>item.id===host.requestId);if(parent&&(parent.source!=='system'||parent.kind!=='evidence_read'||parent.content?.phase!=='started'||parent.content.jobId!==host.jobId||parent.content.attempt!==host.attempt||JSON.stringify(parent.content.request)!==JSON.stringify(request)))return null;
 return{...value,evidenceId:row.id,observedAt:Number(row.observed_at),mappingCandidate:Boolean(request.project),parentEvidenceOmitted:!parent};
}
function inventoryConflict(observations){
 const paths=new Map();for(const value of observations)for(const entry of value.entries){const old=paths.get(entry.path);if(old&&old!==entryIdentity(entry))return true;paths.set(entry.path,entryIdentity(entry));}
 return observations.filter(value=>value.complete).some(value=>{const listed=new Set(value.entries.map(entry=>entry.path));return[...paths.keys()].some(path=>!listed.has(path));});
}
// The full retained input supplies conflict guards. A model projection may
// navigate only entries supported by artifacts actually delivered to it.
export function sourceInventoryWindow(context,{evidenceIds}={}){
 const groups=new Map();let unverified=0;
 for(const row of context.evidence||[]){if(row.source!=='gitlab'||row.kind!=='source_inventory')continue;const value=retainedSourceInventory(row,context);if(!value){unverified++;continue;}const key=identity(value),group=groups.get(key)||[];group.push(value);groups.set(key,group);}
 const values=[];let conflictCount=0;
 for(const group of groups.values()){
  group.sort((a,b)=>b.observedAt-a.observedAt||a.evidenceId.localeCompare(b.evidenceId));
  const full=group.filter(value=>value.complete),conflicting=inventoryConflict(group);
  if(conflicting)conflictCount++;
  const visible=evidenceIds?group.filter(value=>evidenceIds.has(value.evidenceId)):group;if(!visible.length)continue;
  const visibleFull=visible.filter(value=>value.complete),anchor=visibleFull[0]||visible[0],byPath=new Map();
  if(!conflicting)for(const value of visible)for(const entry of value.entries){let found=byPath.get(entry.path);if(!found){found={...entry,evidenceIds:[]};byPath.set(entry.path,found);}if(found.evidenceIds.length<4&&!found.evidenceIds.includes(value.evidenceId))found.evidenceIds.push(value.evidenceId);}
  const entries=[...byPath.values()].sort((a,b)=>a.path.localeCompare(b.path));for(const entry of entries)entry.evidenceIds.sort();
  values.push({...anchor,entries,complete:!conflicting&&visibleFull.length>0,conflicting,latestObservedAt:group[0].observedAt,latestObservationPartial:!group[0].complete,observationsAvailable:group.length,observationsIncluded:visible.length,observationEvidenceIds:visible.slice(0,4).map(value=>value.evidenceId),observationReferencesOmitted:Math.max(0,visible.length-4),...(evidenceIds&&full.length&&!visibleFull.length?{completenessEvidenceOmitted:true}:{}),...(evidenceIds&&conflicting&&!inventoryConflict(visible)?{conflictEvidenceOmitted:true}:{})});
 }
 values.sort((a,b)=>b.latestObservedAt-a.latestObservedAt||identity(a).localeCompare(identity(b)));
 const buckets=new Map();for(const value of values){const bucket=buckets.get(value.project)||[];bucket.push(value);buckets.set(value.project,bucket);}const selected=[];while(selected.length<sourceInventoryLimits.directories&&[...buckets.values()].some(bucket=>bucket.length))for(const bucket of buckets.values())if(bucket.length&&selected.length<sourceInventoryLimits.directories)selected.push(bucket.shift());
 // Allocate complete entries in rounds across all selected directories.
 // Sort only the allocation order so receipt-time churn cannot alter which
 // project gets the shared byte budget; retain the UI's observed group order.
 let bytes=0;const allocated=new Map(selected.map(value=>[identity(value),[]])),cursors=new Map(selected.map(value=>[identity(value),0])),allocation=[...selected].sort((a,b)=>identity(a).localeCompare(identity(b)));
 while(allocation.some(value=>cursors.get(identity(value))<value.entries.length&&allocated.get(identity(value)).length<sourceInventoryLimits.displayEntries))for(const value of allocation){const key=identity(value),target=allocated.get(key),index=cursors.get(key);if(index>=value.entries.length||target.length>=sourceInventoryLimits.displayEntries)continue;const entry=value.entries[index];cursors.set(key,index+1);const size=Buffer.byteLength(JSON.stringify({...entry,evidenceIds:Array(4).fill('f'.repeat(64))}),'utf8');if(bytes+size>sourceInventoryLimits.displayBytes)continue;target.push(entry);bytes+=size;}
 let entriesAvailable=0,entriesIncluded=0;const inventories=selected.map(value=>{const entries=allocated.get(identity(value));entriesAvailable+=value.entries.length;entriesIncluded+=entries.length;return{...value,entries,entriesAvailable:value.entries.length,entriesOmitted:value.entries.length-entries.length};});
 return{version:1,inventories,coverage:{directoriesAvailable:groups.size,directoriesIncluded:inventories.length,directoriesOmitted:Math.max(0,groups.size-inventories.length),entriesAvailable,entriesIncluded,entriesOmitted:entriesAvailable-entriesIncluded,unverified,conflictingDirectories:conflictCount,sourceWindowLimited:context.evidenceWindow?.candidatesLimited===true},historicalAfterRestore:Boolean(context.recoveryFence?.active),interpretation:'Retained non-recursive directory observations at immutable revisions. Compatible partial observations are combined with per-entry provenance; their union cannot prove completeness. A retained complete witness is separate from current provider availability. Filenames are navigation evidence, not source contents, runtime mapping, cause or ownership. Partial or omitted inventory cannot prove a file absent.'};
}
export const materialSourceInventory=window=>window?.inventories?.length?{inventories:[...window.inventories].sort((a,b)=>identity(a).localeCompare(identity(b))).map(value=>[value.project,value.sha,value.path,value.complete,value.conflicting,value.entriesOmitted,[...value.entries].sort((a,b)=>a.path.localeCompare(b.path)).map(entry=>[entry.path,entry.id,entry.type,entry.mode])]),limited:Boolean(window.coverage?.directoriesOmitted||window.coverage?.entriesOmitted||window.coverage?.unverified||window.coverage?.sourceWindowLimited),historical:Boolean(window.historicalAfterRestore)}:null;
export function sourceInventoryText(window,{limit=2}={}){
 if(!window?.inventories?.length)return'';return['Retained source directory observations',...window.inventories.slice(0,limit).flatMap(value=>[value.project+' / '+(value.path||'[repository root]')+' @ '+value.sha.slice(0,12)+' · '+(value.conflicting?'conflicting; entries withheld':value.complete?'retained complete witness within the read bound':'partial inventory')+' · evidence '+value.evidenceId+(value.observationsIncluded>1?' · '+value.observationsIncluded+' retained observations':''),...value.entries.slice(0,4).map(entry=>entry.type+' '+entry.path+(entry.evidenceIds?.length?' · evidence '+entry.evidenceIds[0]:'')),value.entries.length>4||value.entriesOmitted?'Further directory entries are omitted from this brief.':'']),window.inventories.length>limit?'Further retained directories are omitted from this brief.':'',window.historicalAfterRestore?'Retained directory observations are historical after database restoration.':'','Paths support navigation only; runtime mapping and cause remain unverified.'].filter(Boolean).join('\n');
}

// These are selection lanes, never scope or provenance validation. Exclude
// request/receipt churn from fact diversity, and retain projects/directories
// before the SQL candidate limit. Legacy artifacts need no migration.
export function inventorySelectionSql(dialect){
 const pg=dialect==='postgres',field=(path,raw=false)=>pg?"e.content::jsonb"+(raw?'#>':'#>>')+"'{"+path.split('.').join(',')+"}'":(raw?'json_extract(':'CAST(json_extract(')+"e.content,'$."+path+"')"+(raw?'':' AS TEXT)');
 const active="e.source='gitlab' AND e.kind='source_inventory'",array=values=>pg?'jsonb_build_array('+values.join(',')+')::text':'json_array('+values.join(',')+')',project="COALESCE("+field('sourceInventory.project')+",'')",resource=array(['sourceInventory.sha','sourceInventory.path'].map(path=>field(path))),facts=array(['sourceInventory.complete','sourceInventory.invalidEntries','sourceInventory.limitReached','sourceInventory.entries'].map(path=>field(path,true)));
 return{project:'CASE WHEN '+active+' THEN '+project+" ELSE '' END",resource:'CASE WHEN '+active+' THEN '+resource+" ELSE '' END",facts:'CASE WHEN '+active+' THEN '+facts+" ELSE '' END",priority:'CASE WHEN '+active+' AND '+field('sourceInventory.complete')+"='"+(pg?'true':'1')+"' THEN 0 ELSE 1 END"};
}

// Reorder only inventory rows inside their existing reserved code-evidence
// slots. Repeated receipts cannot crowd another project out of model context.
export function orderInventoryEvidence(rows){
 const recent=(a,b)=>Number(b.observed_at)-Number(a.observed_at)||String(b.id).localeCompare(String(a.id)),projects=new Map();
 for(const row of [...rows].sort(recent)){
  const source=row.content?.sourceInventory,project=typeof source?.project==='string'?source.project:'',key=JSON.stringify([source?.sha,source?.path]),facts=hash([source?.complete,source?.invalidEntries,source?.limitReached,source?.entries]);
  let directories=projects.get(project);if(!directories){directories=new Map();projects.set(project,directories);}let directory=directories.get(key);if(!directory){directory=new Map();directories.set(key,directory);}const bucket=directory.get(facts)||[];bucket.push(row);directory.set(facts,bucket);
 }
 const roundRobin=buckets=>{const result=[];while(buckets.some(bucket=>bucket.length))for(const bucket of buckets)if(bucket.length)result.push(bucket.shift());return result;};
 const perProject=[...projects.values()].map(directories=>roundRobin([...directories.values()].map(facts=>roundRobin([...facts.values()].sort((a,b)=>Number(b[0].content?.sourceInventory?.complete===true)-Number(a[0].content?.sourceInventory?.complete===true)||recent(a[0],b[0]))))));
 return roundRobin(perProject);
}
