import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteDatabase } from '../src/sre/database.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { ConnectorPoller } from '../src/sre/poller.mjs';
import { OperationalMonitor,connectionReadHealth } from '../src/sre/operations.mjs';
import { GithubConnector } from '../src/sre/connectors.mjs';
import { PGlite } from '@electric-sql/pglite';
import { postgresSql } from '../src/sre/database.mjs';

async function fixture() {
  let now=Date.now(),firstDenied=true;
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=config.services[0];config.mode='connected';config.teamsMode='live';service.github.enabled=true;
  const store=await new SreStore(sqliteDatabase(':memory:'),{clock:()=>now,services:[service]}).initialize();
  const connector=denied=>new GithubConnector({repository:service.github.repository,tokenEnv:'TOKEN'},{env:{TOKEN:'synthetic'},fetcher:async(url,options)=>{assert.equal(options.method,'GET');return new Response(JSON.stringify(denied()?{message:'Unauthorized'}:[]),{status:denied()?401:200});}});
  const first=new ConnectorPoller({store,services:[service],connectors:new Map([[service.key,{github:connector(()=>firstDenied)}]])});
  const second=new ConnectorPoller({store,services:[service],connectors:new Map([[service.key,{github:connector(()=>false)}]])});
  const a=new OperationalMonitor({store,config:{...config,instanceId:'reader-a'},poller:first,schedulerEnabled:false}),b=new OperationalMonitor({store,config:{...config,instanceId:'reader-b'},poller:second,schedulerEnabled:false});
  await store.rememberConversation({tenant:service.teams.tenantId,serviceKey:service.key,reference:{conversation:{id:service.teams.conversations[0],conversationType:'personal'},serviceUrl:'https://teams-fixture.invalid'}});
  return {store,config,service,first,second,a,b,now:()=>now,advance:value=>now+=value,allowFirst:()=>firstDenied=false,denyFirst:()=>firstDenied=true};
}

test('a healthy peer poll cannot hide another instance HTTP 401 or clear its local alert',async()=>{
  const f=await fixture();
  try {
    await f.first.runOnce();await f.a.observe();
    await f.second.runOnce();assert.equal((await f.store.checkpoint('github:'+f.service.key)).error,undefined);
    const first=await f.a.snapshot(),second=await f.b.snapshot();
    assert.equal(first.state,'needs-attention','The successful peer erased the failing instance credential error');
    assert.ok(first.conditions.some(item=>item.code==='instance_poll_error'&&item.message.includes('401')));
    assert.equal(second.state,'healthy');await f.b.observe();await f.a.observe();
    const before=(await f.store.snapshot()).outbox.length;
    await f.first.runOnce();await f.a.observe();await f.b.observe();assert.equal((await f.store.snapshot()).outbox.length,before,'An instance failure must not toggle a still-fresh shared success');
    const connection={service:f.service.key,source:'github',enabled:true};
    assert.equal(connectionReadHealth(connection,await f.a.snapshot()).state,'needs-attention');
    assert.equal(connectionReadHealth(connection,await f.b.snapshot()).state,'healthy');
    f.allowFirst();await f.first.runOnce();await f.a.observe();
    const notices=(await f.store.snapshot()).outbox;assert.equal(notices.filter(item=>item.text.includes('Instance checks recovered')).length,1);
  } finally {await f.store.db.close();}
});

test('fresh shared data does not certify an instance that has never completed its own read',async()=>{
  const f=await fixture();
  try {
    await f.second.runOnce();assert.equal((await f.a.snapshot()).state,'starting');
    f.advance(181000);await f.second.runOnce();
    assert.ok((await f.a.snapshot()).conditions.some(item=>item.code==='instance_poll_missing'));
    f.allowFirst();await f.first.runOnce();assert.equal((await f.a.snapshot()).state,'healthy');
  } finally {await f.store.db.close();}
});

test('a peer refresh cannot hide this instance stale last successful read',async()=>{
  const f=await fixture();
  try {
    f.allowFirst();await f.first.runOnce();const ownSuccess=f.now();
    f.advance(181000);await f.second.runOnce();
    const report=await f.a.snapshot();assert.ok(report.conditions.some(item=>item.code==='instance_poll_stale'));
    assert.equal(report.localSources.find(item=>item.id==='github:'+f.service.key).successAt,ownSuccess);
    await f.first.runOnce();assert.equal((await f.a.snapshot()).state,'healthy');
  } finally {await f.store.db.close();}
});

test('each instance checks active-issue inventory access instead of borrowing a peer permission result',async()=>{
  const f=await fixture();let firstInventoryReads=0;
  try {
    f.service.github.enabled=false;f.service.dynatrace.enabled=true;
    const firstClient={problems:async()=>({items:[],complete:true}),openProblems:async()=>{firstInventoryReads++;throw new Error('Synthetic inventory access denied');}};
    const secondClient={problems:async()=>({items:[],complete:true}),openProblems:async()=>({items:[],complete:true})};
    const first=new ConnectorPoller({store:f.store,services:[f.service],connectors:new Map([[f.service.key,{dynatrace:firstClient}]])});
    const second=new ConnectorPoller({store:f.store,services:[f.service],connectors:new Map([[f.service.key,{dynatrace:secondClient}]])});
    const monitor=new OperationalMonitor({store:f.store,config:f.config,poller:first,schedulerEnabled:false});
    await second.runOnce();await first.runOnce();assert.equal(firstInventoryReads,1,'The first instance skipped its own inventory permission check');
    assert.ok((await monitor.snapshot()).conditions.some(item=>item.code==='instance_poll_error'));
  } finally {await f.store.db.close();}
});

