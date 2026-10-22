import {logRecordHash} from './log-observation.mjs';
const stamp=value=>typeof value==='number'?value:Date.parse(value);

export function logInvestigationOptions(config={}){
  const raw=config.logInvestigation===undefined?{}:config.logInvestigation,allowed=['maxQueries','minWindowMs','scanLimitGbytes','timeoutMs','levelField','environmentField'];
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!allowed.includes(k)))throw Error('Invalid Dynatrace log investigation configuration');
  const options={maxQueries:8,minWindowMs:1000,scanLimitGbytes:0.125,timeoutMs:30000,levelField:'loglevel',environmentField:'deployment.environment',...raw};
  if(!Number.isInteger(options.maxQueries)||options.maxQueries<3||options.maxQueries>8||!Number.isSafeInteger(options.minWindowMs)||options.minWindowMs<1||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<100||options.timeoutMs>60000||!Number.isFinite(options.scanLimitGbytes)||options.scanLimitGbytes<=0||options.scanLimitGbytes>1||[options.levelField,options.environmentField].some(f=>!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(f)))throw Error('Invalid Dynatrace log investigation budgets');
  return options;
}

export async function readInvestigationLogs(client,{from,to,environment,signal}={}){
  if(!Number.isSafeInteger(from)||from<0||!Number.isSafeInteger(to)||to<=from||!Number.isFinite(new Date(to).getTime()))throw Error('Dynatrace investigation needs an exact finite time window');
  if(!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(client.config.logField||'')||typeof client.config.logValue!=='string'||!client.config.logValue)throw Error('Configure an exact Dynatrace log service field/value');
  if(typeof environment!=='string'||!environment.trim()||environment.length>256)throw Error('Dynatrace investigation requires an explicit service environment');
  const options=logInvestigationOptions(client.config),deadline=AbortSignal.timeout(options.timeoutMs),querySignal=signal?AbortSignal.any([signal,deadline]):deadline;
  const queue=[{kind:'signatures',from,to},{kind:'priority',from,to},{kind:'baseline',from,to}],receipts=[],records=[],aggregates=[],seen=new Set(),projections=new Map(),projected=new Set();let incompletePriority=0,failed=false,baselineComplete=false,aggregateComplete=false,equivalentProjections=0,ambiguousProjections=0;
  const level=options.levelField,priority='('+['ERROR','FATAL','CRITICAL','WARN','WARNING'].map(v=>level+' == '+JSON.stringify(v)).join(' or ')+' or isNotNull(error.code) or isNotNull(exception.type) or http.response.status_code >= 400)';
  // Aggregate in Grail before the result limit. One arbitrary representative
  // per structured stratum is not a random/unbiased population sample and may
  // miss other messages within that stratum; keep broad and targeted reads.
  const strata=[...new Set([client.config.logField,options.environmentField,level,'log.source','code.filepath','error.code','exception.type','http.response.status_code','http.route','service.version','cloud.region'])];
  const sampleFields=[...new Set(['timestamp',...strata,'content','message','stack','exception.stacktrace','trace.id','request.id'])];
  const projection=row=>Object.fromEntries(sampleFields.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
  function retain(row,isProjection){
    if(!Number.isSafeInteger(stamp(row.timestamp))){records.push(row);return;}
    const key=logRecordHash('dynatrace',row),normalized=logRecordHash('dynatrace',projection(row)),bucket=projections.get(normalized)||[];
    if(seen.has(key)){equivalentProjections++;return;}
    if(isProjection&&bucket.length){equivalentProjections++;return;}
    const index=!isProjection?bucket.find(i=>projected.has(i)):undefined;
    if(index!==undefined){
      // Enrich an aggregate witness with the matching full record rather than
      // counting its projected and full query shapes as separate observations.
      const previous=logRecordHash('dynatrace',records[index]);records[index]=row;projected.delete(index);seen.delete(previous);seen.add(key);equivalentProjections++;
      for(const aggregate of aggregates)if(aggregate.sampleHash===previous)aggregate.sampleHash=key;
      return;
    }
    // Different full records can share the selected fields. Keep their extra
    // attributes; projection equality alone cannot prove provider-event identity.
    if(bucket.length)ambiguousProjections++;
    bucket.push(records.length);projections.set(normalized,bucket);if(isProjection)projected.add(records.length);records.push(row);seen.add(key);
  }
  while(queue.length&&receipts.length<options.maxQueries&&!querySignal.aborted){
    const window=queue.shift(),scope=client.config.logField+' == '+JSON.stringify(client.config.logValue)+' and '+options.environmentField+' == '+JSON.stringify(environment);
    const bounds='timestamp >= toTimestamp('+JSON.stringify(new Date(window.from).toISOString())+') and timestamp < toTimestamp('+JSON.stringify(new Date(window.to).toISOString())+')';
    const query='fetch logs, samplingRatio:1 | filter '+scope+' | filter '+bounds+(window.kind==='signatures'?' | summarize observations=count(), firstAt=min(timestamp), lastAt=max(timestamp), sample=takeAny(record('+sampleFields.join(', ')+')), by:{'+strata.join(', ')+'} | sort observations asc':(window.kind==='priority'?' | filter '+priority:'')+' | sort timestamp desc')+' | limit 200';
    try{
      const result=await client.query(query,{from:window.from,to:window.to,signal:querySignal,scanLimitGbytes:options.scanLimitGbytes,fetchTimeoutSeconds:10});
      let missingTime=false;const queryRecords=[],queryAggregates=[];
      if(!Array.isArray(result.records)||result.records.length>200)throw Error('Invalid bounded Dynatrace query result');
      for(const item of result.records){
        let row=window.kind==='signatures'?item.sample:item;
        const at=stamp(row?.timestamp);
        if(!row||row[client.config.logField]!==client.config.logValue||row[options.environmentField]!==environment||window.kind==='signatures'&&(item[client.config.logField]!==client.config.logValue||item[options.environmentField]!==environment)||Number.isFinite(at)&&(at<window.from||at>=window.to))throw Object.assign(Error('Dynatrace log result is outside the configured service/environment/time scope'),{scopeFailure:true});
        if(!Number.isSafeInteger(at))missingTime=true;
        if(window.kind==='signatures'){
          row=projection(row);
          const first=stamp(item.firstAt),last=stamp(item.lastAt);
          if(!Number.isSafeInteger(item.observations)||item.observations<1||!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<from||last>=to||first>last||Number.isSafeInteger(at)&&(at<first||at>last))throw Error('Invalid Dynatrace signature aggregate');
          queryAggregates.push({sampleHash:logRecordHash('dynatrace',row),observations:item.observations,firstAt:first,lastAt:last,stratum:Object.fromEntries(strata.map(k=>[k,item[k]??null])),sampleRepresentsEntireGroup:false});
        }
        queryRecords.push(row);
      }
      aggregates.push(...queryAggregates);
      for(const row of queryRecords)retain(row,window.kind==='signatures');
      const grail=result.metadata?.grail,metadataVerified=grail?.sampled===false&&Array.isArray(grail?.notifications);
      const complete=result.complete===true&&result.records.length<200&&metadataVerified&&grail.notifications.every(note=>note?.severity==='INFO')&&!missingTime;
      receipts.push({...window,records:result.records.length,complete,sampled:grail?.sampled??null,metadataVerified,missingTime,scannedRecords:Number.isSafeInteger(grail?.scannedRecords)?grail.scannedRecords:null,scannedBytes:Number.isSafeInteger(grail?.scannedBytes)?grail.scannedBytes:null,notifications:Array.isArray(grail?.notifications)?grail.notifications.slice(0,10):[]});
      if(window.kind==='signatures')aggregateComplete=complete;
      else if(window.kind==='baseline')baselineComplete=complete;
      else if(!complete){
        if(result.records.length===200&&window.to-window.from>options.minWindowMs){const mid=Math.floor((window.from+window.to)/2);queue.push({kind:'priority',from:window.from,to:mid},{kind:'priority',from:mid,to:window.to});}
        else incompletePriority++;
      }
    }catch(error){
      if(error.scopeFailure||signal?.aborted)throw error;
      failed=true;receipts.push({...window,complete:false,records:0,error:'Scoped query unavailable or exceeded its deadline'});break;
    }
  }
  if(signal?.aborted)throw signal.reason;
  const priorityComplete=!failed&&!deadline.aborted&&!incompletePriority&&!queue.some(w=>w.kind==='priority');
  const complete=baselineComplete&&priorityComplete&&aggregateComplete&&!failed&&!deadline.aborted;
  return {records,aggregates,complete,metadata:{grail:{sampled:receipts.some(r=>r.sampled===true),notifications:complete?[]:[{severity:'WARN',notificationType:'INVESTIGATION_COVERAGE_LIMIT'}]}},coverage:{strategy:'structured-strata-priority-baseline-v1',from,to,environment,equivalentProjections,ambiguousProjections,queries:receipts.length,maxQueries:options.maxQueries,maxScanGbytes:options.maxQueries*options.scanLimitGbytes,baselineComplete,priorityComplete,aggregateComplete,remainingWindows:queue.length,deadlineExceeded:deadline.aborted,failed,receipts},interpretation:'Grail aggregates count structured strata before the result limit, with one arbitrary sample per stratum; that sample cannot characterize all messages in its group. Targeted priority reads supplement a broad baseline. Equivalent projected/full witnesses are retained once with full attributes when available. Distinct full records sharing selected fields remain ambiguous; projected equality is not provider-event identity. These are not the whole log population. Bounded queries, denied reads, missing metadata, sampling and unfinished windows remain unknown.'};
}
