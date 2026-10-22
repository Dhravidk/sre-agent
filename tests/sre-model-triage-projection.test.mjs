import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedContext,modelContextLimits} from '../src/sre/model-context.mjs';
import {sustainedGroupSuite} from '../fixtures/sustained-group-incidents.mjs';
import {triageLogBatch} from '../src/sre/log-triage.mjs';

const at=Date.now();
function context(){
  const suite=sustainedGroupSuite({now:at,recordsPerService:6000}),batch=suite.profiles.values().next().value.batch,triage=triageLogBatch(batch);
  return {incident:{id:'projection',service_key:'scope',status:'open',started_at:at,source_states:'{}'},session:{},deployments:[],evidence:triage.groups.map((g,n)=>({id:'triage-'+n,source:'dynatrace',kind:'log_triage',observed_at:at,content:{derivedFrom:'raw-batch',hostDataReduction:true,complete:false,records:g.samples,triage:{...g,samples:undefined},coverage:triage.coverage,interpretation:triage.interpretation}}))};
}
function expanded(view,row){const {sharedBatchContext,...content}=row.content;return sharedBatchContext?{...content,...view.logTriageBatches[sharedBatchContext]}:content;}

test('shared batch limits preserve exact selected samples, rare operations and contrary release strata with fewer input bytes',()=>{
  const c=context(),view=boundedContext(c),byId=new Map(c.evidence.map(r=>[r.id,r]));
  assert.equal(view.evidence.length,c.evidence.length);assert.equal(Object.keys(view.logTriageBatches).length,1);
  for(const row of view.evidence){
    const expected=structuredClone(byId.get(row.id).content);
    // Original record indices/hashes are host bookkeeping. Every delivered
    // sample and all coverage/interpretation fields must still match exactly.
    delete expected.triage.sampleOrigins;
    assert.deepEqual(expanded(view,row),expected);
    assert.deepEqual(row.content.records,byId.get(row.id).content.records);
    assert.equal(Object.hasOwn(row.content.triage,'sampleOrigins'),false);
  }
  const original=Buffer.byteLength(JSON.stringify(c.evidence)),projected=Buffer.byteLength(JSON.stringify({evidence:view.evidence,batches:view.logTriageBatches}));
  assert.ok(original-projected>15000);assert.ok(Buffer.byteLength(JSON.stringify(view))<=modelContextLimits.totalBytes);
  assert.ok(view.evidence.every(r=>r.content.complete===false));
  assert.deepEqual(boundedContext(view).evidence,view.evidence);assert.deepEqual(boundedContext(view).logTriageBatches,view.logTriageBatches);
});

test('different coverage is never merged and dropped rows leave no dangling batch references',()=>{
  const c=context();c.evidence[1].content.coverage={...c.evidence[1].content.coverage,missingWindows:true,sourceComplete:false};
  const normal=boundedContext(c);assert.equal(Object.keys(normal.logTriageBatches).length,2);
  c.evidence.push(...Array.from({length:100},(_,n)=>({...c.evidence[0],id:'extra-'+n,content:{...c.evidence[0].content,derivedFrom:'raw-'+n,records:[{message:'x'.repeat(10000)}]}})));
  const view=boundedContext(c);assert.ok(view.coverage.included<c.evidence.length);
  for(const row of view.evidence)if(row.content.sharedBatchContext)assert.ok(view.logTriageBatches[row.content.sharedBatchContext]);
  for(const key of Object.keys(view.logTriageBatches))assert.ok(view.evidence.some(row=>row.content.sharedBatchContext===key));
  assert.ok(Buffer.byteLength(JSON.stringify(view.logTriageBatches))<=modelContextLimits.triageSharedBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(view))<=modelContextLimits.totalBytes);
});

test('missing shared context on a projected input remains unknown and never becomes complete coverage',()=>{
  const view=boundedContext(context());delete view.logTriageBatches;
  const next=boundedContext(view);
  for(const row of next.evidence){const content=expanded(next,row);assert.equal(content.sharedBatchContextUnavailable,true);assert.deepEqual(content.coverage,{unknown:true});assert.equal(content.complete,false);}
});
