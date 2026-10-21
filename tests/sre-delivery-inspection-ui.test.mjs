import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeliveryInspectionView} from '../src/sre-web/delivery-inspection.js';
import * as deliveryUi from '../src/sre-web/delivery-inspection.js';
const flush=()=>new Promise(done=>setImmediate(done));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
const snapshot=(id,version='a',extra={})=>({message:{id,incidentId:'inc_fixture',conversationId:'worker-group',status:'unknown',attempt:1,text:'Fictional retained update',error:'Owned uncertain fixture'},facts:{prepared:null,outcome:null,late:null},reviewFingerprint:version.repeat(64),history:[],canRecord:true,held:false,attentionRequired:true,...extra});
function fixture(){
 const elements=new Map(),reads=[],writes=[],errors=[];let refreshed=0;
 const $=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,hidden:false,textContent:'',innerHTML:'',focus(){}});return elements.get(id);};
 const view=createDeliveryInspectionView({element:$,load:path=>{const task=deferred();reads.push({path,...task});return task.promise;},save:(path,body)=>{const task=deferred();writes.push({path,body,...task});return task.promise;},refreshStatus:()=>{refreshed++;},onError:error=>errors.push(error.message)});
 const open=async(id,version='a')=>{const work=view.open(id);reads.at(-1).resolve(snapshot(id,version));await work;};
 const submit=()=>$('delivery-inspection-form').onsubmit({preventDefault(){}});
 return {$,view,reads,writes,errors,open,submit,refreshed:()=>refreshed};
}

