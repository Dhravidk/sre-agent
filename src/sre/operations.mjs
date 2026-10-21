import { randomUUID } from 'node:crypto';
import { hash, redact } from './security.mjs';
import { pollScopeHash } from './poll-scope.mjs';
import {handledDeliveryInspectionSql} from './delivery-inspections.mjs';

const instanceCondition=code=>code.startsWith('loop_')||code.startsWith('instance_poll_')||code.startsWith('instance_delivery_')||['clock_skew','observer_error'].includes(code);

export function connectionReadHealth(connection,report) {
  if(!connection.enabled)return {state:'offline',detail:'Reader disabled'};
  const id=connection.source+':'+connection.service;
  const relevant=report.conditions.filter(item=>item.serviceKey===connection.service&&(item.key===id||item.key==='reader:'+id||(connection.source==='dynatrace'&&(item.key.startsWith('metric:'+connection.service+':')||item.key.startsWith('reader:metric:'+connection.service+':')))));
  if(relevant.length)return {state:'needs-attention',detail:relevant.map(item=>item.message).join(' ')};
  const pending=report.pendingSources.some(item=>item.serviceKey===connection.service&&(item.source===connection.source||(connection.source==='dynatrace'&&item.source.startsWith('metric '))));
  if(pending)return {state:'starting',detail:'Waiting for complete reads on this instance'};
  const local=report.localSources.find(item=>item.id===id);
  return local?.state==='healthy'?{state:'healthy',detail:'Recent complete read on this instance'}:{state:'configured',detail:'On-demand reader configured; live access needs its own check'};
}

export function operationalLimits(config) {
  if(config.operations!==undefined&&(!config.operations||typeof config.operations!=='object'||Array.isArray(config.operations)))throw new Error('operations must be an object');
  const settings={startupGraceSeconds:180,maxPollAgeSeconds:Math.max(180,(config.pollIntervalMs||60000)*3/1000),maxQueueAgeSeconds:300,maxTickDurationSeconds:180,maxPollDurationSeconds:180,maxRollbackWaitSeconds:1800,...config.operations};
  for(const key of ['startupGraceSeconds','maxPollAgeSeconds','maxQueueAgeSeconds','maxTickDurationSeconds','maxPollDurationSeconds','maxRollbackWaitSeconds'])if(!Number.isFinite(settings[key])||settings[key]<1||settings[key]>86400)throw new Error('operations.'+key+' must be between 1 and 86400');
  if(settings.notify!==undefined&&typeof settings.notify!=='boolean')throw new Error('operations.notify must be a boolean');
  return settings;
}

