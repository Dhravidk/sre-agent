import { normalize } from './normalize.mjs';
import { hash, redact } from './security.mjs';
import { metricWindow, validateMonitor } from './monitors.mjs';
import { pollScopeHash } from './poll-scope.mjs';
import {readTrackedChanges} from './change-read.mjs';

export class ConnectorPoller {
  constructor({store,services,connectors,logDetector,concurrency=4,activeReconcileIntervalMs=300000,changeReadMaxAgeMs=180000}) {
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('Polling concurrency must be between 1 and 8');
    if(!Number.isFinite(activeReconcileIntervalMs)||activeReconcileIntervalMs<10000||activeReconcileIntervalMs>86400000)throw new Error('Active reconciliation interval must be between 10 seconds and one day');
    if(!Number.isFinite(changeReadMaxAgeMs)||changeReadMaxAgeMs<1000||changeReadMaxAgeMs>86400000)throw new Error('Tracked-change reader freshness must be between one second and one day');
    Object.assign(this,{store,services,connectors,logDetector,concurrency,activeReconcileIntervalMs,changeReadMaxAgeMs});this.running=false;this.localReads=new Map();
  }
  localState(id,scopeHash) {const state=this.localReads.get(id);return state?.scopeHash===scopeHash?{...state}:null;}
  async readSource(service,source,client) {
    const key=source+':'+service.key,scopeHash=pollScopeHash(service,source),saved=await this.store.checkpoint(key)||{};
    const prior=saved.scopeHash===scopeHash?saved:{};
    const until=await this.store.coordinationNow(),since=Math.min(prior.until||until-300000,until)-60000;
    const localPrior=this.localState(key,scopeHash)||{};
    let activeReconciledAt=localPrior.activeReconciledAt;
    try {
      const signal=AbortSignal.timeout(60000);
      if(source==='dynatraceLogs') {
        const logs=await client.logs({from:since,to:until,signal});
        if(logs.records.length)await this.store.ingest({id:hash(logs.records),source:'dynatrace-logs',serviceKey:service.key,kind:'log',at:Math.max(...logs.records.map(x=>Date.parse(x.timestamp)).filter(Number.isFinite),since),payload:logs});
        if(this.logDetector)await this.logDetector.observe(service,'dynatrace-logs',logs);
        if(!logs.complete)throw new Error('Log query was truncated; narrow the time window or service filter. Checkpoint retained.');
      } else {
        const repositorySource=['github','gitlab'].includes(source);let result,repositoryFailure;
        try{
          result=source==='dynatrace'?await client.problems({since,until,signal}):source==='servicenow'?await client.incidents({since,until,signal}):await client.deployments(service.environment,{signal});
          if(!Array.isArray(result?.items)||typeof result.complete!=='boolean')throw Error('Connector inventory returned an invalid page result');
        }catch(error){if(!repositorySource)throw error;result=null;repositoryFailure=error;}
        for(const item of result?.items||[]) {
          const event=['github','gitlab'].includes(source)?{id:hash(item),source,serviceKey:service.key,kind:'deployment',at:item.at,payload:item}:normalize(source,item,service,{deliveryId:hash(item),now:until});
          if(event)await this.store.ingest(event);
        }
        if(result&&!result.complete){const error=new Error('Polling page budget reached; checkpoint retained to avoid silently skipping records');if(!repositorySource)throw error;repositoryFailure=error;}
        if(repositorySource){
          let changeFailure;try{await readTrackedChanges(this.store,service,source,client,signal,{maxAgeMs:this.changeReadMaxAgeMs});}catch(error){changeFailure=error;}
          if(repositoryFailure||changeFailure)throw Error([...(repositoryFailure?['Deployment reader: '+repositoryFailure.message]:[]),...(changeFailure?['Change reader: '+changeFailure.message]:[])].join('; '));
        }
        if(service[source]?.enabled&&['dynatrace','servicenow'].includes(source)&&(!localPrior.activeReconciledAt||until-localPrior.activeReconciledAt>=this.activeReconcileIntervalMs)) {
          const read=source==='dynatrace'?'openProblems':'openIncidents';
          if(typeof client[read]!=='function')throw new Error('Connector requires a scoped active-issue reconciliation reader');
          const active=await client[read]({until,signal});
          for(const item of active.items) {
            const event=normalize(source,item,service,{deliveryId:hash(item),now:until});
            if(event.status!=='OPEN')throw new Error('Active-issue reconciliation returned a non-open record');
            await this.store.ingest(event);
          }
          if(!active.complete)throw new Error('Active-issue reconciliation is incomplete; checkpoint retained');
          activeReconciledAt=until;
        }
      }
      const readResult={scopeHash,until,activeReconciledAt,successAt:await this.store.coordinationNow(),complete:true};
      await this.store.recordPollResult(key,readResult);this.localReads.set(key,readResult);
    } catch(error) {
      const failure={scopeHash,error:redact(String(error.message)).slice(0,1000)||'Connector read failed',failedAt:await this.store.coordinationNow()};
      this.localReads.set(key,{...localPrior,...failure,complete:false});await this.store.recordPollResult(key,failure);
    }
  }
  async readMonitor(service,monitor,client) {
    const key='metric:'+service.key+':'+monitor.id,scopeHash=pollScopeHash(service,'metric',monitor),now=await this.store.coordinationNow();
    const localPrior=this.localState(key,scopeHash)||{};
    try {
      validateMonitor(monitor);
      if(!client)throw new Error('Metric monitor requires an enabled Dynatrace connector');
      const result=await client.metrics(monitor.selector,{from:now-900000,to:now,signal:AbortSignal.timeout(30000)});
      const {values,timestamps}=metricWindow(result,monitor,now);
      const bad=values.map(x=>monitor.operator==='gt'?x>monitor.threshold:x<monitor.threshold);
      if(bad.every(Boolean)||bad.every(x=>!x)) {
        const status=bad[0]?'OPEN':'CLOSED',title=monitor.name||monitor.id;
        const payload={selector:monitor.selector,threshold:monitor.threshold,operator:monitor.operator,unit:monitor.unit,values,timestamps};
        // Do not create an incident for a monitor that has always been healthy.
        const existing=await this.store.db.query('SELECT id FROM sre_incidents WHERE service_key=? AND issue_key=?',[service.key,'metric:'+monitor.id]);
        if(status==='OPEN'||existing.length)await this.store.ingest({id:hash([monitor.id,status,title,payload]),source:'dynatrace-metric',serviceKey:service.key,kind:'problem',issueKey:'metric:'+monitor.id,status,title,at:timestamps.at(-1),startedAt:timestamps[0],payload});
      }
      const readResult={scopeHash,until:now,successAt:await this.store.coordinationNow(),sampleAt:timestamps.at(-1),complete:true};
      await this.store.recordPollResult(key,readResult);this.localReads.set(key,readResult);
    } catch(error) {
      const failure={scopeHash,error:redact(String(error.message)).slice(0,1000)||'Metric read failed',failedAt:await this.store.coordinationNow()};
      this.localReads.set(key,{...localPrior,...failure,complete:false});await this.store.recordPollResult(key,failure);
    }
  }
  async runOnce() {
    if(this.running)return;this.running=true;
    try {
      const tasks=[];
      for(const service of this.services) {
        const clients=this.connectors.get(service.key)||{};
        for(const source of ['dynatrace','servicenow','github','gitlab','dynatraceLogs'])if(clients[source])tasks.push(()=>this.readSource(service,source,clients[source]));
        for(const monitor of service.monitors||[])tasks.push(()=>this.readMonitor(service,monitor,clients.dynatrace));
      }
      let cursor=0;
      const consume=async()=>{while(cursor<tasks.length){const task=tasks[cursor++];await task();}};
      // Drain every active lane even when the database fails in another one.
      // A rejected Promise.all would otherwise outlive shutdown's tracked poll.
      const results=await Promise.allSettled(Array.from({length:Math.min(this.concurrency,tasks.length)},consume));
      const failure=results.find(x=>x.status==='rejected');if(failure)throw failure.reason;
    } finally {this.running=false;}
  }
}
