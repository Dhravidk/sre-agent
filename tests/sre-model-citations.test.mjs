import test from 'node:test';
import assert from 'node:assert/strict';
import {citationTransport,investigationInvocationInput} from '../src/sre/model-citations.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {investigationCase} from '../fixtures/agent-investigations.mjs';

function snapshot(){
  const view=boundedContext(investigationCase().context);
  for(const [n,row]of view.evidence.entries())row.id=(n+1).toString(16).padStart(64,'0');
  return view;
}

test('repeated question transport is lossless across rooms, conflicting requests and Unicode without mutating durable batches',()=>{
  const question='Review scoped logs and exact source; '+ '界 🔎 \\ \" '.repeat(40),requests=Array.from({length:32},(_,n)=>({jobId:'job-'+n,conversationKey:'room-'+n,question:n===17?'Do not roll back; investigate the dependency':question})),original=structuredClone(requests),view=snapshot();
  const invocation=investigationInvocationInput(view,{question,requests}),input=JSON.parse(invocation.input);
  const expanded=input.requestBatch.map(({questionRef,...request})=>questionRef===undefined?request:{...request,question:input.questionTexts[questionRef]});
  assert.deepEqual(expanded,requests);assert.deepEqual(requests,original);assert.equal(input.request,question);
  assert.equal(input.questionTexts.length,1);assert.equal(input.requestBatch[17].question,requests[17].question);
  assert.ok(Buffer.byteLength(JSON.stringify({questionTexts:input.questionTexts,requestBatch:input.requestBatch}))<Buffer.byteLength(JSON.stringify({requestBatch:requests}))/2);
  assert.deepEqual(input.incident,invocation.wire);
});

test('unique and short questions retain ordinary transport when a dictionary would increase input bytes',()=>{
  for(const requests of [undefined,[{jobId:'one',question:'x'}],[{jobId:'one',question:'x'},{jobId:'two',question:'x'}],[{jobId:'one',question:'first'},{jobId:'two',question:'second'}]]){
    const input=JSON.parse(investigationInvocationInput(snapshot(),{requests}).input);
    assert.equal(input.questionTexts,undefined);assert.deepEqual(input.requestBatch,requests);
  }
});

test('short citation references preserve source bytes and canonicalize every supported result field before validation',()=>{
  const view=snapshot(),original=structuredClone(view),id=view.evidence[0].id;
  view.responderContext.evidenceIds=[id];view.signalDigest={groups:[{evidenceIds:[id]}],changes:[{evidenceId:id}]};
  view.collaboration={rooms:[{key:'room',statusEvidenceId:id,reports:[{evidenceId:id}]}]};
  const {wire,restore,bindings}=citationTransport(view),alias=wire.evidence[0].id;
  assert.ok(alias.length<id.length);assert.equal(bindings[alias],id);assert.notEqual(alias,id);
  assert.deepEqual(wire.evidence.map(e=>e.content),original.evidence.map(e=>e.content));
  assert.deepEqual(wire.responderContext.evidenceIds,[alias]);assert.equal(wire.signalDigest.changes[0].evidenceId,alias);assert.equal(wire.collaboration.rooms[0].reports[0].evidenceId,alias);
  const data={summary:'Supported by '+alias+'.',evidenceIds:[alias],risk:{contraryEvidenceIds:[alias],sourceQuality:[{evidenceId:alias,limitations:'Bounded sample.'}]},codeFindings:[{evidenceId:alias,path:'src/'+alias+'.mjs',sha:'a'.repeat(40),corroboratingEvidenceIds:[alias]}],remediation:{evidenceIds:[alias],rationale:'Review '+alias},issueSpec:{evidenceIds:[alias]},teamsMessages:[{roomKey:alias,text:'Review '+alias,evidenceIds:[alias]}]};
  const result=restore(data);assert.equal(result.summary,'Supported by '+id+'.');assert.deepEqual(result.evidenceIds,[id]);assert.equal(result.risk.sourceQuality[0].evidenceId,id);assert.equal(result.codeFindings[0].evidenceId,id);assert.equal(result.codeFindings[0].path,data.codeFindings[0].path);assert.equal(result.teamsMessages[0].roomKey,alias);
  for(const key of ['remediation','issueSpec'])assert.deepEqual(result[key].evidenceIds,[id]);assert.deepEqual(result.teamsMessages[0].evidenceIds,[id]);
  assert.deepEqual(view.evidence,original.evidence);
});

test('unknown, raw, stale-snapshot and foreign-incident references are rejected instead of selecting another record',()=>{
  const view=snapshot(),first=citationTransport(view),next=structuredClone(view);next.incident.revision=999;
  const second=citationTransport(next),foreign=citationTransport({...next,incident:{...next.incident,id:'foreign'}}),alias=first.wire.evidence[0].id;
  for(const id of ['foreign',view.evidence[0].id,second.wire.evidence[0].id,foreign.wire.evidence[0].id])assert.throws(()=>first.restore({evidenceIds:[id]}),/outside.*incident/);
  assert.equal(first.restore({codeFindings:[{evidenceId:alias}]}).codeFindings[0].evidenceId,view.evidence[0].id);
  assert.deepEqual(first.bindings,citationTransport(view).bindings);assert.throws(()=>citationTransport({...view,evidence:[view.evidence[0],view.evidence[0]]}),/unique/);
});

test('shared triage links are encoded consistently, while quoted vendor fields and source identities stay unchanged',()=>{
  const view=snapshot(),id=view.evidence[0].id;
  view.evidence.push({id:'f'.repeat(64),source:'dynatrace',kind:'log_triage',content:{derivedFrom:id,complete:false,sharedBatchContext:'batch',records:[{evidenceId:id,message:id,sha:id}]}});
  view.logTriageBatches={batch:{derivedFrom:id,coverage:{sourceComplete:false,quotedVendorValue:{evidenceId:id}},interpretation:'Unknown coverage.'}};
  const {wire}=citationTransport(view),alias=wire.evidence[0].id,row=wire.evidence.at(-1);
  assert.equal(row.content.derivedFrom,alias);assert.equal(wire.logTriageBatches.batch.derivedFrom,alias);assert.deepEqual(wire.logTriageBatches.batch.coverage,view.logTriageBatches.batch.coverage);assert.deepEqual(row.content.records,view.evidence.at(-1).content.records);assert.equal(row.content.complete,false);
});
