import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {get} from 'node:http';
import {validateConfig,loadConfig} from '../src/sre/config.mjs';
import {sqliteDatabase} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {prepareRestore} from '../src/sre/restore-recovery.mjs';

test('the demo can inspect a restored database without inventing a fresh ownership directory or clearing its hold',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-restored-demo-')),path=join(directory,'restored.sqlite'),config=loadConfig({SRE_SQLITE_PATH:path}),db=sqliteDatabase(path),store=await new SreStore(db,{services:config.services}).initialize();
  await prepareRestore(store,{restoreId:'demo-restored',backupSha256:'c'.repeat(64),backupAt:Date.now()-1000,reason:'Inspect a restored fixture with no directory',actor:{kind:'local-operator',id:'fixture operator'},offline:true});await db.close();
  const child=spawn(process.execPath,['scripts/sre-trial-demo.mjs'],{env:{PATH:process.env.PATH,SRE_TRIAL_DEMO_PORT:'0',SRE_TRIAL_DEMO_DATABASE:path,SRE_CLAUDE_BIN:join(directory,'claude-must-not-run')},stdio:['ignore','pipe','pipe']}),exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let output='',stderr='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  try{
    let base;for(let i=0;i<200&&!base;i++){if(child.exitCode!==null)throw Error('Restored demo exited: '+stderr);base=output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!base)await delay(50);}assert.ok(base,'Restored demo should serve its inspection UI');
    const status=await(await fetch(base+'/api/status')).json();assert.equal(status.agentMode,'rules');assert.ok(status.operations.conditions.some(c=>c.code==='database_restore_hold'));
    const check=sqliteDatabase(path);try{assert.equal(Number((await check.query('SELECT COUNT(*) AS count FROM sre_directory_snapshots'))[0].count),0);}finally{await check.close();}
  }finally{child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const result=await exit;clearTimeout(timer);await rm(directory,{recursive:true,force:true});assert.equal(result.code,0,stderr);}
});

