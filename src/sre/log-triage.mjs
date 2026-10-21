import {logIdentity} from './signal-digest.mjs';
import {logRecordHash} from './log-observation.mjs';

// Data reduction only. No signature here identifies a particular application
// defect or supplies a causal diagnosis; Claude must examine the evidence.
export const logTriageLimits=Object.freeze({records:100000,groups:4096,selectedGroups:20,samplesPerGroup:2});
const score=g=>(g.rank>=4?4:g.rank===3?3:1)+(g.references.length?2:0)+(g.code||g.errorType||Number(g.statusCode)>=400?2:0);
const stratum=g=>JSON.stringify([g.level,g.version,g.environment,g.region,g.operation,g.statusCode]);
const stamp=value=>{const n=typeof value==='number'?value:Date.parse(value);return Number.isSafeInteger(n)&&n>=0?n:null;};
const short=(s,n)=>Array.from(String(s??'')).slice(0,n).join('');
export function logCodeReferences(records){
  const found=new Map();
  for(const record of records){
    const text=['code.filepath','stack','stacktrace','exception.stacktrace','content','message'].map(k=>typeof record?.[k]==='string'?record[k]:'').join('\n').slice(0,12000);
    const pattern=/((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:[cm]?js|[jt]sx?|py|go|java|cs|rb|rs))(?::(\d{1,7}))?/g;
    for(const m of text.matchAll(pattern)){
      const path=m[1];if(path.length>512||path.split('/').some(p=>p==='..'||p==='.'))continue;
      const line=m[2]?Number(m[2]):null,key=path+':'+line;
      if(found.size<40)found.set(key,{path,line});
    }
  }
  return [...found.values()];
}
function sample(record){
  if(Buffer.byteLength(JSON.stringify(record))<=2200)return record;
  const keys=['timestamp','at','loglevel','level','severity','error.code','errorCode','error.type','exception.type','http.response.status_code','service.name','dt.entity.service','deployment.environment','environment','cloud.region','region','operation','http.route','service.version','release','sha','trace.id','trace_id','request.id','requestId'];
  const value={};let omittedFields=0;
  for(const key of keys)if(record[key]!==undefined){if(typeof record[key]==='string'&&record[key].length>512)omittedFields++;else value[key]=record[key];}
  for(const key of ['content','message','stack','exception.stacktrace'])if(typeof record[key]==='string')value[key]=short(record[key],key.includes('stack')?700:500);
  return {...value,projectionTruncated:true,omittedFields};
}
export function triageLogBatch(content){
  const records=Array.isArray(content?.records)?content.records:[],groups=new Map(),seen=new Set(),buckets=new Map(),stratumKeys=new Map();
  const summaries=new Map((content.aggregates||[]).slice(0,200).map(a=>[a.sampleHash,a]));
  const remember=group=>{const s=score(group),keys=buckets.get(s)||new Set();keys.add(group.key);buckets.set(s,keys);const k=stratum(group),members=stratumKeys.get(k)||new Set();members.add(group.key);stratumKeys.set(k,members);};
  const forget=group=>{buckets.get(score(group))?.delete(group.key);const k=stratum(group),members=stratumKeys.get(k);members?.delete(group.key);if(!members?.size)stratumKeys.delete(k);};
  let scanned=0,invalid=0,duplicates=0,missingTimestamps=0,unretained=0;
  for(const record of records.slice(0,logTriageLimits.records)){
    scanned++;
    if(!record||typeof record!=='object'||Array.isArray(record)){invalid++;continue;}
    const at=stamp(record.timestamp??record.at);if(at===null)missingTimestamps++;
    const unique=at===null?null:logRecordHash('dynatrace',record);
    if(unique&&seen.has(unique)){duplicates++;continue;}if(unique)seen.add(unique);
    const {identity,key,rank}=logIdentity(record,'dynatrace'),references=logCodeReferences([record]);
    let group=groups.get(key);
    if(!group){
      if(groups.size>=logTriageLimits.groups){
        // A late severe/stack-bearing record can displace routine noise.
        const incoming=score({rank,references,...identity});let victimKey;
        for(const value of [...buckets.keys()].sort((a,b)=>a-b)){
          if(value>=incoming||victimKey)break;
          // Retain the last witness for an operation/release stratum even
          // when later routine ERROR messages rank above that witness.
          for(const key of buckets.get(value))if(stratumKeys.get(stratum(groups.get(key)))?.size>1){victimKey=key;break;}
        }
        // Unique routine messages must not consume every slot before a new
        // operation/release/severity stratum arrives, even without error hints.
        if(!victimKey&&!stratumKeys.has(stratum(identity))){let largest=null;for(const members of stratumKeys.values())if(members.size>1&&(!largest||members.size>largest.size))largest=members;victimKey=largest?.values().next().value;}
        if(!victimKey){unretained++;continue;}const victim=groups.get(victimKey);unretained+=victim.observations;forget(victim);groups.delete(victimKey);
      }
      group={key,rank,...Object.fromEntries(Object.entries(identity).map(([k,v])=>[k,short(v,k==='message'?250:160)])),observations:0,firstAt:null,lastAt:null,samples:[],references,serverAggregates:[]};groups.set(key,group);remember(group);
    }
    group.observations++;
    if(at!==null){group.firstAt=group.firstAt===null?at:Math.min(group.firstAt,at);group.lastAt=group.lastAt===null?at:Math.max(group.lastAt,at);}
    const item=sample(record);if(group.samples.length<logTriageLimits.samplesPerGroup)group.samples.push(item);else group.samples[1]=item;
    forget(group);for(const ref of references)if(group.references.length<8&&!group.references.some(r=>r.path===ref.path&&r.line===ref.line))group.references.push(ref);remember(group);
    const aggregate=summaries.get(unique);if(aggregate&&group.serverAggregates.length<2)group.serverAggregates.push(aggregate);
  }
  const sorted=[...groups.values()].sort((a,b)=>score(b)-score(a)||a.observations-b.observations||(b.lastAt||0)-(a.lastAt||0)||a.key.localeCompare(b.key)),selected=[],banks=new Map();
  for(const group of sorted){const key=JSON.stringify([group.source,group.entity,group.environment,group.operation]),bank=banks.get(key)||[];bank.push(group);banks.set(key,bank);}
  // One severity cannot consume the entire transport window. Reserve distinct
  // operations, then release/severity/region counterevidence within each one.
  // These are inspection strata, not judgments that an operation is unhealthy.
  const orderedBanks=[...banks.values()].sort((a,b)=>a.reduce((n,g)=>n+g.observations,0)-b.reduce((n,g)=>n+g.observations,0)||a[0].key.localeCompare(b[0].key));
  for(const bank of orderedBanks.slice(0,10))selected.push(bank[0]);
  const strata=new Set(selected.map(stratum));let advanced=true;
  while(selected.length<16&&advanced){advanced=false;for(const bank of orderedBanks){const group=bank.find(g=>!selected.includes(g)&&!strata.has(stratum(g)));if(group&&selected.length<16){selected.push(group);strata.add(stratum(group));advanced=true;}}}
  for(const group of sorted)if(selected.length<logTriageLimits.selectedGroups&&!selected.includes(group))selected.push(group);
  selected.sort((a,b)=>score(b)-score(a)||a.observations-b.observations||a.key.localeCompare(b.key));
  return {coverage:{recordsAvailable:records.length,recordsScanned:scanned,recordsNotScanned:records.length-scanned,duplicateObservations:duplicates,invalidRecords:invalid,missingTimestamps,retainedGroups:groups.size,selectedGroups:selected.length,operationsAvailable:banks.size,operationsSelected:new Set(selected.map(g=>JSON.stringify([g.source,g.entity,g.environment,g.operation]))).size,omittedGroups:Math.max(0,groups.size-selected.length),unretainedObservations:unretained,sourceComplete:content.complete===true,sourceCoverage:content.coverage||null},groups:selected.map(({rank,...g})=>g),interpretation:'Host data reduction, not diagnosis. observations counts only unique observed samples in this batch, not population failures or rates. serverAggregates are provider counts for structured strata; an arbitrary sample cannot characterize every message in its stratum. Do not add aggregate counts to sample counts. Operation/release diversity and rarity/severity/stack references prioritize inspection, not causality. Samples and queries may be incomplete; overlapping batches are not independent evidence.'};
}
export async function retainLogTriage(store,incidentId,rawEvidenceId,content){
  const triage=triageLogBatch(content),ids=[];
  for(const group of triage.groups)ids.push(await store.addEvidence(incidentId,'dynatrace','log_triage',{derivedFrom:rawEvidenceId,hostDataReduction:true,complete:false,records:group.samples,triage:{...group,samples:undefined},coverage:triage.coverage,interpretation:triage.interpretation}));
  return {ids,references:triage.groups.flatMap(g=>g.references.map(ref=>({...ref,operation:g.operation,version:g.version}))),coverage:triage.coverage};
}

