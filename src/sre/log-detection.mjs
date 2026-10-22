import {hash,redact} from './security.mjs';
import {coalesceLogSamples,logSampleId,readLogSample} from './log-observation.mjs';
import {inspectDetectionLog,detectionSourceIssue,LogAdmissionError} from './log-admission.mjs';
const ruleKey=rule=>hash([rule.id,[...rule.codes].sort(),rule.minCount,rule.windowSeconds]);

// A bounded monitor can be unavailable while independent monitors still have
// valid work. Storage, cache-integrity and unknown failures are not this error.
export class LogScopeLimitError extends Error {
  constructor(failures,incidents=[]) {
    super('Log detection exceeds 100 active scopes for '+failures.slice(0,6).map(item=>item.serviceKey+'/'+item.monitorId).join(', ')+(failures.length>6?' and '+(failures.length-6)+' more monitors':'')+'; narrow the source query. Independent monitors may continue; detection is incomplete.');
    this.name='LogScopeLimitError';this.code='LOG_SCOPE_LIMIT';this.failures=failures;this.incidents=[...new Set(incidents)];
  }
}

export function validateLogMonitor(rule) {
  if(!rule||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(rule.id||'')||!Array.isArray(rule.codes)||!rule.codes.length||rule.codes.length>20||rule.codes.some(c=>typeof c!=='string'||! /^[A-Z0-9_.:-]{1,100}$/.test(c)))throw Error('Log monitor needs an ID and explicit bounded error codes');
  if(!Number.isInteger(rule.minCount)||rule.minCount<1||rule.minCount>50||!Number.isInteger(rule.windowSeconds)||rule.windowSeconds<10||rule.windowSeconds>900)throw Error('Log monitor requires 1–50 observations in a 10–900 second window');
}