test('the loopback trial launcher serves the real UI/API and gathers MCP fixture evidence without vendor credentials',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-trial-mcp-'));
  const child=spawn(process.execPath,['scripts/sre-trial-demo.mjs'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,SRE_CLAUDE_BIN:join(directory,'claude-must-not-run'),SRE_TRIAL_DEMO_PORT:'0',SRE_TRIAL_DEMO_DATABASE:join(directory,'demo.sqlite')},stdio:['ignore','pipe','pipe']});
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let output='',stderr='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const until=async fn=>{for(let i=0;i<200;i++){const result=await fn();if(result)return result;if(child.exitCode!==null)throw Error('Demo exited: '+stderr);await delay(50);}throw Error('Demo acceptance deadline exceeded');};
  try {
    const base=await until(()=>output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
    assert.match(await (await fetch(base)).text(),/<!doctype html>/i);
    const status=await (await fetch(base+'/api/status')).json();assert.equal(status.mode,'local');assert.equal(status.agentMode,'rules');assert.equal(status.connections.find(c=>c.source==='servicenow').transport,'mcp-mock');
    const seeded=await (await fetch(base+'/api/dev/seed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:'recent-regression'})})).json();
    const context=await until(async()=>{const result=await (await fetch(base+'/api/incidents/'+seeded.incidentId)).json();return result.evidence?.some(e=>e.kind==='incident_context')&&result.incident.analysis?result:null;});
    assert.equal(context.incident.status,'open');assert.equal(context.evidence.find(e=>e.kind==='incident_context').content.records.length,5);
    assert.ok(context.evidence.some(e=>e.kind==='incident_details'&&e.content.provenance?.tool==='get_incident_details'));
    const message=async(conversationId,text)=>{
      const response=await fetch(base+'/api/dev/teams',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversationId,conversationType:'groupChat',userId:conversationId==='test-conversation'?'alex':'sam',displayName:conversationId==='test-conversation'?'Alex':'Sam',mentioned:true,text})});
      assert.equal(response.status,202);
    };
    for(const room of ['test-conversation','trial-platform'])await message(room,'join '+seeded.incidentId);
    await until(async()=>{const c=await (await fetch(base+'/api/incidents/'+seeded.incidentId)).json();return c.collaboration.rooms.length===2;});
    await message('test-conversation','work traces active Alex is comparing affected auction traces.');
    await message('trial-platform','theory credit-pool proposed Sam suspects credit timeouts; match affected scope.');
    await message('test-conversation','sync');
    const delivered=await until(async()=>{const c=await (await fetch(base+'/api/incidents/'+seeded.incidentId)).json();return c.collaboration.rooms.length===2&&c.collaboration.rooms.every(room=>room.briefing?.deliveryStatus==='simulated')&&c.collaboration.rooms.some(room=>room.work.length)&&c.collaboration.rooms.some(room=>room.theories.length)?c:null;});
    const inbox=(await readFile(join(directory,'demo.sqlite.teams.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(new Set(inbox.filter(m=>m.text.startsWith('Shared incident coordination')).map(m=>m.conversationId)),new Set(['test-conversation','trial-platform']));
    await message('test-conversation','ack '+delivered.collaboration.briefingGeneration);
    await until(async()=>{const c=await (await fetch(base+'/api/incidents/'+seeded.incidentId)).json();return c.collaboration.rooms.find(room=>room.conversationId==='test-conversation').briefing.acknowledged;});
  } finally {
    child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const result=await exit;clearTimeout(timer);await rm(directory,{recursive:true,force:true});assert.equal(result.code,0,stderr);
  }
});

test('trial mode permits Claude but rejects live provider, Teams, public binding and remote database settings',async()=>{
  const raw=JSON.parse(await readFile(new URL('../config/sre.trial-demo.json',import.meta.url),'utf8'));
  const config=()=>structuredClone(raw);
  assert.equal(validateConfig(config(),{}).agentMode,'claude');
  for(const source of ['github','gitlab','dynatrace','dynatraceLogs','servicenow','jira','releases','logs','verification']) {
    const changed=config();changed.services[0][source]={...changed.services[0][source],enabled:true};
    assert.throws(()=>validateConfig(changed,{}),/mock evidence only/);
  }
  const hook=config();hook.services[0].releases={webhookSecretEnv:'PRIVATE_SECRET'};
  assert.throws(()=>validateConfig(hook,{}),/mock evidence only/);
  assert.throws(()=>validateConfig(config(),{SRE_TEAMS_MODE:'live'}),/Live Teams/);
  assert.throws(()=>validateConfig(config(),{SRE_HOST:'0.0.0.0'}),/loopback/);
  assert.throws(()=>validateConfig(config(),{DATABASE_URL:'postgres://synthetic.invalid/db'}),/SQLite/);
  assert.throws(()=>validateConfig(config(),{SRE_AGENT_MODE:'rules'}),/Trial mode uses Claude/);
});

test('explicit Claude demo invokes print mode for chat and enforces explicit authorized simulated rollback',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-trial-claude-')),command=join(directory,'fake-claude'),record=join(directory,'calls.jsonl');
  const riskModule=fileURLToPath(new URL('../src/sre/analytic-risk.mjs',import.meta.url));
  await writeFile(command,'#!'+process.execPath+'\n'+`
import {appendFileSync} from 'node:fs';
import {fixtureRisk} from ${JSON.stringify(riskModule)};
let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input),context=request.incident;
appendFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),request,envKeys:Object.keys(process.env)})+'\\n');
const current=context.deployments.filter(d=>d.at<=context.incident.started_at).sort((a,b)=>b.at-a.at)[0];
const result={summary:request.request.slice(0,600),hypotheses:['Synthetic deployment regression.'],changeAssessment:'likely',candidateSha:current.sha,evidenceIds:context.evidence.filter(e=>e.kind==='problem').map(e=>e.id),unknowns:['Real vendor acceptance is unverified.'],nextSteps:['Review the exact artifact and explicit approval.'],risk:fixtureRisk(context),codeFindings:[],teamsMessages:[],issueSpec:{title:'Review fixture',problem:'Fixture signal.',impact:'Fictional impact.',proposedChange:'Review source.',acceptanceCriteria:['Check fixture.'],evidenceIds:[],openQuestions:['Live validation pending.']}};
process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:result}));
`,{mode:0o700});
  const child=spawn(process.execPath,['scripts/sre-trial-demo.mjs'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,SRE_TRIAL_DEMO_AGENT_MODE:'claude',SRE_CLAUDE_BIN:command,SRE_AGENT_MODE:'eve',SRE_TEAMS_MODE:'live',DATABASE_URL:'postgres://synthetic.invalid/db',GITLAB_ROLLBACK_TOKEN:'PRIVATE_WRITER_MARKER',SRE_TRIAL_DEMO_PORT:'0',SRE_TRIAL_DEMO_DATABASE:join(directory,'demo.sqlite')},stdio:['ignore','pipe','pipe']});
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let output='',stderr='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const until=async fn=>{for(let i=0;i<300;i++){const result=await fn();if(result)return result;if(child.exitCode!==null)throw Error('Demo exited: '+stderr);await delay(50);}throw Error('Demo acceptance deadline exceeded');};
  try {
    const base=await until(()=>output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
    const api=async(path,body,headers={})=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});assert.equal(response.ok,true,await response.clone().text());return response.json();};
    let status=await api('/api/status');assert.equal(status.mode,'trial');assert.equal(status.agentMode,'claude');assert.equal(status.simulation,true);assert.equal(status.teamsMode,'off');assert.ok(status.connections.every(c=>!c.enabled));
    assert.equal((await fetch(base+'/api/status',{headers:{origin:'https://outside.invalid'}})).status,403);
    const foreignHost=await new Promise((resolve,reject)=>get(base+'/api/status',{headers:{host:'outside.invalid'}},response=>{response.resume();resolve(response.statusCode);}).once('error',reject));assert.equal(foreignHost,403);
    assert.equal((await fetch(base+'/webhooks/gitlab/auction-local',{method:'POST',body:'{}'})).status,403);
    const seeded=await api('/api/dev/seed',{scenario:'recent-regression'}),path='/api/incidents/'+seeded.incidentId;
    let context=await until(async()=>{const c=await api(path);return c.incident.analysis?.mode==='claude'?c:null;});
    assert.equal(context.rollback.eligible,true);assert.equal(context.evidence.find(e=>e.kind==='incident_context').content.records.length,5);
    const agentId=context.session.agent_id,question='Explain the safe target and why approval is required.';
    await api(path+'/questions',{text:question});
    context=await until(async()=>{const c=await api(path);return c.incident.analysis?.summary===question?c:null;});
    assert.equal(context.session.agent_id,agentId);assert.ok(context.conversation.some(t=>t.role==='operator'&&t.text===question));assert.ok(context.conversation.some(t=>t.mode==='claude'&&t.summary===question));
    const teams=async(text,userId='local-operator')=>api('/api/dev/teams',{text,userId,conversationType:'channel',conversationId:'test-conversation;messageid=42'});
    await teams('rollback '+seeded.incidentId);
    const proposal=await until(async()=>{const s=await api('/api/status');return s.rollbacks.find(r=>r.incident_id===seeded.incidentId);});
    assert.equal(proposal.status,'pending');assert.equal(proposal.proposal.simulation,true);
    const approval=proposal.proposal.approvalText.match(/^An authorized approver must send: (approve .+)$/m)[1];
    await teams(approval,'alex');
    status=await until(async()=>{const s=await api('/api/status');return s.outbox.some(m=>m.text.includes('not an authorized rollback approver'))?s:null;});
    assert.equal(status.rollbacks[0].status,'pending');
    await teams(approval);
    status=await until(async()=>{const s=await api('/api/status');return s.rollbacks[0]?.status==='simulated'?s:null;});
    assert.equal(status.rollbacks[0].approved_by,'local-operator');assert.equal(JSON.parse(status.rollbacks[0].external_ref).status,'simulated');assert.equal((await api(path)).incident.status,'open');assert.equal((await api(path)).rollback.eligible,false,'the UI must disable replaying a completed simulation');
    const calls=(await readFile(record,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);
    assert.ok(calls.every(c=>c.args[0]==='-p'&&c.args.includes('--restricted')&&c.args.includes('--strict-mcp-config')));
    assert.ok(calls.every(c=>!c.envKeys.includes('GITLAB_ROLLBACK_TOKEN')&&!c.envKeys.includes('DATABASE_URL')));
    assert.equal(calls[1].request.request,question);assert.ok(calls[1].request.incident.assessmentHistory.length);
  } finally {
    child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const result=await exit;clearTimeout(timer);await rm(directory,{recursive:true,force:true});assert.equal(result.code,0,stderr);
  }
});