test('a delayed other-message read cannot retarget the active delivery inspection or its draft',async()=>{
 const f=fixture(),old=f.view.open('message:a'),fresh=f.view.open('message:b');f.reads[1].resolve(snapshot('message:b'));await fresh;f.$('delivery-inspection-reason').value='Draft for B';f.reads[0].resolve(snapshot('message:a'));await old;
 assert.match(f.$('delivery-inspection-reference').textContent,/message:b/);assert.equal(f.$('delivery-inspection-reason').value,'Draft for B');const saved=f.submit();assert.equal(f.writes[0].path,'/api/deliveries/message%3Ab/inspection');assert.equal(f.writes[0].body.reason,'Draft for B');f.writes[0].resolve(snapshot('message:b','b'));await saved;
});
test('polling preserves a draft and blocks a stale save until the operator explicitly reviews changed facts',async()=>{
 const f=fixture();await f.open('message:a');f.$('delivery-inspection-reason').value='Reviewed exact worker group';f.view.observe({deliveryInspectionVersion:1});f.reads.at(-1).resolve(snapshot('message:a','b'));await flush();
 assert.equal(f.$('delivery-inspection-reason').value,'Reviewed exact worker group');assert.equal(f.$('delivery-inspection-submit').disabled,true);assert.match(f.$('delivery-inspection-state').textContent,/changed/);await f.submit();assert.equal(f.writes.length,0);
 const refreshed=f.$('delivery-inspection-refresh').onclick();f.reads.at(-1).resolve(snapshot('message:a','b'));await refreshed;assert.equal(f.$('delivery-inspection-submit').disabled,false);assert.equal(f.$('delivery-inspection-reason').value,'Reviewed exact worker group');const saved=f.submit();assert.equal(f.writes[0].body.expectedFingerprint,'b'.repeat(64));f.writes[0].resolve(snapshot('message:a','c'));await saved;
});
test('a late POST receipt cannot erase another delivery draft, change its review or clear its busy state',async()=>{
 const f=fixture();await f.open('message:a');f.$('delivery-inspection-reason').value='Fictional A follow-up';const savedA=f.submit();await f.open('message:b','b');f.$('delivery-inspection-reason').value='Fictional B follow-up';const savedB=f.submit();
 f.writes[0].resolve(snapshot('message:a','c'));await savedA;assert.equal(f.$('delivery-inspection-reason').value,'Fictional B follow-up');assert.match(f.$('delivery-inspection-reference').textContent,/message:b/);assert.equal(f.$('delivery-inspection-submit').disabled,true);
 f.writes[1].resolve(snapshot('message:b','d'));await savedB;assert.equal(f.$('delivery-inspection-submit').disabled,false);assert.equal(f.refreshed(),1);
});
test('a lost write response reuses the exact intent; changed text gets a fresh identity and 409 requires review',async()=>{
 const f=fixture();await f.open('message:a');f.$('delivery-inspection-reason').value='Fictional reviewed follow-up';let saved=f.submit();f.writes.at(-1).reject(Error('Owned response lost'));await saved;assert.match(f.$('delivery-inspection-state').textContent,/response lost/);
 saved=f.submit();assert.deepEqual(f.writes[1].body,f.writes[0].body);f.writes.at(-1).reject(Error('Owned response lost again'));await saved;
 f.$('delivery-inspection-reason').value='Different reviewed follow-up';saved=f.submit();assert.notEqual(f.writes[2].body.requestId,f.writes[1].body.requestId);f.writes.at(-1).reject(Object.assign(Error('Current facts changed'),{status:409}));await saved;assert.equal(f.$('delivery-inspection-submit').disabled,true);assert.match(f.$('delivery-inspection-state').textContent,/Current facts changed/);
});
test('restore hold and old backend capability prevent writes and changing selected incident is irrelevant',async()=>{
 const f=fixture();await f.open('message:a');assert.equal(f.$('delivery-inspection-follow-up').value,'required');assert.equal(f.$('delivery-inspection-finding').value,'inconclusive');const refreshed=f.$('delivery-inspection-refresh').onclick();f.reads.at(-1).resolve(snapshot('message:a','b',{held:true,canRecord:false}));await refreshed;assert.equal(f.$('delivery-inspection-submit').disabled,true);assert.match(f.$('delivery-inspection-state').textContent,/restore/);await f.submit();assert.equal(f.writes.length,0);
 f.view.observe({});assert.equal(f.$('delivery-inspection').hidden,true);await f.submit();assert.equal(f.writes.length,0);
});
test('untrusted operator descriptions and source text render as escaped observations rather than executable markup',async()=>{
 const f=fixture(),work=f.view.open('message:a');f.reads[0].resolve(snapshot('message:a','a',{message:{id:'message:a',status:'unknown',attempt:1,text:'<script>bad()</script>'},history:[{finding:'observed',followUp:'handled',current:true,actor:{kind:'operator-api',id:'fixture'},reason:'<img onerror=bad()>',references:['https://fixture.invalid/?a="quoted"'],recordedAt:1,observedAt:1}]}));await work;
 assert.ok(!f.$('delivery-inspection-facts').innerHTML.includes('<script>'));assert.match(f.$('delivery-inspection-facts').innerHTML,/&lt;script&gt;/);assert.ok(!f.$('delivery-inspection-history').innerHTML.includes('<img'));assert.match(f.$('delivery-inspection-history').innerHTML,/Operator reported observed/);
});
test('recipient labels distinguish a prepared target, queued intent, route waits and missing historical metadata without claiming delivery',()=>{
 const names=new Map([['worker-key','Worker desk']]);
 assert.equal(deliveryUi.deliveryRecipientLabel({status:'unknown',conversation_key:null,deliveryAttempt:{conversationKey:'worker-key'}},names),'prepared for Worker desk');
 assert.equal(deliveryUi.deliveryRecipientLabel({status:'sent',conversation_key:null,deliveryAttempt:{conversationKey:'worker-key'}},names),'prepared for Worker desk');
 assert.equal(deliveryUi.deliveryRecipientLabel({status:'pending',conversation_key:'worker-key'},names),'queued for Worker desk');
 assert.equal(deliveryUi.deliveryRecipientLabel({status:'pending',conversation_key:null},names),'awaiting a linked group');
 assert.equal(deliveryUi.deliveryRecipientLabel({status:'unknown',conversation_key:null},names),'recipient not recorded');
 assert.equal(deliveryUi.deliveryRecipientLabel({status:'sent',conversation_key:null,deliveryAttempt:{preparedAt:1}},names),'recipient not recorded');
 assert.equal(deliveryUi.deliveryRecipientLabel({status:'unknown',deliveryAttempt:{conversationKey:'older-key'}},names),'prepared for conversation key older-key');
});
test('an inspection names the recorded prepared key when the original intent was unbound, retaining uncertainty and the draft',async()=>{
 const f=fixture(),open=f.view.open('message:unbound');f.reads[0].resolve(snapshot('message:unbound','a',{message:{id:'message:unbound',incidentId:'inc_fixture',conversationId:null,conversationKey:null,status:'unknown',attempt:1,text:'Fictional retained body'},facts:{prepared:{conversationKey:'worker-recorded-key'},outcome:null,late:null}}));await open;
 assert.match(f.$('delivery-inspection-reference').textContent,/prepared conversation key worker-recorded-key/);assert.match(f.$('delivery-inspection-title').textContent,/unknown/);f.$('delivery-inspection-reason').value='Draft remains about this recorded worker target';f.view.observe({deliveryInspectionVersion:1});f.reads.at(-1).resolve(snapshot('message:unbound','a'));await flush();assert.equal(f.$('delivery-inspection-reason').value,'Draft remains about this recorded worker target');assert.equal(f.writes.length,0);
});
