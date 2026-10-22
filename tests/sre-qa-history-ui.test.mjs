import test from 'node:test';
import assert from 'node:assert/strict';
import {createQaHistoryView} from '../src/sre-web/qa-history.js';

const a='inc_aaaaaaaa',b='inc_bbbbbbbb',one='fix_'+'1'.repeat(24),two='fix_'+'2'.repeat(24),plan='plan_'+'a'.repeat(24);
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
class Element{
 constructor(){this.value='';this.hidden=false;this.disabled=false;this.textContent='';this.children=[];}
 set innerHTML(value){this.html=value;this.children=[...value.matchAll(/data-qa-inspect="([^"]+)"/g)].map(([,id])=>({dataset:{qaInspect:id}}));}
 get innerHTML(){return this.html||'';}
 querySelectorAll(selector){return selector==='[data-qa-inspect]'?this.children:[];}
}
function fixture(){const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},selection={incidentId:a,ready:true,recovery:{active:false,restoreId:null,questionsHeld:false}},reads=[],read=(path,body)=>{const pending={path,body,...deferred()};reads.push(pending);return pending.promise;};return{$,selection,reads,view:createQaHistoryView({element:$,read,selection:()=>selection})};}
const request=(id=one,incidentId=a,changes={})=>({id,incidentId,plan_id:plan,status:'proposed',displayStatus:'proposed',created_at:100,expires_at:600100,plan_revision:12,requested_by:'Avery',approved_by:null,current:true,assessment:{state:'current',reason:'matching-reviewed-facts'},approvalExpired:false,leaseExpired:false,origin:{name:'Bidding',key:'a'.repeat(32),id:'bidding-room',enabled:true,configuredAccess:true,currentIncidentId:incidentId},result:null,resultAvailable:false,error:null,unexpiredProposalsInConversation:1,...changes});
const page=(items=[request()],changes={})=>({version:1,incidentId:a,currentRevision:12,assessmentVersion:'a'.repeat(64),observedAt:200,mode:'attention',items,nextCursor:null,counts:{total:items.length},coverage:{pageSize:20,total:items.length,shown:items.length,omitted:0,attentionTotal:items.length,attentionShown:items.length,attentionOmitted:0,hasMore:false,completeHistory:false},recovery:{active:false,restoreId:null},...changes});
const detail=(id=one,incidentId=a,changes={})=>({version:1,id,incidentId,currentRevision:12,assessmentVersion:'a'.repeat(64),observedAt:250,request:request(id,incidentId),result:null,resultOmitted:false,events:[{id:'a'.repeat(64),at:100,status:'proposed',payloadOmitted:true,result:null}],eventCoverage:{shown:1,total:1,omitted:0,rawPayloadsIncluded:false},recovery:{active:false,restoreId:null},...changes});
const complete=async(x,task,value)=>{x.reads.at(-1).resolve(value);await task;};

test('passed results show a changed assessment separately from the original stored execution outcome',()=>{
 const x=fixture();x.view.observe(a,page([request(one,a,{status:'passed',displayStatus:'passed',current:false,assessment:{state:'changed',reason:'different-reviewed-facts'}})]));assert.match(x.$('casework-qa').innerHTML,/QA passed/);assert.match(x.$('casework-qa').innerHTML,/assessment changed/i);assert.match(x.$('casework-qa').innerHTML,/historical/i);assert.equal(x.reads.length,0);
});
test('legacy or absent assessment metadata never implies the old local result matches the current investigation',()=>{
 for(const assessment of[undefined,{state:'unverified',reason:'legacy-plan'}]){const x=fixture();x.view.observe(a,page([request(one,a,{assessment,current:assessment?false:true})]));assert.match(x.$('casework-qa').innerHTML,/assessment match is unverified/i);assert.equal(x.reads.length,0);}
});
test('a same-revision assessment change marks an open inspection earlier without replacing its retained evidence',async()=>{
 const x=fixture(),version='a'.repeat(64),next='b'.repeat(64);x.$('teams-text').value='Ask Noor whether the ordering trace disproves this fix';x.view.observe(a,page([request()],{assessmentVersion:version}));const task=x.view.inspect(one);await complete(x,task,detail(one,a,{assessmentVersion:version}));x.view.observe(a,page([request(one,a,{current:false,assessment:{state:'changed',reason:'different-reviewed-facts'}})],{assessmentVersion:next}));assert.match(x.$('qa-inspection-status').textContent,/earlier inspection/);assert.equal(x.$('teams-text').value,'Ask Noor whether the ordering trace disproves this fix');assert.match(x.$('qa-inspection-evidence').textContent,/"status": "proposed"/);
});
test('a late saved history page cannot erase the newer same-revision assessment observation',async()=>{
 const x=fixture(),version='a'.repeat(64),next='b'.repeat(64);x.view.observe(a,page([request()],{assessmentVersion:version}));const task=x.view.load();x.view.observe(a,page([request(one,a,{current:false,assessment:{state:'changed',reason:'different-reviewed-facts'}})],{assessmentVersion:next}));await complete(x,task,page([request()],{mode:'history',assessmentVersion:version}));assert.match(x.$('qa-history-status').textContent,/earlier history observation/);
});
test('malformed assessment freshness cannot replace verified QA history',()=>{
 for(const bad of[page([request(one,a,{assessment:{state:'current',reason:'not-a-reason'}})],{assessmentVersion:'bad'}),page([request()],{assessmentVersion:['a'.repeat(64)]}),page([request(one,a,{assessment:{state:'changed',reason:'different-reviewed-facts'},current:true})])]){const x=fixture();x.view.observe(a,page());x.view.observe(a,bad);assert.match(x.$('qa-history-status').textContent,/could not be verified/);}
});

