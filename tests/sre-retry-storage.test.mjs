import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sqliteDatabase,postgresSql,StorageError } from '../src/sre/database.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { providerRetryGate } from '../src/sre/provider-retry.mjs';
import { ApiClient,tokenProvider } from '../src/sre/http-client.mjs';
import { prepareRestore } from '../src/sre/restore-recovery.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { loadConfig } from '../src/sre/config.mjs';

const descriptor={tenant:'synthetic-tenant',provider:'github',endpoint:'https://provider-retry.invalid',scope:'synthetic-account'};
const response=(status=200)=>new Response(JSON.stringify([]),{status,headers:{'content-type':'application/json',...(status===429?{'retry-after':'60'}:{})}});
async function fixture(dialect) {
  let now=Date.now(),db;
  if(dialect==='sqlite')db=sqliteDatabase(':memory:');
  else {const pg=new PGlite();db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const store=await new SreStore(db).initialize();store.coordinationNow=async()=>now;
  return {db,store,now:()=>now,advance:ms=>now+=ms,gate:providerRetryGate(store,descriptor)};
}

for(const dialect of ['sqlite','postgres']) {
  test(dialect+': a different client and store defer API/OAuth acquisition on committed shared deadlines',async()=>{
    const f=await fixture(dialect);let requests=0,tokens=0;
    try {
      const first=new ApiClient({base:descriptor.endpoint,clock:f.now,retryGate:f.gate,fetcher:async()=>{requests++;return response(429);}});
      await assert.rejects(()=>first.request('/read'),error=>error.status===429);assert.equal(requests,1);
      const other=new SreStore(f.db);other.coordinationNow=f.now;
      const second=new ApiClient({base:descriptor.endpoint,clock:f.now,retryGate:providerRetryGate(other,descriptor),fetcher:async()=>{requests++;return response();}});
      await assert.rejects(()=>second.request('/read'),error=>error.status===429);assert.equal(requests,1);
      const oauth={tokenUrl:'https://issuer-retry.invalid/token',clientIdEnv:'ID',clientSecretEnv:'SECRET'};
      const issuer=providerRetryGate(other,{...descriptor,provider:'oauth',endpoint:oauth.tokenUrl});
      const env={ID:'synthetic',SECRET:'synthetic-secret'},options={clock:f.now,retryGate:issuer};
      const limited=tokenProvider({oauth},env,async()=>{tokens++;return response(429);},options);
      await assert.rejects(()=>limited(),error=>error.status===429);
      const fresh=tokenProvider({oauth},env,async()=>{tokens++;return new Response(JSON.stringify({access_token:'synthetic-grant',token_type:'Bearer',expires_in:300}),{headers:{'content-type':'application/json'}});},options);
      await assert.rejects(()=>fresh(),error=>error.status===429);assert.equal(tokens,1);
      f.advance(60001);await second.request('/read');assert.equal(await fresh(),'synthetic-grant');assert.equal(requests,2);assert.equal(tokens,2);
    } finally {await f.db.close();}
  });
  test(dialect+': concurrent and late replies only extend their explicit tenant/provider/endpoint/account bucket',async()=>{
    const f=await fixture(dialect);
    try {
      await Promise.all([f.gate.defer({until:f.now()+60000,status:429}),f.gate.defer({until:f.now()+90000,status:403}),f.gate.defer({until:f.now()+30000,status:503})]);
      assert.deepEqual(await f.gate.read(),{until:f.now()+90000,status:403,retryAfterMs:90000});
      const equivalent=providerRetryGate(f.store,{...descriptor,endpoint:descriptor.endpoint+'/'});assert.equal(equivalent.scopeHash,f.gate.scopeHash);
      for(const changed of [{tenant:'other-tenant'},{provider:'gitlab'},{endpoint:'https://other-retry.invalid'},{endpoint:descriptor.endpoint+'/other'},{scope:'other-account'}])assert.equal(await providerRetryGate(f.store,{...descriptor,...changed}).read(),null);
      const rows=await f.db.query('SELECT * FROM sre_provider_retries');assert.equal(rows.length,1);assert.match(rows[0].scope_hash,/^[a-f0-9]{64}$/);
      for(const secret of Object.values(descriptor))assert.ok(!JSON.stringify(rows).includes(secret));
      f.advance(90001);assert.equal(await f.gate.read(),null);
    } finally {await f.db.close();}
  });
  test(dialect+': interrupted retry persistence rolls back and clients stop safely while storage is unavailable',async()=>{
    const f=await fixture(dialect),transaction=f.db.transaction.bind(f.db);let calls=0;
    try {
      await f.gate.defer({until:f.now()+20000,status:429});
      f.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const result=await q(sql,args);if(sql.startsWith('INSERT INTO sre_provider_retries'))throw new StorageError(new Error('private-synthetic-storage-detail'));return result;}));
      await assert.rejects(()=>f.gate.defer({until:f.now()+90000,status:403}),StorageError);
      assert.equal((await f.gate.read()).until,f.now()+20000);
      const unavailable={...f.gate,read:async()=>{throw new StorageError(new Error('private-synthetic-storage-detail'));}};
      const client=new ApiClient({base:descriptor.endpoint,retryGate:unavailable,fetcher:async()=>{calls++;return response();}});
      await assert.rejects(()=>client.request('/read'),error=>!error.message.includes('private-synthetic')&&error.status===undefined);assert.equal(calls,0);
    } finally {await f.db.close();}
  });
  test(dialect+': offline restore preparation retains retry deadlines contained in the snapshot',async()=>{
    const f=await fixture(dialect);
    try {
      await f.gate.defer({until:f.now()+60000,status:429});
      await prepareRestore(f.store,{restoreId:'retry-restore',backupSha256:'a'.repeat(64),backupAt:f.now()-1000,reason:'Synthetic restore',actor:{kind:'local-operator',id:'synthetic'},offline:true});
      assert.equal((await f.gate.read()).until,f.now()+60000);assert.equal((await f.store.restoreFence()).active,true);
    } finally {await f.db.close();}
  });
}

