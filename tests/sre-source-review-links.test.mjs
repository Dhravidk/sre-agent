import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {postgresSql} from '../src/sre/database.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {IncidentWorker} from '../src/sre/worker.mjs';
import {bindSourceEvidence} from '../src/sre/source-evidence.mjs';
import {normalize} from '../src/sre/normalize.mjs';

for(const dialect of ['sqlite','postgres'])for(const provider of ['gitlab','github'])test(dialect+': Claude source projection retains discovered '+provider+' reviews and follows a later head without rediscovery',async()=>{
  let db;if(dialect==='postgres'){const pg=new PGlite();db={dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=config.services[0],base='a'.repeat(40),deployed='b'.repeat(40),first='c'.repeat(40),next='d'.repeat(40),at=Date.now()-10000;
  service.gitlab={...service.gitlab,project:'17'};service.github={...service.github,repository:'fictional/auction'};
  let head=first,discover=true;const files=[{filename:'src/service.mjs',new_path:'src/service.mjs',patch:'@@ -1 +1 @@\n-old\n+new',diff:'@@ -1 +1 @@\n-old\n+new'}],reads=[];
  const client={deployments:async()=>({items:[],complete:true}),linkedChanges:async()=>({items:discover?[{iid:72,number:72}]:[],complete:true}),compare:async(a,b)=>({merge_base_commit:{sha:a},commit:{id:b},compare_timeout:false,files,diffs:files}),file:async(path,sha)=>({path,sha,complete:true,content:'export const version = '+JSON.stringify(sha)+';\n'}),mergeRequest:async n=>{reads.push([n,head]);return {mergeRequest:{iid:n,sha:head,diff_refs:{base_sha:base,head_sha:head}},files,complete:true};},pull:async n=>{reads.push([n,head]);return {pull:{number:n,head:{sha:head},base:{sha:base}},files,complete:true};}};
  const connectors=new Map([[service.key,{[provider]:client}]]),r=await createSreRuntime({config,db,connectors,autoStart:false});
  const worker=()=>new IncidentWorker({store:r.store,services:[service],connectors,casework:r.casework,reasoner:{mode:'claude'}});
  try{
    for(const [sha,time]of [[base,at-20000],[deployed,at-10000]])await r.store.ingest({id:sha,source:provider,serviceKey:service.key,kind:'deployment',at:time,payload:{provider,sha,environment:service.environment,status:'success'}});
    const {incidentId}=await r.store.ingest({id:'runtime-failure',source:'evaluation',serviceKey:service.key,kind:'problem',issueKey:'runtime-failure',status:'OPEN',at,payload:{}});
    await worker().collect(await r.store.context(incidentId),new AbortController().signal);
    const links=await r.store.db.query('SELECT provider,change_number FROM sre_incident_change_links WHERE incident_id=?',[incidentId]);assert.deepEqual(links.map(l=>({...l})),[{provider,change_number:'72'}]);
    discover=false;head=next;const before=(await r.store.context(incidentId)).incident.revision;
    const payload=provider==='gitlab'?{project:{id:17},object_kind:'merge_request',object_attributes:{iid:72,state:'opened',last_commit:{id:next},updated_at:new Date().toISOString(),title:'Updated scoped fix'}}:{repository:{full_name:'fictional/auction'},action:'synchronize',pull_request:{number:72,state:'open',head:{sha:next},base:{sha:base},updated_at:new Date().toISOString(),title:'Updated scoped fix'}};
    await r.store.ingest(normalize(provider,payload,service,{deliveryId:'new-review-head',eventType:'pull_request'}));
    assert.ok(Number((await r.store.context(incidentId)).incident.revision)>Number(before));
    // A fresh worker must find the relationship in SQL, without linkedChanges.
    await worker().collect(await r.store.context(incidentId),new AbortController().signal);
    const context=await r.store.context(incidentId),reviews=context.evidence.filter(e=>e.kind==='code_review');
    assert.ok(reviews.some(e=>e.content.headSha===next&&e.content.sourceFiles.some(f=>f.sha===next)));
    assert.ok(reads.some(([n,sha])=>String(n)==='72'&&sha===next));assert.ok(context.deployments.every(d=>d.sha!==next));
  }finally{await r.close();}
});

test('source review identity is bounded and is not inferred from deployment comparisons or invalid numbers',async()=>{
  const options={provider:'gitlab',comparisonKind:'review',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),complete:false,client:{},data:{diffs:[],mergeRequest:{iid:17,description:'x'.repeat(1000000)}}};
  const proof=await bindSourceEvidence(options);assert.deepEqual(proof.comparison.mergeRequest,{iid:17});assert.ok(JSON.stringify(proof).length<1500);
  for(const iid of [0,-1,'17',Number.MAX_SAFE_INTEGER+1])assert.equal((await bindSourceEvidence({...options,data:{...options.data,mergeRequest:{iid}}})).comparison.mergeRequest,undefined);
  assert.equal((await bindSourceEvidence({...options,comparisonKind:'deployment'})).comparison.mergeRequest,undefined);
});
