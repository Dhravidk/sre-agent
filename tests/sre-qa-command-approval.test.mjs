import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig,validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {conversationKey} from '../src/sre/store.mjs';
import {StorageError} from '../src/sre/database.mjs';
import {hash} from '../src/sre/security.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {postgresSql} from '../src/sre/database.mjs';
import {createPilotQaAdapter} from '../fixtures/qa-sandbox.mjs';

async function fixture({path=':memory:',db,autoSeed=true,clock}={}){
  const raw=loadConfig({SRE_SQLITE_PATH:path});
  raw.services[0].teams.conversations=['qa-room','other-room'];
  raw.services[0].teams.collaborationGroups=[{key:'qa-review',name:'QA command review',conversations:[{id:'qa-room',name:'QA'},{id:'other-room',name:'Other'}]}];
  const config=validateConfig(raw,{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-qa-command-cli'});
  const r=await createSreRuntime({config,db,connectors:new Map([[config.services[0].key,{}]]),autoStart:false,qaAdapter:{localOnly:true,execute:async()=>{throw Error('No executor in this approval-only fixture');}},sender:{send:async()=>({id:'synthetic-qa-receipt',simulation:true})}});
  let now=clock??Date.now(),sequence=0;r.store.clock=()=>now;
  const key=conversationKey('synthetic','qa-room');
  const f={r,key,now:()=>now,advance:ms=>now+=ms,principal:{verified:true,simulation:true,tenant:'synthetic',conversationId:'qa-room',userId:'local-operator'}};
  f.send=async(text,{process=true,at,room='qa-room'}={})=>{
    now++;const sample=devActivity(text,config.services[0],{id:'qa-command-'+ ++sequence,conversationId:room,conversationType:'groupChat',userId:'local-operator',mentioned:true});sample.activity.timestamp=new Date(at??now).toISOString();
    const receipt=await r.router.accept(sample.activity,sample.reference);if(process)await r.router.processOnce();return receipt;
  };
  f.deliver=async()=>{for(let i=0;i<100&&await r.outbox.runOnce();i++);await r.outbox.drainSettled();};
  if(autoSeed){f.id=(await seedDemo(r.store,config.services[0])).incidentId;await f.send('join '+f.id);await f.send('join '+f.id,{room:'other-room'});for(let i=0;i<20&&await r.worker.runOnce();i++);f.plan=await r.casework.createPlan(f.id);await f.deliver();}
  f.propose=async()=>{
    const receipt=await f.send('fix '+f.plan.id);
    const [request]=await r.store.db.query('SELECT * FROM sre_fix_requests WHERE id=?',['fix_'+hash([f.id,receipt.eventId]).slice(0,24)]);
    assert.ok(request);return {...request,commandId:receipt.eventId};
  };
  f.status=async id=>(await r.store.db.query('SELECT status FROM sre_fix_requests WHERE id=?',[id]))[0].status;
  return f;
}

test('a yes admitted before a QA proposal cannot approve that later request',async()=>{
  const f=await fixture();try{
    await f.send('yes',{process:false});f.advance(20);
    const request=await f.r.casework.proposeFix(f.id,f.plan.id,f.principal,f.key,'later-than-yes');
    await f.r.router.processOnce();assert.equal(await f.status(request.id),'proposed');
  }finally{await f.r.close();}
});

test('bare yes cannot approve a proposal whose bot reply has not been delivered',async()=>{
  const f=await fixture();try{
    const request=await f.propose();await f.send('yes');assert.equal(await f.status(request.id),'proposed');
    assert.ok((await f.r.store.snapshot()).outbox.some(o=>/exact approve-fix|delivered|review/i.test(o.text)&&!o.text.startsWith('Review '+f.plan.id)));
  }finally{await f.r.close();}
});

test('a fresh yes after the delivered proposal approves the sole reviewed request',async()=>{
  const f=await fixture();try{
    const request=await f.propose();await f.deliver();const receipt=await f.send('yes');assert.equal(await f.status(request.id),'approved');
    const [row]=await f.r.store.db.query("SELECT payload FROM sre_fix_events WHERE request_id=? AND status='approval-receipt'",[request.id]);assert.ok(row,'The consumed source command needs a durable request-bound receipt');assert.equal(JSON.parse(row.payload).commandId,receipt.eventId);
  }finally{await f.r.close();}
});

test('a delayed old yes remains invalid even when it arrives after a delivered proposal',async()=>{
  const f=await fixture();try{
    const at=f.now();const request=await f.propose();f.advance(10);await f.deliver();f.advance(10);await f.send('yes',{at});assert.equal(await f.status(request.id),'proposed');
  }finally{await f.r.close();}
});

test('an expired command claim cannot commit a QA approval',async()=>{
  const f=await fixture();const approve=f.r.casework.approveFix.bind(f.r.casework);try{
    const request=await f.propose();await f.deliver();f.r.casework.approveFix=async(...args)=>{f.advance(31000);return approve(...args);};
    await f.send('yes',{process:false});await assert.rejects(f.r.router.processOnce(),/lease/i);assert.equal(await f.status(request.id),'proposed');
  }finally{await f.r.close();}
});

test('a reclaimed source command fences the previous QA approver before mutation',async()=>{
  const f=await fixture();const approve=f.r.casework.approveFix.bind(f.r.casework);try{
    const request=await f.propose();await f.deliver();const receipt=await f.send('yes',{process:false});
    f.r.casework.approveFix=async(...args)=>{await f.r.store.db.query('UPDATE sre_commands SET lease_until=lease_until+1000 WHERE id=?',[receipt.eventId]);return approve(...args);};
    await f.r.router.processOnce();assert.equal(await f.status(request.id),'proposed');
  }finally{await f.r.close();}
});

test('retry after an approval-ack storage failure cannot consume a newer QA proposal',async()=>{
  const f=await fixture();const transaction=f.r.store.db.transaction.bind(f.r.store.db);try{
    const first=await f.propose();await f.deliver();const receipt=await f.send('yes',{process:false});
    f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const result=await q(sql,args);if(sql.startsWith('INSERT INTO sre_outbox')&&args?.includes('command:'+receipt.eventId))throw new StorageError(new Error('Injected command acknowledgement failure'));return result;}));
    await assert.rejects(f.r.router.processOnce(),e=>e instanceof StorageError);f.r.store.db.transaction=transaction;
    assert.equal(await f.status(first.id),'approved');const next=await f.r.casework.proposeFix(f.id,f.plan.id,f.principal,f.key,'next-review');f.advance(31000);
    await f.r.router.processOnce();assert.equal(await f.status(next.id),'proposed');assert.equal(await f.status(first.id),'approved');
    const [ack]=await f.r.store.db.query('SELECT text FROM sre_outbox WHERE id=?',['command:'+receipt.eventId]);assert.ok(ack?.text.includes(first.id));assert.ok(!ack.text.includes(next.id));
  }finally{f.r.store.db.transaction=transaction;await f.r.close();}
});

