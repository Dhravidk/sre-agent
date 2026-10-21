import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {SreStore} from '../src/sre/store.mjs';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {TeamsOutbox} from '../src/sre/teams-outbox.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';

async function fixture(dialect,{path=':memory:',seed=true,clock=Date.now(),fallback=false}={}){
 const profile=rehearsalProfile();if(fallback)profile.services[0].teams.alertConversationId=profile.services[0].teams.conversations[0];
 const config=validateConfig(profile,{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-route-test-cli'}),service=config.services[0];assert.equal(config.sqlitePath,path);
 const pg=dialect==='postgres'?new PGlite():null,db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:sqliteDatabase(path);
 let now=clock;const store=await new SreStore(db,{simulation:true,services:config.services,clock:()=>now}).initialize();store.coordinationNow=async()=>now;
 const calls=[],sender={send:async(ref,text)=>{calls.push({room:ref.conversation.id,text});return {id:'fictional-'+calls.length,simulation:true};}},outbox=new TeamsOutbox({store,services:config.services,sender,maxInFlight:2});
 const f={config,service,store,outbox,sender,calls,now:()=>now,advance:ms=>now+=ms};
 f.issue=async n=>(await store.ingest({id:'routing-issue-'+n,source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'dynatrace:routing-'+n,status:'OPEN',at:now,payload:{synthetic:true,code:'WINNING_BID_REGRESSED'}})).incidentId;
 f.install=async(room=0,incidentId)=>{const reference={serviceUrl:'http://127.0.0.1:1',channelId:'msteams',bot:{id:'fictional-sre'},conversation:{id:service.teams.conversations[room],conversationType:'groupChat'}};const key=await store.rememberConversation({tenant:service.teams.tenantId,reference,serviceKey:service.key});if(incidentId)await store.bindConversation(key,incidentId);return key;};
 f.row=async id=>(await db.query('SELECT * FROM sre_outbox WHERE id=?',[id]))[0];
 f.queue=async(id,incidentId,room=null)=>{now++;await store.queueMessage(incidentId,'Fictional ledger/ownership observation '+id,room,id);};
 f.run=()=>outbox.runOnce();f.close=async()=>{await outbox.close();await db.close();};
 if(seed){f.waiting=await f.issue('unjoined');f.ready=await f.issue('joined');}
 return f;
}
for(const dialect of ['sqlite','postgres']){
 test(dialect+': a large unjoined backlog cannot delay a joined team reply',async()=>{
  const f=await fixture(dialect);try{for(let n=0;n<96;n++)await f.queue('unjoined-'+n,await f.issue('backlog-'+n));const room=await f.install(1,f.ready);await f.queue('ready-reply',f.ready,room);await Promise.all([f.run(),f.run()]);assert.ok(f.calls.some(call=>call.text.endsWith('ready-reply')),'A joined team must progress in the first delivery batch');assert.equal((await f.row('ready-reply')).status,'simulated');assert.equal(f.calls.length,1);}finally{await f.close();}
 });
 test(dialect+': routing deferrals back off persistently, then a verified join wakes the message without consuming rate-limit retries',async()=>{
  const f=await fixture(dialect);try{await f.queue('waiting',f.waiting);let previous=0;for(let n=0;n<8;n++){await f.run();const row=await f.row('waiting'),delay=Number(row.next_at)-f.now();assert.equal(row.status,'pending');assert.equal(f.calls.length,0);if(n<5)assert.ok(delay>previous,'Missing-route checks must back off instead of spinning every fifteen seconds');assert.ok(delay<=300000);previous=delay;if(n<7)f.advance(delay+1);}const deferred=await f.row('waiting');const room=await f.install(0,f.waiting);assert.ok(Number((await f.row('waiting')).next_at)<=f.now(),'Joining should wake the saved observation immediately');let posts=0;f.sender.send=async()=>{posts++;throw Object.assign(Error('Fictional Teams quota'),{status:429});};for(let n=0;n<5;n++){await f.run();f.advance(60000);}assert.equal(posts,4);const row=await f.row('waiting');assert.equal(row.status,'failed');assert.ok(Number(row.attempts)>Number(deferred.attempts));assert.equal((await f.store.db.query('SELECT incident_id FROM sre_conversations WHERE id=?',[room]))[0].incident_id,f.waiting);}finally{await f.close();}
 });
 test(dialect+': installing the configured alert conversation wakes a waiting proactive notice',async()=>{
  const f=await fixture(dialect,{fallback:true});try{await f.queue('before-install',f.waiting);await f.run();assert.ok(Number((await f.row('before-install')).next_at)>f.now());await f.install(0);assert.ok(Number((await f.row('before-install')).next_at)<=f.now());await f.run();assert.equal(f.calls.length,1);assert.equal((await f.row('before-install')).status,'simulated');}finally{await f.close();}
 });
 test(dialect+': joining an incident cannot shorten a real provider Retry-After deadline',async()=>{
  const f=await fixture(dialect,{fallback:true});try{await f.install(0);await f.queue('quota-deadline',f.waiting);let posts=0;f.sender.send=async()=>{posts++;throw Object.assign(Error('Fictional Teams quota'),{status:429,response:{headers:{'retry-after':'120'}}});};await f.run();const before=await f.row('quota-deadline');assert.equal(Number(before.next_at),f.now()+120000);await f.install(1,f.waiting);assert.equal(Number((await f.row('quota-deadline')).next_at),Number(before.next_at));await f.run();assert.equal(posts,1);}finally{await f.close();}
 });
 test(dialect+': chatter in an alert root already bound to another incident cannot wake an unrelated route wait',async()=>{
  const f=await fixture(dialect,{fallback:true});try{await f.install(0,f.ready);await f.queue('unrelated-wait',f.waiting);await f.run();const before=await f.row('unrelated-wait');assert.ok(Number(before.next_at)>f.now());await f.install(0);assert.equal(Number((await f.row('unrelated-wait')).next_at),Number(before.next_at));assert.equal(f.calls.length,0);}finally{await f.close();}
 });
 test(dialect+': corrupt quota receipts prevent another transport call instead of resetting the rejection budget',async()=>{
  const f=await fixture(dialect);try{const room=await f.install(1,f.ready);await f.queue('corrupt_quota',f.ready,room);f.sender.send=async()=>{f.calls.push('post');throw Object.assign(Error('Fictional quota'),{status:429});};await f.run();const [audit]=await f.store.db.query("SELECT id,value FROM sre_checkpoints WHERE id LIKE 'teams-delivery:outcome:%'");const value=JSON.parse(audit.value);value.originalHash='0'.repeat(64);await f.store.db.query('UPDATE sre_checkpoints SET value=? WHERE id=?',[JSON.stringify(value),audit.id]);f.advance(60000);await f.run();assert.equal(f.calls.length,1);assert.equal((await f.row('corrupt_quota')).status,'unknown');}finally{await f.close();}
 });
 test(dialect+': similarly named delivery IDs cannot borrow or corrupt each other’s quota history',async()=>{
  const f=await fixture(dialect);try{const first=await f.install(1,f.ready),second=await f.install(2,f.waiting);await f.queue('quota_A',f.ready,first);await f.queue('quotaXA',f.waiting,second);f.sender.send=async()=>{throw Object.assign(Error('Fictional quota'),{status:429});};await f.run();await f.run();f.advance(60000);f.sender.send=async()=>({id:'separate-receipt',simulation:true});await f.run();await f.run();assert.equal((await f.row('quota_A')).status,'simulated');assert.equal((await f.row('quotaXA')).status,'simulated');}finally{await f.close();}
 });
 test(dialect+': a configured alert root remains deliverable ahead of an unrelated unjoined backlog',async()=>{
  const f=await fixture(dialect,{fallback:true});try{for(let n=0;n<32;n++)await f.queue('before-root-'+n,null);await f.install(0);const room=await f.install(1,f.ready);await f.queue('direct-ready',f.ready,room);await f.queue('root-proactive',f.waiting);await Promise.all([f.run(),f.run()]);assert.ok(f.calls.some(call=>call.text.endsWith('direct-ready')));assert.ok(f.calls.some(call=>call.text.endsWith('root-proactive')));assert.ok(f.calls.every(call=>['rehearsal-bidding','rehearsal-platform'].includes(call.room)));}finally{await f.close();}
 });
}

test('file reopen preserves route claims and the actual quota rejection budget independently',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sre-route-reopen-')),path=join(directory,'agent.sqlite');let f=await fixture('sqlite',{path});
 try{const id=f.waiting;await f.queue('restart-route',id);for(let n=0;n<6;n++){await f.run();f.advance(300001);}await f.install(0,id);f.sender.send=async()=>{throw Object.assign(Error('Fictional Teams quota'),{status:429});};await f.run();const before=await f.row('restart-route');assert.equal(before.status,'pending');const clock=f.now();await f.close();f=await fixture('sqlite',{path,seed:false,clock});assert.equal(Number((await f.row('restart-route')).attempts),Number(before.attempts));let posts=0;f.sender.send=async()=>{posts++;throw Object.assign(Error('Fictional Teams quota'),{status:429});};for(let n=0;n<5;n++){f.advance(60000);await f.run();}assert.equal(posts,3);assert.equal((await f.row('restart-route')).status,'failed');}finally{await f.close();await rm(directory,{recursive:true,force:true});}
});
