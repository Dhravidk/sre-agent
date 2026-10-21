import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { boundedContext,modelContextLimits,EveReasoner } from '../src/sre/reasoner.mjs';
import { fixtureRisk,riskScope } from '../src/sre/analytic-risk.mjs';
import { createSreRuntime } from '../src/sre/server.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { evidenceCapability } from '../src/sre/security.mjs';

const size=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
function context() {
  const now=Date.now();
  return {incident:{id:'inc_fixture',service_key:'auction-local',issue_key:'P-CONTEXT',title:'Auction failure',status:'open',started_at:now-1000,updated_at:now,revision:1,source_states:'{"dynatrace":{"status":"OPEN","at":1}}',analysis:null},session:{agent_id:'agent_fixture',remote_state:{}},evidence:[{id:'human',source:'operator-recovery',kind:'question',observed_at:now,content:{text:'Access restored; recheck current evidence.',action:'retry_investigation'}}],deployments:[],assessmentHistory:[],responderContext:{evidenceIds:['human'],totalAvailable:1}};
}

test('complete model transport is bounded in UTF-8 bytes, including escaped Unicode and metadata',()=>{
  const c=context(),large='中文🚦\n"\\'.repeat(9000),audit='CONSOLE_ONLY_AUDIT_MARKER'.repeat(10000);
  c.incident.title=large;c.incident.analysis={summary:large,hypotheses:Array(20).fill(large),text:audit,risk:{likelihood:'unknown',confidence:'low',likelihoodRationale:large}};
  c.session.remote_state={opaque:audit};c.jobs=Array(40).fill({error:audit});c.retries=Array(40).fill({reason:audit});c.unrecognizedTopLevel=audit;
  c.deployments=Array.from({length:25},(_,i)=>({sha:String(i).padStart(40,'0'),artifact:'sha256:'+'a'.repeat(64),at:1,provider:'github',environment:'local',debug:audit}));
  c.assessmentHistory=Array.from({length:5},()=>({revision:1,evaluatedAt:1,risk:{likelihood:'unknown',likelihoodRationale:large,confidence:'low',confidenceRationale:large}}));
  for(let i=0;i<90;i++)c.evidence.push({id:'telemetry-'+i,source:'dynatrace',kind:'problem',observed_at:1,content:{log:large}});
  const view=boundedContext(c),encoded=JSON.stringify(view);
  assert.ok(size(view)<=modelContextLimits.totalBytes);assert.ok(view.evidence.some(item=>item.id==='human'));
  assert.equal(view.responderContext.evidenceIds[0],'human');assert.ok(view.coverage.included<view.coverage.totalAvailable);
  assert.ok(view.coverage.truncatedEvidence>0);assert.ok(view.coverage.metadataTruncated);
  assert.equal(encoded.includes('CONSOLE_ONLY_AUDIT_MARKER'),false);assert.equal(Object.hasOwn(view,'jobs'),false);assert.equal(Object.hasOwn(view,'retries'),false);assert.equal(Object.hasOwn(view.session,'remote_state'),false);
  assert.equal(view.deployments.length,20);assert.ok(view.deployments.every(item=>!Object.hasOwn(item,'debug')));
  assert.equal(c.jobs.length,40);assert.equal(c.session.remote_state.opaque,audit,'Transport projection must not alter the stored/console context');
});

test('oversized opaque deployment identity is omitted intact, with explicit coverage',()=>{
  const c=context(),normal={sha:'a'.repeat(40),artifact:'sha256:'+'b'.repeat(64),provider:'github',environment:'local',at:1};
  c.deployments=[normal,{...normal,sha:'c'.repeat(40),artifact:'registry/'.repeat(10000)+'@sha256:'+'d'.repeat(64)}];
  const view=boundedContext(c);
  assert.deepEqual(view.deployments,[normal]);assert.equal(view.coverage.deploymentsAvailable,2);assert.equal(view.coverage.deploymentsIncluded,1);
});

test('source-state preview reports omitted open records rather than implying source closure',()=>{
  const c=context(),states=Object.fromEntries(Array.from({length:200},(_,i)=>['servicenow:'+String(i).padStart(32,'0'),{at:1,status:i===199?'OPEN':'CLOSED'}]));
  c.incident.source_states=JSON.stringify(states);
  const summary=boundedContext(c).incident.sourceStateSummary;
  assert.equal(summary.open,1);assert.equal(summary.total,200);assert.ok(summary.omitted>0);assert.ok(summary.preview.length<=20);
  assert.equal(c.incident.source_states,JSON.stringify(states));
});