test('future and equal-time yes activities require the exact command rather than assuming they followed delivery',async()=>{
  for(const kind of ['future','equal']){
    const f=await fixture();try{
      const request=await f.propose();await f.deliver();const [record]=await f.r.store.db.query('SELECT value FROM sre_checkpoints WHERE id=?',['teams-delivery:outcome:command:'+request.commandId+':1']);const at=kind==='future'?f.now()+60000:JSON.parse(record.value).observedAt;
      await f.send('yes',{at});assert.equal(await f.status(request.id),'proposed');
    }finally{await f.r.close();}
  }
});

test('a timed-out proposal, late remote receipt and handled operator inspection cannot authorize bare yes',async()=>{
  const f=await fixture();let release;try{
    f.r.outbox.timeoutMs=5;f.r.outbox.sender={send:async(_reference,text)=>text.startsWith('Review ')?new Promise(resolve=>release=resolve):{id:'fixture-other',simulation:true}};
    const request=await f.propose();await f.deliver();assert.equal((await f.r.store.db.query('SELECT status FROM sre_outbox WHERE id=?',['command:'+request.commandId]))[0].status,'unknown');
    await f.send('yes');assert.equal(await f.status(request.id),'proposed');release({id:'late-proposal-receipt',simulation:true});await f.r.outbox.drainSettled();
    const id='command:'+request.commandId,view=await f.r.inspections.view(id);f.advance(1);
    await f.r.inspections.record(id,{requestId:'manual-qa-review',expectedFingerprint:view.reviewFingerprint,finding:'observed',followUp:'handled',reason:'Synthetic operator saw a late post; this is not an approval.',observedAt:f.now(),references:['https://fixture.invalid/late-proposal']},{kind:'local-operator',id:'fixture operator'});
    await f.send('yes');assert.equal(await f.status(request.id),'proposed');
    const [proposal]=await f.r.store.db.query('SELECT text FROM sre_outbox WHERE id=?',[id]);await f.send(proposal.text.match(/approve-fix fix_[a-f0-9]+ [a-f0-9]+/)[0]);assert.equal(await f.status(request.id),'approved','A reviewed exact nonce remains usable');
  }finally{release?.({id:'fixture-late-cleanup',simulation:true});await f.r.close();}
});

