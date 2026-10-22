import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {incidentScopeFixture} from '../fixtures/sre-incident-scope.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {exportDatabase,importDatabase} from '../src/sre/database-transfer.mjs';

const at=Date.now()-10000;
const sample={timestamp:at,level:'ERROR',code:'CHECKSUM_MISMATCH',environment:'prod',region:'eu',sha:'b'.repeat(40),operation:'/api/bids',message:'Ledger checksum mismatch'};
async function fixture(dialect){
 const pg=dialect==='postgres'?new PGlite():null,db=pg?{dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:sqliteDatabase(':memory:');
 const service=loadConfig({}).services[0],store=await new SreStore(db,{services:[service],clock:()=>at+100000}).initialize();
 const {incidentId}=await store.ingest({id:'log-window',source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'log-window',status:'OPEN',at,payload:{problemId:'P-WINDOW'}});
 return{store,incidentId,close:()=>db.close(),add:async(records,extra={},when=at,source='dynatrace',kind='logs')=>store.addEvidence(incidentId,source,kind,{records,complete:true,...extra},when)};
}
async function pressure(f,{count=320,multi=false,correlation=false,base=at}={}){
 for(let n=1;n<=count;n++){
  const requestId='request-us-'+String(n).padStart(6,'0'),error={...sample,timestamp:base+n,code:'PROVIDER_UNAVAILABLE',region:'us',sha:'a'.repeat(40),message:correlation?'Provider timeout for '+requestId:'Provider timeout',requestId};
  const records=multi?[error,{...sample,timestamp:base+n,level:'INFO',code:undefined,operation:'/health',statusCode:200,message:'Health check success'}]:[error];
  if(multi&&n%2)records.reverse();await f.add(records,{},base+n);
 }
}
for(const dialect of ['sqlite','postgres']){
 for(const[multi,correlation]of[[false,false],[true,true]])test(dialect+': a rare older error survives repeated '+(multi?'multi-record':'single-record')+' snapshots before the candidate cap',async()=>{
  const f=await fixture(dialect);try{
   const rare=await f.add([sample]);await pressure(f,{multi,correlation});const c=await f.store.context(f.incidentId),model=boundedContext(c);
   assert.ok(c.evidence.some(e=>e.id===rare),'deduplication after a recent-row cap loses the rare source');assert.ok(c.signalDigest.groups.some(g=>g.code===sample.code));
   assert.equal(c.evidenceWindow.candidatesLimited,true);assert.ok(c.evidenceWindow.candidatesRead<=240);assert.ok(c.evidence.length<=120);assert.ok(c.signalDigest.groups.some(g=>g.code==='PROVIDER_UNAVAILABLE'));assert.ok(model.evidence.some(e=>e.id===rare));assert.ok(Buffer.byteLength(JSON.stringify(model))<=160000);
   assert.ok(Number((await f.store.db.query('SELECT COUNT(*) AS count FROM sre_evidence WHERE incident_id=?',[f.incidentId]))[0].count)>320);
  }finally{await f.close();}
 });
 for(const[name,a,b]of[
  ['partial receipt',{complete:true},{complete:false}],
  ['sampling receipt',{metadata:{grail:{sampled:false}}},{metadata:{grail:{sampled:true}}}],
  ['conflicting scope alias',{records:[{...sample,'cloud.region':'eu'}]},{records:[{...sample,'cloud.region':'eu',region:'us'}]}],
  ['typed region',{records:[{...sample,region:1}]},{records:[{...sample,region:'1'}]}],
  ['null versus missing attribute',{records:[{...sample,customerSegment:null}]},{records:[sample]}],
  ['unknown source attribute',{records:[{...sample,dependency:{pool:'eu'}}]},{records:[{...sample,dependency:{pool:'us'}}]}]
 ])test(dialect+': '+name+' stays distinct when selecting raw log snapshots',async()=>{
  const f=await fixture(dialect);try{
   const first=await f.add(a.records||[sample],a,at),second=await f.add(b.records||[sample],b,at+1),c=await f.store.context(f.incidentId);
   assert.ok(c.evidence.some(e=>e.id===first));assert.ok(c.evidence.some(e=>e.id===second));
  }finally{await f.close();}
 });
 test(dialect+': amount and status numbers in a message remain significant without an explicit correlation ID',async()=>{
  const f=await fixture(dialect);try{
   const first=await f.add([{...sample,message:'Bid amount 500 rejected with 409'}]),second=await f.add([{...sample,message:'Bid amount 501 rejected with 500'}],{},at+1),c=await f.store.context(f.incidentId);
   assert.ok(c.evidence.some(e=>e.id===first));assert.ok(c.evidence.some(e=>e.id===second));assert.equal(c.signalDigest.groups.length,2);
  }finally{await f.close();}
 });
 test(dialect+': equal samples from independent sources retain both source receipts',async()=>{
  const f=await fixture(dialect);try{const one=await f.add([sample]),two=await f.add([sample],{},at,'logs');const c=await f.store.context(f.incidentId);assert.ok(c.evidence.some(e=>e.id===one));assert.ok(c.evidence.some(e=>e.id===two));}finally{await f.close();}
 });
 test(dialect+': oversized pages and invalid record types remain retained without expanding selection work beyond the page bound',async()=>{
  const f=await fixture(dialect);try{const records=Array.from({length:201},(_,n)=>({...sample,timestamp:at+n})),one=await f.add(records),two=await f.add(records,{},at+1),invalid=await f.add([null,false,'unstructured'],{},at+2);const c=await f.store.context(f.incidentId);for(const id of[one,two,invalid])assert.ok(c.evidence.some(e=>e.id===id));assert.equal(c.signalDigest.coverage.invalidRecords,3);}finally{await f.close();}
 });
 test(dialect+': the source window remains explicitly incomplete with more distinct error families than its bound',async()=>{
  const f=await fixture(dialect);try{for(let n=0;n<260;n++)await f.add([{...sample,timestamp:at+n,message:'Different bid amount '+n}],{},at+n);const c=await f.store.context(f.incidentId);assert.equal(c.evidenceWindow.candidatesLimited,true);assert.equal(c.signalDigest.coverage.candidateWindowLimited,true);assert.ok(c.signalDigest.coverage.omittedGroups>0);assert.ok(c.signalDigest.groups.length<=12);}finally{await f.close();}
 });
 test(dialect+': the real rules flow retains a rare EU alternative, code, both team reports and separate US context during a repetition storm',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   const base=await f.r.store.coordinationNow()-1000,rare=await f.r.store.addEvidence(f.state.primaryId,'dynatrace','logs',{records:[{...sample,timestamp:base,environment:f.service.environment,region:'eu-west-1',sha:f.state.badSha}],complete:true},base);
   await pressure({add:(records,extra,when)=>f.r.store.addEvidence(f.state.primaryId,'dynatrace','logs',{records:records.map(r=>({...r,environment:f.service.environment,region:r.region==='eu'?'eu-west-1':'us-east-1',sha:r.region==='eu'?f.state.badSha:f.state.baselineSha})),complete:true,...extra},when)},{base});
   await f.message(f.state.primaryId,f.state.primaryRooms[0],'report blocked Log-window drill: EU checksum and winner invariant remain wrong.');
   await f.message(f.state.primaryId,f.state.primaryRooms[1],'report recovered Log-window drill: probes pass but the business invariant is unverified.','noor');
   await f.message(f.state.providerId,f.state.providerRooms[0],'update US-WINDOW-PRIVATE-47 remains in the separate US investigation.','alex');
   await f.question();await f.settle();await f.message(f.state.primaryId,f.state.primaryRooms[0],'sync');await f.deliver();
   const c=await f.r.store.context(f.state.primaryId),plan=await f.r.casework.createPlan(f.state.primaryId);
   assert.ok(c.evidence.some(e=>e.id===rare));assert.ok(c.signalDigest.groups.some(g=>g.code===sample.code&&g.scopeRelation==='matching'));assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.ok(c.incident.analysis.codeReview.findings.length);assert.equal(plan.payload.patch,null);assert.ok(plan.payload.signalGroups.some(g=>g.code===sample.code));assert.ok(plan.markdown.includes('Ledger checksum mismatch'));assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
   for(const room of f.state.primaryRooms.slice(0,2)){const messages=f.sent.filter(m=>m.room===room);assert.ok(messages.some(m=>m.text.includes(sample.code)));assert.ok(messages.some(m=>m.text.includes('Log-window drill: EU')&&m.text.includes('Log-window drill: probes')));assert.ok(messages.every(m=>!m.text.includes('US-WINDOW-PRIVATE-47')));}
  }finally{await f.close();}
 });
 test(dialect+': a newer malformed monitor scope cannot be hidden by log repetitions or repaired by an older replay',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   const c=await f.r.store.context(f.state.primaryId),scope=c.signalDigest.incidentScope,row=c.evidence.find(e=>e.id===scope.evidenceId);assert.equal(scope.state,'reported');
   await f.r.store.addEvidence(f.state.primaryId,'log-monitor','problem',{...row.content,scope:{...row.content.scope,region:'us-east-1'}},scope.observedAt+2);
   await pressure({add:(records,extra,when)=>f.r.store.addEvidence(f.state.primaryId,'dynatrace','logs',{records,...extra},when)});
   assert.equal((await f.r.store.context(f.state.primaryId)).signalDigest.incidentScope.state,'unknown');
   await f.r.store.addEvidence(f.state.primaryId,'log-monitor','problem',{...row.content,mockReceipt:'late-older-host-observation'},scope.observedAt+1);
   assert.equal((await f.r.store.context(f.state.primaryId)).signalDigest.incidentScope.state,'unknown');
   await f.r.store.addEvidence(f.state.primaryId,'log-monitor','problem',{...row.content,mockReceipt:'newer-host-observation'},scope.observedAt+3);
   assert.equal((await f.r.store.context(f.state.primaryId)).signalDigest.incidentScope.state,'reported');
  }finally{await f.close();}
 });
}