export class OperationalMonitor {
  constructor({store,config,poller,outbox,schedulerEnabled=true}) {
    Object.assign(this,{store,config,poller,outbox,schedulerEnabled});this.limits=operationalLimits(config);this.startedAt=store.clock();this.runtimeId=randomUUID();this.instanceId=config.instanceId||'agent';this.loops={tick:{running:false},poll:{running:false},commands:{running:false},...(outbox?{delivery:{running:false}}:{})};this.active=null;this.stopped=false;
  }
  begin(lane) {Object.assign(this.loops[lane],{running:true,startedAt:this.store.clock(),lastStartedAt:this.store.clock()});}
  end(lane,error) {Object.assign(this.loops[lane],{running:false,lastFinishedAt:this.store.clock(),...(error?{error:redact(String(error.message)).slice(0,1000)}:{error:null,lastSuccessAt:this.store.clock()})});}
  async snapshot() {
    const now=this.store.clock(),conditions=[],pendingSources=[],localSources=[];
    const add=(serviceKey,key,code,message,extra={})=>conditions.push({serviceKey,key,code,message,scope:instanceCondition(code)?'instance':'shared',...extra});
    const recoveryFence=await this.store.restoreFence();
    if(recoveryFence?.active)add(null,'recovery:database-restore','database_restore_hold','Database restore reconciliation is holding outbound actions.',{restoreId:recoveryFence.restoreId});
    const coordinationNow=await this.store.coordinationNow(),afterClockRead=this.store.clock();
    const clockOffset=now>coordinationNow?now-coordinationNow:afterClockRead<coordinationNow?afterClockRead-coordinationNow:0;
    if(this.store.db.dialect==='postgres'&&Math.abs(clockOffset)>30000)add(null,'clock:application','clock_skew','The application clock differs from PostgreSQL by more than 30 seconds; synchronize the host clock.',{offsetMs:clockOffset});
    const pollCheckpointIds=this.config.services.flatMap(service=>[...['dynatrace','dynatraceLogs','servicenow','github','gitlab'].filter(source=>service[source]?.enabled).map(source=>source+':'+service.key),...(service.monitors||[]).map(monitor=>'metric:'+service.key+':'+monitor.id)]);
    const [checkpointRows,jobs,outbox,rollbacks,qa,reviews]=await Promise.all([
      pollCheckpointIds.length?this.store.db.query('SELECT id,value FROM sre_checkpoints WHERE id IN ('+pollCheckpointIds.map(()=>'?').join(',')+')',pollCheckpointIds):[],
      this.store.db.query("SELECT i.service_key,j.status,COUNT(*) AS count,MIN(j.created_at) AS oldest,MIN(j.lease_until) AS lease_until FROM sre_jobs j JOIN sre_incidents i ON i.id=j.incident_id WHERE j.status IN ('pending','running','dead') GROUP BY i.service_key,j.status"),
      this.store.db.query("SELECT COALESCE(i.service_key,c.service_key) AS service_key,o.status,COUNT(*) AS count,MIN(o.created_at) AS oldest,MIN(o.lease_until) AS lease_until FROM sre_outbox o LEFT JOIN sre_incidents i ON i.id=o.incident_id LEFT JOIN sre_conversations c ON c.id=o.conversation_key WHERE o.status IN ('pending','sending','failed','unknown') AND NOT "+handledDeliveryInspectionSql('o')+' GROUP BY COALESCE(i.service_key,c.service_key),o.status',[recoveryFence?.restoreId??null]),
      this.store.db.query("SELECT i.service_key,r.status,COUNT(*) AS count,MIN(COALESCE(r.approved_at,r.created_at)) AS oldest,MIN(r.lease_until) AS lease_until FROM sre_rollbacks r JOIN sre_incidents i ON i.id=r.incident_id WHERE r.status IN ('checking','dispatching','dispatched','unknown') GROUP BY i.service_key,r.status"),
      this.store.db.query("SELECT i.service_key,r.status,COUNT(*) AS count,MIN(r.created_at) AS oldest,MIN(r.lease_until) AS lease_until FROM sre_fix_requests r JOIN sre_incidents i ON i.id=r.incident_id WHERE r.status IN ('approved','running','failed','unknown','superseded') AND (r.status<>'superseded' OR NOT EXISTS(SELECT 1 FROM sre_fix_requests fresh JOIN sre_fix_plans plan ON plan.id=fresh.plan_id WHERE fresh.incident_id=i.id AND fresh.status='passed' AND plan.revision=i.revision AND fresh.created_at>=r.created_at)) GROUP BY i.service_key,r.status"),
      this.store.db.query("SELECT service_key,waiting,exhausted,COUNT(*) AS count,MIN(id) AS incident_id FROM (SELECT i.id,i.service_key,CASE WHEN EXISTS(SELECT 1 FROM sre_jobs j WHERE j.incident_id=i.id AND j.status IN ('pending','running')) THEN 1 ELSE 0 END AS waiting,CASE WHEN EXISTS(SELECT 1 FROM sre_jobs j WHERE j.incident_id=i.id AND j.status='dead') THEN 1 ELSE 0 END AS exhausted FROM sre_incidents i WHERE i.status<>'resolved' AND (i.analysis IS NULL OR i.analysis='' OR NOT EXISTS(SELECT 1 FROM sre_assessments a WHERE a.incident_id=i.id AND a.revision=i.revision AND a.body=i.analysis) OR EXISTS(SELECT 1 FROM sre_assessments a WHERE a.incident_id=i.id AND a.revision>i.revision))) unreviewed GROUP BY service_key,waiting,exhausted"),
    ]);
    const checkpoints=new Map(checkpointRows.map(row=>{try{return [row.id,JSON.parse(row.value)];}catch{return [row.id,{error:'Invalid polling checkpoint'}];}}));
    for(const service of this.config.services) {
      const required=['dynatrace','dynatraceLogs','servicenow','github','gitlab'].filter(source=>service[source]?.enabled).map(source=>({id:source+':'+service.key,label:source}));
      for(const monitor of service.monitors||[])required.push({id:'metric:'+service.key+':'+monitor.id,label:'metric '+monitor.id,monitor});
      for(const source of required) {
        const checkpoint=checkpoints.get(source.id)||{};
        const expected=pollScopeHash(service,source.monitor?'metric':source.label,source.monitor);
        const freshShared=checkpoint.complete===true&&Number.isFinite(checkpoint.successAt)&&checkpoint.successAt<=coordinationNow&&coordinationNow-checkpoint.successAt<=this.limits.maxPollAgeSeconds*1000&&(!Number.isFinite(checkpoint.until)||(checkpoint.until<=coordinationNow&&coordinationNow-checkpoint.until<=this.limits.maxPollAgeSeconds*1000));
        if(this.poller) {
          const local=this.poller.localState(source.id,expected);
          const key='reader:'+source.id;
          let state='starting';
          if(local?.error) {
            state='needs-attention';add(service.key,key,'instance_poll_error',source.label+' reading failed on this instance: '+local.error,{lastSuccessAt:local.successAt??null});
          } else if(!local||local.complete!==true||!Number.isFinite(local.successAt)) {
            if(now-this.startedAt>=this.limits.startupGraceSeconds*1000){state='needs-attention';add(service.key,key,'instance_poll_missing',source.label+' has no completed read on this instance.');}
            else pendingSources.push({serviceKey:service.key,source:source.label,scope:'instance'});
          } else if(local.successAt>coordinationNow||coordinationNow-local.successAt>this.limits.maxPollAgeSeconds*1000||local.until>coordinationNow||coordinationNow-local.until>this.limits.maxPollAgeSeconds*1000) {
            state='needs-attention';add(service.key,key,'instance_poll_stale',source.label+' has no recent complete read on this instance.',{lastSuccessAt:local.successAt});
          } else if(source.monitor&&(!Number.isFinite(local.sampleAt)||local.sampleAt>coordinationNow||coordinationNow-local.sampleAt>(source.monitor.maxSampleAgeSeconds??180)*1000)) {
            state='needs-attention';add(service.key,key,'instance_poll_sample_stale',source.label+' has no recent valid sample on this instance.',{lastSampleAt:local.sampleAt??null});
          } else state='healthy';
          localSources.push({id:source.id,serviceKey:service.key,source:source.label,state,...local});
        }
        if(checkpoint.scopeHash!==expected) {
          if(now-this.startedAt>=this.limits.startupGraceSeconds*1000)add(service.key,source.id,'poll_scope',source.label+' has no completed read for the configured scope.');
          else pendingSources.push({serviceKey:service.key,source:source.label,scope:'shared'});
        }
        else if(checkpoint.error&&!freshShared)add(service.key,source.id,'poll_error',source.label+' polling failed: '+redact(String(checkpoint.error)).slice(0,1000),{lastSuccessAt:checkpoint.successAt??null});
        else if(!Number.isFinite(checkpoint.successAt)||checkpoint.complete!==true) {
          if(now-this.startedAt>=this.limits.startupGraceSeconds*1000)add(service.key,source.id,'poll_missing',source.label+' has no completed polling result.');
          else pendingSources.push({serviceKey:service.key,source:source.label,scope:'shared'});
        } else if(!freshShared)add(service.key,source.id,'poll_stale',source.label+' has no recent complete poll.',{lastSuccessAt:checkpoint.successAt});
        else if(source.monitor&&(!Number.isFinite(checkpoint.sampleAt)||checkpoint.sampleAt>coordinationNow||coordinationNow-checkpoint.sampleAt>(source.monitor.maxSampleAgeSeconds??180)*1000))add(service.key,source.id,'metric_stale',source.label+' has no recent valid sample.',{lastSampleAt:checkpoint.sampleAt??null});
      }
    }
    for(const row of jobs) {
      const count=Number(row.count),key='jobs:'+row.status;
      if(row.status==='dead')add(row.service_key,key,'investigation_dead','Investigation jobs exhausted retries; inspect the failure and use Retry investigation with a reason.',{count});
      if(row.status==='pending'&&coordinationNow-Number(row.oldest)>this.limits.maxQueueAgeSeconds*1000)add(row.service_key,key,'investigation_delayed','Investigation work is waiting beyond the configured queue age.',{count});
      if(row.status==='running'&&Number(row.lease_until)<coordinationNow-10000)add(row.service_key,key,'investigation_stuck','An investigation lease expired without being reclaimed.',{count});
    }
    for(const row of reviews){
      const extra={count:Number(row.count),incidentId:row.incident_id};
      if(Number(row.waiting))pendingSources.push({serviceKey:row.service_key,source:'incident assessment',scope:'shared',...extra});
      else if(!Number(row.exhausted))add(row.service_key,'assessments:orphaned','assessment_orphaned','An active incident has no current audited assessment and no queued investigation. Open the affected case and ask for a current review.',extra);
      // Exhausted jobs already have their explicit manual-retry condition.
      // A queued review stays pending until publication, preventing an early
      // shared recovery notice merely because a question was accepted.
    }
    for(const row of outbox) {
      const count=Number(row.count),key='outbox:'+row.status;
      if(['unknown','failed'].includes(row.status))add(row.service_key,key,'notification_'+row.status,row.status==='unknown'?'A Teams delivery outcome is unknown; inspect the conversation before retrying.':'Teams delivery failed; inspect authentication and conversation access.',{count});
      if(row.status==='pending'&&this.config.teamsMode==='live'&&coordinationNow-Number(row.oldest)>this.limits.maxQueueAgeSeconds*1000)add(row.service_key,key,'notification_delayed','Teams messages are waiting beyond the configured queue age.',{count});
      if(row.status==='sending'&&Number(row.lease_until)<coordinationNow-10000)add(row.service_key,key,'notification_stuck','A Teams delivery lease expired without reconciliation.',{count});
    }
    const transport=this.outbox?.deliveryState();
    if(transport&&transport.reserved>=transport.limit&&transport.timedOut)add(null,'delivery:capacity','instance_delivery_saturated','Teams send capacity is occupied by unresolved calls; incident intake and investigation continue.',{...transport});
    if(this.outbox?.auditError)add(null,'delivery:audit','instance_delivery_audit','Late Teams delivery evidence could not be saved: '+this.outbox.auditError);
    for(const row of rollbacks) {
      const count=Number(row.count),key='rollback:'+row.status;
      if(row.status==='unknown')add(row.service_key,key,'rollback_unknown','A rollback dispatch outcome is unknown; reconcile its request before another action.',{count});
      if(row.status==='dispatched'&&coordinationNow-Number(row.oldest)>this.limits.maxRollbackWaitSeconds*1000)add(row.service_key,key,'rollback_unverified','A dispatched rollback has no matching independent recovery proof within the configured wait.',{count});
      if(['checking','dispatching'].includes(row.status)&&Number(row.lease_until)<coordinationNow-10000)add(row.service_key,key,'rollback_stuck','A rollback execution lease expired without reconciliation.',{count});
    }
    for(const row of qa){
      const key='qa:'+row.status,count=Number(row.count);
      if(['failed','unknown'].includes(row.status))add(row.service_key,key,'qa_'+row.status,row.status==='unknown'?'Local QA was interrupted or its outcome is uncertain; inspect the saved workspace and audit before another request.':'Local QA failed; review its recorded test result or scope error.',{count});
      if(row.status==='superseded')add(row.service_key,key,'qa_superseded','Local QA artifacts describe an older incident revision or authorization scope; review a fresh plan before further work.',{count});
      if(row.status==='running'&&Number(row.lease_until)<=coordinationNow)add(row.service_key,key,'qa_stuck','A local QA execution lease expired; its outcome requires reconciliation.',{count});
      if(row.status==='approved'&&coordinationNow-Number(row.oldest)>this.limits.maxQueueAgeSeconds*1000)add(row.service_key,key,'qa_delayed','Approved local QA is waiting beyond the configured queue age.',{count});
    }
    for(const [name,loop] of Object.entries(this.loops)) {
      const limit=(name==='poll'?this.limits.maxPollDurationSeconds:this.limits.maxTickDurationSeconds)*1000;
      if(loop.error)add(null,'loop:'+name,'loop_error',name+' loop failed: '+loop.error);
      else if(loop.running&&now-loop.startedAt>limit)add(null,'loop:'+name,'loop_stalled',name+' loop has exceeded its configured execution time.');
      else if(this.schedulerEnabled&&!loop.running&&now-(loop.lastFinishedAt??this.startedAt)>Math.max(this.limits.startupGraceSeconds*1000,name==='poll'?(this.config.pollIntervalMs||60000)*3:5000))add(null,'loop:'+name,'loop_missing',name+' loop has stopped making progress.');
    }
    if(this.observerError)add(null,'operations:observer','observer_error','Operational notice persistence failed: '+this.observerError);
    conditions.sort((a,b)=>(String(a.serviceKey)+a.key+a.code).localeCompare(String(b.serviceKey)+b.key+b.code));
    return {state:conditions.length?'needs-attention':pendingSources.length?'starting':'healthy',observedAt:now,runtimeId:this.runtimeId,instanceId:this.instanceId,startedAt:this.startedAt,schedulerEnabled:this.schedulerEnabled,mode:this.config.mode,liveAccessValidated:false,conditions,pendingSources,localSources,loops:structuredClone(this.loops),note:this.config.mode==='local'?'Offline fixture operation. Live vendor access is unverified.':this.config.mode==='trial'?'Claude CLI analysis with fictional provider evidence. Teams and rollback execution are simulated; live vendor access is unverified.':'Shared service state and local checks for instance '+this.instanceId+' ('+this.runtimeId.slice(0,8)+'). Other runtime views require their own observation.'};
  }
  observe() {
    if(this.stopped)return Promise.resolve();
    if(!this.active)this.active=this.publishChanges().then(value=>{this.observerError=null;return value;},error=>{this.observerError=redact(String(error.message)).slice(0,1000);throw error;}).finally(()=>{this.active=null;});
    return this.active;
  }
  async publishChanges() {
    const snapshot=await this.snapshot();
    if((await this.store.restoreFence())?.active)return snapshot;
    if(this.config.mode!=='connected'||this.limits.notify===false||this.config.teamsMode!=='live')return snapshot;
    for(const service of this.config.services) {
      const conditions=snapshot.conditions.filter(item=>item.code!=='observer_error'&&(!item.serviceKey||item.serviceKey===service.key));
      const roots=service.teams.conversations||[];
      const conversationId=service.teams.operationsConversationId||(roots.length===1?roots[0]:null);
      if(!conversationId||!roots.includes(conversationId))continue;
      for(const scope of ['shared','instance']) {
        const relevant=conditions.filter(item=>item.scope===scope);
        // Startup uncertainty is not evidence that a shared failure recovered.
        if(!relevant.length&&snapshot.pendingSources.some(item=>item.serviceKey===service.key&&(item.scope||'shared')===scope))continue;
        const fingerprint=hash(relevant.map(({key,code,message})=>({key,code,message})));
        const id='operations:v2:'+scope+':'+hash([service.key,service.tenant,service.environment,service.teams.tenantId,conversationId,scope==='instance'?this.runtimeId:null]);
        await this.store.db.transaction(async q=>{
          const [conversation]=await q('SELECT id FROM sre_conversations WHERE service_key=? AND tenant_id=? AND conversation_id=? AND enabled=1',[service.key,service.teams.tenantId,conversationId]);
          if(!conversation)return;
          // Healthy runtime starts need no per-boot notification row.
          if(scope==='instance'&&!relevant.length&&!(await q('SELECT id FROM sre_checkpoints WHERE id=?',[id])).length)return;
          const now=await this.store.coordinationNow(q);
          await q("INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,'{}',?) ON CONFLICT DO NOTHING",[id,now]);
          const [saved]=await q('SELECT value FROM sre_checkpoints WHERE id=?'+(this.store.db.dialect==='postgres'?' FOR UPDATE':''),[id]);
          const prior=JSON.parse(saved.value);
          if(prior.fingerprint===fingerprint)return;
          const sequence=Number(prior.sequence||0)+1;
          if(relevant.length||prior.active) {
            const target=service.name+' / '+service.environment,instance=this.instanceId+' ('+this.runtimeId.slice(0,8)+')';
            const heading=scope==='shared'?'Shared service checks':'Instance '+instance;
            const text=relevant.length?heading+(scope==='shared'?' need':' needs')+' attention for '+target+':\n'+relevant.map(item=>'- '+item.message+(item.count?' ('+item.count+')':'')).join('\n'):scope==='shared'?'Shared service checks recovered for '+target+'.':'Instance checks recovered for '+target+' on '+instance+'.';
            await this.store.queueMessage(null,text,conversation.id,'operations:'+hash([id,sequence,fingerprint]),q);
          }
          await q('UPDATE sre_checkpoints SET value=?,updated_at=? WHERE id=?',[JSON.stringify({scope,runtimeId:scope==='instance'?this.runtimeId:null,instanceId:scope==='instance'?this.instanceId:null,fingerprint,sequence,active:relevant.length>0,observedAt:now}),now,id]);
        });
      }
    }
    return snapshot;
  }
  stop() {this.stopped=true;}
  drain() {return this.active||Promise.resolve();}
}