test('caller dates cannot replace admitted command provenance and legacy proposals retain their exact approval path',async()=>{
  const f=await fixture();try{
    const request=await f.r.casework.proposeFix(f.id,f.plan.id,f.principal,f.key,'legacy-proposal');
    await assert.rejects(f.r.casework.approveFix(null,null,f.principal,f.key,{bareYes:true,at:f.now()+1,receivedAt:f.now()+1}),/exact approve-fix/);assert.equal(await f.status(request.id),'proposed');
    assert.equal((await f.r.casework.approveFix(request.id,request.nonce,f.principal,f.key)).status,'approved');
  }finally{await f.r.close();}
});

test('altering the mutable command payload cannot forge a source-backed approval',async()=>{
  const f=await fixture();try{
    const request=await f.propose();await f.deliver();const receipt=await f.send('yes',{process:false});
    const [row]=await f.r.store.db.query('SELECT payload FROM sre_commands WHERE id=?',[receipt.eventId]);const message=JSON.parse(row.payload);message.at+=10;
    await f.r.store.db.query('UPDATE sre_commands SET payload=? WHERE id=?',[JSON.stringify(message),receipt.eventId]);await assert.rejects(f.r.router.processOnce(),e=>e instanceof StorageError);assert.equal(await f.status(request.id),'proposed');
  }finally{await f.r.close();}
});

test('the command lease is checked again at commit and rolls back the request and its receipt together',async()=>{
  const f=await fixture();const transaction=f.r.store.db.transaction.bind(f.r.store.db);try{
    const request=await f.propose();await f.deliver();await f.send('yes',{process:false});let expired=false;
    f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const result=await q(sql,args);if(sql.startsWith('INSERT INTO sre_fix_events')&&args?.includes('approval-receipt')&&!expired){expired=true;f.advance(31000);}return result;}));
    await assert.rejects(f.r.router.processOnce(),/lease/i);assert.equal(await f.status(request.id),'proposed');assert.equal(Number((await f.r.store.db.query("SELECT COUNT(*) AS count FROM sre_fix_events WHERE request_id=? AND status IN ('approved','approval-receipt')",[request.id]))[0].count),0);
  }finally{f.r.store.db.transaction=transaction;await f.r.close();}
});

test('a proposal request identity cannot be reused in a different conversation or by another developer',async()=>{
  const f=await fixture();try{
    const request=await f.r.casework.proposeFix(f.id,f.plan.id,f.principal,f.key,'reused-proposal');assert.equal((await f.r.casework.proposeFix(f.id,f.plan.id,f.principal,f.key,'reused-proposal')).id,request.id);
    await assert.rejects(f.r.casework.proposeFix(f.id,f.plan.id,{...f.principal,conversationId:'other-room'},conversationKey('synthetic','other-room'),'reused-proposal'),e=>e.status===409);
    f.r.config.services[0].teams.approvers.push('alex');await assert.rejects(f.r.casework.proposeFix(f.id,f.plan.id,{...f.principal,userId:'alex'},f.key,'reused-proposal'),e=>e.status===409);
  }finally{await f.r.close();}
});

