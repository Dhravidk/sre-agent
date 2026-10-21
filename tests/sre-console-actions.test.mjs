import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {createIncidentView} from '../src/sre-web/incident-view.js';
import {createDeliveryInspectionView} from '../src/sre-web/delivery-inspection.js';

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
  });}
  get innerHTML(){return this.html||'';}
  querySelectorAll(selector){return selector==='button'?this.children:[];}
  querySelector(selector){return selector==='button'?(this.button??=new Element()):null;}
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
  await runInNewContext('(async()=>{'+source+'\n})()',{createIncidentView,createDeliveryInspectionView,document:{getElementById:$},fetch,crypto:{randomUUID},setInterval:fn=>intervals.push(fn),console});
  const select=async id=>{$('incidents').children.find(button=>button.dataset.id===id).onclick();await flush();};
  const load=async(id,overrides={})=>{const request=requests.find(r=>r.method==='GET'&&r.path==='/api/incidents/'+id&&!r.done);assert.ok(request,'Expected a new detail read');request.done=true;request.resolve(json({...incident(id),...overrides}));await flush();};
  const submit=id=>$(id).onsubmit({preventDefault(){},target:$(id)});
  const complete=async request=>{request.done=true;request.resolve(json({accepted:true}));await flush();};
  return {$,requests,select,load,submit,complete,status};
}

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

test('the console distinguishes a released handoff, an older assignment and a reported current owner without granting an action',async()=>{
 const app=await consoleApp();await app.select(ids.bidding);const report={evidenceId:'retained-report',roomKey:'room',roomName:'Bidding <untrusted>',author:'Avery <untrusted>',state:'released',at:1,text:'Exact source replay <untrusted>'};const collaboration={enabled:true,incidentId:ids.bidding,rooms:[],issues:[],actions:[],nextStep:'Ask the lead for a receiver',handoffs:[{key:'eu-ledger',state:'awaiting-owner',release:report,owner:null,completion:null,ownerCount:0,priorAssignedCount:1,verified:false}],handoffCoverage:{total:1,retained:1,omitted:0}};await app.load(ids.bidding,{collaboration});assert.equal(app.$('coordination-handoffs').hidden,false);assert.match(app.$('coordination-handoff-items').innerHTML,/No current owner report after this release/);assert.match(app.$('coordination-handoff-items').innerHTML,/predate this release/);assert.ok(!app.$('coordination-handoff-items').innerHTML.includes('<untrusted>'));assert.match(app.$('coordination-handoff-items').innerHTML,/&lt;untrusted&gt;/);assert.equal(app.requests.filter(r=>r.method==='POST').length,0);
});
