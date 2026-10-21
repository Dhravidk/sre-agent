import test from 'node:test';
import assert from 'node:assert/strict';
import {createSreRuntime} from '../src/sre/server.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';
import {fictionalDirectory} from '../fixtures/ownership-directory.mjs';
import {seedDemo,devActivity} from '../src/sre/demo.mjs';
import {hash} from '../src/sre/security.mjs';
import {assessmentBrief,assessmentBriefLimits} from '../src/sre/assessment-brief.mjs';
import {contactsBriefText} from '../src/sre/contact-messages.mjs';

async function fixture(){
 const config=validateConfig(rehearsalProfile(),{SRE_SQLITE_PATH:':memory:',SRE_CLAUDE_BIN:'/nonexistent-assessment-brief-cli'}),service=config.services[0],sent=[];
 const r=await createSreRuntime({config,autoStart:false,connectors:new Map([[service.key,{}]]),sender:{send:async(ref,text)=>{sent.push({room:ref.conversation.id,text});return {id:'briefing-fixture-'+sent.length,simulation:true};}}});
 let now=Date.now(),sequence=0;r.store.clock=()=>now;const f={r,service,rooms:service.teams.conversations.slice(0,3),sent,now:()=>now,advance:ms=>now+=ms};
 f.send=async(room,text,user='local-operator')=>{now++;const sample=devActivity(text,service,{id:'briefing-'+ ++sequence,conversationId:f.rooms[room],conversationType:'groupChat',userId:user,displayName:user+' · fictional responder'});sample.activity.timestamp=new Date(now).toISOString();const receipt=await r.router.accept(sample.activity,sample.reference);await r.router.processOnce();return receipt;};
 f.settle=async()=>{for(let n=0;n<50;n++){const [pending]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(pending.count))return;assert.equal(await r.worker.runOnce(),true);}throw Error('Briefing fixture did not settle');};
 f.drain=async()=>{for(let n=0;n<200&&await r.outbox.runOnce();n++);await r.outbox.drainSettled();};
 // The fixture clock can give successive revisions the same completion time.
 // Select the newest revision instead of a random hash at that timestamp.
 f.rows=async()=>{const assessments=await r.store.db.query('SELECT id FROM sre_assessments WHERE incident_id=? ORDER BY revision DESC,evaluated_at DESC,id DESC',[f.id]);const [latest]=assessments;assert.ok(latest);const key=hash(['analysis',latest.id]);return r.store.db.query('SELECT * FROM sre_outbox WHERE id=? OR id LIKE ? ORDER BY id',[key,key+':%']);};
 f.id=(await seedDemo(r.store,service)).incidentId;await r.casework.importDirectory(service.key,fictionalDirectory(now));for(let room=0;room<3;room++)await f.send(room,'join '+f.id);await f.settle();await f.drain();sent.length=0;
 return f;
}

test('an unchanged Teams question answers its origin without broadcasting the same assessment to the other groups',async()=>{
 const f=await fixture();try{await f.send(0,'What should I compare in the bid ledger?','avery');await f.settle();const rows=await f.rows();assert.equal(rows.length,1);assert.ok(rows[0].text.includes('operator request'));assert.equal(rows[0].conversation_key,hash([f.service.teams.tenantId,f.rooms[0]]).slice(0,32));assert.ok((await f.r.store.context(f.id)).incident.analysis.text.includes('What should I compare'));}finally{await f.r.close();}
});

test('an unchanged console question remains saved without creating a notification in every Teams conversation',async()=>{
 const f=await fixture();try{await f.r.store.ingest({id:'console-brief-question',source:'operator-api',serviceKey:f.service.key,incidentId:f.id,kind:'question',at:f.now(),payload:{text:'Explain the existing source finding again.'}});await f.settle();assert.equal((await f.rows()).length,0);assert.ok((await f.r.store.conversation(f.id)).some(turn=>turn.role==='operator'&&turn.text.includes('Explain the existing')));}finally{await f.r.close();}
});

test('material changes reach peer teams as bounded briefs that retain a handoff hidden behind a long direct answer',async()=>{
 const f=await fixture();try{
  await f.send(1,'work eu-ledger active Earlier window; this is not acceptance of a later handoff.','noor');await f.send(0,'work eu-ledger released A new exact-source replay needs a receiving owner.','avery');
  for(let n=0;n<5;n++)await f.send(2,'update Worker trace '+n+': '+('EU request timing is still being compared; these are unverified observations. ').repeat(22),'worker-'+n);
  await f.r.store.addEvidence(f.id,'dynatrace','problem',{metrics:{codes:['CREDIT_PROVIDER_UNAVAILABLE'],requests:3}},f.now());await f.send(0,'Summarize the independent failures and the unaccepted handoff.','avery');await f.settle();const context=await f.r.store.context(f.id);assert.ok(Buffer.byteLength(context.incident.analysis.text)>14000,'This must exercise the real oversized-answer path');await f.drain();
  for(const room of f.rooms.slice(1)){const [notice]=f.sent.filter(m=>m.room===room&&/^Incident brief/.test(m.text));assert.ok(notice,'A material update needs a peer briefing');assert.ok(Buffer.byteLength(notice.text)<=11000);assert.match(notice.text,/Handoff gap.*eu-ledger/);assert.match(notice.text,/CREDIT_PROVIDER_UNAVAILABLE|credit provider/i);assert.match(notice.text,/coverage|sample/i);assert.match(notice.text,/not.*recovery|recovery.*not|unverified/i);}
  assert.match(context.incident.analysis.text,/Worker trace/);assert.equal(context.incident.status,'open');
 }finally{await f.r.close();}
});

