import test from 'node:test';
import assert from 'node:assert/strict';
import {createIncidentView} from '../src/sre-web/incident-view.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=id=>({incident:{id,title:id}});
function consoleView() {
  const requests=[],renders=[],pending=[],errors=[];
  const view=createIncidentView({
    load:id=>{const d=deferred();requests.push({id,...d});return d.promise;},
    render:data=>renders.push(data.incident.id),pending:id=>pending.push(id),onError:(error,id)=>errors.push({id,error:error.message}),
  });
  return {view,requests,renders,pending,errors};
}
const started=()=>Promise.resolve();

test('console discards a delayed old incident and blocks actions until the new context is ready',async()=>{
  const {view,requests,renders,pending}=consoleView();
  const a=view.select('bidding');await started();const b=view.select('provider');await started();
  assert.deepEqual(pending,['bidding','provider']);assert.throws(()=>view.capture(),/Wait/);
  requests[0].resolve(response('bidding'));assert.equal(await a,false);assert.deepEqual(renders,[]);assert.throws(()=>view.capture(),/Wait/);
  requests[1].resolve(response('provider'));assert.equal(await b,true);assert.deepEqual(renders,['provider']);assert.equal(view.capture().incidentId,'provider');
});

test('console rejects an old A response after A to B to A selection',async()=>{
  const {view,requests,renders}=consoleView();
  const a1=view.select('bidding');await started();const b=view.select('provider');await started();const a2=view.select('bidding');await started();
  requests[0].resolve(response('bidding'));requests[1].resolve(response('provider'));await Promise.all([a1,b]);
  assert.deepEqual(renders,[]);assert.throws(()=>view.capture(),/Wait/);
  requests[2].resolve(response('bidding'));await a2;assert.deepEqual(renders,['bidding']);
});

test('an old network failure cannot hide the current incident or display its error',async()=>{
  const {view,requests,renders,errors}=consoleView();const a=view.select('bidding');await started();const b=view.select('provider');await started();
  requests[1].resolve(response('provider'));await b;requests[0].reject(Error('old read timed out'));await a;
  assert.deepEqual(renders,['provider']);assert.deepEqual(errors,[]);assert.equal(view.capture().incidentId,'provider');
});

test('polling coalesces a slow detail request instead of perpetually invalidating it',async()=>{
  const {view,requests,renders}=consoleView();const a=view.select('bidding');await started();
  const polls=[view.refresh(),view.refresh(),view.select('bidding')];await started();assert.equal(requests.length,1);
  requests[0].resolve(response('bidding'));assert.deepEqual(await Promise.all([a,...polls]),[true,true,true,true]);assert.deepEqual(renders,['bidding']);
});

test('an explicit post-mutation read supersedes an older same-incident snapshot',async()=>{
  const {view,requests,renders}=consoleView();const before=view.select('bidding');await started();const after=view.refresh({fresh:true});await started();
  requests[1].resolve(response('bidding'));await after;requests[0].resolve(response('bidding'));assert.equal(await before,false);
  assert.deepEqual(renders,['bidding']);assert.equal(view.capture().incidentId,'bidding');
});

test('a failed current read blocks actions and a later successful read recovers',async()=>{
  const {view,requests,errors}=consoleView();const initial=view.select('bidding');await started();requests[0].resolve(response('bidding'));await initial;const intent=view.capture();
  const failed=view.refresh();await started();requests[1].reject(Error('database unavailable'));await failed;assert.equal(view.isCurrent(intent),false);assert.throws(()=>view.capture(),/Wait/);assert.equal(errors[0].error,'database unavailable');
  const recovery=view.refresh();await started();requests[2].resolve(response('bidding'));await recovery;assert.equal(view.capture().incidentId,'bidding');
});

test('a plan or MR button bound to another incident cannot acquire the current action scope',async()=>{
  const {view,requests}=consoleView();const ready=view.select('provider');await started();requests[0].resolve(response('provider'));await ready;
  assert.throws(()=>view.capture('bidding'),/Wait/);assert.equal(view.capture('provider').incidentId,'provider');assert.ok(Object.isFrozen(view.capture()));
});

test('a synchronous detail load failure is handled and can be retried',async()=>{
  const errors=[];let failing=true;
  const view=createIncidentView({load:id=>{if(failing)throw Error('offline');return response(id);},render:()=>{},onError:error=>errors.push(error.message)});
  assert.equal(await view.select('bidding'),false);assert.deepEqual(errors,['offline']);assert.throws(()=>view.capture(),/Wait/);
  failing=false;assert.equal(await view.refresh(),true);assert.equal(view.capture().incidentId,'bidding');
});

test('selection invalidates the old action scope synchronously before the network starts',async()=>{
  const {view,requests,pending}=consoleView();const a=view.select('bidding');await started();requests[0].resolve(response('bidding'));await a;const intent=view.capture();
  const b=view.select('provider');assert.equal(pending.at(-1),'provider');assert.equal(view.isCurrent(intent),false);assert.throws(()=>view.capture(),/Wait/);assert.equal(requests.length,1);
  await started();requests[1].resolve(response('provider'));await b;
});

test('a mismatched API response never enables actions or renders',async()=>{
  const {view,requests,renders,errors}=consoleView();const a=view.select('bidding');await started();requests[0].resolve(response('provider'));assert.equal(await a,false);
  assert.deepEqual(renders,[]);assert.match(errors[0].error,/does not match/);assert.throws(()=>view.capture(),/Wait/);
});

test('a submitted action keeps its original target and cannot clear a different or revisited draft',async()=>{
  const {view,requests}=consoleView();const a=view.select('bidding');await started();requests[0].resolve(response('bidding'));await a;const submitted=view.capture();
  const b=view.select('provider');await started();requests[1].resolve(response('provider'));await b;
  assert.equal(submitted.incidentId,'bidding');assert.equal(view.isCurrent(submitted),false);
  const a2=view.select('bidding');await started();requests[2].resolve(response('bidding'));await a2;assert.equal(view.isCurrent(submitted),false);assert.notEqual(view.capture().generation,submitted.generation);
});

test('render failures revoke the current action scope rather than leaving a half-rendered context ready',async()=>{
  const errors=[];const view=createIncidentView({load:async id=>response(id),render:()=>{throw Error('invalid view');},onError:error=>errors.push(error.message)});
  assert.equal(await view.select('bidding'),false);assert.deepEqual(errors,['invalid view']);assert.throws(()=>view.capture(),/Wait/);
});