test('global envelope sheds telemetry before responder requests when metadata fills the remaining budget',()=>{
  const c=context();c.incident.id='i'.repeat(4096);c.incident.service_key='s'.repeat(4096);c.incident.issue_key='p'.repeat(4096);c.session.agent_id='a'.repeat(4096);
  c.incident.title='title'.repeat(10000);c.incident.analysis={summary:'summary'.repeat(10000)};
  c.deployments=Array.from({length:20},(_,i)=>({sha:String(i).padStart(40,'0'),artifact:'registry/'.repeat(250)+'@sha256:'+'b'.repeat(64),environment:'local',at:1}));
  c.assessmentHistory=Array.from({length:5},()=>({revision:1,risk:{likelihoodRationale:'r'.repeat(10000)}}));
  for(let i=0;i<30;i++)c.evidence.push({id:'log-'+i,source:'dynatrace',kind:'log',observed_at:1,content:{text:'data'.repeat(10000)}});
  const view=boundedContext(c);assert.ok(size(view)<=modelContextLimits.totalBytes);assert.ok(view.evidence.some(item=>item.id==='human'));
  assert.equal(view.incident.id,c.incident.id);assert.equal(view.session.agent_id,c.session.agent_id);
});

test('invalid required identity fails before creating a remote session or sending a model turn',async()=>{
  const c=context();c.incident.id='x'.repeat(10000);let calls=0;
  const reasoner=new EveReasoner({host:'http://127.0.0.1:2000',token:'fixture',capabilitySecret:'fixture',client:{sessions:{create:async()=>{calls++;throw new Error('Should not create a session');}}}});
  await assert.rejects(()=>reasoner.investigate(c,{persistRemote:async()=>{}}),/identity exceeds/);assert.equal(calls,0);
});

test('oversized or non-text direct operator requests fail before remote session creation',async()=>{
  let calls=0;
  const reasoner=new EveReasoner({host:'http://127.0.0.1:2000',token:'fixture',capabilitySecret:'fixture',client:{sessions:{create:async()=>{calls++;throw new Error('Should not create a session');}}}});
  for(const question of ['x'.repeat(4001),{text:'not a direct string'}])await assert.rejects(()=>reasoner.investigate(context(),{question,persistRemote:async()=>{}}),/Operator request/);
  assert.equal(calls,0);
});

test('Eve client context and capability read use the same bounded view while the console audit remains complete',async()=>{
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'});config.capabilitySecret='fixture-context-capability-secret-32';
  const runtime=await createSreRuntime({config,autoStart:false}),store=runtime.store,now=Date.now();store.clock=()=>now;
  runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');
  try {
    const {incidentId}=await store.ingest({id:'model-context',source:'dynatrace',serviceKey:'auction-local',kind:'problem',issueKey:'context',status:'OPEN',at:now,payload:{}});
    await store.db.query('UPDATE sre_jobs SET error=? WHERE incident_id=?',['CONSOLE_PRIVATE_JOB_HISTORY'.repeat(1000),incidentId]);
    await store.setRemoteState(incidentId,{opaque:'PRIVATE_REMOTE_STATE'.repeat(1000)});
    await store.addEvidence(incidentId,'operator-recovery','question',{text:'Read access restored; preserve this operator request.'});
    for(let i=0;i<12;i++)await store.addEvidence(incidentId,'logs','log',{i,text:'中文\n"'.repeat(6000)});
    const input=await store.context(incidentId);input.riskScope=riskScope(input,config.services[0],now);
    let sent;
    const session={state:{sessionId:'fixture-session',streamIndex:1},send:async(message,options)=>{sent=options.clientContext.evidence;return {result:async()=>({status:'completed',data:{summary:'Fixture model response',hypotheses:[],changeAssessment:'unknown',candidateSha:null,evidenceIds:[sent.evidence[0].id],unknowns:[],nextSteps:[],risk:fixtureRisk(sent)}})};}};
    const reasoner=new EveReasoner({host:'http://127.0.0.1:2000',token:'fixture',capabilitySecret:config.capabilitySecret,client:{sessions:{create:async()=>({session})}}});
    await reasoner.investigate(input,{persistRemote:state=>store.setRemoteState(incidentId,state)});
    const response=await fetch('http://127.0.0.1:'+runtime.server.address().port+'/internal/evidence',{headers:{authorization:'Bearer '+evidenceCapability(incidentId,config.capabilitySecret,now)}});
    assert.equal(response.status,200);const raw=await response.text();assert.ok(Buffer.byteLength(raw,'utf8')<=modelContextLimits.totalBytes);assert.deepEqual(JSON.parse(raw),sent);
    assert.equal(raw.includes('CONSOLE_PRIVATE_JOB_HISTORY'),false);assert.equal(raw.includes('PRIVATE_REMOTE_STATE'),false);
    assert.ok(sent.evidence.some(item=>item.content.text?.includes('preserve this operator request')));
    assert.match((await store.context(incidentId)).jobs[0].error,/CONSOLE_PRIVATE_JOB_HISTORY/);
  } finally {await runtime.close();}
});
