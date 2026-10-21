import {hash,redact} from './security.mjs';
import {coalesceLogSamples,logSampleId,readLogSample} from './log-observation.mjs';
const ruleKey=rule=>hash([rule.id,[...rule.codes].sort(),rule.minCount,rule.windowSeconds]);

export function validateLogMonitor(rule) {
  if(!rule||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(rule.id||'')||!Array.isArray(rule.codes)||!rule.codes.length||rule.codes.length>20||rule.codes.some(c=>typeof c!=='string'||! /^[A-Z0-9_.:-]{1,100}$/.test(c)))throw Error('Log monitor needs an ID and explicit bounded error codes');
  if(!Number.isInteger(rule.minCount)||rule.minCount<1||rule.minCount>50||!Number.isInteger(rule.windowSeconds)||rule.windowSeconds<10||rule.windowSeconds>900)throw Error('Log monitor requires 1–50 observations in a 10–900 second window');
}

// Observed counts, not an inferred error rate. Persistent observation IDs
// deduplicate overlapping reads. Missing observations never close a problem.
export class LogDetector {
  constructor({store,services}){Object.assign(this,{store,services});this.identityRepairs=new Map();}
  ensureIdentity(service,rule){
    const key=service.key+':'+ruleKey(rule);let repair=this.identityRepairs.get(key);
    if(!repair){repair=coalesceLogSamples(this.store,service.key,ruleKey(rule)).then(result=>{if(!result.ready)this.identityRepairs.delete(key);return result.ready;},error=>{this.identityRepairs.delete(key);throw error;});this.identityRepairs.set(key,repair);}
    return repair;
  }
  async observe(service,source,batch) {
    const rules=service.logMonitors||[];if(!rules.length)return {matched:0,incidents:[]};
    for(const rule of rules)validateLogMonitor(rule);
    if(!Array.isArray(batch.records)||batch.records.length>500)throw Error('Log detection accepts up to 500 records per bounded page');
    for(const rule of rules)if(!await this.ensureIdentity(service,rule))throw Error('Log detection is held during restore reconciliation');
    const now=await this.store.coordinationNow(),maxWindow=Math.max(...rules.map(r=>r.windowSeconds))*1000;let matched=0;
    await this.store.db.transaction(async q=>{
      if((await this.store.restoreFence(q))?.active)throw Error('Log detection is held during restore reconciliation');
      const knownGroups=new Map();
      for(const raw of batch.records){
        const record=redact(raw),at=typeof record.timestamp==='number'?record.timestamp:Date.parse(record.timestamp),code=record['error.code']||record.code,level=String(record.loglevel||record.level||'').toUpperCase();
        const environment=record['deployment.environment']||record.environment,region=record['cloud.region']||record.region||'unknown',version=record['service.version']||record.sha||'unknown';
        if(!Number.isSafeInteger(at)||at>now||at<now-maxWindow||!['ERROR','FATAL'].includes(level)||environment!==service.environment)continue;
        const scope={environment,region,version},scopeKey=hash(scope);
        for(const rule of rules)if(rule.codes.includes(code)&&at>=now-rule.windowSeconds*1000){
          const key=ruleKey(rule),id=logSampleId(source,service.key,key,record),groupKey=JSON.stringify([key,scopeKey,at]);
          let known=knownGroups.get(groupKey);
          if(!known){known=new Set((await q('SELECT * FROM sre_log_samples WHERE service_key=? AND rule_key=? AND scope_key=? AND observed_at=?',[service.key,key,scopeKey,at])).map(row=>readLogSample(row).canonicalId));knownGroups.set(groupKey,known);}
          if(known.has(id))continue;
          const inserted=await q('INSERT INTO sre_log_samples(id,service_key,rule_key,scope_key,observed_at,payload) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id',[id,service.key,key,scopeKey,at,JSON.stringify({source,record,scope,partial:batch.complete!==true})]);matched+=inserted.length;
          known.add(id);
        }
      }
      await q('DELETE FROM sre_log_samples WHERE service_key=? AND observed_at<?',[service.key,now-maxWindow]);
    });
    return {matched,incidents:await this.evaluate(service)};
  }
  async evaluate(service) {
    const now=await this.store.coordinationNow(),incidents=[];
    for(const rule of service.logMonitors||[]){
      if(!await this.ensureIdentity(service,rule))continue;
      const key=ruleKey(rule),groups=await this.store.db.query('SELECT scope_key,COUNT(*) AS count FROM sre_log_samples WHERE service_key=? AND rule_key=? AND observed_at>=? AND observed_at<=? GROUP BY scope_key HAVING COUNT(*)>=? ORDER BY scope_key LIMIT 101',[service.key,key,now-rule.windowSeconds*1000,now,rule.minCount]);
      if(groups.length>100)throw Error('Log monitor exceeds 100 active scopes; narrow its source query');
      for(const group of groups){
        const samples=await this.store.db.query('SELECT id,service_key,rule_key,scope_key,observed_at,payload,COUNT(*) OVER() AS available FROM sre_log_samples WHERE service_key=? AND rule_key=? AND scope_key=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at DESC,id DESC LIMIT 50',[service.key,key,group.scope_key,now-rule.windowSeconds*1000,now]);
        if(samples.length<rule.minCount)continue;
        const decoded=samples.map(s=>({...readLogSample(s).value,id:s.id,at:Number(s.observed_at)})),scope=decoded[0].scope,records=decoded.map(s=>s.record);
        const observedCount=Number(samples[0].available);
        const result=await this.store.ingest({id:hash([key,observedCount,samples.map(s=>s.id)]),source:'log-monitor',serviceKey:service.key,kind:'problem',issueKey:'log-monitor:'+rule.id+':'+group.scope_key,status:'OPEN',at:decoded[0].at,startedAt:Math.min(...decoded.map(s=>s.at)),title:'Observed log threshold: '+rule.id+' · '+scope.region,payload:{monitorId:rule.id,scope,observedCount,sampleCount:records.length,windowSeconds:rule.windowSeconds,observationIds:decoded.map(s=>s.id),recordSources:decoded.map(s=>s.source),records,complete:decoded.every(s=>!s.partial),interpretation:'Observed matching log records in a bounded source window; not an error rate, unique affected users or verified cause. Silence does not establish recovery.'}});
        incidents.push(result.incidentId);
      }
    }return [...new Set(incidents)];
  }
  async runOnce(){for(const service of this.services)if(service.logMonitors?.length)await this.evaluate(service);}
}
