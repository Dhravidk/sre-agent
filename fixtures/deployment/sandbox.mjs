import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync,openSync,closeSync,writeFileSync,readFileSync,unlinkSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest,verifyArtifact } from './artifacts.mjs';
import { verifyAuctionStore } from './verify-store.mjs';
import { approvalWindow,workflowRequest } from '../../src/sre/workflow-contract.mjs';

const error=message=>Object.assign(new Error(message),{localWorkflowBlocked:true});
const parse=row=>row?JSON.parse(row.payload):null;
const same=(a,b)=>a.sha===b.sha&&a.artifact===b.artifact&&String(a.deploymentId)===String(b.deploymentId)&&a.deploymentAt===b.deploymentAt;

// A disposable, single-controller local fixture. This is not a production
// executor, a distributed CI lock, or a runner for arbitrary repository code.
export class LocalAuctionSandbox {
  constructor(directory,artifacts,{initialDurationMs}={}) {
    this.directory=resolve(directory);mkdirSync(this.directory,{recursive:true});this.artifacts=new Map(artifacts.map(item=>[item.artifact,item]));
    this.configuration={initialDurationMs};this.environment='local-process-test';this.tail=Promise.resolve();this.processes=[];
    this.lockPath=join(this.directory,'controller.lock');this.lockToken=randomUUID();
    const fd=openSync(this.lockPath,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,token:this.lockToken}));closeSync(fd);
    try {
      this.db=new DatabaseSync(join(this.directory,'deployments.sqlite'));
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS deployments(id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,status TEXT NOT NULL,result TEXT);');
    } catch(cause){unlinkSync(this.lockPath);throw cause;}
  }
  serial(fn) {
    if(this.closing)return Promise.reject(new Error('Local fixture is closing'));
    const next=this.tail.then(fn);this.tail=next.catch(()=>{});return next;
  }
  history() {return this.db.prepare('SELECT payload FROM deployments ORDER BY id').all().map(parse);}
  requests() {return this.db.prepare('SELECT * FROM requests ORDER BY rowid').all().map(item=>({...item,result:item.result?JSON.parse(item.result):null}));}
  inspectStore() {return verifyAuctionStore(join(this.directory,'auction.sqlite'));}
  async fetch(path,options={}) {
    if(!this.child||this.child.exitCode!==null||this.child.signalCode!==null)throw new Error('Owned auction process is not running');
    return fetch('http://127.0.0.1:'+this.port+path,{...options,redirect:'error',signal:AbortSignal.timeout(5000)});
  }
  async json(path,options={}) {const response=await this.fetch(path,options);return {status:response.status,data:await response.json()};}
  async identity() {const result=await this.json('/identity');if(result.status!==200||!same(result.data,this.current))throw error('Actual runtime identity differs from the local deployment ledger');return result.data;}
  metadata(artifact) {
    return {schemaVersion:artifact.policy.schemaVersion,rollbackCompatible:artifact.policy.rollbackCompatible===true,dataRollbackSafe:artifact.policy.rollbackCompatible===true&&artifact.policy.schemaVersion===1,dependencyFingerprint:'node-'+process.versions.node,configurationFingerprint:digest(JSON.stringify({directory:this.directory,...this.configuration})),featureFlagsFingerprint:'local-fixture-default',artifactType:'local-auction-source-bundle-v1'};
  }
  async launch(record,artifact) {
    verifyArtifact(artifact);
    const logFd=openSync(join(this.directory,'process-'+(this.processes.length+1)+'.log'),'a');
    const config={...this.configuration,storePath:join(this.directory,'auction.sqlite'),sha:record.sha,artifact:record.artifact,deploymentId:record.deploymentId,deploymentAt:record.deploymentAt,rollbackRequestId:record.rollbackRequestId,environment:this.environment};
    const child=spawn(process.execPath,[join(artifact.path,'runtime.mjs')],{cwd:artifact.path,env:{PATH:process.env.PATH||'',LANG:'C',TZ:'UTC',NODE_ENV:'test',LOCAL_AUCTION_CONFIG:JSON.stringify(config)},stdio:['ignore',logFd,logFd,'ipc']});
    this.child=child;
    const processRecord={pid:child.pid,deploymentId:record.deploymentId,sha:record.sha,artifact:record.artifact,startedAt:new Date().toISOString()};this.processes.push(processRecord);
    this.childExit=new Promise(resolveExit=>child.once('close',(code,signal)=>{closeSync(logFd);processRecord.exit={code,signal,at:new Date().toISOString()};resolveExit(processRecord.exit);}));
    try {
      const ready=await new Promise((accept,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Owned auction process did not become ready')),10000);
        child.once('error',cause=>{clearTimeout(timer);reject(cause);});
        child.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error('Owned auction exited before readiness: '+code+'/'+signal));});
        child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);accept(message);}});
      });
      if(!same(ready,record)||ready.pid!==child.pid)throw error('Owned process reported the wrong deployment identity');
      this.port=ready.port;this.current=record;await this.identity();return ready;
    } catch(cause){await this.stop('SIGKILL');throw cause;}
  }
  async stop(signal='SIGTERM') {
    if(!this.child)return;
    const child=this.child,exit=this.childExit;
    if(child.exitCode===null&&child.signalCode===null)child.kill(signal);
    let timer;const wait=ms=>Promise.race([exit,new Promise(resolveWait=>{timer=setTimeout(()=>resolveWait(null),ms);})]).finally(()=>clearTimeout(timer));
    let result=await wait(7000);
    if(!result){child.kill('SIGKILL');result=await wait(3000);}
    if(!result)throw new Error('Owned auction process did not exit; retain its controller lock');
    this.child=null;this.port=null;return result;
  }
  async replace(artifact,rollbackRequestId=null) {
    verifyArtifact(artifact); // Retention/integrity must be checked before stopping the running version.
    const at=Date.now(),pending={sha:artifact.sha,artifact:artifact.artifact,environment:this.environment,at,deploymentAt:at,status:'pending',...this.metadata(artifact),rollbackRequestId};
    const inserted=this.db.prepare('INSERT INTO deployments(payload) VALUES(?)').run(JSON.stringify(pending));
    const record={...pending,deploymentId:String(inserted.lastInsertRowid)};
    this.db.prepare('UPDATE deployments SET payload=? WHERE id=?').run(JSON.stringify(record),record.deploymentId);
    try {
      await this.stop();await this.launch(record,artifact);record.status='success';this.current=record;
      this.db.prepare('UPDATE deployments SET payload=? WHERE id=?').run(JSON.stringify(record),record.deploymentId);return structuredClone(record);
    } catch(cause){record.status='failed';record.error=cause.message;this.db.prepare('UPDATE deployments SET payload=? WHERE id=?').run(JSON.stringify(record),record.deploymentId);throw cause;}
  }
  deployFixture(artifact) {return this.serial(()=>{if(!this.artifacts.has(artifact.artifact))throw error('Unregistered local fixture artifact');return this.replace(this.artifacts.get(artifact.artifact));});}
  markHealthyTarget() {return this.serial(async()=>{
    await this.identity();const {data:metrics}=await this.json('/metrics');
    const business=this.inspectStore();
    if(!same(metrics,this.current)||!metrics.samples.some(sample=>sample.operation==='bid'&&sample.status===201&&sample.at>=this.current.at)||metrics.errors!==0||metrics.p95Ms>250||metrics.violations.length||business.violations.length)throw error('Actual auction traffic/business checks do not establish a healthy target');
    this.current={...this.current,healthy:true,healthVerifiedAt:metrics.observedAt};
    this.db.prepare('UPDATE deployments SET payload=? WHERE id=?').run(JSON.stringify(this.current),this.current.deploymentId);return structuredClone(this.current);
  });}
  rollback(input) {const submitted=structuredClone(input);return this.serial(async()=>{
    const request=workflowRequest(submitted);
    if(!/^[A-Za-z0-9._:-]{1,200}$/.test(request.requestId||'')||request.environment!==this.environment||!Number.isSafeInteger(request.expected.deploymentAt))throw error('Invalid scoped local rollback request');
    const bodyHash=digest(JSON.stringify(request)),prior=this.db.prepare('SELECT * FROM requests WHERE id=?').get(request.requestId);
    if(prior) {if(prior.body_hash!==bodyHash)throw error('Local rollback request ID was reused with different content');if(prior.status!=='complete')throw error('Earlier local workflow is unresolved or blocked; inspect its audit');return {...JSON.parse(prior.result),duplicate:true};}
    const unresolved=this.db.prepare("SELECT id FROM requests WHERE status IN ('running','unknown') LIMIT 1").get();if(unresolved)throw error('An earlier local workflow requires reconciliation');
    this.db.prepare("INSERT INTO requests(id,body_hash,status) VALUES(?,?,'running')").run(request.requestId,bodyHash);
    let started=false;
    try {
      approvalWindow(request.approval);
      await this.identity();
      if(!same(request.expected,this.current))throw error('Actual deployment changed after approval, including same-SHA redeployment');
      const artifact=this.artifacts.get(request.target.artifact);
      if(!artifact||artifact.sha!==request.target.sha)throw error('Rollback target is not a retained, registered local artifact');
      verifyArtifact(artifact);
      const target=this.history().find(item=>item.artifact===artifact.artifact&&item.healthy===true&&item.healthVerifiedAt>=item.at);
      if(!target)throw error('The exact target artifact has no measured healthy baseline');
      if(!this.current.rollbackCompatible||!this.current.dataRollbackSafe||['schemaVersion','dependencyFingerprint','configurationFingerprint','featureFlagsFingerprint'].some(key=>target[key]!==this.current[key]))throw error('Local pipeline schema/configuration/data compatibility checks failed');
      approvalWindow(request.approval); // Recheck after queueing and preflight, immediately before replacement.
      started=true;const deployed=await this.replace(artifact,request.requestId),result={requestId:request.requestId,status:'complete',deployment:deployed,duplicate:false};
      this.db.prepare("UPDATE requests SET status='complete',result=? WHERE id=?").run(JSON.stringify(result),request.requestId);return result;
    } catch(cause){this.db.prepare('UPDATE requests SET status=?,result=? WHERE id=?').run(started?'unknown':'blocked',JSON.stringify({error:cause.message}),request.requestId);throw cause;}
  });}
  control(type,extra={}) {return this.serial(async()=>{
    await this.identity();const child=this.child,id=randomUUID();
    return new Promise((accept,reject)=>{
      const cleanup=()=>{clearTimeout(timer);child.off('message',listener);};
      const listener=message=>{if(message.type==='control-receipt'&&message.id===id){cleanup();if(message.error)reject(new Error(message.error));else accept(message);}};
      const timer=setTimeout(()=>{cleanup();reject(new Error('Owned fixture control did not respond'));},5000);
      child.on('message',listener);child.send({type,id,...extra},cause=>{if(cause){cleanup();reject(cause);}});
    });
  });}
  restartCurrent(signal='SIGKILL') {return this.serial(async()=>{const record=this.current,artifact=this.artifacts.get(record.artifact);await this.stop(signal);return this.launch(record,artifact);});}
  close() {
    if(!this.closePromise){this.closing=true;this.closePromise=(async()=>{await this.tail;await this.stop();this.db.close();const saved=JSON.parse(readFileSync(this.lockPath,'utf8'));if(saved.token===this.lockToken)unlinkSync(this.lockPath);})();}
    return this.closePromise;
  }
}