test('brief reads the retained assessment without creating an investigation and warns when new evidence is awaiting review',async()=>{
 const f=await fixture();try{
  const count=Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_jobs'))[0].count);await f.send(0,'brief','avery');assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_jobs'))[0].count),count);
  let [reply]=await f.r.store.db.query("SELECT text FROM sre_outbox WHERE text LIKE 'Incident brief%' ORDER BY created_at DESC LIMIT 1");assert.ok(reply);assert.match(reply.text,/revision/);
  await f.send(1,'update New evidence needs review; it is not confirmation of recovery.','noor');await f.send(0,'brief','avery');const rows=await f.r.store.db.query("SELECT text FROM sre_outbox WHERE text LIKE 'Incident brief%' ORDER BY created_at DESC LIMIT 1");assert.match(rows[0].text,/awaiting|outdated|historical|pending/i);assert.match(rows[0].text,/not.*recovery|recovery.*not|unverified/i);
 }finally{await f.r.close();}
});

test('separate responders receive their own full answers while a quiet peer receives no repeated assessment',async()=>{
 const f=await fixture();try{const before=(await f.r.store.context(f.id)).session.agent_id;await f.send(0,'Which request should Avery compare?','avery');await f.settle();assert.equal((await f.rows()).length,1);await f.send(1,'What should Noor check next?','noor');await f.settle();assert.equal((await f.rows()).length,1);await f.drain();assert.ok(!f.sent.some(m=>m.room===f.rooms[2]&&/^Incident brief|^inc_/.test(m.text)));const view=await f.r.store.context(f.id);assert.equal(view.session.agent_id,before);const replies=await f.r.store.conversation(f.id);assert.ok(replies.some(r=>r.role==='assistant'&&r.text.includes('Which request should Avery')));assert.ok(replies.some(r=>r.role==='assistant'&&r.text.includes('What should Noor')));}finally{await f.r.close();}
});

test('a changed risk assumption informs peers even when the summary and likelihood are unchanged',async()=>{
 const f=await fixture();const original=f.r.worker.reasoner.investigate.bind(f.r.worker.reasoner);try{
  f.r.worker.reasoner.investigate=async(...args)=>{const result=await original(...args);result.analysis.risk.assumptions=['The previous exact release reproduces the dependency failure; deployment identity does not establish cause.'];return result;};
  await f.send(0,'Reconsider the assumptions behind the same summary.','avery');await f.settle();const rows=await f.rows();assert.equal(rows.length,3);const briefs=rows.filter(r=>r.text.startsWith('Incident brief'));assert.equal(briefs.length,2);assert.ok(briefs.every(r=>r.text.includes('previous exact release')));
 }finally{await f.r.close();}
});

test('reordering equivalent hypotheses and unknowns does not manufacture a peer update',async()=>{
 const f=await fixture();const original=f.r.worker.reasoner.investigate.bind(f.r.worker.reasoner);try{f.r.worker.reasoner.investigate=async(...args)=>{const result=await original(...args);result.analysis.hypotheses.reverse();result.analysis.unknowns.reverse();return result;};await f.send(0,'Restate the existing evidence.','avery');await f.settle();assert.equal((await f.rows()).length,1);}finally{await f.r.close();}
});

test('a queued compact brief refreshes its contact section while keeping its original body and source audit',async()=>{
 const f=await fixture();try{await f.send(0,'brief','avery');const [queued]=await f.r.store.db.query("SELECT * FROM sre_outbox WHERE text LIKE 'Incident brief%' AND status='pending' ORDER BY created_at DESC LIMIT 1");assert.match(queued.text,/Noor/);const [provenance]=await f.r.store.db.query('SELECT value FROM sre_checkpoints WHERE id=?',['outbox-contact:'+queued.id]);assert.equal(JSON.parse(provenance.value).format,'brief');f.advance(2);const directory=fictionalDirectory(f.now());directory.entries=directory.entries.map(e=>e.role==='on-call'?{...e,id:'asha',name:'Asha Rao',contact:'asha@example.invalid'}:e);await f.r.casework.importDirectory(f.service.key,directory);await f.drain();const [delivered]=f.sent.filter(m=>m.text.includes('Incident brief'));assert.match(delivered.text,/Asha/);assert.doesNotMatch(delivered.text,/Noor/);assert.match(delivered.text,/changed while.*queued/);assert.equal((await f.r.store.db.query('SELECT text FROM sre_outbox WHERE id=?',[queued.id]))[0].text,queued.text);const [audit]=await f.r.store.db.query('SELECT value FROM sre_checkpoints WHERE id=?',['contact-delivery:'+queued.id+':1']);assert.equal(JSON.parse(audit.value).renderedText,delivered.text);}finally{await f.r.close();}
});

