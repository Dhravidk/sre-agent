import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateConfig} from '../src/sre/config.mjs';
import {createSreRuntime} from '../src/sre/server.mjs';
import {rehearsalProfile,seedRehearsal,settleRehearsal} from '../fixtures/sre-rehearsal.mjs';
import {hash} from '../src/sre/security.mjs';

async function fixture(path=':memory:'){
  const config=validateConfig(rehearsalProfile(),{SRE_SQLITE_PATH:path,SRE_CLAUDE_BIN:'/nonexistent-rehearsal-test'});
  return createSreRuntime({config,autoStart:false,sender:{send:async()=>({id:'fixture-delivery',simulation:true})}});
}
async function retained(runtime){
  const result={};for(const table of ['sre_events','sre_incidents','sre_sessions','sre_conversations','sre_fix_plans','sre_fix_requests','sre_outbox','sre_coordination_receipts'])result[table]=(await runtime.store.db.query('SELECT * FROM '+table)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));return result;
}

test('the multi-team rehearsal detects before people, retains quiet workers and conflicts, and isolates the second issue',async()=>{
  const r=await fixture();try{
    const state=await seedRehearsal(r),primary=await r.store.context(state.primaryId),other=await r.store.context(state.providerId);
    assert.equal((await r.store.snapshot()).incidents.length,3,'Two operational incidents and one explicitly separate MR risk review');
    const [firstHuman]=await r.store.db.query("SELECT received_at FROM sre_events WHERE source='teams' ORDER BY received_at LIMIT 1");
    const [detected]=await r.store.db.query("SELECT received_at FROM sre_events WHERE source='log-monitor' ORDER BY received_at LIMIT 1");
    assert.ok(Number(detected.received_at)<=Number(firstHuman.received_at));assert.match(primary.incident.issue_key,/^log-monitor:/);
    assert.equal(primary.collaboration.rooms.length,3);assert.equal(other.collaboration.rooms.length,2);
    assert.ok(primary.collaboration.issues.some(i=>/different service states/i.test(i.text)));assert.ok(primary.collaboration.issues.some(i=>/duplicate work/i.test(i.text)));assert.ok(primary.collaboration.issues.some(i=>/different active theories/i.test(i.text)));
    assert.ok(primary.collaboration.rooms.some(room=>room.reports.some(report=>report.author.startsWith('sam')&&report.text.includes('Quiet worker'))));
    const drawing=primary.evidence.find(e=>e.content.unreadAttachments?.length);assert.equal(drawing.content.unreadAttachments[0].contentRead,false);assert.equal(drawing.content.unreadAttachments[0].contentUrl,undefined);
    assert.equal(primary.signalDigest.groups.find(g=>g.code==='WINNING_BID_REGRESSED').observations,3);assert.equal(primary.signalDigest.groups.find(g=>g.statusCode==='200').observations,180);
    assert.ok(primary.incident.analysis.codeReview.findings.some(f=>f.signal==='WINNING_BID_REGRESSED'));assert.equal(primary.incident.status,'open');
    assert.equal(other.incident.analysis.changeAssessment,'unlikely');assert.equal(other.incident.analysis.rollback.eligible,false);assert.equal(other.signalDigest.groups[0].region,'us-east-1');
    assert.equal(other.evidence.filter(e=>e.source==='teams-context').some(e=>e.content.text.includes('eu-bid-42')),false);
    const plan=await r.casework.getPlan(state.planId,state.primaryId);assert.equal(plan.payload.patch.field,'checkVersion');assert.match(plan.markdown,/Avery Chen/);assert.match(plan.markdown,/HTTP health probe/);
    assert.equal((await r.casework.snapshot(state.primaryId)).qa.length,0);assert.equal((await r.store.snapshot()).rollbacks.length,0);
  }finally{await r.close();}
});

test('a partially seeded rehearsal resumes after reconstruction without duplicate incident identities or chat messages',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-rehearsal-partial-')),path=join(directory,'agent.sqlite');let r=await fixture(path);
  try{
    const accept=r.router.accept.bind(r.router);let calls=0;r.router.accept=async(...args)=>{if(++calls===4)throw Error('Injected process interruption');return accept(...args);};
    await assert.rejects(()=>seedRehearsal(r),/Injected process interruption/);await r.close();r=await fixture(path);
    const state=await seedRehearsal(r);await settleRehearsal(r);assert.equal(state.phase,'ready');assert.equal((await r.store.snapshot()).incidents.length,3);
    const chat=await r.store.db.query("SELECT external_id FROM sre_events WHERE source='teams'");assert.equal(chat.length,17);assert.equal(new Set(chat.map(row=>row.external_id)).size,17);
    assert.equal((await r.store.context(state.primaryId)).collaboration.rooms.length,3);assert.equal((await r.store.context(state.providerId)).collaboration.rooms.length,2);
  }finally{await r.close();await rm(directory,{recursive:true,force:true});}
});

test('reopening a completed rehearsal preserves user history instead of reseeding it',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-rehearsal-ready-')),path=join(directory,'agent.sqlite');let r=await fixture(path);
  try{
    const state=await seedRehearsal(r),before=await retained(r);await r.close();r=await fixture(path);
    assert.deepEqual(await seedRehearsal(r),state);assert.deepEqual(await retained(r),before);
    // A changed mapping must not silently move persisted discussion to another service.
    r.config.services[0].teams.conversations[0]='foreign';await assert.rejects(()=>seedRehearsal(r),/profile changed/);
  }finally{await r.close();await rm(directory,{recursive:true,force:true});}
});

test('foreign histories, corrupted checkpoints and mismatched ready identities are rejected without reseeding',async()=>{
  const r=await fixture();try{
    await r.store.ingest({id:'foreign',source:'operator-api',serviceKey:r.config.services[0].key,kind:'problem',issueKey:'foreign',status:'OPEN',at:Date.now()-1000,payload:{}});
    await assert.rejects(()=>seedRehearsal(r),/dedicated empty/);assert.equal((await r.store.snapshot()).incidents.length,1);
  }finally{await r.close();}
  const c=await fixture();try{
    const state=await seedRehearsal(c),id='rehearsal:multi-team:v1',before=await retained(c);
    await c.store.db.query('UPDATE sre_checkpoints SET value=? WHERE id=?',['{}',id]);await assert.rejects(()=>seedRehearsal(c),{code:'SRE_STORAGE_UNAVAILABLE'});assert.deepEqual(await retained(c),before);
    const missing={...state,providerId:'inc_'+'a'.repeat(20)};await c.store.db.query('UPDATE sre_checkpoints SET value=? WHERE id=?',[JSON.stringify({...missing,checksum:hash(missing)}),id]);
    await assert.rejects(()=>seedRehearsal(c),{code:'SRE_STORAGE_UNAVAILABLE'});assert.deepEqual(await retained(c),before);
    c.config.agentMode='claude';await assert.rejects(()=>seedRehearsal(c),/offline rules/);
  }finally{await c.close();}
});
