import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sqliteDatabase,postgresSql,StorageError} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {hash} from '../src/sre/security.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {incidentScopeFixture} from '../fixtures/sre-incident-scope.mjs';
import {exportDatabase,importDatabase} from '../src/sre/database-transfer.mjs';

const end=Date.now(),base=end-1000000,sha='b'.repeat(40);
const sample={timestamp:base,level:'ERROR',code:'WINNING_BID_REGRESSED',environment:'local',region:'eu-west-1',sha,message:'Fictional accepted winner mismatch'};
async function fixture(dialect,{path=':memory:',seed=true}={}){
 const pg=dialect==='postgres'?new PGlite():null,db=pg?{dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:sqliteDatabase(path);
 const service=loadConfig({}).services[0],store=await new SreStore(db,{services:[service],clock:()=>Date.now(),simulation:true}).initialize();let id,monitor,code,people=[];
 if(seed){const scope={environment:service.environment,region:'eu-west-1',version:sha},receipt=await store.ingest({id:'source-fairness',source:'log-monitor',serviceKey:service.key,kind:'problem',issueKey:'log-monitor:source-fairness:'+hash(scope),status:'OPEN',at:base,payload:{monitorId:'source-fairness',scope,records:[{...sample,environment:service.environment}],complete:true}});id=receipt.incidentId;monitor=(await store.context(id)).signalDigest.incidentScope.evidenceId;
  code=await store.addEvidence(id,'gitlab','release_diff',{comparisonKind:'deployment',baseSha:'a'.repeat(40),headSha:sha,complete:true,policySources:{path:'src/auction/rules.mjs',complete:true,base:'Fictional before code',head:'Fictional after code'}},base+1);
  for(const[user,n]of[['avery',0],['noor',1]])people.push(await store.addEvidence(id,'teams-context','responder_update',{conversationId:service.teams.conversations[n],userId:user,text:'Fictional quiet '+user+' report; recovery unverified.'},base+2+n));
 }
 return{store,service,id,monitor,code,people,close:()=>db.close()};
}
async function pressure(f,{count=330,kind='logs',sameTime=false}={}){
 for(let n=0;n<count;n++)await f.store.addEvidence(f.id,'dynatrace',kind,{records:[{...sample,timestamp:base+100+n,level:'CRITICAL',code:'DISTINCT_PROVIDER_FAILURE_'+n,environment:f.service.environment,region:'us-east-1',sha:'a'.repeat(40),message:'Fictional provider pattern '+n}],complete:true},sameTime?base+100:base+100+n);
}
function retained(f,c){assert.ok(c.evidence.some(e=>e.id===f.code),'quiet code must survive a high-cardinality log source');assert.ok(c.evidence.some(e=>e.id===f.monitor),'the host monitor must survive that source');assert.equal(c.signalDigest.incidentScope.state,'reported');for(const id of f.people)assert.ok(c.evidence.some(e=>e.id===id));assert.ok(c.evidenceWindow.candidatesRead<=240);assert.equal(c.evidenceWindow.candidatesLimited,true);const model=boundedContext(c);assert.ok(model.evidence.some(e=>e.id===f.code));assert.ok(Buffer.byteLength(JSON.stringify(model))<=160000);}

for(const dialect of ['sqlite','postgres']){
 test(dialect+': hundreds of distinct log families cannot evict quiet code, the monitor or either responder before the candidate cap',async()=>{
  const f=await fixture(dialect);try{await pressure(f);const rows=await f.store.db.query('SELECT * FROM sre_evidence ORDER BY id'),c=await f.store.context(f.id);retained(f,c);assert.deepEqual(await f.store.db.query('SELECT * FROM sre_evidence ORDER BY id'),rows);assert.ok(c.signalDigest.coverage.omittedGroups>0);assert.ok(c.signalDigest.groups.some(g=>g.scopeRelation==='different'));}finally{await f.close();}
 });
 test(dialect+': a quiet review and deployment comparison survive distinct logs plus hundreds of heads from a busy MR',async()=>{
  const f=await fixture(dialect);try{
   const quiet=await f.store.addEvidence(f.id,'gitlab','code_review',{comparisonKind:'review',number:73,baseSha:'a'.repeat(40),headSha:sha,complete:true,comparison:{mergeRequest:{iid:73,project_id:55},diffs:[{new_path:'quiet-fix.mjs',diff:'Fictional quiet review'}]}},base+5);
   for(let n=1;n<=300;n++)await f.store.addEvidence(f.id,'gitlab','code_review',{comparisonKind:'review',number:72,baseSha:'a'.repeat(40),headSha:n.toString(16).padStart(40,'0'),complete:true,comparison:{mergeRequest:{iid:72,project_id:55},diffs:[{new_path:'busy-fix.mjs',diff:'Fictional head '+n}]}},base+10+n);
   await pressure(f);const c=await f.store.context(f.id);retained(f,c);assert.ok(c.evidence.some(e=>e.id===quiet));assert.ok(boundedContext(c).evidence.some(e=>e.id===quiet));assert.ok(c.signalDigest.changes.some(g=>g.mergeRequest?.number===73));
  }finally{await f.close();}
 });
 test(dialect+': source/kind fairness preserves a quiet partial reader and ticket amid two noisy log kinds',async()=>{
  const f=await fixture(dialect);try{
   const partial=await f.store.addEvidence(f.id,'dynatrace-logs','logs',{records:[{...sample,code:'PARTIAL_EU_SAMPLE'}],complete:false,metadata:{grail:{sampled:true}}},base+5),ticket=await f.store.addEvidence(f.id,'servicenow','ticket',{number:'INC-QUIET',short_description:'Fictional scoped ticket'},base+6);
   await pressure(f);await pressure(f,{kind:'log'});const c=await f.store.context(f.id);retained(f,c);for(const id of[partial,ticket])assert.ok(c.evidence.some(e=>e.id===id));assert.ok(c.signalDigest.coverage.partialResults>0);
  }finally{await f.close();}
 });
 test(dialect+': tied observations stay deterministic and hydration cannot import another incident’s private responder context',async()=>{
  const f=await fixture(dialect);try{
   const other=(await f.store.ingest({id:'other-source-fairness',source:'dynatrace',serviceKey:f.service.key,kind:'problem',issueKey:'other-source-fairness',status:'OPEN',at:base,payload:{problemId:'OTHER'}})).incidentId;await f.store.addEvidence(other,'teams-context','responder_update',{conversationId:'separate-us',userId:'alex',text:'FAIRNESS-US-PRIVATE-91'},base+1000);
   await pressure(f,{sameTime:true});const c=await f.store.context(f.id),again=await f.store.context(f.id);retained(f,c);assert.deepEqual(again.evidence.map(e=>e.id),c.evidence.map(e=>e.id));assert.ok(c.evidence.every(e=>e.incident_id===f.id));assert.ok(!JSON.stringify(c).includes('FAIRNESS-US-PRIVATE-91'));
  }finally{await f.close();}
 });
 test(dialect+': a denied ranked read rejects the context without returning an empty or partly hydrated source window',async()=>{
  const f=await fixture(dialect);try{await pressure(f);const rows=await f.store.db.query('SELECT * FROM sre_evidence ORDER BY id'),query=f.store.db.query;let denied=true;f.store.db.query=async(sql,args)=>{if(denied&&sql.includes('AS source_rank'))throw new StorageError(Object.assign(Error('Fictional denied candidate query'),{code:'42501'}));return query(sql,args);};await assert.rejects(f.store.context(f.id),e=>e.status===503);denied=false;retained(f,await f.store.context(f.id));assert.deepEqual(await query('SELECT * FROM sre_evidence ORDER BY id'),rows);}finally{await f.close();}
 });
 test(dialect+': parsed JSON remains transient and retains typed, Unicode, oversized and malformed-record uncertainty',async()=>{
  const f=await fixture(dialect);try{
   const record={...sample,message:'Fictional 🧪 trace with "quotes" and \\slashes',region:null,extra:{missing:null,number:1,string:'1',flag:false}},typed=await f.store.addEvidence(f.id,'dynatrace','logs',{records:[record],complete:false},base+10),oversized=await f.store.addEvidence(f.id,'logs','logs',{records:Array.from({length:201},(_,n)=>({...sample,timestamp:base+n}))},base+11),invalid=await f.store.addEvidence(f.id,'dynatrace-logs','logs',{records:[null,false,'unstructured']},base+12);
   const c=await f.store.context(f.id);for(const id of[typed,oversized,invalid])assert.ok(c.evidence.some(e=>e.id===id));assert.deepEqual(c.evidence.find(e=>e.id===typed).content.records,[record]);assert.equal(c.signalDigest.coverage.invalidRecords,3);assert.ok(c.signalDigest.coverage.partialResults>0);for(const row of c.evidence){assert.ok(!Object.hasOwn(row,'family_rank'));assert.ok(!Object.hasOwn(row,'source_rank'));assert.ok(!Object.hasOwn(row,'log_document'));}
  }finally{await f.close();}
 });
 test(dialect+': the full rules flow keeps its actual code finding and both groups informed during distinct-error pressure',async()=>{
  const f=await incidentScopeFixture(dialect);try{
   const before=await f.r.store.context(f.state.primaryId),code=before.evidence.find(e=>e.source==='gitlab'&&e.content.policySources);assert.ok(code);
   for(let n=0;n<330;n++){const at=await f.r.store.coordinationNow();await f.r.store.addEvidence(f.state.primaryId,'dynatrace','logs',{records:[{timestamp:at,level:'CRITICAL',code:'DISTINCT_PROVIDER_FAILURE_'+n,environment:f.service.environment,region:'us-east-1',sha:f.state.baselineSha,message:'Distinct source-pressure provider pattern '+n}],complete:true},at);}
   await f.message(f.state.primaryId,f.state.primaryRooms[0],'report blocked Source-fairness drill: retain the exact code finding and compare one affected EU request.');await f.message(f.state.primaryId,f.state.primaryRooms[1],'report recovered Source-fairness drill: probes pass, but neither cause nor the winner invariant has been verified.','noor');await f.message(f.state.providerId,f.state.providerRooms[0],'update FAIRNESS-US-PRIVATE-91 belongs only to the separate US incident.','alex');await f.question();await f.settle();await f.message(f.state.primaryId,f.state.primaryRooms[0],'sync');await f.deliver();
   const c=await f.r.store.context(f.state.primaryId),plan=await f.r.casework.createPlan(f.state.primaryId);assert.ok(c.evidence.some(e=>e.id===code.id));assert.equal(c.signalDigest.incidentScope.state,'reported');assert.ok(c.incident.analysis.codeReview.findings.length);assert.equal(c.incident.analysis.changeAssessment,'unknown');assert.equal(plan.payload.patch,null);assert.ok(plan.payload.findings.length);assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
   for(const room of f.state.primaryRooms.slice(0,2)){const messages=f.sent.filter(m=>m.room===room);assert.ok(messages.some(m=>m.text.includes('Scoped code findings')&&m.text.includes('WINNING_BID_REGRESSED')));assert.ok(messages.some(m=>m.text.includes('Source-fairness drill: retain')&&m.text.includes('Source-fairness drill: probes')));assert.ok(messages.every(m=>!m.text.includes('FAIRNESS-US-PRIVATE-91')));}
  }finally{await f.close();}
 });
}

test('file reopen reconstructs source fairness from unchanged raw evidence without a new persistent index',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sre-source-fairness-')),path=join(dir,'agent.sqlite');let f=await fixture('sqlite',{path});try{await pressure(f);const state={id:f.id,code:f.code,monitor:f.monitor,people:f.people},rows=await f.store.db.query('SELECT * FROM sre_evidence ORDER BY id');await f.close();f=await fixture('sqlite',{path,seed:false});Object.assign(f,state);retained(f,await f.store.context(f.id));assert.deepEqual(await f.store.db.query('SELECT * FROM sre_evidence ORDER BY id'),rows);}finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
for(const[from,to]of[['sqlite','postgres'],['postgres','sqlite']])test(from+' → '+to+': a held transfer retains quiet code and the monitor under source-family pressure',async()=>{
 const source=await fixture(from),target=await fixture(to,{seed:false});try{await pressure(source);const archive=await exportDatabase(source.store,{offline:true,actor:{kind:'local-operator',id:'Fictional source-window lead'}});await importDatabase(target.store,{snapshot:archive.snapshot,expectedSha256:archive.sha256,restoreId:'source-fairness-transfer',reason:'Fictional source-window transfer',offline:true,actor:{kind:'local-operator',id:'Fictional source-window lead'}});const c=await target.store.context(source.id);retained(source,c);assert.equal(c.recoveryFence.active,true);}finally{await source.close();await target.close();}
});
