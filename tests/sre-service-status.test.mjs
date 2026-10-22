import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {serviceStatusFixture} from '../fixtures/sre-service-status.mjs';import {StorageError} from '../src/sre/database.mjs';import {prepareRestore} from '../src/sre/restore-recovery.mjs';
const count=(status,service,source)=>Number(status.connections.find(connection=>connection.service===service.key&&connection.source===source).eventCount);
const rows=(f,table)=>f.r.store.db.query('SELECT * FROM '+table+' ORDER BY id');
for(const dialect of ['sqlite','postgres']){
 test(dialect+': the actual status API separates retained source events by service while preserving database-wide totals',async()=>{
  const f=await serviceStatusFixture(dialect);try{
   const before=await rows(f,'sre_events'),jobs=await rows(f,'sre_jobs'),s=await f.status();assert.equal(s.connections.length,12);assert.equal(count(s,f.quiet,'dynatraceLogs'),1);assert.equal(count(s,f.noisy,'dynatraceLogs'),3);assert.equal(count(s,f.quiet,'dynatrace'),0);assert.equal(count(s,f.noisy,'dynatrace'),1);assert.equal(count(s,f.quiet,'gitlab'),1);assert.equal(count(s,f.noisy,'gitlab'),2);assert.equal(count(s,f.quiet,'servicenow'),2);assert.equal(count(s,f.noisy,'servicenow'),0);assert.equal(count(s,f.quiet,'github'),0);assert.equal(count(s,f.noisy,'jira'),0);assert.equal(Number(s.counts.find(row=>row.source==='dynatrace-logs').count),4);assert.equal(s.counts.reduce((sum,row)=>sum+Number(row.count),0),10);assert.equal(s.countsByService.filter(row=>row.source==='dynatrace-logs').reduce((sum,row)=>sum+Number(row.count),0),4);assert.equal(f.pages[0].logs.records.length,200);assert.ok(s.connections.filter(connection=>connection.source==='servicenow').every(connection=>connection.transport==='mcp-mock'));assert.deepEqual(await rows(f,'sre_events'),before);assert.deepEqual(await rows(f,'sre_jobs'),jobs);
  }finally{await f.close();}
 });

 test(dialect+': retained counts do not turn a denied reader healthy or transfer another service’s successful read',async()=>{
  const f=await serviceStatusFixture(dialect);try{
   await f.poll();const s=await f.status(),ledger=s.connections.find(connection=>connection.service===f.quiet.key&&connection.source==='dynatraceLogs'),cache=s.connections.find(connection=>connection.service===f.noisy.key&&connection.source==='dynatraceLogs');assert.equal(Number(ledger.eventCount),1);assert.equal(Number(cache.eventCount),3);assert.equal(ledger.health.state,'needs-attention');assert.match(ledger.health.detail,/403/);assert.equal(cache.health.state,'healthy');assert.equal(s.operations.liveAccessValidated,false);f.controls.failLedger=false;await f.poll();const recovered=await f.status();assert.equal(count(recovered,f.quiet,'dynatraceLogs'),1);assert.equal(recovered.connections.find(connection=>connection.service===f.quiet.key&&connection.source==='dynatraceLogs').health.state,'healthy');
  }finally{await f.close();}
 });

 test(dialect+': a retired service remains in database totals without acquiring a current integration card or another service’s count',async()=>{
  const f=await serviceStatusFixture(dialect);try{
   const retired=await f.retire(),before=await rows(f,'sre_events'),s=await f.status();assert.equal(Number(s.counts.find(row=>row.source==='dynatrace-logs').count),7);assert.equal(count(s,f.quiet,'dynatraceLogs'),1);assert.equal(count(s,f.noisy,'dynatraceLogs'),3);assert.ok(!s.connections.some(connection=>connection.service===retired));assert.ok(!s.countsByService.some(row=>row.service_key===retired));assert.equal(Number((await f.r.store.snapshot()).countsByService.find(row=>row.service_key===retired).count),3);assert.deepEqual(await rows(f,'sre_events'),before);
  }finally{await f.close();}
 });

 test(dialect+': exact log replays keep counts stable and a busy source is counted beyond recent display windows',async()=>{
  const f=await serviceStatusFixture(dialect);try{
   await f.r.store.ingestLogRead({...f.pages[0],until:await f.r.store.coordinationNow()});const now=await f.r.store.coordinationNow();for(let n=0;n<105;n++)await f.r.store.ingestLogRead({serviceKey:f.noisy.key,logs:{records:[{timestamp:now-1000+n,level:'INFO',environment:f.noisy.environment,message:'Fictional additional batch '+n}],complete:true},until:now});const s=await f.status();assert.equal(count(s,f.quiet,'dynatraceLogs'),1);assert.equal(count(s,f.noisy,'dynatraceLogs'),108);assert.equal(Number(s.counts.find(row=>row.source==='dynatrace-logs').count),109);
  }finally{await f.close();}
 });

 test(dialect+': a count query failure returns unavailable rather than a zero or a global count, without changing stored history',async()=>{
  const f=await serviceStatusFixture(dialect);try{
   const url=await f.serve(),before=await rows(f,'sre_events'),query=f.r.store.db.query;f.r.store.db.query=async(sql,args=[])=>{if(sql.includes('FROM sre_events GROUP BY service_key,source'))throw new StorageError(Error('Controlled source count read denial'));return query(sql,args);};const failed=await fetch(url+'/api/status');assert.equal(failed.status,503);assert.equal(failed.headers.get('retry-after'),'5');const body=await failed.json();assert.match(body.error,/storage.*unavailable/i);assert.equal(body.connections,undefined);f.r.store.db.query=query;assert.equal(count(await f.status(),f.noisy,'dynatraceLogs'),3);assert.deepEqual(await rows(f,'sre_events'),before);
  }finally{await f.close();}
 });

 test(dialect+': a restore hold keeps historical retained counts readable without making them fresh source evidence',async()=>{
  const f=await serviceStatusFixture(dialect);try{
   const now=await f.r.store.coordinationNow();await prepareRestore(f.r.store,{restoreId:'service-count-restore',backupSha256:'d'.repeat(64),backupAt:now-1,reason:'Fictional historical service counts',actor:{kind:'local-operator',id:'Fictional lead'},offline:true});const before=await rows(f,'sre_events'),s=await f.status();assert.equal(s.recovery.active,true);assert.equal(count(s,f.quiet,'dynatraceLogs'),1);assert.equal(count(s,f.noisy,'dynatraceLogs'),3);assert.deepEqual(await rows(f,'sre_events'),before);assert.equal(await f.r.outbox.runOnce(),false);
  }finally{await f.close();}
 });
}
test('file-backed restart preserves source counts and raw history without inheriting a previous instance’s reader-health claim',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sre-service-counts-')),path=join(directory,'agent.sqlite'),f=await serviceStatusFixture('sqlite',{path});try{await f.poll();const before=await rows(f,'sre_events');await f.restart();const s=await f.status();assert.equal(count(s,f.quiet,'dynatraceLogs'),1);assert.equal(count(s,f.noisy,'dynatraceLogs'),3);assert.equal(s.connections.find(connection=>connection.service===f.noisy.key&&connection.source==='dynatraceLogs').health.state,'starting');assert.deepEqual(await rows(f,'sre_events'),before);await f.poll();assert.equal((await f.status()).connections.find(connection=>connection.service===f.noisy.key&&connection.source==='dynatraceLogs').health.state,'healthy');}finally{await f.close();await rm(directory,{recursive:true,force:true});}
});