test('attention cards identify expired and interrupted requests, original people, conversations and ambiguous approvals',()=>{
 const x=fixture();x.view.observe(a,page([request(one,a,{status:'unknown',displayStatus:'unknown',current:false}),request(two,a,{displayStatus:'expired',current:false,approvalExpired:true,requested_by:'Noor',origin:{...request().origin,name:'Platform'},unexpiredProposalsInConversation:3})]));const html=x.$('casework-qa').innerHTML;
 assert.match(html,/QA unknown/);assert.match(html,/QA expired/);assert.match(html,/Stored state: proposed/);assert.match(html,/Requested by Noor in Platform/);assert.match(html,/3 unexpired proposals/);assert.match(x.$('qa-history-status').textContent,/2\/2 retained/);assert.equal(x.reads.length,0);
});
test('history controls issue only scoped GETs and replace pages using the returned cursor',async()=>{
 const x=fixture();let task=x.view.load();assert.equal(x.reads[0].path,'/api/incidents/'+a+'/qa-requests');await complete(x,task,page([request()],{mode:'history',nextCursor:'retained_cursor',coverage:{...page().coverage,total:2,omitted:1,hasMore:true}}));assert.equal(x.$('qa-history-older').disabled,false);
 task=x.view.load(true);assert.equal(x.reads.at(-1).path,'/api/incidents/'+a+'/qa-requests?cursor=retained_cursor');await complete(x,task,page([request(two)],{mode:'history',coverage:{...page().coverage,total:2,omitted:1}}));assert.ok(!x.$('casework-qa').innerHTML.includes(one));assert.ok(x.$('casework-qa').innerHTML.includes(two));assert.equal(x.$('qa-history-older').disabled,true);assert.ok(x.reads.every(r=>r.body===undefined));
});
test('an exact saved request can be read and refreshed without touching the Teams draft or sending an approval',async()=>{
 const x=fixture();x.$('teams-text').value='Noor is still checking the accepted-winner replay';x.view.observe(a,page());let task=x.view.inspect(one);assert.equal(x.reads[0].path,'/api/incidents/'+a+'/qa-requests/'+one);await complete(x,task,detail());assert.equal(x.$('qa-inspection').hidden,false);assert.match(x.$('qa-inspection-evidence').textContent,/Avery/);assert.equal(x.$('teams-text').value,'Noor is still checking the accepted-winner replay');
 task=x.view.inspect(one);x.reads.at(-1).reject(Error('Owned reader unavailable'));await task;assert.match(x.$('qa-inspection-status').textContent,/earlier inspection/);assert.match(x.$('qa-inspection-status').textContent,/Owned reader unavailable/);assert.match(x.$('qa-inspection-evidence').textContent,/Avery/);assert.ok(x.reads.every(r=>r.body===undefined));
});
test('late history and inspection from another incident cannot replace the selected case or its lookup',async()=>{
 const x=fixture(),history=x.view.load(),inspection=x.view.inspect(one);x.selection.incidentId=b;x.view.observe(b,page([request(two,b)],{incidentId:b}));const selected=x.view.inspect(two);await complete(x,selected,detail(two,b));x.reads[0].resolve(page([request()],{mode:'history'}));x.reads[1].resolve(detail());await Promise.all([history,inspection]);assert.match(x.$('casework-qa').innerHTML,new RegExp(two));assert.ok(!x.$('casework-qa').innerHTML.includes(one));assert.equal(x.$('qa-request-id').value,two);assert.match(x.$('qa-inspection-reference').textContent,new RegExp(b));x.selection.incidentId=a;x.view.render();assert.equal(x.$('qa-request-id').value,one);assert.match(x.$('qa-inspection-reference').textContent,new RegExp(a));
});
test('a newer request inspection wins over an earlier late response for the same incident',async()=>{
 const x=fixture(),old=x.view.inspect(one),fresh=x.view.inspect(two);x.reads[1].resolve(detail(two));await fresh;x.reads[0].reject(Error('Late old failure'));await old;assert.match(x.$('qa-inspection-reference').textContent,new RegExp(two));assert.ok(!x.$('qa-inspection-status').textContent.includes('Late old failure'));assert.equal(x.$('qa-request-id').value,two);
});
test('history serials reject superseded errors and failed pages retain an explicitly earlier page',async()=>{
 const x=fixture();let task=x.view.load();await complete(x,task,page([request()],{mode:'history'}));const old=x.view.load(),fresh=x.view.load();x.reads.at(-1).resolve(page([request(two)],{mode:'history'}));await fresh;x.reads[1].reject(Error('Old failure'));await old;assert.match(x.$('casework-qa').innerHTML,new RegExp(two));assert.ok(!x.$('qa-history-status').textContent.includes('Old failure'));task=x.view.load();x.reads.at(-1).reject(Error('Saved history unavailable'));await task;assert.match(x.$('qa-history-status').textContent,/unavailable.*earlier history observation/);assert.match(x.$('casework-qa').innerHTML,new RegExp(two));
});
test('malformed scoped attention never falls back to unverified foreign evidence, and a good refresh clears its warning',()=>{
 const x=fixture();x.view.observe(a,page([request(one,b)]));assert.ok(!x.$('casework-qa').innerHTML.includes(one));assert.match(x.$('qa-history-status').textContent,/could not be verified/);x.view.observe(a,page());assert.ok(!x.$('qa-history-status').textContent.includes('unavailable'));assert.match(x.$('casework-qa').innerHTML,new RegExp(one));
});
test('old summaries have an explicit missing-coverage label and exclude summaries with another incident identity',()=>{
 const x=fixture();x.view.observe(a,{items:[{id:one,status:'unknown'},{id:two,status:'passed',incidentId:b}]});assert.match(x.$('qa-history-status').textContent,/has not returned verified QA coverage/);assert.match(x.$('casework-qa').innerHTML,new RegExp(one));assert.ok(!x.$('casework-qa').innerHTML.includes(two));
});
test('malformed pages cannot replace history: wrong scope, duplicate rows, impossible coverage and unsafe restore identity',async()=>{
 const x=fixture();let task=x.view.load();await complete(x,task,page([request()],{mode:'history'}));for(const bad of[page([request(two,b)],{mode:'history'}),page([request(),request()],{mode:'history'}),page([request()],{mode:'history',coverage:{...page().coverage,total:0,omitted:0}}),page([request()],{mode:'history',nextCursor:'unannounced'}),page([request()],{mode:'history',recovery:{active:true,restoreId:null}}),page([request()],{mode:'history',recovery:{active:false,restoreId:'invalid id'}})]){task=x.view.load();await complete(x,task,bad);assert.match(x.$('qa-history-status').textContent,/could not be verified.*earlier history observation/);assert.match(x.$('casework-qa').innerHTML,new RegExp(one));}
});
test('wrong request scope, oversized results and raw event payload claims cannot become inspected evidence',async()=>{
 for(const bad of[detail(one,b),detail(two),detail(one,a,{result:{log:'x'.repeat(131073)}}),detail(one,a,{result:{log:'界'.repeat(43000)}}),detail(one,a,{eventCoverage:{shown:1,total:1,omitted:0,rawPayloadsIncluded:true}}),detail(one,a,{recovery:{active:true,restoreId:null}})]){const x=fixture(),task=x.view.inspect(one);await complete(x,task,bad);assert.match(x.$('qa-inspection-status').textContent,/could not be verified/);assert.equal(x.$('qa-inspection-evidence').hidden,true);}
});
test('cached views are marked earlier after a restore and late reads cannot clear that observation',async()=>{
 const x=fixture();x.view.observe(a,page());let task=x.view.inspect(one);await complete(x,task,detail());const late=x.view.inspect(one),history=x.view.load();x.selection.recovery={active:true,restoreId:'qa-restore-hold',questionsHeld:true};x.view.render();assert.match(x.$('qa-inspection-status').textContent,/earlier inspection/);x.reads.at(-2).resolve(detail());x.reads.at(-1).resolve(page([request(two)],{mode:'history'}));await Promise.all([late,history]);assert.match(x.$('qa-inspection-status').textContent,/Restore state changed/);assert.match(x.$('qa-history-status').textContent,/Restore state changed/);assert.equal(x.$('qa-history-load').disabled,false);
 task=x.view.inspect(one);await complete(x,task,detail(one,a,{recovery:{...x.selection.recovery},request:request(one,a,{current:false})}));assert.ok(!x.$('qa-inspection-status').textContent.includes('Restore state changed'));assert.equal(x.reads.at(-1).body,undefined);
});
test('a changed request or revision marks an earlier inspection until it is refreshed',async()=>{
 const x=fixture();x.view.observe(a,page());const task=x.view.inspect(one);await complete(x,task,detail());x.view.observe(a,page([request(one,a,{status:'unknown',displayStatus:'unknown',current:false})],{currentRevision:13}));assert.match(x.$('qa-inspection-status').textContent,/earlier inspection/);assert.match(x.$('qa-inspection-evidence').textContent,/"status": "proposed"/);assert.match(x.$('casework-qa').innerHTML,/QA unknown/);
});
test('large result omission and bounded transition coverage stay visible while text is safely rendered',async()=>{
 const x=fixture();x.view.observe(a,page([request(one,a,{requested_by:'<script>actor</script>',error:'<img src=x>',result:{isSummary:true,branch:'codex/fix',commit:'a'.repeat(40),summary:'<svg>untrusted</svg>',patchNeedsRegeneration:true}})]));assert.ok(!x.$('casework-qa').innerHTML.includes('<script>'));assert.ok(!x.$('casework-qa').innerHTML.includes('<img'));assert.match(x.$('casework-qa').innerHTML,/&lt;script&gt;/);assert.match(x.$('casework-qa').innerHTML,/final newline/);const task=x.view.inspect(one);await complete(x,task,detail(one,a,{resultOmitted:true,eventCoverage:{shown:1,total:20,omitted:19,rawPayloadsIncluded:false}}));assert.match(x.$('qa-inspection-status').textContent,/exceeds this reader budget/);assert.match(x.$('qa-inspection-status').textContent,/1\/20 transition summaries/);
});
test('a removed card cannot inspect its old request, and changing back to attention cancels a pending history display',async()=>{
 const x=fixture();x.view.observe(a,page());const old=x.$('casework-qa').children[0];x.view.observe(a,page([request(two)]));old.onclick();assert.equal(x.reads.length,0);const task=x.view.load();x.$('qa-show-attention').onclick();x.reads[0].resolve(page([request()],{mode:'history'}));await task;assert.match(x.$('casework-qa').innerHTML,new RegExp(two));assert.ok(!x.$('casework-qa').innerHTML.includes(one));
});
test('not-ready views perform no reads, retain lookup by incident and never touch another Teams draft',async()=>{
 const x=fixture();x.$('qa-request-id').value=one;x.$('qa-request-id').oninput();x.selection.ready=false;x.view.render();await x.view.load();await x.view.inspect(one);x.$('qa-inspection-refresh').onclick();x.$('qa-inspection-close').onclick();assert.equal(x.reads.length,0);assert.equal(x.$('qa-inspection').hidden,true);assert.equal(x.$('qa-inspect-submit').disabled,true);x.selection.ready=true;x.view.render();assert.equal(x.$('qa-request-id').value,one);await x.view.inspect('not-a-request');assert.equal(x.reads.length,0);x.selection.incidentId=null;x.selection.ready=false;x.view.render();x.$('qa-inspection-close').onclick();assert.equal(x.reads.length,0);
});
