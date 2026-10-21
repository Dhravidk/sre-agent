import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir,userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { SreStore } from '../src/sre/store.mjs';
import { sqliteDatabase,postgresSql,StorageError } from '../src/sre/database.mjs';
import { prepareRestore,releaseRestore } from '../src/sre/restore-recovery.mjs';
import { restoreProviderRetries } from '../src/sre/restore-provider-retries.mjs';
import { configuredRetryScopes,configuredRetryDescriptor,providerRetryGate } from '../src/sre/provider-retry.mjs';
import { createConnectors } from '../src/sre/connectors.mjs';

const actor={kind:'local-operator',id:'synthetic recovery operator'};
const profiles=()=>[
  {key:'retry-first',name:'First',tenant:'synthetic-tenant',environment:'staging',github:{enabled:false,base:'https://provider-recovery.invalid',repository:'fixture/auction',tokenEnv:'READ',retryScope:'first-account',oauth:{tokenUrl:'https://issuer-recovery.invalid/token',clientIdEnv:'ID',clientSecretEnv:'SECRET',retryScope:'first-issuer'}},rollback:{enabled:false,provider:'github',tokenEnv:'WRITE',ref:'main',workflow:'rollback.yml',retryScope:'writer-account'}},
  {key:'retry-second',name:'Second',tenant:'synthetic-tenant',environment:'staging',servicenow:{enabled:false,base:'https://tickets-recovery.invalid',cmdbCi:'a'.repeat(32),retryScope:'second-account'}},
];
async function fixture(dialect='sqlite',{path=':memory:',prepared=true}={}) {
  let now=Date.now(),db;
  if(dialect==='sqlite')db=sqliteDatabase(path);
  else {const pg=new PGlite();db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const services=profiles(),store=await new SreStore(db,{clock:()=>now}).initialize();store.coordinationNow=async()=>now;
  if(prepared)await prepareRestore(store,{restoreId:'retry-recovery',backupSha256:'a'.repeat(64),backupAt:now-60000,reason:'Restore the synthetic snapshot',actor,offline:true});
  const gate=(key='retry-first',connector='github',kind='api')=>providerRetryGate(store,configuredRetryDescriptor(services.find(s=>s.key===key),connector,kind,{allowDisabled:true}));
  const fact=(key='retry-first',connector='github',kind='api',ms=60000)=>({serviceKey:key,connector,kind,scopeHash:gate(key,connector,kind).scopeHash,observedAt:now-1000,until:now+ms,status:429});
  const input=(facts=[fact()])=>({restoreId:'retry-recovery',requestId:'retry-facts-1',reason:'Review independent provider records for the lost interval',reviewedAt:now,evidenceUrls:['https://synthetic-evidence.invalid/provider/1'],facts,actor});
  return {db,store,services,gate,fact,input,now:()=>now,advance:ms=>now+=ms,close:()=>db.close()};
}

for(const dialect of ['sqlite','postgres']) {
  test(dialect+': reviewed API/issuer/writer facts commit atomically and preserve a later existing wait',async()=>{
    const f=await fixture(dialect);
    try {
      await f.gate().defer({until:f.now()+120000,status:403});
      const facts=[f.fact(),f.fact('retry-first','github','oauth'),f.fact('retry-first','rollback'),f.fact('retry-second','servicenow')];
      const receipt=await restoreProviderRetries(f.store,f.services,f.input(facts));assert.equal(receipt.duplicate,false);assert.equal(receipt.providerVerified,false);assert.equal(receipt.authority,'local_operator_attestation');assert.equal(receipt.effective.length,4);
      assert.equal((await f.gate().read()).until,f.now()+120000);assert.equal((await f.gate().read()).status,403);assert.equal((await f.gate('retry-first','github','oauth').read()).status,429);assert.equal((await f.store.restoreFence()).active,true);
      f.services[0].github.enabled=true;f.services[0].rollback.enabled=true;let calls=0;
      const clients=createConnectors(f.services[0],{env:{},clock:f.now,retryGateFactory:descriptor=>providerRetryGate(f.store,descriptor),fetcher:async()=>{calls++;return new Response('{}');}});
      await assert.rejects(()=>clients.github.request('/read'),error=>error.status===403);await assert.rejects(()=>clients.rollback.request('/write',{method:'POST',mutating:true,body:{}}),/provider retry delay/);assert.equal(calls,0);
    } finally {await f.close();}
  });
  test(dialect+': concurrent exact retries return one receipt; changed bodies cannot replace it',async()=>{
    const f=await fixture(dialect);
    try {
      const input=f.input(),results=await Promise.all([restoreProviderRetries(f.store,f.services,input),restoreProviderRetries(f.store,f.services,input)]);assert.equal(results.filter(r=>r.duplicate).length,1);
      for(const changed of [{reason:'Changed review'},{facts:[{...input.facts[0],until:f.now()+90000}]},{actor:{...actor,id:'Different operator'}}])await assert.rejects(()=>restoreProviderRetries(f.store,f.services,{...input,...changed}),error=>error.status===409);
      assert.equal(Number((await f.db.query("SELECT COUNT(*) AS count FROM sre_checkpoints WHERE id LIKE 'recovery:database-restore:provider-retries:%'"))[0].count),1);
      await releaseRestore(f.store,{restoreId:input.restoreId,requestId:'release',reason:'Independent evidence reviewed',actor,observedAt:f.now(),evidenceUrls:input.evidenceUrls});
      f.advance(700000);assert.equal((await restoreProviderRetries(f.store,f.services,input)).duplicate,true);
      await assert.rejects(()=>restoreProviderRetries(f.store,f.services,{...input,requestId:'new-after-release',reviewedAt:f.now()}),/active restore hold/);
    } finally {await f.close();}
  });
  for(const point of ['wait-write','receipt-write'])test(dialect+': failure after '+point+' leaves no partial wait or receipt and can be retried',async()=>{
    const f=await fixture(dialect),transaction=f.db.transaction.bind(f.db);let armed=true;
    f.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const rows=await q(sql,args);if(armed&&((point==='wait-write'&&sql.startsWith('INSERT INTO sre_provider_retries'))||(point==='receipt-write'&&sql.startsWith('INSERT INTO sre_checkpoints'))))throw new StorageError(new Error('private-synthetic-storage-detail'));return rows;}));
    try {
      const input=f.input([f.fact(),f.fact('retry-second','servicenow')]);await assert.rejects(()=>restoreProviderRetries(f.store,f.services,input),StorageError);
      assert.equal(Number((await f.db.query('SELECT COUNT(*) AS count FROM sre_provider_retries'))[0].count),0);assert.equal(Number((await f.db.query("SELECT COUNT(*) AS count FROM sre_checkpoints WHERE id LIKE 'recovery:database-restore:provider-retries:%'"))[0].count),0);
      assert.equal((await f.store.restoreFence()).active,true);armed=false;assert.equal((await restoreProviderRetries(f.store,f.services,input)).duplicate,false);
    } finally {await f.close();}
  });
  test(dialect+': invalid bindings, unreviewed times and unknown fields cannot mutate the restored state',async()=>{
    const f=await fixture(dialect);
    try {
      const input=f.input(),wrongTenant=providerRetryGate(f.store,{...configuredRetryDescriptor(f.services[0],'github','api',{allowDisabled:true}),tenant:'other-tenant'}).scopeHash;
      for(const changed of [{serviceKey:'unknown-service'},{connector:'unknown'},{kind:undefined},{scopeHash:wrongTenant},{observedAt:f.now()+1},{until:f.now()-2000},{status:0},{privateToken:'private-synthetic-marker'}])await assert.rejects(()=>restoreProviderRetries(f.store,f.services,{...input,facts:[{...input.facts[0],...changed}]}));
      for(const changed of [{restoreId:'other-restore'},{reviewedAt:f.now()+1},{reviewedAt:f.now()-600001},{actor:{kind:'teams',id:'untrusted'}},{facts:[]},{facts:[input.facts[0],input.facts[0]]},{evidenceUrls:['https://name:private-url-secret@invalid.test/proof']},{debug:'private-synthetic-marker'}])await assert.rejects(()=>restoreProviderRetries(f.store,f.services,{...input,...changed}));
      assert.equal(Number((await f.db.query('SELECT COUNT(*) AS count FROM sre_provider_retries'))[0].count),0);assert.equal((await f.store.restoreFence()).active,true);
    } finally {await f.close();}
  });
}

