import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {prepareRestore} from '../src/sre/restore-recovery.mjs';

async function database(dialect){
  if(dialect==='sqlite')return sqliteDatabase(':memory:');const pg=new PGlite();
  return {dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};
}
for(const dialect of ['sqlite','postgres'])test(dialect+': model notices stay quiet across routine turns/restart while explicit batched questions retain selected replies',async()=>{
  const db=await database(dialect),service={key:'service',tenant:'tenant',environment:'evaluation',teams:{tenantId:'tenant',conversations:['one','two'],collaborationGroups:[{key:'fixture',name:'Fixture',conversations:[{id:'one',name:'One'},{id:'two',name:'Two'}]}]}};
  const options={services:[service],questionBatchLimit:8};let store=await new SreStore(db,options).initialize(),sequence=0;
  try{
    const id=(await store.ingest({id:'incident',source:'evaluation',serviceKey:service.key,kind:'problem',issueKey:'incident',status:'OPEN',at:Date.now(),payload:{}})).incidentId,rooms=[];
    for(const room of ['one','two']){const key=await store.rememberConversation({tenant:'tenant',serviceKey:service.key,reference:{serviceUrl:'https://delivery.invalid',conversation:{id:room}}});await store.bindConversation(key,id);rooms.push(key);}
    const enqueue=async(kind='responder_update',room=rooms[0])=>store.ingest({id:'input-'+sequence++,source:kind==='question'?'operator-api':'teams-context',serviceKey:service.key,incidentId:id,kind,at:Date.now(),payload:{text:'Scoped fixture request '+sequence},conversationKey:room});
    const publish=async(summary,text,selected=rooms.slice(0,1),changeAssessment='unknown')=>{const job=await store.claim('worker');assert.ok(job);const analysis={mode:'claude',summary,changeAssessment,text:'Full fixture assessment',teamsMessages:selected.map(roomKey=>({roomKey,text,evidenceIds:[]}))};await store.finish(job,analysis,null,Number((await store.context(id)).incident.revision));};
    const count=async()=>Number((await db.query('SELECT COUNT(*) AS count FROM sre_outbox'))[0].count);
    await publish('Stable assessment','Original notice');assert.equal(await count(),1);
    await enqueue();await publish('Stable assessment','Original notice');assert.equal(await count(),1);
    await enqueue();await publish('Stable assessment','A paraphrase without a changed assessment');assert.equal(await count(),1);
    await enqueue();await publish('New assessment detail','Original notice');assert.equal(await count(),1);
    await enqueue();await publish('A wording-only summary change','A wording-only notice change');assert.equal(await count(),1,'paraphrasing both fields cannot create a material update');
    await enqueue();await publish('Verified new finding','New useful notice',undefined,'likely');assert.equal(await count(),2);
    await enqueue();await publish('Another assessment','No message',[],'likely');
    store=await new SreStore(db,options).initialize();await enqueue();await publish('Another assessment','New useful notice',undefined,'likely');assert.equal(await count(),2,'an intervening empty selection/restart does not reset the last queued notice');
    await enqueue('question');await publish('Another assessment','New useful notice',undefined,'likely');assert.equal(await count(),3,'an actual selected answer may repeat for a new explicit question');
    await enqueue('question',rooms[0]);await enqueue('question',rooms[1]);await publish('Another assessment','New useful notice',rooms,'likely');assert.equal(await count(),5,'both rooms in the persisted request batch keep selected replies');
    await enqueue();await db.query('UPDATE sre_conversations SET enabled=0 WHERE id=?',[rooms[0]]);
    await assert.rejects(()=>publish('Another assessment','New useful notice'),/authorized|scope|disabled|access/);
    assert.equal(await count(),5,'suppression cannot bypass current destination authorization');
    const notices=await db.query("SELECT id,value FROM sre_checkpoints WHERE id LIKE 'agent-message-last:%' ORDER BY id");
    await prepareRestore(store,{restoreId:'model-notice-restore',backupSha256:'b'.repeat(64),backupAt:Date.now()-1000,reason:'Synthetic restore notice retention',actor:{kind:'local-operator',id:'fixture'},offline:true});
    assert.deepEqual(await db.query("SELECT id,value FROM sre_checkpoints WHERE id LIKE 'agent-message-last:%' ORDER BY id"),notices,'restore retains queued-notice uncertainty rather than rearming a broadcast');
  }finally{await db.close();}
});