test('SQLite close/reopen preserves a provider wait and expiry uses coordination time',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'sre-retry-')),path=join(directory,'state.sqlite');let db;
  try {
    let now=Date.now();db=sqliteDatabase(path);let store=await new SreStore(db,{clock:()=>now}).initialize();
    await providerRetryGate(store,descriptor).defer({until:now+60000,status:429});await db.close();
    db=sqliteDatabase(path);store=await new SreStore(db,{clock:()=>now}).initialize();const gate=providerRetryGate(store,descriptor);
    assert.equal((await gate.read()).retryAfterMs,60000);now+=60001;assert.equal(await gate.read(),null);
  } finally {await db?.close();rmSync(directory,{recursive:true,force:true});}
});

test('the connected runtime wires configured API waits to its actual persistent store',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});config.mode='connected';config.env={READ:'synthetic-reader'};
  const service=config.services[0];service.github={enabled:true,repository:'fixture/auction',base:descriptor.endpoint,tokenEnv:'READ',retryScope:descriptor.scope};service.rollback.enabled=false;
  const runtime=await createSreRuntime({config,autoStart:false});let calls=0;
  try {
    const client=runtime.poller.connectors.get(service.key).github;client.fetcher=async()=>{calls++;return response(429);};
    await assert.rejects(()=>client.request('/read'),error=>error.status===429);assert.equal(calls,1);
    const gate=providerRetryGate(runtime.store,{...descriptor,tenant:service.tenant});assert.equal(client.retryGate.scopeHash,gate.scopeHash);assert.equal((await gate.read()).status,429);
    await assert.rejects(()=>client.request('/read'),error=>error.status===429);assert.equal(calls,1);
  } finally {await runtime.close();}
});
