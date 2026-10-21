import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';

async function database(dialect){
  if(dialect==='sqlite')return sqliteDatabase(':memory:');
  const pg=new PGlite();
  return {dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': quiet groups beyond 128 older hot-group jobs enter the next bounded batches',async()=>{
    const db=await database(dialect),store=await new SreStore(db,{questionBatchLimit:8}).initialize(),at=await store.coordinationNow();
    try{
      const id=(await store.ingest({id:'busy',source:'evaluation',serviceKey:'service',kind:'problem',issueKey:'busy',status:'OPEN',at,payload:{}})).incidentId;
      const question=async(n,room)=>store.ingest({id:'q-'+n,source:'operator-api',serviceKey:'service',incidentId:id,kind:'question',at,payload:{text:'Question '+n},conversationKey:room});
      for(let n=0;n<160;n++)await question(n,'hot-group');
      for(let n=0;n<31;n++)await question(160+n,'quiet-'+String(n).padStart(2,'0'));
      const finish=async job=>store.finish(job,{summary:'Queue regression only',text:'Synthetic queue check',mode:'claude',teamsMessages:[]},null,Number((await store.context(id)).incident.revision));
      const seen=new Set();
      for(let turn=0;turn<5;turn++){
        const job=await store.claim('worker'),requests=job.payload.requests||[{question:job.payload.question,conversationKey:job.payload.conversationKey}];
        assert.ok(requests.length<=8);
        const quiet=requests.filter(r=>r.conversationKey.startsWith('quiet-'));
        if(turn===0)assert.equal(quiet.length,7,'older hot-group jobs must not hide every quiet group');
        for(const request of quiet)seen.add(request.conversationKey);
        await finish(job);
        // Continued hot arrivals must not reset the quiet groups' service order.
        for(let n=0;n<12;n++)await question(200+turn*12+n,'hot-group');
      }
      assert.equal(seen.size,31,'every quiet group gets a turn within five bounded batches');
      const [count]=await db.query("SELECT COUNT(*) AS count FROM sre_events WHERE kind='question'");assert.equal(Number(count.count),251);
      const served=await db.query("SELECT id,value FROM sre_checkpoints WHERE id LIKE 'agent-room-scheduled:%'");assert.equal(served.length,32);
    }finally{await db.close();}
  });

  test(dialect+': a question turn absorbs eligible updates and retains deferred work and reply obligations',async()=>{
    const rooms=['hot','quiet-0','quiet-1','quiet-2'],service={key:'service',environment:'evaluation',teams:{tenantId:'evaluation',conversations:rooms,collaborationGroups:[{key:'shared',name:'Shared fixture',conversations:rooms.map(id=>({id,name:id}))}]}};
    const db=await database(dialect),store=await new SreStore(db,{questionBatchLimit:8,services:[service]}).initialize(),at=await store.coordinationNow();
    try{
      const id=(await store.ingest({id:'incident',source:'evaluation',serviceKey:'service',kind:'problem',issueKey:'incident',status:'OPEN',at,payload:{}})).incidentId;
      const keys={};for(const room of rooms){keys[room]=await store.rememberConversation({tenant:'evaluation',serviceKey:'service',reference:{serviceUrl:'https://delivery.invalid',conversation:{id:room}}});await store.bindConversation(keys[room],id);}
      const [initial]=await db.query('SELECT id,payload FROM sre_jobs WHERE incident_id=?',[id]);await db.query('UPDATE sre_jobs SET payload=? WHERE id=?',[JSON.stringify({...JSON.parse(initial.payload),replyConversationKey:keys['quiet-2']}),initial.id]);
      for(let n=0;n<16;n++)await store.ingest({id:'update-'+n,source:'teams-context',serviceKey:'service',incidentId:id,kind:'responder_update',at,payload:{text:'Routine update '+n},conversationKey:keys.hot});
      for(let n=0;n<3;n++)await store.ingest({id:'question-'+n,source:'operator-api',serviceKey:'service',incidentId:id,kind:'question',at,payload:{text:'Explicit request '+n},conversationKey:keys['quiet-'+n]});
      await store.ingest({id:'deferred',source:'teams-context',serviceKey:'service',incidentId:id,kind:'responder_update',at,payload:{text:'A read must wait'},conversationKey:keys.hot});
      await db.query("UPDATE sre_jobs SET next_at=? WHERE payload LIKE ?",[at+3600000,'%'+(await db.query("SELECT id FROM sre_events WHERE external_id='deferred'"))[0].id+'%']);
      const job=await store.claim('worker');assert.ok(job.payload.question);assert.equal(job.payload.requests.length,3);
      assert.deepEqual(job.payload.replyConversationKeys,[keys['quiet-2']]);
      const pending=await db.query("SELECT payload FROM sre_jobs WHERE status='pending'");assert.equal(pending.length,1,'only the deferred update remains pending');
      assert.equal((await db.query("SELECT COUNT(*) AS count FROM sre_events"))[0].count,21);
      await store.finish(job,{mode:'claude',summary:'Question and fresh updates reviewed',text:'Synthetic queue test',teamsMessages:[]},null,Number((await store.context(id)).incident.revision));
      assert.equal(await store.claim('worker'),null);
      assert.equal((await store.context(id)).assessmentStatus.state,'current');
    }finally{await db.close();}
  });

  test(dialect+': batching preserves retry deadlines and the persisted batch across retry',async()=>{
    const db=await database(dialect),store=await new SreStore(db,{questionBatchLimit:8}).initialize(),at=await store.coordinationNow();
    try{
      const id=(await store.ingest({id:'incident',source:'evaluation',serviceKey:'service',kind:'problem',issueKey:'incident',status:'OPEN',at,payload:{}})).incidentId;
      const finish=async job=>store.finish(job,{summary:'Queue only',text:'Queue only',mode:'claude',teamsMessages:[]},null,Number((await store.context(id)).incident.revision));
      await finish(await store.claim('worker'));
      for(const [n,room]of ['hot','quiet','deferred'].entries())await store.ingest({id:'q-'+n,source:'operator-api',serviceKey:'service',incidentId:id,kind:'question',at,payload:{text:'Question '+n},conversationKey:room});
      await db.query("UPDATE sre_jobs SET next_at=? WHERE payload LIKE ?",[at+3600000,'%deferred%']);
      let job=await store.claim('worker');assert.deepEqual(new Set(job.payload.requests.map(r=>r.conversationKey)),new Set(['hot','quiet']));
      const batch=job.payload.requests;await store.fail(job,Error('Transient provider error'));
      await db.query('UPDATE sre_jobs SET next_at=0 WHERE id=?',[job.id]);
      job=await store.claim('worker');assert.deepEqual(job.payload.requests,batch);await finish(job);
      assert.equal(await store.claim('worker'),null,'a future retry deadline cannot be consumed early');
      const [pending]=await db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status='pending'");assert.equal(Number(pending.count),1);
    }finally{await db.close();}
  });
}
