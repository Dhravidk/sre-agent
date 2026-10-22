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
import {hash} from '../src/sre/security.mjs';

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

  test(dialect+': a recovery correction in another joined chat retires only that native responder’s old state claim',async()=>{
    const f=await fixture(dialect);try{
      const id=await f.incident();for(const room of [0,1])await f.send(room,'operator','join '+id);
      await f.send(0,'alex','report recovered Only the health endpoint passed; business validation is pending.');
      const old=(await f.snapshot(id)).rooms.find(r=>r.conversationId===f.rooms[0]).stateReports[0],source=await f.r.store.db.query('SELECT * FROM sre_evidence WHERE id=?',[old.evidenceId]);
      await f.send(1,'alex','report blocked Correction: the accepted-bid ledger still regresses.',{name:'Alex renamed'});
      let view=await f.snapshot(id),historical=view.rooms.find(r=>r.conversationId===f.rooms[0]);
      assert.equal(view.issues.some(i=>['reported-state-disagreement','recovery-unverified'].includes(i.code)),false);
      assert.equal(historical.stateReports[0].currentForAuthor,false);assert.equal(historical.statusCurrentForAuthor,false);assert.equal(historical.reportedStatus,'recovered');assert.match(collaborationText(view),/recovered.*historical; responder updated elsewhere/);
      assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_evidence WHERE id=?',[old.evidenceId]),source);
      const current=view.rooms.find(r=>r.conversationId===f.rooms[1]).stateReports[0];assert.equal(current.currentForAuthor,true);assert.equal(current.participantKey,old.participantKey);
      await f.send(1,'sam','report recovered A different responder still considers the probes sufficient.',{name:'Alex renamed'});
      view=await f.snapshot(id);assert.ok(view.issues.some(i=>i.code==='reported-state-disagreement'));assert.ok(view.issues.some(i=>i.code==='recovery-unverified'));assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
    }finally{await f.r.close();}
  });

  test(dialect+': delayed and equal-time state corrections follow source time then receipt order without crossing incident scope',async()=>{
    const f=await fixture(dialect);try{
      const a=await f.incident('a'),b=await f.incident('b');for(const room of [0,1])await f.send(room,'operator','join '+a);await f.send(2,'operator','join '+b);
      const at=f.now;await f.send(0,'alex','report recovered Initial probe report.',{at});await f.send(1,'alex','report blocked Correction at the same provider millisecond.',{at});await f.send(0,'alex','report recovered Delayed old recovery packet.',{at:at-1});await f.send(2,'alex','report recovered Separate US incident report.');
      const view=await f.snapshot(a);assert.equal(view.issues.some(i=>i.code==='reported-state-disagreement'),false);assert.equal(view.issues.some(i=>i.code==='recovery-unverified'),false);assert.equal(view.rooms.find(r=>r.conversationId===f.rooms[0]).stateReports[0].currentForAuthor,false);assert.equal(view.rooms.find(r=>r.conversationId===f.rooms[1]).stateReports[0].state,'blocked');assert.equal((await f.snapshot(b)).rooms[0].stateReports[0].currentForAuthor,true);assert.ok((await f.snapshot(b)).issues.some(i=>i.code==='recovery-unverified'));
    }finally{await f.r.close();}
  });

  test(dialect+': a departed or moved chat cannot supply a hidden superseding service-state report',async()=>{
    const f=await fixture(dialect);try{
      const id=await f.incident(),other=await f.incident('other');for(const room of [0,1])await f.send(room,'operator','join '+id);
      await f.send(0,'alex','report recovered Original report in the retained chat.');await f.send(1,'alex','report blocked Correction in a chat that later leaves.');assert.equal((await f.snapshot(id)).issues.some(i=>i.code==='recovery-unverified'),false);
      await f.send(1,'operator','leave');let view=await f.snapshot(id);assert.equal(view.rooms.length,1);assert.equal(view.rooms[0].stateReports[0].currentForAuthor,true);assert.ok(view.issues.some(i=>i.code==='recovery-unverified'));
      await f.send(1,'operator','join '+other);await f.send(1,'alex','report blocked Separate issue still blocked.');view=await f.snapshot(id);assert.equal(view.rooms[0].stateReports[0].currentForAuthor,true);assert.equal(view.rooms[0].stateReports[0].state,'recovered');assert.equal((await f.snapshot(other)).rooms[0].stateReports[0].state,'blocked');
    }finally{await f.r.close();}
  });

  test(dialect+': state supersession is computed before a busy peer chat’s bounded display window',async()=>{
    const f=await fixture(dialect);try{
      const id=await f.incident();for(const room of [0,1])await f.send(room,'operator','join '+id);
      await f.send(0,'quiet','report recovered Initial quiet report.');await f.send(1,'quiet','report blocked Quiet responder corrects the business-impact claim.');
      for(let n=0;n<12;n++)await f.send(1,'busy-'+n,'report blocked Independent impact sample '+n);
      const view=await f.snapshot(id),peer=view.rooms.find(r=>r.conversationId===f.rooms[1]);assert.equal(peer.stateReports.length,8);assert.equal(peer.omittedStateReports,5);assert.ok(!peer.stateReports.some(r=>r.author==='quiet'));assert.equal(view.rooms.find(r=>r.conversationId===f.rooms[0]).stateReports[0].currentForAuthor,false);assert.equal(view.issues.some(i=>['reported-state-disagreement','recovery-unverified'].includes(i.code)),false);
    }finally{await f.r.close();}
  });

  test(dialect+': current participant state claims are reserved before newer historical claims at the room cap',async()=>{
    const f=await fixture(dialect);try{
      const id=await f.incident();for(const room of [0,1])await f.send(room,'operator','join '+id);
      await f.send(0,'quiet','report blocked The quiet participant still sees the defect.');
      for(let n=0;n<10;n++){await f.send(0,'mirror-'+n,'report recovered Earlier health-only observation.');await f.send(1,'mirror-'+n,'report blocked Corrected business validation.');}
      const view=await f.snapshot(id),room=view.rooms.find(r=>r.conversationId===f.rooms[0]);assert.equal(room.stateReports.length,8);assert.equal(room.omittedStateReports,3);assert.equal(room.stateReports[0].author,'quiet');assert.equal(room.stateReports[0].currentForAuthor,true);assert.ok(room.stateReports.slice(1).every(r=>r.currentForAuthor===false));assert.equal(view.issues.some(i=>i.code==='reported-state-disagreement'),false);
    }finally{await f.r.close();}
  });

  test(dialect+': aging only a superseded service-state claim does not publish another unread briefing',async()=>{
    const f=await fixture(dialect);try{
      f.r.store.coordinationNow=async()=>f.now;
      const id=await f.incident();for(const room of [0,1])await f.send(room,'operator','join '+id);
      await f.send(0,'alex','report recovered Earlier health-only report.');f.now+=200000;await f.send(1,'alex','report blocked Corrected business impact.');await f.r.coordination.publish(id);await f.drain();const generation=(await f.snapshot(id)).briefingGeneration;
      f.now+=100001;const view=await f.snapshot(id);assert.equal(view.rooms.find(r=>r.conversationId===f.rooms[0]).statusStale,true);assert.equal(view.issues.some(i=>i.code==='stale-team-state'),false);assert.equal(await f.r.coordination.publish(id),false);assert.equal((await f.snapshot(id)).briefingGeneration,generation);
    }finally{await f.r.close();}
  });

  test(dialect+': anonymous service-state claims in different chats cannot supersede one another',async()=>{
    const f=await fixture(dialect);try{
      const id=await f.incident();for(const room of [0,1])await f.send(room,'operator','join '+id);await f.send(0,'anonymous-a','report recovered Unattributed health report.');await f.send(1,'anonymous-b','report blocked Unattributed impact report.');
      await f.r.store.db.query("UPDATE sre_responder_people SET author_key='unknown' WHERE incident_id=?",[id]);const view=await f.snapshot(id);assert.ok(view.issues.some(i=>i.code==='reported-state-disagreement'));assert.ok(view.rooms.every(room=>room.stateReports[0].currentForAuthor&&room.stateReports[0].participantKey===null));
    }finally{await f.r.close();}
  });

  for(const savedFormat of ['prior-release','expanded-trial'])test(dialect+': an unchanged '+savedFormat+' coordination receipt survives upgrade without another unread briefing',async()=>{
    const f=await fixture(dialect);try{
      f.r.store.coordinationNow=async()=>f.now;
      const id=await f.incident();for(const room of [0,1])await f.send(room,'operator','join '+id);await f.send(0,'alex','report blocked EU ledger still fails.');await f.send(1,'sam','report blocked Matched business validation also fails.');await f.r.coordination.publish(id);await f.drain();
      const {briefingGeneration,...content}=await f.snapshot(id),rooms=content.rooms.map(({briefing,...room})=>room);
      // Persist the wire shape used by each already-running release. This
      // simulates an upgrade, rather than publishing another responder report.
      if(savedFormat==='prior-release')for(const room of rooms){delete room.statusCurrentForAuthor;room.stateReports=room.stateReports.map(report=>({state:report.state,evidenceId:report.evidenceId,at:report.at,author:report.author,participantKey:report.participantKey,text:report.text,stale:report.stale,verified:report.verified}));}
      await f.r.store.db.query('UPDATE sre_coordination SET last_hash=? WHERE incident_id=?',[hash({...content,rooms,issues:content.issues.filter(issue=>!issue.delivery)}),id]);
      const before=await f.r.store.db.query('SELECT * FROM sre_outbox ORDER BY id');f.now+=16001;assert.equal(await f.r.coordination.publish(id),false);assert.equal((await f.snapshot(id)).briefingGeneration,briefingGeneration);assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_outbox ORDER BY id'),before);
      // An actual cross-chat correction must still reach both teams once.
      await f.send(1,'alex','report recovered My later business validation passed; Sam still reports blocked.');const view=await f.snapshot(id);assert.equal(view.briefingGeneration,briefingGeneration+1);assert.ok(view.issues.some(issue=>issue.code==='reported-state-disagreement'));assert.equal(view.rooms.find(room=>room.conversationId===f.rooms[0]).statusCurrentForAuthor,false);const next=await f.r.store.db.query('SELECT * FROM sre_outbox ORDER BY id'),briefings=rows=>rows.filter(row=>row.text.startsWith('Shared incident coordination'));assert.equal(briefings(next).length,briefings(before).length+2);f.now+=16001;assert.equal(await f.r.coordination.publish(id),false);assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_outbox ORDER BY id'),next);
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

test('a service-state correction committed between room reads cannot manufacture a disagreement with the same person',async()=>{
  const f=await fixture('sqlite');try{
    const id=await f.incident(),[first,second]=[0,1].sort((a,b)=>conversationKey('synthetic',f.rooms[a]).localeCompare(conversationKey('synthetic',f.rooms[b])));for(const room of [0,1])await f.send(room,'operator','join '+id);await f.send(first,'alex','report recovered Earlier health report.');
    const query=f.r.store.db.query;let injected=false;f.r.store.db.query=async(sql,args=[])=>{const rows=await query(sql,args);if(!injected&&sql.includes('AS state_count')&&args.at(-1)===conversationKey('synthetic',f.rooms[first])){injected=true;await f.send(second,'alex','report blocked Correction committed during the read.');}return rows;};
    const view=await f.snapshot(id);assert.ok(injected);assert.equal(view.issues.some(i=>['reported-state-disagreement','recovery-unverified'].includes(i.code)),false);assert.equal(view.rooms.find(room=>room.conversationId===f.rooms[first]).statusCurrentForAuthor,false);assert.equal(view.rooms.flatMap(room=>room.stateReports).filter(report=>report.currentForAuthor).length,1);
  }finally{await f.r.close();}
});

test('cross-chat state corrections and historical fix-ticket claims survive a durable reopen without replacing old evidence',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-state-correction-')),path=join(directory,'agent.sqlite');let f=await fixture('sqlite',{path});try{
    const id=await f.incident();for(const room of [0,1])await f.send(room,'operator','join '+id);await f.send(0,'alex','report recovered Initial health report.');for(let n=0;n<20&&await f.r.worker.runOnce();n++);const old=await f.r.casework.createPlan(id);
    await f.send(1,'alex','report blocked Correction: business validation failed.');for(let n=0;n<20&&await f.r.worker.runOnce();n++);const fresh=await f.r.casework.createPlan(id),before=await f.snapshot(id),events=await f.r.store.db.query('SELECT * FROM sre_events ORDER BY id');assert.notEqual(fresh.id,old.id);assert.match(fresh.markdown,/historical claim, responder updated elsewhere/);assert.equal(fresh.markdown.includes('Reported recovery is not independently verified'),false);assert.ok(fresh.payload.collaboration.some(room=>room.statusCurrentForAuthor===false));
    const model=boundedContext(await f.r.store.context(id));assert.ok(model.collaboration.rooms.some(room=>room.statusCurrentForAuthor===false));assert.ok(model.collaboration.rooms.flatMap(room=>room.stateReports).some(report=>report.currentForAuthor===false));
    await f.r.close();f=await fixture('sqlite',{path});assert.deepEqual((await f.snapshot(id)).rooms.map(room=>[room.statusCurrentForAuthor,room.stateReports]),before.rooms.map(room=>[room.statusCurrentForAuthor,room.stateReports]));assert.deepEqual(await f.r.store.db.query('SELECT * FROM sre_events ORDER BY id'),events);assert.equal((await f.r.casework.getPlan(old.id,id)).markdown,old.markdown);assert.equal((await f.r.casework.getPlan(fresh.id,id)).markdown,fresh.markdown);assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
  }finally{await f.r.close();await rm(directory,{recursive:true,force:true});}
});