test('a database reopen replays the consumed approval receipt rather than approving the next request',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-qa-command-restart-')),path=join(directory,'agent.sqlite');let f=await fixture({path});let transaction=f.r.store.db.transaction.bind(f.r.store.db);try{
    const first=await f.propose();await f.deliver();const receipt=await f.send('yes',{process:false});
    f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const result=await q(sql,args);if(sql.startsWith('INSERT INTO sre_outbox')&&args?.includes('command:'+receipt.eventId))throw new StorageError(Error('Injected acknowledgement crash'));return result;}));
    await assert.rejects(f.r.router.processOnce(),e=>e instanceof StorageError);f.r.store.db.transaction=transaction;
    const next=await f.r.casework.proposeFix(f.id,f.plan.id,f.principal,f.key,'next-after-crash'),saved={id:f.id,plan:f.plan,now:f.now()};await f.r.close();
    f=await fixture({path,autoSeed:false,clock:saved.now+31000});transaction=f.r.store.db.transaction.bind(f.r.store.db);await f.r.router.processOnce();assert.equal(await f.status(first.id),'approved');assert.equal(await f.status(next.id),'proposed');
    const [ack]=await f.r.store.db.query('SELECT text FROM sre_outbox WHERE id=?',['command:'+receipt.eventId]);assert.match(ack.text,new RegExp(first.id));assert.equal(Number((await f.r.store.db.query("SELECT COUNT(*) AS count FROM sre_fix_events WHERE status='approval-receipt'"))[0].count),1);
  }finally{f.r.store.db.transaction=transaction;await f.r.close();await rm(directory,{recursive:true,force:true});}
});

test('the PostgreSQL SQL contract commits a source-bound approval and idempotent receipt',async()=>{
  const pg=new PGlite(),db={dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
  // This case verifies portable SQL. Native server clock/locking is exercised
  // separately; use one explicit fixture clock for the timestamp contract here.
  const f=await fixture({db,autoSeed:false});f.r.store.coordinationNow=async()=>f.now();try{
    f.id=(await seedDemo(f.r.store,f.r.config.services[0])).incidentId;await f.send('join '+f.id);for(let i=0;i<20&&await f.r.worker.runOnce();i++);f.plan=await f.r.casework.createPlan(f.id);await f.deliver();
    const request=await f.propose();await f.deliver();await f.send('yes');assert.equal(await f.status(request.id),'approved');assert.equal(Number((await f.r.store.db.query("SELECT COUNT(*) AS count FROM sre_fix_events WHERE status='approval-receipt'"))[0].count),1);
  }finally{await f.r.close();}
});

test('the delivered-proposal yes flow creates a real local fixture fix and passes its business checks exactly once',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-qa-command-branch-')),f=await fixture();try{
    f.r.casework.qaAdapter=createPilotQaAdapter(directory);const request=await f.propose();await f.deliver();await f.send('yes');assert.equal(await f.status(request.id),'approved');await f.r.casework.runOnce();assert.equal(await f.r.casework.runOnce(),false);
    const result=(await f.r.casework.snapshot(f.id)).qa.find(r=>r.id===request.id);result.result=(await f.r.casework.qaRequest(f.id,result.id)).result;assert.equal(result.status,'passed',result.error);assert.notEqual(result.result.reproduction.exitCode,0);assert.equal(result.result.validation.exitCode,0);assert.match(result.result.branch,/^codex\/qa-/);assert.match(result.result.commit,/^[a-f0-9]{40}$/);assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
  }finally{await f.r.close();await rm(directory,{recursive:true,force:true});}
});
