import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {createIncidentView} from '../src/sre-web/incident-view.js';
import {createDeliveryInspectionView,deliveryRecipientLabel} from '../src/sre-web/delivery-inspection.js';
import {visibleConversation} from '../src/sre-web/conversation-history.js';

const ids={bidding:'inc_aaaaaaaa',provider:'inc_bbbbbbbb'};
const deferred=()=>{let resolve;const promise=new Promise(a=>{resolve=a;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const json=value=>({ok:true,status:200,json:async()=>value});
const incident=id=>({incident:{id,title:id,status:'open'},jobs:[],casework:null,evidence:[],deployments:[],rollback:{eligible:false,reasons:[]},session:{agent_id:'agent:'+id},conversation:[],collaboration:{enabled:false}});

// Execute the real console module against a small DOM boundary. Fetch responses
// are manually held, so no test depends on network timing or a browser package.
class Element {
  constructor(){this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.textContent='';this.children=[];this.classList={toggle:()=>{}};}
  set innerHTML(html){this.html=html;this.children=[...html.matchAll(/<button\b([^>]*)>/g)].map(([,attributes])=>{
    const button=new Element();for(const [,key,value] of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g))button.dataset[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;return button;
  });this.messageDetails=[...html.matchAll(/<details\b([^>]*)><summary>([\s\S]*?)<\/summary><pre(?:\s[^>]*)?>([\s\S]*?)<\/pre><\/details>/g)].filter(([,attributes])=>attributes.includes('data-message-id=')).map(([,attributes,summary,text])=>{const detail=new Element();detail.dataset.messageId=/data-message-id="([^"]*)"/.exec(attributes)[1];detail.open=/\bopen\b/.test(attributes);detail.pre=new Element();detail.pre.textContent=text;detail.pre.scrollTop=0;detail.pre.scrollLeft=0;detail.summary=new Element();detail.summary.textContent=summary;return detail;});}
  get innerHTML(){return this.html||'';}
  querySelectorAll(selector){return selector==='button'?this.children:selector.startsWith('details')&&selector.includes('data-message-id')?(this.messageDetails||[]).filter(detail=>!selector.includes('[open]')||detail.open):[];}
  querySelector(selector){return selector==='button'?(this.button??=new Element()):selector==='pre'?this.pre||null:selector==='summary'?this.summary||null:null;}
  setAttribute(name,value){this[name]=value;}
  focus(){}
}
async function consoleApp(statusOverrides={}){
  const source=(await readFile(new URL('../src/sre-web/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  const elements=new Map(),requests=[],intervals=[];
  const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  for(const [id,value] of Object.entries({'teams-room':'room','teams-user':'local-operator','teams-surface':'channel','teams-intent':'direct','change-provider':'gitlab'}))$(id).value=value;
  const status={simulationConversationId:'room',simulationConversations:[{id:'room',name:'Fictional group'}],conversations:[],agentMode:'rules',mode:'local',simulation:true,teamsMode:'off',incidents:Object.values(ids).map(id=>({id,title:id,status:'open'})),counts:[],jobs:[],workerConcurrency:1,connections:[],outbox:[],rollbacks:[]};
  Object.assign(status,statusOverrides);
  const fetch=async(path,options)=>{
    if(path==='/api/status')return json(status);
    const d=deferred(),request={path,method:options.method,body:options.body?JSON.parse(options.body):undefined,...d};requests.push(request);return d.promise;
  };
  await runInNewContext('(async()=>{'+source+'\n})()',{createIncidentView,createDeliveryInspectionView,deliveryRecipientLabel,visibleConversation,document:{getElementById:$},fetch,crypto:{randomUUID},setInterval:fn=>intervals.push(fn),console});
  const select=async id=>{$('incidents').children.find(button=>button.dataset.id===id).onclick();await flush();};
  const load=async(id,overrides={})=>{const request=requests.find(r=>r.method==='GET'&&r.path==='/api/incidents/'+id&&!r.done);assert.ok(request,'Expected a new detail read');request.done=true;request.resolve(json({...incident(id),...overrides}));await flush();};
  const submit=id=>$(id).onsubmit({preventDefault(){},target:$(id)});
  const complete=async request=>{request.done=true;request.resolve(json({accepted:true}));await flush();};
  return {$,requests,select,load,submit,complete,status,refresh:()=>intervals[0]()};
}

test('quota controls retain pending work and bind resume to the displayed hold even when a newer hold arrives',async()=>{
 const hold={id:'hold-1',state:'held',provider:'claude-cli',resetLabel:'7pm America/Detroit'},app=await consoleApp({modelQuota:hold});
 assert.equal(app.$('model-quota').hidden,false);assert.match(app.$('model-quota-description').textContent,/Claude.*7pm America\/Detroit/);
 app.$('model-quota-reason').value='Account reset checked';const pending=app.submit('model-quota-resume');await flush();
 const request=app.requests.find(r=>r.path==='/api/agent/quota/resume');assert.ok(request);assert.deepEqual(request.body,{holdId:'hold-1',reason:'Account reset checked'});
 app.status.modelQuota={...hold,id:'hold-2'};await app.refresh();app.$('model-quota-reason').value='Reviewing the newer quota';
 await app.complete(request);await pending;
 assert.equal(app.$('model-quota').hidden,false);assert.equal(app.$('model-quota-reason').value,'Reviewing the newer quota');
 assert.equal(app.requests.filter(r=>r.method==='POST').length,1);
 app.status.modelQuota={...app.status.modelQuota,state:'released'};await app.refresh();assert.equal(app.$('model-quota').hidden,true);
});

test('background status polls leave an unchanged expanded delivery and its scroll position intact',async()=>{
 const message={id:'delivery-long',incident_id:ids.bidding,status:'simulated',text:'Incident brief\n'+('Evidence for the exact changed head.\n'.repeat(80))},app=await consoleApp({outbox:[message]});const detail=app.$('outbox').messageDetails[0];detail.open=true;detail.pre.scrollTop=460;detail.pre.scrollLeft=24;await app.refresh();assert.equal(app.$('outbox').messageDetails[0],detail);assert.equal(detail.pre.scrollTop,460);assert.equal(detail.pre.scrollLeft,24);assert.equal(detail.open,true);
});
test('a new delivery retains the existing message reader while changed message text starts at the top',async()=>{
 const message={id:'delivery-long',incident_id:ids.bidding,status:'simulated',text:'Incident brief\n'+('Evidence for the exact changed head.\n'.repeat(80))},app=await consoleApp({outbox:[message]});let detail=app.$('outbox').messageDetails[0];detail.open=true;detail.pre.scrollTop=460;app.status.outbox.unshift({...message,id:'independent-message',text:'Different incident\n'+message.text});await app.refresh();detail=app.$('outbox').messageDetails.find(row=>row.dataset.messageId===message.id);assert.equal(detail.open,true);assert.equal(detail.pre.scrollTop,460);app.status.outbox.find(row=>row.id===message.id).text='Updated rendered contact snapshot\n'+message.text;await app.refresh();detail=app.$('outbox').messageDetails.find(row=>row.dataset.messageId===message.id);assert.equal(detail.open,true);assert.equal(detail.pre.scrollTop,0);assert.equal(app.$('outbox').messageDetails.find(row=>row.dataset.messageId==='independent-message').open,false);
});
test('original queued content keeps its own reader independently of the prepared delivery text',async()=>{
 const message={id:'delivery-long',incident_id:ids.bidding,status:'simulated',text:'Original queued reply\n'+('Original evidence.\n'.repeat(80)),deliveryAttempt:{text:'Prepared reply\n'+('Fresh delivery evidence.\n'.repeat(80))}},app=await consoleApp({outbox:[message]});for(const row of app.$('outbox').messageDetails){row.open=true;row.pre.scrollTop=row.dataset.messageId.endsWith(':original')?210:430;}app.status.outbox.unshift({...message,id:'another-delivery'});await app.refresh();assert.equal(app.$('outbox').messageDetails.find(row=>row.dataset.messageId===message.id).pre.scrollTop,430);assert.equal(app.$('outbox').messageDetails.find(row=>row.dataset.messageId===message.id+':original').pre.scrollTop,210);
});

test('console form handlers reject pending context and never render a delayed other incident',async()=>{
  const app=await consoleApp();await app.select(ids.bidding);await app.select(ids.provider);
  app.$('question-text').value='Fictional question while no current view';await app.submit('question');
  assert.equal(app.requests.filter(r=>r.method==='POST').length,0);assert.match(app.$('notice').textContent,/Wait/);assert.equal(app.$('incident-teams-controls').disabled,true);
  await app.load(ids.bidding);assert.equal(app.$('detail').dataset.incident,'');assert.equal(app.$('question').hidden,true);
  await app.load(ids.provider);assert.equal(app.$('detail').dataset.incident,ids.provider);assert.equal(app.$('teams-thread').textContent,'Incident thread: '+ids.provider);assert.equal(app.$('incident-teams-controls').disabled,false);
});

test('a late question receipt clears only its saved incident draft and cannot erase another incident',async()=>{
  const app=await consoleApp();await app.select(ids.provider);await app.load(ids.provider);
  app.$('question-text').value='Fictional provider timeout';const submitted=app.submit('question');await flush();const post=app.requests.find(r=>r.method==='POST');
  assert.equal(post.path,'/api/incidents/'+ids.provider+'/questions');assert.equal(post.body.text,'Fictional provider timeout');
  await app.select(ids.bidding);await app.load(ids.bidding);assert.equal(app.$('question-text').value,'');app.$('question-text').value='Fictional bidding draft';app.$('teams-text').value='Fictional Bidding team draft';
  await app.complete(post);await submitted;assert.equal(app.$('question-text').value,'Fictional bidding draft');assert.equal(app.$('teams-text').value,'Fictional Bidding team draft');assert.equal(app.$('notice').textContent,'');
  await app.select(ids.provider);await app.load(ids.provider);assert.equal(app.$('question-text').value,'');await app.select(ids.bidding);await app.load(ids.bidding);assert.equal(app.$('question-text').value,'Fictional bidding draft');
});

test('simulated Teams messages capture incident and channel before a switch; late receipts keep new drafts',async()=>{
  const app=await consoleApp();await app.select(ids.bidding);await app.load(ids.bidding);
  app.$('teams-text').value='update Fictional bidding race';const submitted=app.submit('teams');await flush();const post=app.requests.find(r=>r.method==='POST');
  assert.equal(post.path,'/api/dev/teams');assert.equal(post.body.expectedIncidentId,ids.bidding);assert.equal(post.body.conversationId,'room;messageid='+BigInt('0xaaaaaaaa').toString());
  await app.select(ids.provider);await app.load(ids.provider);assert.equal(app.$('teams-text').value,'');app.$('teams-text').value='update Fictional provider draft';
  await app.complete(post);await submitted;assert.equal(app.$('teams-text').value,'update Fictional provider draft');assert.equal(app.$('notice').textContent,'');assert.equal(app.$('teams').querySelector('button').disabled,false);
});

test('same-incident typing while a question is submitted is retained after the fresh detail read',async()=>{
  const app=await consoleApp();await app.select(ids.bidding);await app.load(ids.bidding);app.$('question-text').value='Fictional original question';
  const submitted=app.submit('question');await flush();const post=app.requests.find(r=>r.method==='POST');app.$('question-text').value='Fictional next question';
  await app.complete(post);await app.load(ids.bidding);await submitted;
  assert.equal(app.$('question-text').value,'Fictional next question');assert.match(app.$('notice').textContent,/Question saved/);
});

test('the persisted rehearsal opens the correct incident thread while preserving separate room and question drafts',async()=>{
  const guide={title:'Fictional rehearsal',note:'All people are scripted.',primaryId:ids.bidding,providerId:ids.provider,primaryRoot:'eu',providerRoot:'us'};
  const app=await consoleApp({simulationGuide:guide,simulationConversations:[{id:'eu',name:'EU'},{id:'us',name:'US'},{id:'worker',name:'Worker'}]});
  assert.equal(app.$('simulation-guide').hidden,false);assert.equal(app.$('simulation-guide-note').textContent,guide.note);
  app.$('simulation-eu').onclick();await flush();await app.load(ids.bidding);assert.equal(app.$('teams-room').value,'eu');assert.equal(app.$('teams-surface').value,'channel');
  app.$('teams-room').value='worker';app.$('question-text').value='Check the worker update';app.$('teams-text').value='update EU draft';
  app.$('simulation-us').onclick();await flush();await app.load(ids.provider);assert.equal(app.$('teams-room').value,'us');assert.equal(app.$('question-text').value,'');assert.equal(app.$('teams-text').value,'');
  app.$('question-text').value='US draft';app.$('simulation-eu').onclick();await flush();await app.load(ids.bidding);
  assert.equal(app.$('teams-room').value,'worker');assert.equal(app.$('question-text').value,'Check the worker update');assert.equal(app.$('teams-text').value,'update EU draft');
});

test('a guide with a missing case or unconfigured room is hidden and cannot select an incident',async()=>{
  for(const invalid of [{primaryId:'inc_absent',primaryRoot:'room'},{primaryId:ids.bidding,primaryRoot:'outside'}]){
    const app=await consoleApp({simulationGuide:{...invalid,providerId:ids.provider,providerRoot:'room'}});assert.equal(app.$('simulation-guide').hidden,true);assert.equal(app.$('simulation-eu').onclick,undefined);
  }
});

test('the console retains an earlier-timed current assessment with escaped question context and a display-order explanation',async()=>{
 const app=await consoleApp(),analysis={mode:'rules',summary:'Current reviewed fixture',text:'Exact current assessment'},questions=Array.from({length:15},(_,n)=>({id:'question-'+n,role:'operator',name:'Responder',at:100+n,text:'Compare request <untrusted> '+n})),current={id:'earlier-current',role:'assistant',at:1,revision:9,...analysis,matchesCurrentAssessment:true,inReplyTo:'question-14'};await app.select(ids.bidding);await app.load(ids.bidding,{incident:{...incident(ids.bidding).incident,revision:9,analysis},assessmentStatus:{state:'current'},conversation:[current,...questions]});const html=app.$('conversation-messages').innerHTML;assert.equal((html.match(/<article /g)||[]).length,12);assert.match(html,/Current assessment retained here despite its earlier recorded time/);assert.match(html,/revision 9 · current snapshot/);assert.match(html,/In reply to Responder: Compare request &lt;untrusted&gt; 14/);assert.ok(!html.includes('<untrusted>'));assert.equal(html.lastIndexOf('<article '),html.indexOf('<article class="chat-turn assistant"'));assert.equal(app.requests.filter(row=>row.method==='POST').length,0);
});

test('the console distinguishes a released handoff, an older assignment and a reported current owner without granting an action',async()=>{
 const app=await consoleApp();await app.select(ids.bidding);const report={evidenceId:'retained-report',roomKey:'room',roomName:'Bidding <untrusted>',author:'Avery <untrusted>',state:'released',at:1,text:'Exact source replay <untrusted>'};const collaboration={enabled:true,incidentId:ids.bidding,rooms:[],issues:[],actions:[],nextStep:'Ask the lead for a receiver',handoffs:[{key:'eu-ledger',state:'awaiting-owner',release:report,owner:null,completion:null,ownerCount:0,priorAssignedCount:1,verified:false}],handoffCoverage:{total:1,retained:1,omitted:0}};await app.load(ids.bidding,{collaboration});assert.equal(app.$('coordination-handoffs').hidden,false);assert.match(app.$('coordination-handoff-items').innerHTML,/No current owner report after this release/);assert.match(app.$('coordination-handoff-items').innerHTML,/predate this release/);assert.ok(!app.$('coordination-handoff-items').innerHTML.includes('<untrusted>'));assert.match(app.$('coordination-handoff-items').innerHTML,/&lt;untrusted&gt;/);assert.equal(app.requests.filter(r=>r.method==='POST').length,0);
});