test('an imported issuer wait blocks new token acquisition while a configured API bucket remains clear',async()=>{
  const f=await fixture();let calls=0;
  try {
    await restoreProviderRetries(f.store,f.services,f.input([f.fact('retry-first','github','oauth')]));f.services[0].github.enabled=true;
    const client=createConnectors(f.services[0],{env:{ID:'synthetic',SECRET:'synthetic-secret'},clock:f.now,retryGateFactory:descriptor=>providerRetryGate(f.store,descriptor),fetcher:async()=>{calls++;return new Response('{}');}}).github;
    await assert.rejects(()=>client.request('/read'),error=>error.status===429);assert.equal(await f.gate().read(),null);assert.equal(calls,0);
  } finally {await f.close();}
});

for(const kind of ['api','oauth'])test(kind+': an imported wait observed with HTTP 200 still defers the request with a failing status',async()=>{
  const f=await fixture();let calls=0;
  try {
    const fact={...f.fact('retry-first','github',kind),status:200};await restoreProviderRetries(f.store,f.services,f.input([fact]));f.services[0].github.enabled=true;
    const client=createConnectors(f.services[0],{env:{ID:'synthetic',SECRET:'synthetic-secret'},clock:f.now,retryGateFactory:descriptor=>providerRetryGate(f.store,descriptor),fetcher:async()=>{calls++;return new Response('{}');}}).github;
    await assert.rejects(()=>client.request('/read'),error=>error.status===429&&(kind==='oauth'||error.providerStatus===200));assert.equal(calls,0);assert.equal((await f.gate('retry-first','github',kind).read()).status,200);
  } finally {await f.close();}
});

