import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {ModelQuotaError} from '../src/sre/model-quota.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {seedDemo} from '../src/sre/demo.mjs';

async function database(dialect,path){
  if(dialect==='sqlite')return sqliteDatabase(path);
  const pg=new PGlite(path);
  return {dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
}
const actor={kind:'local-operator',id:'test operator'};
for(const dialect of ['sqlite','postgres'])test(dialect+': quota holds every incident across restart and preserves the exact question batch',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-quota-')),path=join(directory,dialect==='sqlite'?'state.sqlite':'postgres');
  let store=await new SreStore(await database(dialect,path),{questionBatchLimit:8}).initialize();
  const open=async id=>(await store.ingest({id,source:'fixture',serviceKey:'service',kind:'problem',issueKey:id,status:'OPEN',at:await store.coordinationNow(),payload:{}})).incidentId;
  try{
    const incident=await open('first');
    for(let n=0;n<3;n++)await store.ingest({id:'question-'+n,source:'operator-api',serviceKey:'service',incidentId:incident,kind:'question',conversationKey:'room-'+n,at:await store.coordinationNow(),payload:{text:'Scoped question '+n}});
    const job=await store.claim('first-worker'),payload=structuredClone(job.payload);assert.equal(payload.requests.length,3);
    await store.fail(job,new ModelQuotaError('claude-cli',{resetLabel:'7pm America/Detroit'}),1);
    const hold=await store.modelQuota();assert.equal(hold.state,'held');assert.equal(hold.retryAt,null);
    const later=await open('second');assert.ok(later);
    assert.equal(await store.claim('first-worker'),null);
    let [retained]=await store.db.query('SELECT status,attempts,payload FROM sre_jobs WHERE id=?',[job.id]);
    assert.equal(retained.status,'pending');assert.equal(Number(retained.attempts),0);assert.deepEqual(JSON.parse(retained.payload),payload);
    await store.release('first-worker');await store.db.close();
    store=await new SreStore(await database(dialect,path),{questionBatchLimit:8}).initialize();
    assert.deepEqual(await store.modelQuota(),hold);assert.equal(await store.claim('replacement-worker'),null);
    await assert.rejects(()=>store.resumeModelQuota({holdId:hold.id,reason:'resume',actor:{kind:'teams',id:'responder'}}),/operator/);
    await assert.rejects(()=>store.resumeModelQuota({holdId:'stale-id',reason:'resume',actor}),/changed/);
    const input={holdId:hold.id,reason:'Operator checked the account reset',actor};
    assert.equal((await store.resumeModelQuota(input)).duplicate,false);assert.equal((await store.resumeModelQuota(input)).duplicate,true);
    await assert.rejects(()=>store.resumeModelQuota({...input,reason:'different request'}),/different/);
    // The newer incident keeps its fair turn; then the retained batch resumes.
    const other=await store.claim('replacement-worker');assert.equal(other.incident_id,later);
    await store.finish(other,{summary:'Queue fixture',text:'Queue fixture'},null,Number((await store.context(later)).incident.revision));
    const retry=await store.claim('replacement-worker');assert.equal(retry.id,job.id);assert.deepEqual(retry.payload,payload);assert.equal(retry.attempts,1);
    // An old owner cannot install a hold after takeover, even with a real error.
    await store.fail(job,new ModelQuotaError('claude-cli'),1);assert.equal((await store.modelQuota()).state,'released');
    await store.fail(retry,new ModelQuotaError('codex-cli',{retryAt:(await store.coordinationNow())-1}),1);
    const automatic=await store.claim('replacement-worker');assert.equal(automatic.id,job.id);assert.equal((await store.modelQuota()).release.kind,'provider-reset-deadline');
    // Model-shaped objects and ordinary failures do not acquire quota authority.
    await store.fail(automatic,Object.assign(new Error('Fixture failure'),{provider:'claude-cli',retryAt:null}),1);
    assert.equal((await store.modelQuota()).state,'released');
    [retained]=await store.db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]);assert.equal(retained.status,'dead');
  }finally{await store.db.close();await rm(directory,{recursive:true,force:true});}
});

test('quota API exposes the hold and requires the current authenticated operator boundary to resume',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),runtime=await createSreRuntime({config,autoStart:false,reasoner:{mode:'claude',investigate:async()=>{throw new ModelQuotaError('claude-cli',{resetLabel:'7pm America/Detroit'});}}});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+runtime.server.address().port;
  try{
    await seedDemo(runtime.store,config.services[0]);assert.equal(await runtime.worker.runOnce(),false);
    const response=await fetch(base+'/api/agent/quota'),hold=await response.json();assert.equal(response.status,200);assert.equal(hold.state,'held');
    const input={holdId:hold.id,reason:'Account reset checked by operator'};
    const denied=await fetch(base+'/api/agent/quota/resume',{method:'POST',headers:{'content-type':'application/json',origin:'https://untrusted.invalid'},body:JSON.stringify(input)});assert.equal(denied.status,403);assert.equal((await runtime.store.modelQuota()).state,'held');
    const resumed=await fetch(base+'/api/agent/quota/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});assert.equal(resumed.status,200);assert.equal((await resumed.json()).state,'released');
    const status=await (await fetch(base+'/api/status')).json();assert.equal(status.modelQuota.state,'released');assert.ok(status.jobs.every(j=>j.status!=='dead'));
  }finally{await runtime.close();}
});
