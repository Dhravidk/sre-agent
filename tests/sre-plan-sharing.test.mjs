import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createSreRuntime} from '../src/sre/server.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {postgresSql,StorageError} from '../src/sre/database.mjs';
import {conversationKey} from '../src/sre/store.mjs';

async function fixture(dialect,{path=':memory:',seed=true,clock=Date.now(),separate=false}={}){
 const profile=rehearsalProfile(),service=profile.services[0],rooms=['plan-workers','plan-platform','plan-third'];service.teams.conversations=rooms;service.teams.alertConversationId=rooms[0];service.teams.collaborationGroups=separate?[{key:'response',name:'Response',conversations:rooms.slice(0,2).map(id=>({id,name:id}))}]:[{key:'response',name:'Response',conversations:rooms.map(id=>({id,name:id}))}];
 const config=validateConfig(profile,{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-plan-sharing-cli'}),pg=dialect==='postgres'?new PGlite():null,db=pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined;
 const sent=[],r=await createSreRuntime({config,db,autoStart:false,connectors:new Map([[service.key,{}]]),sender:{send:async(reference,text)=>{sent.push({room:reference.conversation.id,text});return {id:'fictional-plan-'+sent.length,simulation:true};}},qaAdapter:{localOnly:true,execute:async()=>{throw Error('This metadata fixture must not execute QA');}}});
 assert.equal(r.config.sqlitePath,path);let now=clock,sequence=0;r.store.clock=()=>now;const keys=rooms.map(room=>conversationKey(service.teams.tenantId,room)),f={r,service,rooms,keys,sent,now:()=>now};
 f.send=async(room,text)=>{now++;const sample=devActivity(text,service,{id:'plan-sharing-'+ ++sequence+'-'+now,conversationId:rooms[room],conversationType:'groupChat',userId:'local-operator'}),receipt=await r.router.accept(sample.activity,sample.reference);await r.router.processOnce();return receipt;};
 f.settle=async()=>{for(let n=0;n<50;n++){const [jobs]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(jobs.count))return;await r.worker.runOnce();}throw Error('Plan fixture did not settle');};
 f.notices=()=>r.store.db.query("SELECT * FROM sre_outbox WHERE id LIKE 'fix-ticket:%' ORDER BY id");f.plans=()=>r.store.db.query('SELECT * FROM sre_fix_plans ORDER BY id');
 if(seed){f.id=(await seedDemo(r.store,service)).incidentId;for(let n=0;n<(separate?2:3);n++)await f.send(n,'join '+f.id);await f.settle();}
 return f;
}
for(const dialect of ['sqlite','postgres']){
 test(dialect+': a Teams plan shares bounded review metadata with peers and the full ticket only with its requester',async()=>{
  const f=await fixture(dialect);try{const receipt=await f.send(0,'plan'),[plan]=await f.plans(),notices=await f.notices();assert.ok(plan);assert.deepEqual(notices.map(row=>row.conversation_key).sort(),f.keys.slice(1).sort());for(const row of notices){assert.ok(Buffer.byteLength(row.text)<1400);assert.match(row.text,/Fix ticket saved/);assert.ok(row.text.includes(plan.id));assert.ok(row.text.includes('ticket '+plan.id));assert.doesNotMatch(row.text,/# Fix ticket|approve-fix|approve .*nonce|## Who to contact/);}const [direct]=await f.r.store.db.query('SELECT * FROM sre_outbox WHERE id=?',['command:'+receipt.eventId]);assert.equal(direct.conversation_key,f.keys[0]);assert.match(direct.text,/# Fix ticket/);}finally{await f.r.close();}
 });
 test(dialect+': operator-created tickets notify all current joined rooms once without revising their immutable Markdown',async()=>{
  const f=await fixture(dialect);try{const plan=await f.r.casework.createPlan(f.id);assert.equal((await f.notices()).length,3);const before=await f.notices();const again=await f.r.casework.createPlan(f.id);assert.equal(again.id,plan.id);assert.deepEqual(await f.notices(),before);assert.equal((await f.r.casework.getPlan(plan.id,f.id)).markdown,plan.markdown);}finally{await f.r.close();}
 });
 test(dialect+': ticket ID reads remain scoped, expose historical revision and do not create another artifact or peer notification',async()=>{
  const f=await fixture(dialect);try{const plan=await f.r.casework.createPlan(f.id,{originConversationKey:f.keys[0]}),before=await f.notices();await f.send(0,'update New fictional provider evidence arrived.');const request=await f.send(1,'ticket '+plan.id),[reply]=await f.r.store.db.query('SELECT text FROM sre_outbox WHERE id=?',['command:'+request.eventId]);assert.match(reply.text,/Historical snapshot/);assert.ok(reply.text.includes(plan.id));assert.match(reply.text,/# Fix ticket/);assert.equal((await f.plans()).length,1);assert.deepEqual(await f.notices(),before);assert.equal((await f.r.casework.getPlan(plan.id,f.id)).markdown,plan.markdown);}finally{await f.r.close();}
 });
 test(dialect+': leaving before a plan notice is sent discards that recipient without changing the ticket or other recipients',async()=>{
  const f=await fixture(dialect);try{const plan=await f.r.casework.createPlan(f.id,{originConversationKey:f.keys[0]});await f.r.store.unbindConversation(f.keys[1],f.id);for(let n=0;n<100&&await f.r.outbox.runOnce();n++);await f.r.outbox.drainSettled();const rows=await f.notices();assert.equal(rows.find(row=>row.conversation_key===f.keys[1]).status,'discarded');assert.equal(rows.find(row=>row.conversation_key===f.keys[2]).status,'simulated');assert.equal((await f.r.casework.getPlan(plan.id,f.id)).markdown,plan.markdown);}finally{await f.r.close();}
 });
 test(dialect+': knowing a ticket ID cannot read a different incident or silently draft a replacement',async()=>{
  const f=await fixture(dialect);try{const receipt=await f.r.store.ingest({id:'other-plan-incident',source:'dynatrace',serviceKey:f.service.key,kind:'problem',issueKey:'dynatrace:other-plan-incident',title:'Fictional isolated provider plan',status:'OPEN',at:f.now(),payload:{synthetic:true,metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE']}}});await f.settle();const foreign=await f.r.casework.createPlan(receipt.incidentId),before=await f.notices(),request=await f.send(0,'ticket '+foreign.id),[reply]=await f.r.store.db.query('SELECT text FROM sre_outbox WHERE id=?',['command:'+request.eventId]);assert.match(reply.text,/not found in this incident/);assert.ok(!reply.text.includes('Fictional isolated provider plan'));assert.equal((await f.plans()).length,1);assert.deepEqual(await f.notices(),before);}finally{await f.r.close();}
 });
 test(dialect+': a foreign sharing scope cannot originate a plan or receive its metadata',async()=>{
  const f=await fixture(dialect,{separate:true});try{const sample=devActivity('help',f.service,{conversationId:f.rooms[2],conversationType:'groupChat'});await f.r.store.rememberConversation({tenant:f.service.teams.tenantId,reference:sample.reference,serviceKey:f.service.key});await assert.rejects(()=>f.r.casework.createPlan(f.id,{originConversationKey:f.keys[2]}),/different sharing group|cannot access/);assert.equal((await f.plans()).length,0);assert.equal((await f.notices()).length,0);const plan=await f.r.casework.createPlan(f.id);assert.ok(plan.id);assert.equal((await f.notices()).length,2);assert.ok(!(await f.notices()).some(row=>row.conversation_key===f.keys[2]));}finally{await f.r.close();}
 });
 test(dialect+': a peer outbox failure rolls back both a new ticket and every partial shared notice',async()=>{
  const f=await fixture(dialect);try{const transaction=f.r.store.db.transaction;let attempted=0;f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('INSERT INTO sre_outbox')&&String(args[0]).startsWith('fix-ticket:')&&++attempted===2)throw new StorageError(Error('Owned artifact notice failure'));return q(sql,args);}));await assert.rejects(()=>f.r.casework.createPlan(f.id,{originConversationKey:f.keys[0]}),error=>error instanceof StorageError);assert.equal(attempted,2);assert.equal((await f.plans()).length,0);assert.equal((await f.notices()).length,0);}finally{await f.r.close();}
 });
 test(dialect+': shared review metadata cannot approve QA or copy the requesting room’s approval nonce',async()=>{
  const f=await fixture(dialect);try{const plan=await f.r.casework.createPlan(f.id,{originConversationKey:f.keys[0]}),principal={verified:true,simulation:true,tenant:f.service.teams.tenantId,conversationId:f.rooms[0],userId:'local-operator'},proposal=await f.r.casework.proposeFix(f.id,plan.id,principal,f.keys[0],'qa-only-origin');for(const notice of await f.notices()){assert.ok(!notice.text.includes(proposal.nonce));assert.ok(!notice.text.includes('approve-fix'));}const request=await f.send(1,'yes');const [reply]=await f.r.store.db.query('SELECT text FROM sre_outbox WHERE id=?',['command:'+request.eventId]);assert.match(reply.text,/Request could not be completed/);assert.equal((await f.r.store.db.query('SELECT status FROM sre_fix_requests WHERE id=?',[proposal.id]))[0].status,'proposed');}finally{await f.r.close();}
 });
}

test('a file-backed ticket and queued peer notices reopen without another artifact or duplicate announcement',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sre-shared-ticket-')),path=join(directory,'agent.sqlite');let f=await fixture('sqlite',{path});try{const plan=await f.r.casework.createPlan(f.id,{originConversationKey:f.keys[0]}),before=await f.notices(),id=f.id,clock=f.now();await f.r.close();f=await fixture('sqlite',{path,seed:false,clock});f.id=id;assert.equal((await f.r.casework.createPlan(id,{originConversationKey:f.keys[0]})).id,plan.id);assert.equal((await f.r.casework.getPlan(plan.id,id)).markdown,plan.markdown);assert.deepEqual(await f.notices(),before);}finally{await f.r.close();await rm(directory,{recursive:true,force:true});}
});