test('missing Claude in the explicit Claude trial surfaces a failed job without publishing rules analysis',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sre-trial-missing-'));
  const child=spawn(process.execPath,['scripts/sre-trial-demo.mjs'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,SRE_TRIAL_DEMO_AGENT_MODE:'claude',SRE_CLAUDE_BIN:join(directory,'missing-claude'),SRE_TRIAL_DEMO_PORT:'0',SRE_TRIAL_DEMO_DATABASE:join(directory,'demo.sqlite')},stdio:['ignore','pipe','pipe']});
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let output='',stderr='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const until=async fn=>{for(let i=0;i<240;i++){const result=await fn();if(result)return result;if(child.exitCode!==null)throw Error('Demo exited: '+stderr);await delay(50);}throw Error('Missing CLI error was not observed');};
  try {
    const base=await until(()=>output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
    const seeded=await (await fetch(base+'/api/dev/seed',{method:'POST',body:JSON.stringify({scenario:'recent-regression'})})).json();
    const c=await until(async()=>{const c=await (await fetch(base+'/api/incidents/'+seeded.incidentId)).json();return c.jobs.some(j=>j.error?.includes('Claude CLI could not start'))?c:null;});
    assert.equal(c.incident.analysis,null);assert.equal(c.conversation.filter(t=>t.role==='assistant').length,0);assert.equal(c.rollback.eligible,false);
  } finally {
    child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const result=await exit;clearTimeout(timer);await rm(directory,{recursive:true,force:true});assert.equal(result.code,0,stderr);
  }
});
