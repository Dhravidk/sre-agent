import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { sqliteDatabase, StorageError } from '../src/sre/database.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';

test('database adapters classify storage failure without reclassifying application validation',async()=>{
  const db=sqliteDatabase(':memory:');
  try {
    await assert.rejects(()=>db.query('SELECT secret_value FROM missing_table'),error=>error instanceof StorageError&&error.status===503&&!error.message.includes('secret_value')&&Boolean(error.cause));
    await db.query('CREATE TABLE validation_test (value TEXT)');
    const validation=new Error('Invalid source identity');
    await assert.rejects(()=>db.transaction(async q=>{await q('INSERT INTO validation_test(value) VALUES(?)',['uncommitted']);throw validation;}),error=>error===validation);
    assert.equal((await db.query('SELECT * FROM validation_test')).length,0);
  } finally {await db.close();}
});

test('failed webhook storage returns retryable 503, rolls back the inbox, and accepts a safe retry once',async()=>{
  const db=sqliteDatabase(':memory:');let failInsert=false;
  const database={...db,transaction:fn=>db.transaction(q=>fn(async(sql,args)=>{
    const result=await q(sql,args);
    if(failInsert&&sql.includes('INSERT INTO sre_events')){failInsert=false;await q('SELECT * FROM deliberately_missing_storage_fixture');}
    return result;
  }))};
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});config.mode='connected';config.apiToken='fixture-api';config.env={HOOK:'fixture-hook'};
  const service=config.services[0];Object.assign(service.github,{enabled:true,webhookSecretEnv:'HOOK'});
  const runtime=await createSreRuntime({config,db:database,connectors:new Map(),autoStart:false});
  runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');
  const base='http://127.0.0.1:'+runtime.server.address().port;
  const payload={repository:{full_name:service.github.repository},action:'opened',pull_request:{number:42,head:{sha:'a'.repeat(40)},base:{sha:'b'.repeat(40)},updated_at:new Date().toISOString(),title:'Fixture change'}};
  const body=JSON.stringify(payload),headers={'x-github-event':'pull_request','x-github-delivery':'retryable-delivery','x-hub-signature-256':'sha256='+createHmac('sha256',config.env.HOOK).update(body).digest('hex')};
  const post=()=>fetch(base+'/webhooks/github/'+service.key,{method:'POST',headers,body});
  try {
    failInsert=true;
    const failed=await post();assert.equal(failed.status,503);assert.equal(failed.headers.get('retry-after'),'5');
    assert.deepEqual(await failed.json(),{error:'SRE storage is temporarily unavailable'});
    assert.equal((await runtime.store.snapshot()).counts.length,0);assert.equal((await runtime.store.snapshot()).jobs.length,0);
    assert.equal((await post()).status,202);
    const duplicate=await post();assert.equal(duplicate.status,202);assert.equal((await duplicate.json()).duplicate,true);
    assert.equal((await runtime.store.snapshot()).counts[0].count,1);
    assert.equal((await runtime.store.snapshot()).jobs.length,1);
    const malformed=await fetch(base+'/webhooks/github/'+service.key,{method:'POST',headers,body:body+' '});
    assert.equal(malformed.status,401);
  } finally {await runtime.close();}
});

test('liveness reports a storage outage as 503 and recovers without exposing database details',async()=>{
  const runtime=await createSreRuntime({config:loadConfig({SRE_SQLITE_PATH:':memory:'}),autoStart:false});
  const original=runtime.store.db.query;let failed=true;
  runtime.store.db.query=(sql,args)=>failed?Promise.reject(new StorageError(new Error('private database address'))):original(sql,args);
  runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');
  const base='http://127.0.0.1:'+runtime.server.address().port;
  try {
    const response=await fetch(base+'/health');assert.equal(response.status,503);assert.equal((await response.text()).includes('private database address'),false);
    failed=false;assert.equal((await fetch(base+'/health')).status,200);
  } finally {failed=false;await runtime.close();}
});