test('expired facts remain audited without becoming a fresh relative delay; redacted reasons still bind exact input',async()=>{
  const f=await fixture();
  try {
    const input=f.input([{...f.fact(),observedAt:f.now()-2000,until:f.now()-1}]);input.reason='Review Bearer synthetic-private-one';
    const receipt=await restoreProviderRetries(f.store,f.services,input);assert.equal(receipt.effective[0].active,false);assert.equal(await f.gate().read(),null);assert.ok(!JSON.stringify(receipt).includes('synthetic-private-one'));
    await assert.rejects(()=>restoreProviderRetries(f.store,f.services,{...input,reason:'Review Bearer synthetic-private-two'}),error=>error.status===409);
  } finally {await f.close();}
});

test('review expiry during a wait write rolls back the complete import and its receipt',async()=>{
  const f=await fixture(),transaction=f.db.transaction.bind(f.db);let advanced=false;
  f.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const rows=await q(sql,args);if(!advanced&&sql.startsWith('INSERT INTO sre_provider_retries')){advanced=true;f.advance(600001);}return rows;}));
  try {
    await assert.rejects(()=>restoreProviderRetries(f.store,f.services,f.input([f.fact(),f.fact('retry-second','servicenow')])),/fresh/);
    assert.equal(Number((await f.db.query('SELECT COUNT(*) AS count FROM sre_provider_retries'))[0].count),0);assert.equal((await f.store.restoreFence()).active,true);
  } finally {await f.close();}
});

test('an ordinary database with no prepared restore cannot accept provider recovery facts',async()=>{
  const f=await fixture('sqlite',{prepared:false});
  try {await assert.rejects(()=>restoreProviderRetries(f.store,f.services,f.input()),/matching prepared database restore/);assert.equal(Number((await f.db.query('SELECT COUNT(*) AS count FROM sre_provider_retries'))[0].count),0);}
  finally {await f.close();}
});

test('a corrupted recovery receipt fails closed instead of certifying provider verification',async()=>{
  const f=await fixture();
  try {
    const input=f.input();await restoreProviderRetries(f.store,f.services,input);const [row]=await f.db.query("SELECT id,value FROM sre_checkpoints WHERE id LIKE 'recovery:database-restore:provider-retries:%'");
    const original=JSON.parse(row.value);
    for(const changed of [{providerVerified:true},{reason:'Corrupted review'},{privateDebug:'private-synthetic-marker'},{effective:[{...original.effective[0],scopeHash:'b'.repeat(64)}]}]) {
      await f.db.query('UPDATE sre_checkpoints SET value=? WHERE id=?',[JSON.stringify({...original,...changed}),row.id]);
      await assert.rejects(()=>restoreProviderRetries(f.store,f.services,input),StorageError);
    }
    assert.equal((await f.store.restoreFence()).active,true);
  } finally {await f.close();}
});

