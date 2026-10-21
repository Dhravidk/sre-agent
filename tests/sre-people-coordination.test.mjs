import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createSreRuntime} from '../src/sre/server.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {postgresSql} from '../src/sre/database.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {collaborationText} from '../src/sre/collaboration.mjs';
import {conversationKey} from '../src/sre/store.mjs';

async function fixture(dialect,{path=':memory:',database}={}){
  const profile=rehearsalProfile(),rooms=profile.services[0].teams.conversations.slice(0,3);profile.services[0].teams.conversations=rooms;profile.services[0].teams.collaborationGroups[0].conversations=profile.services[0].teams.collaborationGroups[0].conversations.slice(0,3);
  const config=validateConfig(profile,{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-people-test'}),pg=dialect==='postgres'&&!database?new PGlite():null;
  const db=database||(pg?{dialect:'postgres',query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()}:undefined);
  const sent=[],r=await createSreRuntime({config,db,autoStart:false,sender:{send:async(ref,text)=>{sent.push({room:ref.conversation.id,text});return {id:'fixture-'+sent.length,simulation:true};}}});
  const f={r,config,rooms,now:Date.now(),sequence:0,sent};r.store.clock=()=>f.now;
  f.incident=async(key='eu')=>(await r.store.ingest({id:'people-'+key,source:'dynatrace',serviceKey:config.services[0].key,kind:'problem',issueKey:'people-'+key,status:'OPEN',at:f.now-1000,payload:{}})).incidentId;
  f.send=async(room,user,text,{at,mentioned=true,name=user}={})=>{f.now+=10;const sample=devActivity(text,config.services[0],{id:'people:'+ ++f.sequence,conversationType:'groupChat',conversationId:rooms[room],userId:user,displayName:name,mentioned});sample.activity.timestamp=new Date(at??f.now).toISOString();const receipt=await r.router.accept(sample.activity,sample.reference);if(!receipt.ignored)await r.commands();return receipt;};
  f.snapshot=id=>r.coordination.snapshot(id);
  f.drain=async()=>{for(let i=0;i<100;i++){await r.deliver();await r.outbox.drainSettled();const [row]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_outbox WHERE status='sending' OR (status='pending' AND next_at<=?)",[await r.store.coordinationNow()]);if(!Number(row.count))return;}throw Error('People fixture transport did not settle');};
  return f;
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': peers in one group retain separate work, theory and service-state claims through noisy conversation',async()=>{
    const f=await fixture(dialect);try{
      const id=await f.incident();await f.send(0,'operator','join '+id);
      await f.send(0,'alex','report blocked The accepted winner is still lower than the accepted high bid.');await f.send(0,'sam','report recovered Health probes passed; I have not checked the ledger.');
      await f.send(0,'alex','theory version-guard supported Reproduced on the deployed source.');await f.send(0,'sam','theory version-guard ruled-out A smoke check passed on a different request.');
      await f.send(0,'alex','work eu-ledger active Replaying the affected accepted-bid sequence.');await f.send(0,'sam','work eu-ledger active I also started that same replay.');
      for(let i=0;i<45;i++)await f.send(0,'noor','Routine chat sample '+i,{mentioned:false});
      const c=await f.r.store.context(id),room=c.collaboration.rooms[0];assert.equal(room.work.length,2);assert.equal(room.theories.length,2);assert.equal(room.stateReports.length,2);
      for(const code of ['reported-state-disagreement','theory-disagreement','overlapping-work'])assert.ok(c.collaboration.issues.some(i=>i.code===code),code);
      assert.equal(c.incident.status,'open');assert.equal((await f.r.store.snapshot()).rollbacks.length,0);assert.ok(c.evidence.some(e=>e.content.text?.includes('Replaying the affected')));
      await f.r.coordination.publish(id,{requestId:'after-busy-chat'});await f.drain();assert.ok(f.sent.some(m=>m.text.startsWith('Shared incident coordination')&&m.text.includes('duplicate work')&&m.text.includes('alex')&&m.text.includes('sam')),'A single multi-person chat must receive its conflict briefing');
      await f.send(0,'sam','work eu-ledger cancelled Alex owns the replay; I will check upstream traces.');assert.equal((await f.snapshot(id)).issues.some(i=>i.code==='overlapping-work'),false);
    }finally{await f.r.close();}
  });

  test(dialect+': one responder mirrored across chats is one owner and can update only their own current position',async()=>{
    const f=await fixture(dialect);try{
      const id=await f.incident();for(const room of [0,1])await f.send(room,'operator','join '+id);
      await f.send(0,'alex','work eu-replay active Collecting the request trace.');await f.send(1,'alex','work eu-replay active Mirroring my same assignment here.',{name:'Alex renamed'});
      let view=await f.snapshot(id);assert.equal(view.issues.some(i=>i.code==='overlapping-work'),false);
      const first=view.rooms.find(r=>r.conversationId===f.rooms[0]).work[0],second=view.rooms.find(r=>r.conversationId===f.rooms[1]).work[0];assert.equal(first.currentForAuthor,false);assert.equal(second.currentForAuthor,true);assert.equal(first.participantKey,second.participantKey);
      await f.send(1,'sam','work eu-replay active I independently started the same task.',{name:'Alex renamed'});view=await f.snapshot(id);assert.ok(view.issues.some(i=>i.code==='overlapping-work'),'Matching display names do not collapse distinct identities');
      await f.send(1,'alex','work eu-replay done My replay finished.');view=await f.snapshot(id);assert.equal(view.issues.some(i=>i.code==='overlapping-work'),false);assert.ok(view.issues.some(i=>i.code==='work-status-disagreement'));assert.ok(view.rooms.find(r=>r.conversationId===f.rooms[1]).work.some(w=>w.author==='Alex renamed'&&w.state==='active'));
      await f.send(1,'sam','work eu-replay cancelled I stopped my duplicate and will read the existing result.');view=await f.snapshot(id);assert.equal(view.issues.some(i=>['overlapping-work','work-status-disagreement'].includes(i.code)),false);
    }finally{await f.r.close();}
  });

  test(dialect+': an active participant cannot flood other current owners out of the bounded work window',async()=>{
    const f=await fixture(dialect);try{
      const id=await f.incident();await f.send(0,'operator','join '+id);
      await f.send(0,'quiet-a','work accepted-bid-replay active Quiet owner A is replaying the business invariant.');await f.send(0,'quiet-b','work accepted-bid-replay active Quiet owner B started the same scope.');
      for(let i=0;i<24;i++)await f.send(0,'chatty','work trace-'+i+' active Routine trace bucket '+i);
      const view=await f.snapshot(id),room=view.rooms[0];assert.equal(room.work.length,8);assert.equal(room.omittedItems,18);assert.equal(room.work.filter(w=>w.key==='accepted-bid-replay').length,2);assert.ok(view.issues.some(i=>i.code==='overlapping-work'));
    }finally{await f.r.close();}
  });

  test(dialect+': delayed reports and equal-time receipt order stay participant-scoped across rooms and incidents',async()=>{
    const f=await fixture(dialect);try{
      const a=await f.incident('a'),b=await f.incident('b');await f.send(0,'operator','join '+a);await f.send(1,'operator','join '+a);await f.send(2,'operator','join '+b);
      const at=f.now;await f.send(0,'alex','work eu-check active Initial assignment.',{at});await f.send(1,'alex','work eu-check done Same millisecond, later receipt.',{at});await f.send(0,'alex','work eu-check active Delayed older packet.',{at:at-1});
      await f.send(2,'alex','work eu-check active Separate incident, same word key.');
      let view=await f.snapshot(a);assert.equal(view.issues.some(i=>i.code==='overlapping-work'),false);assert.equal(view.rooms.find(r=>r.conversationId===f.rooms[1]).work[0].currentForAuthor,true);assert.equal(view.rooms.find(r=>r.conversationId===f.rooms[0]).work[0].currentForAuthor,false);
      assert.equal((await f.snapshot(b)).rooms[0].work[0].currentForAuthor,true);
      await f.send(1,'operator','leave');view=await f.snapshot(a);assert.equal(view.rooms.length,1);assert.equal(view.rooms[0].work[0].currentForAuthor,true,'An unlinked room cannot supply a hidden superseding position');
    }finally{await f.r.close();}
  });
}

test('participant positions survive database reopen and bounded model metadata drops unavailable source references',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-people-reopen-')),path=join(directory,'agent.sqlite');let f=await fixture('sqlite',{path});try{
    const id=await f.incident();await f.send(0,'operator','join '+id);await f.send(0,'alex','report blocked Accepted bids still regress.');await f.send(0,'sam','report recovered Only the health route passed.');await f.send(0,'alex','work replay active Comparing the stored bid sequence.');await f.send(0,'sam','work replay active I started the same sequence.');
    const before=await f.snapshot(id),events=await f.r.store.db.query('SELECT id,body_hash FROM sre_events ORDER BY id');await f.r.close();f=await fixture('sqlite',{path});const after=await f.snapshot(id);assert.deepEqual(after.rooms.map(r=>[r.work,r.stateReports]),before.rooms.map(r=>[r.work,r.stateReports]));assert.deepEqual(await f.r.store.db.query('SELECT id,body_hash FROM sre_events ORDER BY id'),events);
    const c=await f.r.store.context(id);c.collaboration.rooms[0].stateReports[0].evidenceId='omitted-evidence';for(const report of c.collaboration.rooms[0].stateReports)report.text='超长上下文'.repeat(4000);const model=boundedContext(c);assert.equal(model.collaboration.rooms[0].stateReports[0].evidenceId,undefined);assert.equal(model.collaboration.rooms[0].stateReports[0].evidenceOmitted,true);assert.ok(model.collaboration.rooms[0].work.every(w=>w.participantKey));
    const text=collaborationText(c.collaboration);assert.match(text,/alex/);assert.match(text,/sam/);assert.match(text,/blocked/);assert.match(text,/recovered/);
  }finally{await f.r.close();await rm(directory,{recursive:true,force:true});}
});

test('single-chat conflict clearing publishes once and a fresh Markdown ticket retains individual state claims',async()=>{
  const f=await fixture('sqlite');try{
    const id=await f.incident();await f.send(0,'operator','join '+id);await f.send(0,'alex','report blocked Ledger is still incorrect.');await f.send(0,'sam','report recovered Health route passed.');await f.send(0,'alex','work replay active Replaying affected requests.');await f.send(0,'sam','work replay active Running the same replay.');
    f.now+=16000;await f.r.coordination.runOnce();await f.drain();const generation=(await f.snapshot(id)).briefingGeneration;assert.ok(generation>0);
    await f.send(0,'sam','work replay cancelled Alex owns the replay.');await f.send(0,'sam','report blocked Correction: no verified recovery yet.');f.now+=16000;await f.r.coordination.runOnce();await f.drain();
    const view=await f.snapshot(id);assert.equal(view.issues.some(i=>['overlapping-work','reported-state-disagreement'].includes(i.code)),false);assert.ok(view.briefingGeneration>generation);const count=f.sent.filter(m=>m.text.startsWith('Shared incident coordination')).length;await f.r.coordination.runOnce();await f.drain();assert.equal(f.sent.filter(m=>m.text.startsWith('Shared incident coordination')).length,count);
    for(let i=0;i<20&&await f.r.worker.runOnce();i++);const plan=await f.r.casework.createPlan(id);assert.match(plan.markdown,/State claim in EU Bidding: alex reports blocked/);assert.match(plan.markdown,/State claim in EU Bidding: sam reports blocked/);assert.equal(plan.payload.collaboration[0].work.length,2);assert.ok(plan.payload.collaboration[0].work.every(w=>w.participantKey&&w.currentForAuthor));
  }finally{await f.r.close();}
});

test('a mirrored assignment committed during a read cannot turn one person into two current owners',async()=>{
  const f=await fixture('sqlite');try{
    const id=await f.incident(),[first,second]=[0,1].sort((a,b)=>conversationKey('synthetic',f.rooms[a]).localeCompare(conversationKey('synthetic',f.rooms[b])));await f.send(0,'operator','join '+id);await f.send(1,'operator','join '+id);await f.send(first,'alex','work eu-check active I own the request replay.');
    const query=f.r.store.db.query;let injected=false;
    f.r.store.db.query=async(sql,args=[])=>{const result=await query(sql,args);if(!injected&&sql.includes('author_global_rank')&&args.at(-1)===conversationKey('synthetic',f.rooms[first])){injected=true;await f.send(second,'alex','work eu-check active Mirroring my one assignment in the second room.');}return result;};
    const view=await f.snapshot(id);assert.ok(injected);assert.equal(view.issues.some(i=>i.code==='overlapping-work'),false);assert.equal(view.rooms.flatMap(r=>r.work).filter(w=>w.currentForAuthor).length,1);
  }finally{await f.r.close();}
});