// Observed counts, not an inferred error rate. Persistent observation IDs
// deduplicate overlapping reads. Missing observations never close a problem.
export class LogDetector {
  constructor({store,services}){Object.assign(this,{store,services});this.identityRepairs=new Map();}
  ensureIdentity(service,rule){
    const key=service.key+':'+hash([ruleKey(rule),service.tenant,service.environment,service.dynatraceLogs?.logField,service.dynatraceLogs?.logValue]);let repair=this.identityRepairs.get(key);
    if(!repair){repair=this.store.coordinationNow().then(now=>coalesceLogSamples(this.store,service.key,ruleKey(rule),{oldest:now-rule.windowSeconds*1000,service})).then(result=>{if(!result.ready)this.identityRepairs.delete(key);return result.ready;},error=>{this.identityRepairs.delete(key);throw error;});this.identityRepairs.set(key,repair);}
    return repair;
  }
  async observe(service,source,batch) {
    const rules=service.logMonitors||[];if(!rules.length)return {matched:0,incidents:[]};
    for(const rule of rules)validateLogMonitor(rule);
    if(!Array.isArray(batch.records)||batch.records.length>500)throw Error('Log detection accepts up to 500 records per bounded page');
    for(const rule of rules)if(!await this.ensureIdentity(service,rule))throw Error('Log detection is held during restore reconciliation');
    const now=await this.store.coordinationNow(),maxWindow=Math.max(...rules.map(r=>r.windowSeconds))*1000;let matched=0;
    const coverage={version:1,records:batch.records.length,rejected:0,ignored:0,reasons:{},complete:batch.complete===true},accepted=[];
    for(const raw of batch.records){
      const record=redact(raw),fields=inspectDetectionLog(record,service);
      if(Number.isSafeInteger(fields.at)&&(fields.at>now||fields.at<now-maxWindow)){coverage.ignored++;continue;}
      if(fields.errorHint&&fields.codes.some(code=>rules.some(rule=>rule.codes.includes(code)))&&!fields.issues.includes('record')){const issue=detectionSourceIssue(record,service,source);if(issue){fields.issues.push(issue);fields.rejected=true;}}
      if(fields.rejected){coverage.rejected++;for(const issue of fields.issues)coverage.reasons[issue]=(coverage.reasons[issue]||0)+1;continue;}
      if(!Number.isSafeInteger(fields.at)||!['ERROR','FATAL'].includes(fields.level)||fields.scope?.environment!==service.environment||!rules.some(rule=>rule.codes.includes(fields.code))){coverage.ignored++;continue;}
      accepted.push({record,...fields});
    }
    if(coverage.rejected)coverage.complete=false;
    await this.store.db.transaction(async q=>{
      if((await this.store.restoreFence(q))?.active)throw Error('Log detection is held during restore reconciliation');
      const knownGroups=new Map();
      for(const {record,at,code,scope} of accepted){
        const scopeKey=hash(scope);
        for(const rule of rules)if(rule.codes.includes(code)&&at>=now-rule.windowSeconds*1000){
          const key=ruleKey(rule),id=logSampleId(source,service.key,key,record),groupKey=JSON.stringify([key,scopeKey,at]);
          let known=knownGroups.get(groupKey);
          if(!known){known=new Set((await q('SELECT * FROM sre_log_samples WHERE service_key=? AND rule_key=? AND scope_key=? AND observed_at=?',[service.key,key,scopeKey,at])).map(row=>readLogSample(row,{service}).canonicalId));knownGroups.set(groupKey,known);}
          if(known.has(id))continue;
          const inserted=await q('INSERT INTO sre_log_samples(id,service_key,rule_key,scope_key,observed_at,payload) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id',[id,service.key,key,scopeKey,at,JSON.stringify({source,record,scope,partial:!coverage.complete})]);matched+=inserted.length;
          known.add(id);
        }
      }
      await q('DELETE FROM sre_log_samples WHERE service_key=? AND observed_at<?',[service.key,now-maxWindow]);
    });
    let incidents;
    try {incidents=await this.evaluate(service);}
    catch(error){if(error instanceof LogScopeLimitError){error.partialResult={matched,incidents:error.incidents,coverage,evaluationComplete:false};if(coverage.rejected)error.message+=' '+new LogAdmissionError(error.partialResult).message;}throw error;}
    const result={matched,incidents,coverage};if(coverage.rejected)throw new LogAdmissionError(result);return result;
  }
  async evaluate(service) {
    const now=await this.store.coordinationNow(),incidents=[],failures=[];
    for(const rule of service.logMonitors||[]){
      if(!await this.ensureIdentity(service,rule))continue;
      const key=ruleKey(rule),groups=await this.store.db.query('SELECT scope_key,COUNT(*) AS count FROM sre_log_samples WHERE service_key=? AND rule_key=? AND observed_at>=? AND observed_at<=? GROUP BY scope_key HAVING COUNT(*)>=? ORDER BY scope_key LIMIT 101',[service.key,key,now-rule.windowSeconds*1000,now,rule.minCount]);
      if(groups.length>100){failures.push({serviceKey:service.key,monitorId:rule.id,scopeLimit:100,scopesObservedAtLeast:groups.length});continue;}
      for(const group of groups){
        const samples=await this.store.db.query('SELECT id,service_key,rule_key,scope_key,observed_at,payload,COUNT(*) OVER() AS available FROM sre_log_samples WHERE service_key=? AND rule_key=? AND scope_key=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at DESC,id DESC LIMIT 50',[service.key,key,group.scope_key,now-rule.windowSeconds*1000,now]);
        if(samples.length<rule.minCount)continue;
        const decoded=samples.map(s=>({...readLogSample(s,{service}).value,id:s.id,at:Number(s.observed_at)})),scope=decoded[0].scope,records=decoded.map(s=>s.record);
        const observedCount=Number(samples[0].available);
        const result=await this.store.ingest({id:hash([key,observedCount,samples.map(s=>s.id)]),source:'log-monitor',serviceKey:service.key,kind:'problem',issueKey:'log-monitor:'+rule.id+':'+group.scope_key,status:'OPEN',at:decoded[0].at,startedAt:Math.min(...decoded.map(s=>s.at)),title:'Observed log threshold: '+rule.id+' · '+scope.region,payload:{monitorId:rule.id,scope,observedCount,sampleCount:records.length,windowSeconds:rule.windowSeconds,observationIds:decoded.map(s=>s.id),recordSources:decoded.map(s=>s.source),records,complete:decoded.every(s=>!s.partial),interpretation:'Observed matching log records in a bounded source window; not an error rate, unique affected users or verified cause. Silence does not establish recovery.'}});
        incidents.push(result.incidentId);
      }
    }if(failures.length)throw new LogScopeLimitError(failures,incidents);return [...new Set(incidents)];
  }
  async runOnce(){
    const failures=[],incidents=[];
    for(const service of this.services)if(service.logMonitors?.length){try{incidents.push(...await this.evaluate(service));}catch(error){if(!(error instanceof LogScopeLimitError))throw error;failures.push(...error.failures);incidents.push(...error.incidents);}}
    if(failures.length)throw new LogScopeLimitError(failures,incidents);
  }
}
