import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {claudeSchema} from '../src/sre/claude-reasoner.mjs';
import {fixtureRisk,validateRisk} from '../src/sre/analytic-risk.mjs';
import {OperationalMonitor} from '../src/sre/operations.mjs';
import {investigationTimeBudgetMs} from '../src/sre/investigation-budget.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {loadConfig} from '../src/sre/config.mjs';

const context=()=>({incident:{id:'review',service_key:'review',started_at:1,status:'open'},riskScope:{stage:'incident',environment:'test'},evidence:[{id:'complete',source:'source',kind:'problem',observed_at:1,content:{complete:true,text:'Complete delivered observation.'}}],deployments:[]});
const high=c=>({...fixtureRisk(c),likelihood:'likely',confidence:'high'});
for(const [name,change]of [
 ['candidate window',c=>c.evidenceWindow={candidatesLimited:true,totalAvailable:100}],
 ['byte window',c=>c.evidence=Array.from({length:40},(_,n)=>({...c.evidence[0],id:'row-'+n,content:{complete:true,text:'x'.repeat(6000)}}))],
 ['metadata window',c=>c.incident.title='x'.repeat(8000)],
 ['deployment window',c=>c.deployments=Array.from({length:30},(_,n)=>({id:String(n),sha:n.toString(16).padStart(40,'0'),at:0}))],
 ['unscanned digest',c=>c.signalDigest={coverage:{recordsNotScanned:5},groups:[],changes:[],deployments:[]}]
])test('generation and host confidence reject known omissions in the '+name+' even when retained rows are complete',()=>{
 const c=context();change(c);const snapshot=boundedContext(c);assert.ok(snapshot.evidence.every(e=>e.content.complete===true));assert.deepEqual(claudeSchema(snapshot).properties.risk.properties.confidence.enum,['low','moderate']);assert.throws(()=>validateRisk(high(snapshot),{...snapshot,riskScope:c.riskScope}),/High confidence/);
 assert.equal(validateRisk({...high(snapshot),confidence:'moderate'},{...snapshot,riskScope:c.riskScope}).confidence,'moderate');
});
test('complete delivered coverage retains the existing high-confidence contract',()=>{const c=boundedContext(context());assert.deepEqual(claudeSchema(c).properties.risk.properties.confidence.enum,['low','moderate','high']);assert.equal(validateRisk(high(c),c).confidence,'high');});

for(const timeoutMs of [180000,300000])test('monitor tick covers the full '+timeoutMs+'ms model budget while other lanes keep their own limits',async()=>{
 const config=loadConfig({SRE_SQLITE_PATH:':memory:'});let now=Date.now();const store=await new SreStore(sqliteDatabase(':memory:'),{services:config.services,clock:()=>now}).initialize(),budget=investigationTimeBudgetMs({mode:'claude',options:{timeoutMs}}),monitor=new OperationalMonitor({store,config,schedulerEnabled:false,investigationBudgetMs:budget});
 try{monitor.begin('tick');monitor.begin('commands');now+=180001;let report=await monitor.snapshot();assert.ok(!report.conditions.some(c=>c.key==='loop:tick'));assert.ok(report.conditions.some(c=>c.key==='loop:commands'&&c.code==='loop_stalled'));
 now=monitor.startedAt+budget+9999;assert.ok(!(await monitor.snapshot()).conditions.some(c=>c.key==='loop:tick'));
 now+=2;assert.ok((await monitor.snapshot()).conditions.some(c=>c.key==='loop:tick'&&c.code==='loop_stalled'));monitor.end('tick');assert.ok(!(await monitor.snapshot()).conditions.some(c=>c.key==='loop:tick'));
 }finally{await store.db.close();}
});
test('runtime supplies the actual model budget and preserves a larger configured tick threshold',async()=>{
 const config=loadConfig({SRE_SQLITE_PATH:':memory:'});config.operations={maxTickDurationSeconds:500};const runtime=await createSreRuntime({config,autoStart:false,reasoner:{mode:'claude',options:{timeoutMs:300000},investigate:()=>{throw Error('No model call expected');}}});
 try{assert.equal(runtime.operations.tickLimitMs,500000);}finally{await runtime.close();}
 const normal=await createSreRuntime({config:loadConfig({SRE_SQLITE_PATH:':memory:'}),autoStart:false,reasoner:{mode:'codex',options:{timeoutMs:300000}}});try{assert.equal(normal.operations.tickLimitMs,370000);}finally{await normal.close();}
});