test('the actual CLI inventories disabled buckets without a database and restores facts using the host actor',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'sre-retry-recovery-cli-')),path=join(directory,'state.sqlite'),configPath=join(directory,'profile.json'),attestation=join(directory,'facts.json');let f;
  try {
    f=await fixture('sqlite',{path});const input=f.input();input.actor={kind:'teams',id:'spoofed-actor'};writeFileSync(configPath,JSON.stringify({mode:'local',services:f.services}));writeFileSync(attestation,JSON.stringify(input));await f.close();f=null;
    const baseEnv={SRE_CONFIG:configPath};
    const inventory=spawnSync(process.execPath,['scripts/sre-restore.mjs','retry-scopes'],{env:baseEnv,encoding:'utf8'});assert.equal(inventory.status,0,inventory.stderr);const scopes=JSON.parse(inventory.stdout);assert.equal(scopes.networkCalls,0);assert.ok(scopes.scopes.length>=4);assert.ok(scopes.scopes.every(s=>s.enabled===false));assert.ok(!inventory.stdout.includes('first-account'));assert.ok(!inventory.stdout.includes('issuer-recovery.invalid'));
    const env={...baseEnv,SRE_SQLITE_PATH:path};
    const first=spawnSync(process.execPath,['scripts/sre-restore.mjs','retry-facts','--attestation',attestation],{env,encoding:'utf8'});assert.equal(first.status,0,first.stderr);const receipt=JSON.parse(first.stdout);assert.equal(receipt.operator,userInfo().username);assert.equal(receipt.providerVerified,false);assert.ok(!first.stdout.includes('spoofed-actor'));
    const second=spawnSync(process.execPath,['scripts/sre-restore.mjs','retry-facts','--attestation',attestation],{env,encoding:'utf8'});assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).duplicate,true);
    const db=sqliteDatabase(path);try{const store=await new SreStore(db).initialize();assert.equal((await store.restoreFence()).active,true);assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM sre_provider_retries'))[0].count),1);}finally{await db.close();}
  } finally {await f?.close();rmSync(directory,{recursive:true,force:true});}
});

test('invalid or oversized attestation files fail before selecting/creating a database and omit their contents',()=>{
  const directory=mkdtempSync(join(tmpdir(),'sre-retry-input-')),path=join(directory,'must-not-exist.sqlite'),config=join(directory,'profile.json'),file=join(directory,'input.json');
  try {
    writeFileSync(config,JSON.stringify({mode:'local',services:profiles()}));
    for(const bytes of [Buffer.from('private-synthetic-marker'+ 'x'.repeat(256*1024)),Buffer.from('private-synthetic-marker'),Buffer.from([0xff,0xfe])]) {
      writeFileSync(file,bytes);const result=spawnSync(process.execPath,['scripts/sre-restore.mjs','retry-facts','--attestation',file],{env:{SRE_CONFIG:config,SRE_SQLITE_PATH:path},encoding:'utf8'});
      assert.equal(result.status,1);assert.equal(existsSync(path),false);assert.ok(!result.stderr.includes('private-synthetic-marker'));assert.match(result.stderr,/256 KiB/);
    }
    const services=profiles();services[0].github.base='https://name:private-synthetic-marker@';writeFileSync(config,JSON.stringify({mode:'local',services}));
    const invalid=spawnSync(process.execPath,['scripts/sre-restore.mjs','retry-scopes'],{env:{SRE_CONFIG:config,SRE_SQLITE_PATH:path},encoding:'utf8'});assert.equal(invalid.status,1);assert.equal(existsSync(path),false);assert.ok(!invalid.stderr.includes('private-synthetic-marker'));assert.match(invalid.stderr,/retry endpoint is invalid/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('restore administration accepts an actual connected profile without HTTP/model secrets while runtime readiness stays strict',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'sre-retry-connected-')),path=join(directory,'state.sqlite'),configPath=join(directory,'connected.json'),file=join(directory,'facts.json');let f;
  try {
    f=await fixture('sqlite',{path});writeFileSync(file,JSON.stringify(f.input()));writeFileSync(configPath,JSON.stringify({mode:'connected',agentMode:'eve',forAdministration:true,services:f.services}));await f.close();f=null;
    const env={SRE_CONFIG:configPath,SRE_SQLITE_PATH:path};
    const inventory=spawnSync(process.execPath,['scripts/sre-restore.mjs','retry-scopes'],{env,encoding:'utf8'});assert.equal(inventory.status,0,inventory.stderr);assert.equal(JSON.parse(inventory.stdout).networkCalls,0);
    const imported=spawnSync(process.execPath,['scripts/sre-restore.mjs','retry-facts','--attestation',file],{env,encoding:'utf8'});assert.equal(imported.status,0,imported.stderr);assert.equal(JSON.parse(imported.stdout).providerVerified,false);
    const runtime=spawnSync(process.execPath,['scripts/sre-readiness.mjs','--strict','--json'],{env,encoding:'utf8'});assert.equal(runtime.status,1);assert.equal(JSON.parse(runtime.stdout).core.runtimeConfigurationValid,false);
  } finally {await f?.close();rmSync(directory,{recursive:true,force:true});}
});