for(const outcome of ['old-success','late-failure'])test(outcome+': a late reader cannot roll back a newer successful peer cursor',async()=>{
  const f=await fixture();let entered,unblock;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>unblock=resolve);
  try {
    f.allowFirst();f.first.connectors.get(f.service.key).github.fetcher=async()=>{entered();await gate;return new Response(JSON.stringify(outcome==='old-success'?[]:{}),{status:outcome==='old-success'?200:401});};
    const reading=f.first.runOnce();await started;f.advance(1000);await f.second.runOnce();
    const newest=await f.store.checkpoint('github:'+f.service.key);unblock();await reading;
    const shared=await f.store.checkpoint('github:'+f.service.key);assert.equal(shared.until,newest.until);assert.equal(shared.successAt,newest.successAt);assert.equal(shared.complete,true);
    assert.equal((await f.b.snapshot()).state,'healthy');
    if(outcome==='late-failure')assert.ok((await f.a.snapshot()).conditions.some(item=>item.code==='instance_poll_error'));
  } finally {unblock();await f.store.db.close();}
});

test('a malformed credential response cannot expose its text in source health diagnostics',async()=>{
  const f=await fixture(),secret='s3cr3t';let sourceCalls=0;
  try {
    const client=new GithubConnector({repository:f.service.github.repository,oauth:{tokenUrl:'https://identity-fixture.invalid/token',clientIdEnv:'ID',clientSecretEnv:'SECRET'}},{env:{ID:'synthetic',SECRET:'synthetic-client-secret'},fetcher:async url=>{
      if(url.startsWith('https://identity-fixture.invalid/'))return new Response(secret,{status:200});
      sourceCalls++;return new Response('[]',{status:200});
    }});
    f.first.connectors=new Map([[f.service.key,{github:client}]]);await f.first.runOnce();
    const checkpoint=await f.store.checkpoint('github:'+f.service.key),report=await f.a.snapshot();
    assert.ok(!JSON.stringify(checkpoint).includes(secret),'Credential response text escaped into the shared diagnostic');
    assert.ok(!JSON.stringify(report).includes(secret),'Credential response text escaped into local health');assert.equal(sourceCalls,0);
  } finally {await f.store.db.close();}
});

for(const dialect of ['sqlite','postgres'])test(dialect+': failed checkpoint commit preserves peer evidence and a new scope cannot inherit it',async()=>{
  let db;
  if(dialect==='sqlite')db=sqliteDatabase(':memory:');
  else {const pg=new PGlite();db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const store=await new SreStore(db).initialize(),now=await store.coordinationNow(),key='github:atomic-scope',scopeHash='a'.repeat(64);
  const previous={scopeHash,complete:true,successAt:now,until:now-1000};
  try {
    await store.recordPollResult(key,previous);
    const transaction=db.transaction.bind(db);let fail=true;
    db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const rows=await q(sql,args);if(fail&&sql.startsWith('UPDATE sre_checkpoints'))throw new Error('Synthetic checkpoint commit failure');return rows;}));
    await assert.rejects(()=>store.recordPollResult(key,{scopeHash,error:'Synthetic read denied',failedAt:now}),/checkpoint commit failure/);
    assert.deepEqual(await store.checkpoint(key),previous);fail=false;
    await store.recordPollResult(key,{scopeHash,error:'Synthetic read denied',failedAt:now});
    assert.equal((await store.checkpoint(key)).until,previous.until);
    await store.recordPollResult(key,{scopeHash:'b'.repeat(64),error:'New scope denied',failedAt:now});
    const changed=await store.checkpoint(key);assert.equal(changed.successAt,undefined);assert.equal(changed.until,undefined);
    await assert.rejects(()=>store.recordPollResult(key,{scopeHash,complete:true,successAt:now+86400000,until:now}),/future/);
    assert.deepEqual(await store.checkpoint(key),changed);
  } finally {await db.close();}
});

test('a valid peer metric sample cannot hide this instance invalid metric window',async()=>{
  const f=await fixture();let invalid=true;
  try {
    f.service.github.enabled=false;f.service.dynatrace.enabled=true;
    f.service.monitors=[{id:'latency',selector:'fixture:latency',threshold:250,operator:'gt',consecutive:3,unit:'ms'}];
    const client=bad=>({problems:async()=>({items:[],complete:true}),openProblems:async()=>({items:[],complete:true}),metrics:async()=>({result:[{data:[{timestamps:[f.now()-120000,f.now()-60000,f.now()],values:bad()?[100,null,120]:[100,110,120]}]}]})});
    f.first.connectors=new Map([[f.service.key,{dynatrace:client(()=>invalid)}]]);f.second.connectors=new Map([[f.service.key,{dynatrace:client(()=>false)}]]);
    await f.first.runOnce();await f.second.runOnce();await f.first.runOnce();
    const first=await f.a.snapshot(),second=await f.b.snapshot();
    assert.ok(first.conditions.some(item=>item.code==='instance_poll_error'&&item.key==='reader:metric:'+f.service.key+':latency'));
    assert.equal(second.state,'healthy');
    const connection={service:f.service.key,source:'dynatrace',enabled:true};
    assert.equal(connectionReadHealth(connection,first).state,'needs-attention');assert.equal(connectionReadHealth(connection,second).state,'healthy');
    const checkpoint=await f.store.checkpoint('metric:'+f.service.key+':latency');assert.equal(checkpoint.complete,true);assert.equal(checkpoint.sampleAt,f.now());
    invalid=false;await f.first.runOnce();assert.equal((await f.a.snapshot()).state,'healthy');
  } finally {await f.store.db.close();}
});