test('file reopen retains all original log rows and the selected rare sample without a persisted selection index',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sre-log-window-')),f=await incidentScopeFixture('sqlite',{path:join(dir,'agent.sqlite')});try{
  const rare=await f.r.store.addEvidence(f.state.primaryId,'dynatrace','logs',{records:[sample]},at);await pressure({add:(records,extra,when)=>f.r.store.addEvidence(f.state.primaryId,'dynatrace','logs',{records,...extra},when)});const rows=await f.r.store.db.query('SELECT * FROM sre_evidence ORDER BY id');await f.restart();assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_evidence ORDER BY id'),rows);assert.ok((await f.r.store.context(f.state.primaryId)).evidence.some(e=>e.id===rare));
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
for(const[from,to]of[['sqlite','postgres'],['postgres','sqlite']])test(from+' → '+to+': selection is reconstructed after a held database transfer from immutable log evidence',async()=>{
 const source=await incidentScopeFixture(from),target=await incidentScopeFixture(to,{initialize:false});try{
  const rare=await source.r.store.addEvidence(source.state.primaryId,'dynatrace','logs',{records:[sample]},at);await pressure({add:(records,extra,when)=>source.r.store.addEvidence(source.state.primaryId,'dynatrace','logs',{records,...extra},when)});
  const archive=await exportDatabase(source.r.store,{offline:true,actor:{kind:'local-operator',id:'Fictional window lead'}});await importDatabase(target.r.store,{snapshot:archive.snapshot,expectedSha256:archive.sha256,restoreId:'log-window-transfer',reason:'Fictional rare log transfer',offline:true,actor:{kind:'local-operator',id:'Fictional window lead'}});
  const c=await target.r.store.context(source.state.primaryId);assert.equal(c.recoveryFence.active,true);assert.ok(c.evidence.some(e=>e.id===rare));assert.equal(await target.r.outbox.runOnce(),false);assert.equal((await target.r.store.snapshot()).rollbacks.length,0);
 }finally{await source.close();await target.close();}
});
