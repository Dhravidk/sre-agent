import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {sqliteDatabase,postgresSql} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';

for(const dialect of ['sqlite','postgres'])test(dialect+': a Dynatrace log storm cannot evict the older GitLab comparison or either team report',async()=>{
  let db;
  if(dialect==='sqlite')db=sqliteDatabase(':memory:');
  else {const pg=new PGlite();db={dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const service=loadConfig({}).services[0];let now=Date.now()-20000;
  const store=await new SreStore(db,{services:[service],clock:()=>now}).initialize();
  try {
    const {incidentId}=await store.ingest({id:'noise-window',source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:'noise-window',status:'OPEN',at:now,payload:{problemId:'P-NOISE',metrics:{codes:['CREDIT_TIMEOUT']}}});
    await store.addEvidence(incidentId,'gitlab','release_diff',{provider:'gitlab',comparisonKind:'deployment',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),complete:true,unrecognizedPaths:[],policySources:{path:'src/auction/rules.mjs',complete:true,base:'old code',head:'new code'}});
    await store.addEvidence(incidentId,'teams-context','responder_update',{conversationId:'team-a',text:'Bidding plans traffic isolation.'});
    await store.addEvidence(incidentId,'teams-context','responder_update',{conversationId:'team-b',text:'Platform proposes rollback; no action executed.'});
    for(let i=0;i<110;i++){now++;await store.addEvidence(incidentId,'dynatrace','logs',{records:[{timestamp:new Date(now).toISOString(),content:'Repeated credit timeout',loglevel:'ERROR',region:'eu',requestId:'request-'+i}]});}
    const context=await store.context(incidentId);
    assert.ok(context.evidence.some(row=>row.source==='gitlab'&&row.kind==='release_diff'),'the older immutable code comparison must survive the noisy source window');
    assert.deepEqual(context.signalDigest.changes[0].paths,['src/auction/rules.mjs'],'legacy immutable source pairs must keep their known path in the digest');
    assert.equal(context.evidence.filter(row=>row.kind==='responder_update').length,2);
    assert.ok(context.evidence.length<=120);
    assert.ok((await db.query('SELECT COUNT(*) AS n FROM sre_evidence WHERE incident_id=?',[incidentId]))[0].n>=114,'raw evidence must remain retained');
  } finally {await db.close();}
});

test('the model byte budget reserves GitLab history even when large Dynatrace entries precede it',()=>{
  const now=Date.now(),context={incident:{id:'inc_noise',service_key:'auction-local',issue_key:'P-NOISE',started_at:now,source_states:'{}'},session:{agent_id:'agent_noise'},deployments:[],evidence:[]};
  for(let i=0;i<40;i++)context.evidence.push({id:'dt-'+i,source:'dynatrace',kind:'problem',observed_at:now,content:{details:'noise'.repeat(5000)}});
  context.evidence.push({id:'immutable-gitlab-comparison',source:'gitlab',kind:'release_diff',observed_at:now-10000,content:{provider:'gitlab',complete:true,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),policySources:{base:'source'.repeat(3000),head:'changed'.repeat(3000)}}});
  const bounded=boundedContext(context);
  assert.ok(bounded.evidence.some(row=>row.id==='immutable-gitlab-comparison'),'runtime volume must not consume the code-history byte budget');
});