export function incidentLogReferences(context,references){
  const operations=new Set(context.evidence.filter(row=>row.kind==='problem').flatMap(row=>[row.content?.operation,row.content?.affectedOperation]).filter(v=>typeof v==='string'&&v.length<=512));
  return [...references].sort((a,b)=>Number(operations.has(b.operation))-Number(operations.has(a.operation)));
}

// Standard evidence redaction retains at most 500 array entries. Store larger
// batches as idempotent pages before publishing the manifest. Interrupted page
// writes cannot publish a complete batch; retries reuse content-addressed rows.
export async function retainLogBatch(store,incidentId,content){
  const records=Array.isArray(content?.records)?content.records:[];
  if(records.length<=500)return store.addEvidence(incidentId,'dynatrace','logs',content);
  const retained=Math.min(records.length,logTriageLimits.records),pages=[];
  for(let offset=0;offset<retained;offset+=500)pages.push(await store.addEvidence(incidentId,'dynatrace','log_page',{offset,records:records.slice(offset,Math.min(offset+500,retained)),projection:'Standard evidence redaction and per-record field/string/depth bounds apply.'}));
  return store.addEvidence(incidentId,'dynatrace','logs',{...content,records:[],rawPages:pages,complete:content.complete===true&&retained===records.length,retention:{recordsAvailable:records.length,recordsRetained:retained,recordsNotRetained:records.length-retained,pageSize:500,pages:pages.length},interpretation:'Records are retained in redacted rawPages. Pages are excluded from the bounded model snapshot; derived log_triage rows contain selected samples. Missing records, redaction and per-record storage projection remain limitations.'});
}