async function database(dialect){if(dialect==='sqlite')return sqliteDatabase(':memory:');const pg=new PGlite();return {dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
for(const dialect of ['sqlite','postgres'])for(const selected of [0,4])test(dialect+': all eight direct rooms get one scoped answer with '+selected+' model selections, and restart cannot duplicate them',async()=>{
 const db=await database(dialect),service={key:'review',tenant:'tenant',environment:'test',teams:{tenantId:'tenant',conversations:Array.from({length:8},(_,n)=>'room-'+n),collaborationGroups:[{key:'review',conversations:Array.from({length:8},(_,n)=>({id:'room-'+n,name:'Room '+n}))}]}},options={services:[service],questionBatchLimit:8};let store=await new SreStore(db,options).initialize();
 try{const {incidentId}=await store.ingest({id:'incident',source:'evaluation',serviceKey:service.key,kind:'problem',issueKey:'incident',status:'OPEN',at:Date.now(),payload:{}}),rooms=[];
 for(const id of service.teams.conversations){const key=await store.rememberConversation({tenant:'tenant',serviceKey:service.key,reference:{serviceUrl:'https://delivery.invalid',conversation:{id}}});await store.bindConversation(key,incidentId);rooms.push(key);}
 const enqueue=async prefix=>{for(const [n,room]of rooms.entries()){const message={id:prefix+n,source:'teams-question',serviceKey:service.key,incidentId,kind:'question',at:Date.now(),conversationKey:room,payload:{text:'Question from room '+n}};await store.ingest(message);assert.equal((await store.ingest(message)).duplicate,true);}};
 await enqueue('q-');let job=await store.claim('review');assert.equal(job.payload.requests.length,8);const revision=Number((await store.context(incidentId)).incident.revision),analysis={mode:'claude',summary:'Shared answer',text:'Full combined answer',teamsMessages:rooms.slice(0,selected).map(roomKey=>({roomKey,text:'Selected answer',evidenceIds:[]}))};await store.finish(job,analysis,null,revision,{text:'Bounded combined assessment'});
 const outbox=await db.query('SELECT id,conversation_key,text,status FROM sre_outbox ORDER BY id');assert.equal(outbox.length,8);assert.equal(new Set(outbox.map(o=>o.conversation_key)).size,8);assert.ok(outbox.every(o=>o.status==='pending'));assert.equal(outbox.filter(o=>o.text==='Selected answer').length,selected);assert.equal(outbox.filter(o=>o.text===analysis.text).length,8-selected,'direct fallbacks retain the full source, remediation and issue specification rather than the proactive brief');
 store=await new SreStore(db,options).initialize();assert.equal(await store.claim('reopened'),null);assert.deepEqual(await db.query('SELECT id,conversation_key,text,status FROM sre_outbox ORDER BY id'),outbox);
 await enqueue('revoked-');job=await store.claim('review');const before=Number((await store.context(incidentId)).incident.revision);await db.query('UPDATE sre_conversations SET enabled=0 WHERE id=?',[rooms[7]]);
 await assert.rejects(()=>store.finish(job,{...analysis,teamsMessages:[]},null,before,{text:'Must not escape scope'}),/authorized|scope|disabled|access/);assert.deepEqual(await db.query('SELECT id,conversation_key,text,status FROM sre_outbox ORDER BY id'),outbox);assert.equal((await db.query('SELECT status FROM sre_jobs WHERE id=?',[job.id]))[0].status,'running');
 }finally{await db.close();}
});
