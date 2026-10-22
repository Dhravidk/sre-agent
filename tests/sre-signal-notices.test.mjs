import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {incidentScopeFixture} from '../fixtures/sre-incident-scope.mjs';
import {assessmentBrief,assessmentBriefLimits} from '../src/sre/assessment-brief.mjs';

async function review(f){await f.question();await f.settle();await f.deliver();}
async function stable(dialect,options){const f=await incidentScopeFixture(dialect,options);await f.foreign();await review(f);f.sent.length=0;return f;}
async function sample(f,{code='EU_CHECKSUM_MISMATCH',extra={},complete=true,at}={}){
 at??=await f.r.store.coordinationNow();return f.r.store.addEvidence(f.state.primaryId,'dynatrace','logs',{records:[{timestamp:at,level:'ERROR',code,environment:f.service.environment,region:'eu-west-1',sha:f.state.badSha,message:'A distinct EU checksum check needs request comparison.',...extra}],complete},at);
}
const briefs=f=>f.sent.filter(m=>m.text.startsWith('Incident brief'));
for(const dialect of ['sqlite','postgres']){
 test(dialect+': a new failure sample informs both peers even when summary, cause and uncertainty text are unchanged; repeats stay quiet',async()=>{
  const f=await stable(dialect);try{
   const before=(await f.r.store.context(f.state.primaryId)).incident.analysis;await sample(f);await review(f);const after=(await f.r.store.context(f.state.primaryId)).incident.analysis;
   assert.equal(after.summary,before.summary);assert.equal(after.changeAssessment,'unknown');assert.deepEqual(after.unknowns,before.unknowns);
   for(const room of f.state.primaryRooms.slice(0,2))assert.ok(briefs(f).some(m=>m.room===room&&m.text.includes('EU_CHECKSUM_MISMATCH')));
   assert.equal(after.observedSignals?.version,1);assert.ok(after.observedSignalChanges?.keys?.length);f.sent.length=0;
   await sample(f,{extra:{requestId:'different-request-123'},at:await f.r.store.coordinationNow()+1});await review(f);assert.equal(briefs(f).length,0,'counts, times and explicit correlation IDs must not rebroadcast an unchanged sample family');
   assert.equal((await f.r.store.snapshot()).rollbacks.length,0);
  }finally{await f.close();}
 });
 test(dialect+': a new pattern outside the old three-sample brief window is shown first in the peer update',async()=>{
  const f=await stable(dialect);try{
   const now=await f.r.store.coordinationNow();for(let n=0;n<4;n++)await sample(f,{code:'EXISTING_EU_PATTERN_'+n,at:now-100-n});await review(f);f.sent.length=0;
   await sample(f,{code:'NEW_QUIET_EU_PATTERN',at:now-1000});const c=await f.r.store.context(f.state.primaryId);assert.ok(!c.signalDigest.groups.slice(0,3).some(g=>g.code==='NEW_QUIET_EU_PATTERN'));await review(f);
   for(const room of f.state.primaryRooms.slice(0,2)){const message=briefs(f).find(m=>m.room===room);assert.ok(message);assert.ok(message.text.includes('NEW_QUIET_EU_PATTERN'));assert.ok(message.text.includes('New or newly ambiguous failure samples appear first.'));assert.ok(Buffer.byteLength(message.text)<=11000);}
  }finally{await f.close();}
 });
 test(dialect+': newly ambiguous scope metadata reaches peers without treating a responder claim as cause or recovery',async()=>{
  const f=await stable(dialect);try{
   await sample(f,{extra:{'cloud.region':'eu-west-1'}});await review(f);const before=(await f.r.store.context(f.state.primaryId)).incident.analysis;f.sent.length=0;
   await sample(f,{extra:{'cloud.region':'eu-west-1',region:'us-east-1'},at:await f.r.store.coordinationNow()+1});await review(f);const after=(await f.r.store.context(f.state.primaryId)).incident.analysis;
   assert.equal(after.changeAssessment,'unknown');assert.equal(after.summary,before.summary);for(const room of f.state.primaryRooms.slice(0,2)){const m=briefs(f).find(m=>m.room===room);assert.ok(m);assert.match(m.text,/EU_CHECKSUM_MISMATCH/);assert.match(m.text,/unknown reported scope/);}assert.ok(after.observedSignalChanges?.keys?.length);
  }finally{await f.close();}
 });
 test(dialect+': coverage state is retained but changing partial-page counts alone does not notify peers again',async()=>{
  const f=await stable(dialect);try{
   await sample(f,{complete:false});await review(f);let a=(await f.r.store.context(f.state.primaryId)).incident.analysis;assert.equal(a.observedSignals?.coverage.partial,true);assert.ok(briefs(f).length);f.sent.length=0;
   await sample(f,{complete:false,at:await f.r.store.coordinationNow()+1});await review(f);a=(await f.r.store.context(f.state.primaryId)).incident.analysis;assert.equal(a.observedSignals.coverage.partial,true);assert.equal(briefs(f).length,0);
  }finally{await f.close();}
 });
 test(dialect+': model-supplied signal descriptors cannot manufacture host observation changes',async()=>{
  const f=await stable(dialect),original=f.r.worker.reasoner.investigate.bind(f.r.worker.reasoner);try{
   f.r.worker.reasoner.investigate=async(...args)=>{const result=await original(...args);result.analysis.observedSignals={version:99,failures:[{key:'f'.repeat(64)}]};result.analysis.observedSignalChanges={keys:['f'.repeat(64)]};return result;};
   await review(f);const a=(await f.r.store.context(f.state.primaryId)).incident.analysis;assert.equal(a.observedSignals?.version,1);assert.ok(!a.observedSignals.failures.some(g=>g.key==='f'.repeat(64)));assert.deepEqual(a.observedSignalChanges.keys,[]);assert.equal(briefs(f).length,0);
  }finally{await f.close();}
 });
}

