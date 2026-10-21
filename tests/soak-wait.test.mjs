import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForObservation} from '../scripts/soak-wait.mjs';

test('a suspended observer retains its gap and gives resumed recovery a bounded window',async()=>{
  let now=0,reads=0;const gaps=[];
  const result=await waitForObservation('recovery',async()=>++reads===4,{clock:()=>now,timeout:1000,maxGapMs:500,interval:100,onGap:gap=>gaps.push(gap),sleep:async()=>{now+=reads===1?16000:100;}});
  assert.equal(result,true);assert.equal(gaps.length,1);assert.equal(gaps[0].gapMs,16000);assert.equal(reads,4);
});
test('a genuinely stuck job still times out; repeated gaps and child exits cannot pass',async()=>{
  let now=0;
  await assert.rejects(()=>waitForObservation('stuck',async()=>false,{clock:()=>now,timeout:100,maxGapMs:1000,sleep:async()=>{now+=50;}}),/deadline/);
  await assert.rejects(()=>waitForObservation('repeated',async()=>false,{clock:()=>now,maxGapMs:100,sleep:async()=>{now+=1000;}}),/interrupted repeatedly/);
  await assert.rejects(()=>waitForObservation('dead',async()=>true,{alive:()=>false}),/Child terminated/);
});
test('suspension during an in-flight HTTP probe cannot turn its expired request into lost work',async()=>{
  let now=0,reads=0;const gaps=[];
  const value=await waitForObservation('restarted job',async()=>{if(++reads===1){now+=16000;throw Error('HTTP probe timed out while suspended');}return reads===3;},{clock:()=>now,timeout:1000,maxGapMs:500,onGap:gap=>gaps.push(gap),sleep:async()=>{now+=100;}});
  assert.equal(value,true);assert.equal(gaps.length,1);assert.equal(gaps[0].gapMs,16000);assert.equal(reads,3);
});
