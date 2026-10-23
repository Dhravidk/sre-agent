import test from 'node:test';
import assert from 'node:assert/strict';
import {readImmutableSource,sourceReadBudget,bindSourceEvidence} from '../src/sre/source-evidence.mjs';
const service={key:'reservation-boundary',environment:'testing',gitlab:{base:'https://fixture.invalid',project:'fixture/boundary',sourceInspection:{enabled:true}}},sha='a'.repeat(40);
function harness({bytes=40000,reply}={}){const budget=sourceReadBudget(),calls=[];budget.bytes=bytes;budget.initialReservation={reads:2,bytes:32000};const client={file:async(path,sha)=>{calls.push(path);return reply?reply(path,sha):{path,sha,complete:true,content:'x'.repeat(10000)};}};return{budget,calls,client,read:(path,extra={})=>readImmutableSource(path,sha,{service,client,budget,...extra})};}

test('a 10 KB file at the 40 KB/32 KB reservation boundary is readable after release, without a poisoned failure or wasted call',async()=>{
 const h=harness();const deferred=await h.read('helper.mjs');assert.equal(deferred.state,'unavailable');assert.equal(h.calls.length,0);assert.equal(h.budget.files.size,0);assert.equal(h.budget.reads,8);
 delete h.budget.initialReservation;const file=await h.read('helper.mjs');assert.equal(file.state,'available');assert.equal(file.content.length,10000);assert.equal(h.calls.length,1);assert.equal(h.budget.reads,7);assert.equal(h.budget.bytes,30000);
});

test('parallel accepted-byte pressure does not cache a reservation-only failure or refund its attempted read',async()=>{
 const releases=[],h=harness({bytes:50000,reply:async(path,sha)=>{await new Promise(resolve=>releases.push(resolve));return{path,sha,complete:true,content:'x'.repeat(10000)};}});
 const first=h.read('first.mjs'),second=h.read('second.mjs');assert.equal(h.calls.length,2);releases[0]();assert.equal((await first).state,'available');releases[1]();assert.equal((await second).state,'unavailable');assert.equal(h.budget.reads,6);assert.equal(h.budget.files.size,1);
 delete h.budget.initialReservation;const later=h.read('second.mjs');assert.equal(h.calls.length,3);releases[2]();assert.equal((await later).state,'available');assert.equal(h.budget.reads,5);assert.equal(h.budget.bytes,30000);
});

for(const [name,reply,bytes]of [['denied',()=>{throw Error('403 denied');},64000],['wrong-ref',(path)=>({path,sha:'b'.repeat(40),complete:true,content:'x'}),64000],['absolute-cap',(path,sha)=>({path,sha,complete:true,content:'x'.repeat(17000)}),64000]])test(name+' remains unavailable and cached after a reservation is removed',async()=>{
 const h=harness({bytes,reply});assert.equal((await h.read('helper.mjs')).state,'unavailable');assert.equal(h.calls.length,1);delete h.budget.initialReservation;assert.equal((await h.read('helper.mjs')).state,'unavailable');assert.equal(h.calls.length,1);assert.equal(h.budget.reads,7);
});

test('a source arriving after cancellation cannot be accepted or recast as a retryable reservation failure',async()=>{
 let release;const h=harness({bytes:64000,reply:async(path,sha)=>{await new Promise(resolve=>release=resolve);return{path,sha,complete:true,content:'x'.repeat(10000)};}}),controller=new AbortController(),pending=h.read('helper.mjs',{signal:controller.signal});controller.abort(Error('cancelled source'));release();await assert.rejects(pending,/cancelled source/);assert.equal(h.budget.bytes,64000);assert.equal(h.budget.reads,7);
});

test('untrusted location hints cannot displace every safe immutable comparison frame',async()=>{
 const calls=[],files=['src/entry.mjs','src/other.mjs','src/third.mjs'].map(new_path=>({new_path,diff:'@@ -1 +1 @@\n-old\n+new'}));
 const proof=await bindSourceEvidence({provider:'gitlab',baseSha:'b'.repeat(40),headSha:sha,data:{diffs:files},complete:true,retainComparisonAnchor:true,priorityReferences:Array.from({length:40},(_,n)=>({path:'generated/noise-'+n+'.mjs',line:1})),client:{file:async(path,sha)=>{calls.push(path);return{path,sha,complete:true,content:'export const value=1;\n'};}}});
 assert.equal(calls[0],'src/entry.mjs');assert.equal(calls.length,4);assert.ok(proof.sourceFiles.some(file=>file.path==='src/entry.mjs'&&file.sha===sha));assert.equal(proof.sourceCoverage.referencedOutsideComparison,2);
});