test('the stable signal notice survives reopen so a repeated question does not re-notify joined groups',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sre-signal-notice-')),f=await stable('sqlite',{path:join(dir,'agent.sqlite')});try{
  await sample(f);await review(f);const before=(await f.r.store.context(f.state.primaryId)).incident.analysis.observedSignals;assert.equal(before?.version,1);f.sent.length=0;await f.restart();assert.deepEqual((await f.r.store.context(f.state.primaryId)).incident.analysis.observedSignals,before);await review(f);assert.equal(briefs(f).length,0);
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});

test('prioritizing a new sample keeps the Unicode brief bounded and does not mutate source ordering',()=>{
 const text='🧪故障'.repeat(1600),groups=Array.from({length:12},(_,n)=>({key:n.toString(16).padStart(64,'0'),level:'ERROR',code:n===11?'NEW_CRITICAL_SAMPLE':'OLD_PATTERN_'+n,message:text,environment:text,region:text,version:'b'.repeat(40),observations:200})),analysis={mode:'rules',summary:text,changeAssessment:'unknown',risk:{likelihood:'unknown',confidence:'low',assumptions:[text],alternatives:[text]},hypotheses:[text],unknowns:Array(20).fill(text),nextSteps:[text],rollback:{eligible:false,reasons:[text]},observedSignalChanges:{keys:[groups[11].key]},codeReview:{findings:[]}};
 const context={incident:{id:'inc_'+ 'a'.repeat(20),revision:17,status:'open'},assessmentStatus:{state:'current'},signalDigest:{groups,coverage:{recordsScanned:2000,candidateWindowLimited:true}},collaboration:{issues:[{code:'unaccepted-handoff',text:'Name a receiver for the accepted-bid replay.'}]}},before=JSON.stringify({context,analysis}),brief=assessmentBrief(context,analysis);
 assert.ok(brief.includes('NEW_CRITICAL_SAMPLE'));assert.ok(Buffer.byteLength(brief)<=assessmentBriefLimits.bytes);assert.equal(JSON.stringify({context,analysis}),before);
});