test('legacy full contact provenance without a format still refreshes and an unknown format prevents sending',async()=>{
 for(const format of [null,'invented']){const f=await fixture();try{await f.send(0,'contacts','avery');const [queued]=await f.r.store.db.query("SELECT * FROM sre_outbox WHERE text LIKE 'Who to contact%' AND status='pending'");const [row]=await f.r.store.db.query('SELECT value FROM sre_checkpoints WHERE id=?',['outbox-contact:'+queued.id]);const provenance=JSON.parse(row.value);if(format===null)delete provenance.format;else provenance.format=format;await f.r.store.db.query('UPDATE sre_checkpoints SET value=? WHERE id=?',[JSON.stringify(provenance),'outbox-contact:'+queued.id]);await f.drain();if(format===null)assert.ok(f.sent.some(m=>m.text.includes('Noor')));else{assert.equal(f.sent.length,0);assert.equal((await f.r.store.db.query('SELECT status FROM sre_outbox WHERE id=?',[queued.id]))[0].status,'unknown');}}finally{await f.r.close();}}
});

test('worst-case Unicode brief stays bounded and retains rare signals, scoped commits, handoffs and explicit omissions',()=>{
 const text='🧪故障'.repeat(1200),sha='b'.repeat(40),base='a'.repeat(40),id='c'.repeat(64),at=Date.now(),contacts={state:'current',directoryId:'dir_'+id,observedAt:at,validUntil:at+60000,contacts:Array.from({length:100},(_,n)=>({id:'owner-'+n,name:n===99?'Current Oncall':text,team:text,role:n===99?'on-call':'component-owner',contact:text,reason:text,endsAt:at+60000})),unknowns:Array(20).fill(text)};
 const analysis={mode:'rules',summary:text,changeAssessment:'unknown',risk:{likelihood:'unknown',confidence:'low',assumptions:Array(20).fill(text),alternatives:Array(20).fill(text)},hypotheses:Array(20).fill(text),unknowns:Array(20).fill(text),nextSteps:Array(20).fill(text),rollback:{eligible:false,reasons:Array(20).fill(text)},contacts,evidenceIds:[id],codeReview:{findings:Array.from({length:20},()=>({signal:'WINNING_BID_REGRESSED',path:text,baseSha:base,headSha:sha,issue:text,evidenceId:id}))},trackedChanges:Array.from({length:10},()=>({provider:'gitlab',number:900731,headSha:sha,ci:{status:'failed'}}))};
 const context={incident:{id:'inc_'+id.slice(0,20),revision:17,status:'open'},assessmentStatus:{state:'current'},signalDigest:{groups:Array.from({length:20},(_,n)=>({level:'ERROR',code:n?'OTHER':'RARE_CRITICAL_ERROR',message:text,environment:text,region:text,version:sha,observations:1})),coverage:{recordsScanned:2000,omittedGroups:2000,partialResults:1,candidateWindowLimited:true}},collaboration:{issues:[...Array.from({length:40},()=>({code:'stale-team-state',text})),{code:'unaccepted-handoff',text:'Handoff gap on eu-ledger: a receiver must explicitly accept.'}]}};
 const before=JSON.stringify({context,analysis}),brief=assessmentBrief(context,analysis);assert.ok(Buffer.byteLength(brief)<=assessmentBriefLimits.bytes);assert.match(brief,/RARE_CRITICAL_ERROR/);assert.match(brief,/Sample: "/);assert.ok(brief.includes(base)&&brief.includes(sha));assert.match(brief,/Handoff gap on eu-ledger/);assert.match(brief,/Current Oncall/);assert.match(brief,/8\/20/);assert.match(brief,/3\/100 contacts/);assert.match(brief,/partial\/sampled/);assert.match(brief,/source window limited/);assert.doesNotMatch(brief,/�|Message shortened/);assert.equal(JSON.stringify({context,analysis}),before);assert.ok(Buffer.byteLength(contactsBriefText(contacts))<2800);
});

test('retained rollback eligibility cannot appear as current after new evidence or a restore',async()=>{
 const f=await fixture();try{const context=await f.r.store.context(f.id),analysis={...context.incident.analysis,rollback:{eligible:true,targetSha:'b'.repeat(40)}};for(const view of [{...context,assessmentStatus:{state:'outdated'}},{...context,recoveryFence:{active:true}}]){const brief=assessmentBrief(view,analysis);assert.match(brief,/eligibility is historical/);assert.doesNotMatch(brief,/eligible to request/);}const missing=assessmentBrief({...context,assessmentStatus:{state:'missing'}},null);assert.match(missing,/No saved assessment/);assert.doesNotMatch(missing,/Change assessment: likely/);}finally{await f.r.close();}
});
