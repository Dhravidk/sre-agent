import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createSreRuntime} from '../src/sre/server.mjs';
import {loadConfig} from '../src/sre/config.mjs';
import {postgresSql,StorageError} from '../src/sre/database.mjs';
import {GitlabConnector,GithubConnector} from '../src/sre/connectors.mjs';
import {normalize} from '../src/sre/normalize.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {changeReadReceipt,providerChangeSnapshot,providerChangeEvent,readTrackedChanges} from '../src/sre/change-read.mjs';
import {pollScopeHash} from '../src/sre/poll-scope.mjs';
import {prepareRestore,releaseRestore} from '../src/sre/restore-recovery.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {hash} from '../src/sre/security.mjs';

const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40),d='d'.repeat(40);
const operator={kind:'local-operator',id:'fictional operator'};
const gate=()=>{let release,enter;return {waiting:new Promise(r=>release=r),started:new Promise(r=>enter=r),release:()=>release(),enter:()=>enter()};};
async function fixture(dialect,{path=':memory:',provider='gitlab'}={}){
  let db;if(dialect==='postgres'){const pg=new PGlite();db={dialect,query:async(sql,args=[])=>(await pg.query(postgresSql(sql),args)).rows,transaction:fn=>pg.transaction(tx=>fn(async(sql,args=[])=>(await tx.query(postgresSql(sql),args)).rows)),close:()=>pg.close()};}
  const config=loadConfig({SRE_SQLITE_PATH:path}),service=config.services[0],rooms=['bidding','platform','workers','other-team'];
  service.teams={...service.teams,conversations:rooms,captureResponderUpdates:true,collaborationGroups:[{key:'incident',name:'Fictional response',conversations:rooms.map(id=>({id,name:id}))}]};
  service[provider]={...service[provider],enabled:true,base:'https://repository-fixture.invalid',tokenEnv:'TOKEN',...(provider==='gitlab'?{project:'17'}:{repository:'fictional/auction'})};
  let time=Date.now()-30000,sequence=0;const states=new Map(),calls=[],denied=new Set(),reviewHeads=[];
  const raw=(n,head,{state=provider==='gitlab'?'opened':'open',updatedAt=++time,pipeline=null,...overrides}={})=>provider==='gitlab'?{iid:n,project_id:17,state,sha:head,diff_refs:{head_sha:head,base_sha:a,start_sha:a},merge_commit_sha:state==='merged'?d:null,updated_at:new Date(updatedAt).toISOString(),title:'Fictional winning-bid forward fix',description:'Compare exact commits and accepted bid order.',web_url:'https://repository-fixture.invalid/merge_requests/'+n,changes_count:'0',head_pipeline:pipeline,...overrides}:{number:n,state:state==='merged'?'closed':state,merged:state==='merged',head:{sha:head},base:{sha:a,repo:{full_name:'fictional/auction'}},merge_commit_sha:state==='merged'?d:c,updated_at:new Date(updatedAt).toISOString(),title:'Fictional winning-bid forward fix',body:'Compare exact commits and accepted bid order.',html_url:'https://repository-fixture.invalid/pull/'+n,changed_files:0,...overrides};
  const fetcher=async(url,options)=>{
    assert.equal(options.method,'GET');const u=new URL(url);calls.push(u.pathname);const match=u.pathname.match(/\/(?:merge_requests|pulls)\/(\d+)(\/diffs|\/files)?$/);
    if(match){const n=Number(match[1]);if(denied.has(n))return new Response('{}',{status:404});if(!states.has(n))return new Response('{}',{status:404});return new Response(JSON.stringify(match[2]?[]:states.get(n)),{status:200});}
    if(u.pathname.endsWith('/deployments'))return new Response('[]',{status:200});
    if(u.pathname.endsWith('/check-runs'))return new Response('{"total_count":0,"check_runs":[]}',{status:200});
    if(u.pathname.endsWith('/status'))return new Response(JSON.stringify({sha:b,state:'pending',total_count:0,statuses:[]}),{status:200});
    if(u.pathname.includes('/compare/'))return new Response(JSON.stringify({merge_base_commit:{sha:a},files:[]}),{status:200});
    return new Response('{}',{status:404});
  };
  const client=provider==='gitlab'?new GitlabConnector(service.gitlab,{env:{TOKEN:'fictional-token'},fetcher}):new GithubConnector(service.github,{env:{TOKEN:'fictional-token'},fetcher});
  const reviewMethod=provider==='gitlab'?'mergeRequest':'pull',review=client[reviewMethod].bind(client);client[reviewMethod]=async(n,options)=>{reviewHeads.push(options.expectedSha);return review(n,options);};
  const r=await createSreRuntime({config,db,connectors:new Map([[service.key,{[provider]:client}]]),autoStart:false});
  const issue=(id,title)=>({id,source:'dynatrace',serviceKey:service.key,kind:'problem',issueKey:id,status:'OPEN',at:Date.now()-60000,title,payload:{problemId:id,metrics:{codes:[id==='bidding'?'WINNING_BID_REGRESSED':'CREDIT_PROVIDER_UNAVAILABLE']}}});
  const id=(await r.store.ingest(issue('bidding','Fictional accepted-bid ordering'))).incidentId,other=(await r.store.ingest(issue('upstream','Fictional independent upstream timeout'))).incidentId;
  const send=async(room,text,user='local-operator')=>{const m=devActivity(text,service,{id:'poll-chat-'+ ++sequence,conversationId:room,conversationType:'groupChat',userId:user,displayName:user});await r.router.accept(m.activity,m.reference);await r.router.processOnce();};
  for(const room of rooms.slice(0,3))await send(room,'join '+id);await send(rooms[3],'join '+other);
  const webhook=async(n,head,options={})=>{
    const s=raw(n,head,options);states.set(n,s);
    return r.store.ingest(normalize(provider,provider==='gitlab'?{project:{id:17},object_kind:'merge_request',object_attributes:{iid:n,state:s.state,last_commit:{id:head},merge_commit_sha:s.merge_commit_sha,updated_at:s.updated_at,title:s.title,description:s.description,url:s.web_url}}:{repository:{full_name:service.github.repository},action:s.state==='closed'?'closed':'opened',pull_request:s},service,{eventType:'pull_request',deliveryId:'initial-'+ ++sequence}));
  };
  const link=async(n,head=a)=>{await webhook(n,head);return r.casework.trackChange(id,provider,n,operator);};
  const settle=async()=>{for(let n=0;n<60;n++){const [active]=await r.store.db.query("SELECT COUNT(*) AS count FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(active.count))return;await r.worker.runOnce();}throw Error('Polling fixture did not settle');};
  return {r,config,service,provider,rooms,id,other,raw,states,calls,denied,reviewHeads,send,webhook,link,settle,advance:()=>time+=1000,receipt:n=>changeReadReceipt(r.store.db.query,service,provider,n,r.store.db.dialect)};
}

for(const dialect of ['sqlite','postgres']){
  test(dialect+': missed MR webhooks are reconciled at the current head and only the joined incident teams are informed',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);await f.send('bidding','theory ordering supported Fictional ledger replay shows lower-bid overwrite.','avery');await f.send('platform','theory upstream proposed Fictional credit latency may explain the symptoms; compare the same requests.','noor');await f.send('workers','work replay active Fictional independent replay checks the accepted order.','sam');await f.send('workers','update Fictional quiet worker preserves an unusual bid trace.','robin');await f.settle();
      const before=await f.r.store.context(f.id),other=await f.r.store.context(f.other);f.states.set(72,f.raw(72,b));await f.r.poller.runOnce();
      const read=await f.receipt(72);assert.equal(read.complete,true);assert.equal(read.headSha,b);assert.ok(read.readCompletedAt>read.providerUpdatedAt);assert.equal((await f.r.store.context(f.other)).incident.revision,other.incident.revision);assert.ok(Number((await f.r.store.context(f.id)).incident.revision)>Number(before.incident.revision));
      await f.settle();assert.ok(f.reviewHeads.includes(b),'Associated forward-fix code must be collected at the new pinned head');const view=await f.r.store.context(f.id);assert.equal(view.session.agent_id,before.session.agent_id);assert.equal(view.collaboration.rooms.length,3);assert.ok(view.evidence.some(e=>e.kind==='code_review'&&e.content.headSha===b));
      const messages=(await f.r.store.snapshot()).outbox.filter(o=>o.incident_id===f.id);assert.ok(new Set(messages.map(o=>o.conversation_key)).size===3);assert.equal((await f.r.store.context(f.other)).incident.revision,other.incident.revision);
    }finally{await f.r.close();}
  });
  test(dialect+': unchanged metadata reads refresh proof without changing revision, plans, work or remote-effect records',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);await f.r.poller.runOnce();await f.settle();const plan=await f.r.casework.createPlan(f.id),before=await f.r.store.context(f.id),jobs=await f.r.store.db.query('SELECT id FROM sre_jobs ORDER BY id'),events=await f.r.store.db.query('SELECT id FROM sre_events ORDER BY id');
      await f.r.poller.runOnce();await f.r.poller.runOnce();assert.equal((await f.r.store.context(f.id)).incident.revision,before.incident.revision);assert.deepEqual(await f.r.store.db.query('SELECT id FROM sre_jobs ORDER BY id'),jobs);assert.deepEqual(await f.r.store.db.query('SELECT id FROM sre_events ORDER BY id'),events);assert.equal((await f.r.casework.snapshot(f.id)).plans.find(p=>p.id===plan.id).current,true);assert.equal((await f.receipt(72)).complete,true);
      assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_fix_requests'))[0].count),0);assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_rollbacks'))[0].count),0);assert.match((await f.r.casework.createPlan(f.id)).markdown,/Provider read: gitlab #72/);
    }finally{await f.r.close();}
  });
  test(dialect+': GitLab head CI and merge state are retained separately from deployment or recovery',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const updatedAt=f.advance(),pipeline={id:91,project_id:17,sha:b,status:'running',updated_at:new Date(updatedAt).toISOString(),web_url:'https://repository-fixture.invalid/pipeline/91'};f.states.set(72,f.raw(72,b,{pipeline}));await f.r.poller.runOnce();
      const first=(await f.r.store.context(f.id)).incident.revision;f.states.set(72,{...f.states.get(72),head_pipeline:{...pipeline,status:'success',updated_at:new Date(f.advance()).toISOString()}});await f.r.poller.runOnce();assert.ok(Number((await f.r.store.context(f.id)).incident.revision)>Number(first));
      f.states.set(72,f.raw(72,b,{state:'merged',pipeline:{...pipeline,status:'success',sha:d,updated_at:new Date(f.advance()).toISOString()}}));await f.r.poller.runOnce();const timeline=await f.r.casework.timeline(f.id);assert.ok(timeline.items.some(c=>c.stage==='merge'&&c.payload.mergedSha===d));assert.ok(timeline.items.some(c=>c.stage==='ci-update'&&c.head_sha===d));assert.equal((await f.r.store.context(f.id)).incident.status,'open');assert.equal((await f.r.store.context(f.id)).deployments.length,0);
      f.states.set(72,f.raw(72,b,{state:'merged',pipeline:{...pipeline,sha:'e'.repeat(40)}}));await f.r.poller.runOnce();assert.equal((await f.receipt(72)).ci.state,'unknown');assert.match((await f.receipt(72)).ci.note,/different|synthetic/);
    }finally{await f.r.close();}
  });
  test(dialect+': a delayed old provider read cannot roll back an accepted head or certify freshness',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);await f.r.poller.runOnce();const newer=Date.now()-1000;await f.webhook(72,c,{updatedAt:newer});const current=await f.r.store.context(f.id);f.states.set(72,f.raw(72,b,{updatedAt:newer-1000}));await f.r.poller.runOnce();
      assert.equal((await f.r.store.context(f.id)).incident.revision,current.incident.revision);assert.equal((await f.receipt(72)).complete,false);assert.match((await f.receipt(72)).error,/older/);assert.ok((await f.r.operations.snapshot()).conditions.some(c=>c.code==='instance_poll_error'));assert.ok((await f.r.casework.timeline(f.id)).items.some(c=>c.head_sha===b),'The late observation remains in the audit');
    }finally{await f.r.close();}
  });
  test(dialect+': a fresh unchanged post-restore read reaffirms an old provider timestamp without fabricating an MR update',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);await f.r.poller.runOnce();const first=await f.receipt(72),fence=await prepareRestore(f.r.store,{restoreId:'provider-read-restore',backupSha256:'a'.repeat(64),backupAt:Date.now()-60000,reason:'Fictional offline read recovery',actor:operator,offline:true});
      await releaseRestore(f.r.store,{restoreId:fence.restoreId,requestId:'read-release',reason:'Reviewed isolated fixture',actor:operator,observedAt:await f.r.store.coordinationNow(),evidenceUrls:['https://fixture.invalid/read-restore']});await assert.rejects(f.r.casework.trackChange(f.id,'gitlab',72,operator),/historical/);
      await f.r.poller.runOnce();const fresh=await f.receipt(72);assert.equal(fresh.providerUpdatedAt,first.providerUpdatedAt);assert.equal(fresh.restoreId,fence.restoreId);assert.ok(fresh.readStartedAt>=fence.preparedAt);const linked=await f.r.casework.trackChange(f.id,'gitlab',72,operator);assert.equal(linked.duplicate,false);assert.equal((await f.r.casework.timeline(f.id)).links.find(l=>l.change_number==='72').historicalAfterRestore,undefined);
      const [e]=await f.r.store.db.query('SELECT content FROM sre_evidence WHERE id=?',[linked.evidenceId]);const proof=JSON.parse(e.content).providerObservation;assert.equal(proof.readObservation.providerUpdatedAt,first.providerUpdatedAt);assert.ok(proof.readObservation.completedAt>=fence.preparedAt);
    }finally{await f.r.close();}
  });
  test(dialect+': receipt commit failure rolls back provider facts and revisions and exact retry recovers once',async()=>{
    const f=await fixture(dialect),transaction=f.r.store.db.transaction.bind(f.r.store.db);try{
      await f.link(72);f.states.set(72,f.raw(72,b));const before=(await f.r.store.context(f.id)).incident.revision;
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const rows=await q(sql,args);if(sql.startsWith('UPDATE sre_checkpoints')&&String(args[2]).startsWith('change-read:'))throw new StorageError(new Error('Injected receipt commit failure'));return rows;}));await f.r.poller.runOnce();f.r.store.db.transaction=transaction;
      assert.equal((await f.r.store.context(f.id)).incident.revision,before);assert.equal(await f.receipt(72),null);assert.ok(!(await f.r.casework.timeline(f.id)).items.some(c=>c.head_sha===b));await f.r.poller.runOnce();const after=(await f.r.store.context(f.id)).incident.revision;assert.ok(Number(after)>Number(before));await f.r.poller.runOnce();assert.equal((await f.r.store.context(f.id)).incident.revision,after);
    }finally{f.r.store.db.transaction=transaction;await f.r.close();}
  });
  test(dialect+': a withdrawn MR read never re-joins its former incident, and metadata stays in model and Markdown without granting approval',async()=>{
    const f=await fixture(dialect);try{
      const association=await f.link(72);await f.r.poller.runOnce();await f.r.casework.withdrawChange(f.id,'gitlab',72,operator,{expectedEvidenceId:association.evidenceId,reason:'Fictional different incident scope'});const revision=(await f.r.store.context(f.id)).incident.revision;f.states.set(72,f.raw(72,b));await f.r.poller.runOnce();assert.equal((await f.r.store.context(f.id)).incident.revision,revision);assert.ok(!(await f.r.casework.timeline(f.id)).links.some(l=>l.change_number==='72'));
      await f.r.casework.trackChange(f.id,'gitlab',72,operator,{reconsiderEvidenceId:(await f.r.store.context(f.id)).changeAssociations.controls[0].evidenceId,reason:'Fictional exact scope reconciled'});await f.settle();const context=await f.r.store.context(f.id),model=boundedContext(context);assert.equal(model.changeAssociations.reads[0].headSha,b);assert.equal(model.changeAssociations.reads[0].ci.state,'unknown');assert.match((await f.r.casework.createPlan(f.id)).markdown,/read completed/);assert.equal(Number((await f.r.store.db.query('SELECT COUNT(*) AS count FROM sre_fix_requests'))[0].count),0);
    }finally{await f.r.close();}
  });
}

test('tracked read scheduling progresses beyond a denied hot reference and preserves incomplete coverage',async()=>{
  const f=await fixture('sqlite');try{
    for(let n=1;n<=23;n++)await f.link(n);f.denied.add(1);await f.r.poller.runOnce();assert.equal((await f.receipt(1)).complete,false);assert.equal(await f.receipt(9),null);
    await f.r.poller.runOnce();assert.equal((await f.receipt(9)).complete,true);assert.ok((await f.r.operations.snapshot()).conditions.some(c=>c.code==='instance_poll_error'));f.denied.clear();await f.r.poller.runOnce();await f.r.poller.runOnce();assert.equal((await f.receipt(1)).complete,true);assert.ok(!(await f.r.operations.snapshot()).conditions.some(c=>c.code==='instance_poll_error'));
  }finally{await f.r.close();}
});

test('GitHub missed updates retain head/base identity and do not treat the pre-merge test SHA as a merged release',async()=>{
  const f=await fixture('sqlite',{provider:'github'});try{
    await f.link(72);f.states.set(72,f.raw(72,b));await f.r.poller.runOnce();const read=await f.receipt(72);assert.equal(read.headSha,b);assert.equal(read.ci.state,'unknown');const item=(await f.r.casework.timeline(f.id)).items.find(i=>i.payload.providerRead===1);assert.equal(item.payload.mergedSha,null);await f.settle();assert.ok(f.reviewHeads.includes(b));
  }finally{await f.r.close();}
});

test('provider metadata readers reject foreign resources, moving references and missing timestamps',async()=>{
  for(const provider of ['github','gitlab']){
    const f=await fixture('sqlite',{provider});try{
      const raw=f.raw(72,b);for(const invalid of [provider==='gitlab'?{...raw,project_id:18}:{...raw,base:{...raw.base,repo:{full_name:'foreign/repo'}}},{...raw,updated_at:null},provider==='gitlab'?{...raw,diff_refs:{...raw.diff_refs,head_sha:c}}:{...raw,number:73}])assert.throws(()=>providerChangeSnapshot(provider,invalid,f.service[provider],72));
      let reads=0;f.states.set(72,raw);const request=f.r.poller.connectors.get(f.service.key)[provider].request.bind(f.r.poller.connectors.get(f.service.key)[provider]);f.r.poller.connectors.get(f.service.key)[provider].request=async(...args)=>{if(++reads===2)f.states.set(72,f.raw(72,c));return request(...args);};await assert.rejects(f.r.poller.connectors.get(f.service.key)[provider].change(72),/changed while/);
    }finally{await f.r.close();}
  }
});

test('SQLite reopen retains reader proofs, withdrawn context and the same incident agent without rerunning unchanged work',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sre-change-read-'));let f,r;
  try{
    f=await fixture('sqlite',{path:join(dir,'agent.sqlite')});const association=await f.link(72);await f.r.poller.runOnce();await f.settle();const agent=(await f.r.store.context(f.id)).session.agent_id,read=await f.receipt(72);await f.r.casework.withdrawChange(f.id,'gitlab',72,operator,{expectedEvidenceId:association.evidenceId,reason:'Retained correction across restart'});await f.r.close();r=await createSreRuntime({config:f.config,connectors:f.r.poller.connectors,autoStart:false});
    assert.equal((await r.store.context(f.id)).session.agent_id,agent);assert.equal((await r.store.context(f.id)).changeAssociations.controls[0].state,'withdrawn');assert.deepEqual(await changeReadReceipt(r.store.db.query,f.service,'gitlab',72),read);const revision=(await r.store.context(f.id)).incident.revision;await r.poller.runOnce();assert.equal((await r.store.context(f.id)).incident.revision,revision);
  }finally{await r?.close();await f?.r.close();await rm(dir,{recursive:true,force:true});}
});

test('a late read cannot replace a newer peer proof, and a read crossing restore cannot certify the new generation',async()=>{
  const f=await fixture('sqlite');try{
    await f.link(72);const old=providerChangeEvent(providerChangeSnapshot('gitlab',f.states.get(72),f.service.gitlab,72),f.service),startedAt=await f.r.store.coordinationNow();
    await new Promise(resolve=>setTimeout(resolve,2));f.states.set(72,f.raw(72,b));await f.r.poller.runOnce();const newer=await f.receipt(72);
    const stale=await f.r.store.ingest(old,{changeRead:{scopeHash:pollScopeHash(f.service,'gitlab'),startedAt,completedAt:await f.r.store.coordinationNow(),restoreId:null}});assert.match(stale.readError,/older/);assert.deepEqual(await f.receipt(72),newer);
    const current=providerChangeEvent(providerChangeSnapshot('gitlab',f.states.get(72),f.service.gitlab,72),f.service),beforeRestore=await f.r.store.coordinationNow();
    await prepareRestore(f.r.store,{restoreId:'crossed-read',backupSha256:'b'.repeat(64),backupAt:Date.now()-60000,reason:'Fictional read interrupted by offline restore',actor:operator,offline:true});
    await assert.rejects(f.r.store.ingest(current,{changeRead:{scopeHash:pollScopeHash(f.service,'gitlab'),startedAt:beforeRestore,completedAt:await f.r.store.coordinationNow(),restoreId:null}}),/restore generation/);assert.equal(await f.receipt(72),null);
  }finally{await f.r.close();}
});

test('equal-timestamp competing heads remain unknown and a corrupt receipt fails closed',async()=>{
  const f=await fixture('sqlite');try{
    await f.link(72);const raw=f.states.get(72),at=Date.parse(raw.updated_at);await f.r.poller.runOnce();for(let n=0;n<20;n++)await f.webhook(72,a,{updatedAt:at});f.states.set(72,f.raw(72,b,{updatedAt:at}));await f.r.poller.runOnce();assert.equal((await f.receipt(72)).complete,false);assert.match((await f.receipt(72)).error,/Conflicting/);
    const before=f.reviewHeads.length;await f.r.worker.collect(await f.r.store.context(f.id),new AbortController().signal);assert.equal(f.reviewHeads.length,before);assert.ok((await f.r.store.context(f.id)).evidence.some(e=>e.kind==='connector_error'&&e.content.message.includes('conflict')));
    await f.r.store.db.query("UPDATE sre_checkpoints SET value='{}' WHERE id=?",['change-read:'+f.service.key+':gitlab:72']);await assert.rejects(f.receipt(72),e=>e instanceof StorageError);await f.r.poller.runOnce();await assert.rejects(f.receipt(72),e=>e instanceof StorageError);
  }finally{await f.r.close();}
});

test('a stalled change read has its own deadline and cannot consume the next reference budget',async()=>{
  const f=await fixture('sqlite');try{
    await f.link(1);await f.link(2);f.states.set(2,f.raw(2,b));const client=f.r.poller.connectors.get(f.service.key).gitlab,change=client.change.bind(client);let secondRead=false;
    client.change=async(n,{signal})=>{
      if(n==='2'){secondRead=true;return change(n,{signal});}
      return new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture guard: first read remained stalled')),1500);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('Fictional first MR read timed out'));},{once:true});});
    };
    await assert.rejects(readTrackedChanges(f.r.store,f.service,'gitlab',client,AbortSignal.timeout(1000),{referenceTimeoutMs:30}),/timed out|deadline/);
    assert.equal(secondRead,true);assert.equal((await f.receipt(2)).complete,true);assert.equal((await f.receipt(2)).headSha,b);
  }finally{await f.r.close();}
});

test('a deployment-reader permission error does not suppress independently permitted tracked MR reads',async()=>{
  const f=await fixture('sqlite');try{
    await f.link(72);f.states.set(72,f.raw(72,b));const client=f.r.poller.connectors.get(f.service.key).gitlab,fetcher=client.fetcher;
    client.fetcher=async(url,options)=>new URL(url).pathname.endsWith('/deployments')?new Response('{}',{status:401}):fetcher(url,options);
    await f.r.poller.runOnce();assert.equal((await f.receipt(72))?.headSha,b);assert.equal((await f.receipt(72))?.complete,true);assert.ok((await f.r.operations.snapshot()).conditions.some(c=>c.code==='instance_poll_error'&&c.message.includes('401')));
  }finally{await f.r.close();}
});

for(const dialect of ['sqlite','postgres']){
  test(dialect+': a failed pipeline write cannot publish an accepted CI read or a partial MR update',async()=>{
    const f=await fixture(dialect),transaction=f.r.store.db.transaction.bind(f.r.store.db);try{
      await f.link(72);await f.r.poller.runOnce();await f.settle();const plan=await f.r.casework.createPlan(f.id),before=(await f.r.store.context(f.id)).incident.revision,other=(await f.r.store.context(f.other)).incident.revision,receipt=await f.receipt(72),events=await f.r.store.db.query('SELECT id FROM sre_events ORDER BY id');
      f.states.set(72,f.raw(72,b,{pipeline:{id:91,project_id:17,sha:b,status:'success',updated_at:new Date(f.advance()).toISOString()}}));
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const rows=await q(sql,args);if(sql.startsWith('INSERT INTO sre_events')&&args[4]==='change'&&JSON.parse(args[8]).payload?.stage==='ci-update')throw new StorageError(new Error('Injected CI persistence failure'));return rows;}));
      await f.r.poller.runOnce();f.r.store.db.transaction=transaction;
      const actual=await f.receipt(72);assert.notEqual(actual.ci?.state,'observed','A pipeline read is not accepted when its CI event did not commit');assert.deepEqual(actual,receipt);assert.equal((await f.r.store.context(f.id)).incident.revision,before);assert.equal((await f.r.store.context(f.other)).incident.revision,other);assert.deepEqual(await f.r.store.db.query('SELECT id FROM sre_events ORDER BY id'),events);assert.equal((await f.r.casework.snapshot(f.id)).plans.find(p=>p.id===plan.id).current,true);
      await f.r.poller.runOnce();const accepted=await f.receipt(72);assert.equal(accepted.ci.state,'observed');assert.ok(accepted.ci.eventId);assert.ok((await f.r.store.db.query('SELECT id FROM sre_events WHERE id=?',[accepted.ci.eventId])).length);const revision=(await f.r.store.context(f.id)).incident.revision;await f.r.poller.runOnce();assert.equal((await f.r.store.context(f.id)).incident.revision,revision);
    }finally{f.r.store.db.transaction=transaction;await f.r.close();}
  });
  test(dialect+': an unchanged MR and changed pipeline share one commit and retain the last accepted CI after a failed update',async()=>{
    const f=await fixture(dialect),transaction=f.r.store.db.transaction.bind(f.r.store.db);try{
      await f.link(72);const original=f.states.get(72),pipeline={id:92,project_id:17,sha:a,status:'running',updated_at:new Date(f.advance()).toISOString()};f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();const before=await f.receipt(72),revision=(await f.r.store.context(f.id)).incident.revision;
      f.states.set(72,{...original,head_pipeline:{...pipeline,status:'success',updated_at:new Date(f.advance()).toISOString()}});
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const rows=await q(sql,args);if(sql.startsWith('INSERT INTO sre_events')&&args[4]==='change'&&JSON.parse(args[8]).payload?.stage==='ci-update')throw new StorageError(new Error('Injected CI-only persistence failure'));return rows;}));await f.r.poller.runOnce();f.r.store.db.transaction=transaction;
      const failed=await f.receipt(72);assert.equal(failed.ci.status,'running','A failed CI-only update cannot replace the accepted running observation');assert.deepEqual(failed,before);assert.equal((await f.r.store.context(f.id)).incident.revision,revision);
      await f.r.poller.runOnce();const fresh=await f.receipt(72);assert.equal(fresh.ci.status,'success');assert.equal(fresh.providerUpdatedAt,before.providerUpdatedAt);assert.notEqual(fresh.ci.eventId,before.ci.eventId);assert.equal(Number((await f.r.store.context(f.id)).incident.revision),Number(revision)+1);
    }finally{f.r.store.db.transaction=transaction;await f.r.close();}
  });
  test(dialect+': a CI receipt cannot be minted without its scoped pipeline source fact',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const at=f.advance(),pipeline={id:92,project_id:17,sha:b,status:'success',updated_at:new Date(at).toISOString()};f.states.set(72,f.raw(72,b,{pipeline}));
      const source=await f.r.poller.connectors.get(f.service.key).gitlab.change(72),event=providerChangeEvent(source.snapshot,f.service),now=await f.r.store.coordinationNow(),read={scopeHash:pollScopeHash(f.service,'gitlab'),startedAt:now,completedAt:now,restoreId:null,ci:source.ci};
      const child=normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:pipeline},f.service,{deliveryId:'atomic-bundle-pipeline'}),events=await f.r.store.db.query('SELECT id FROM sre_events ORDER BY id'),revision=(await f.r.store.context(f.id)).incident.revision;
      await assert.rejects(f.r.store.ingest(event,{changeRead:read}),/atomic/);await assert.rejects(f.r.store.ingestChangeRead(event,read),/matching pipeline/);
      for(const mutate of [e=>({...e,source:'github'}),e=>({...e,serviceKey:'other-service'}),e=>({...e,kind:'deployment'}),e=>({...e,incidentId:f.other}),e=>({...e,conversationKey:'forced-room'}),e=>({...e,alertThread:{id:'forced-thread'}}),e=>({...e,payload:{...e.payload,number:72}}),e=>({...e,payload:{...e.payload,sha:c}}),e=>({...e,payload:{...e.payload,pipeline:{...e.payload.pipeline,project_id:18}}}),e=>({...e,payload:{...e.payload,pipeline:{...e.payload.pipeline,status:'failed'}}}),e=>({...e,at:e.at-1})])await assert.rejects(f.r.store.ingestChangeRead(event,read,mutate(structuredClone(child))),/does not match/);
      assert.deepEqual(await f.r.store.db.query('SELECT id FROM sre_events ORDER BY id'),events);assert.equal((await f.r.store.context(f.id)).incident.revision,revision);assert.equal(await f.receipt(72),null);
      await f.r.store.ingestChangeRead(event,read,child);const accepted=await f.receipt(72);assert.equal(accepted.version,2);assert.equal(accepted.ci.status,'success');assert.equal(accepted.ci.eventId,hash([child.source,child.serviceKey,child.id]));
    }finally{await f.r.close();}
  });
  test(dialect+': old CI receipts remain unknown until a fresh atomic read, without rerunning unchanged work',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const pipeline={id:93,project_id:17,sha:a,status:'success',updated_at:new Date(f.advance()).toISOString()};f.states.set(72,{...f.states.get(72),head_pipeline:pipeline});await f.r.poller.runOnce();await f.settle();const accepted=await f.receipt(72),{checksum,...legacy}=accepted;legacy.version=1;delete legacy.ci.eventId;delete legacy.ci.projectId;
      const stored=JSON.stringify({...legacy,checksum:hash(legacy)});await f.r.store.db.query('UPDATE sre_checkpoints SET value=? WHERE id=?',[stored,'change-read:'+f.service.key+':gitlab:72']);const projected=await f.receipt(72);assert.equal(projected.ci.state,'unknown');assert.equal(projected.ci.status,null);assert.equal(projected.ci.eventId,null);assert.equal(projected.ci.legacyUnverified,true);
      assert.equal((await f.r.store.db.query('SELECT value FROM sre_checkpoints WHERE id=?',['change-read:'+f.service.key+':gitlab:72']))[0].value,stored,'Reading history must not rewrite it');
      const context=await f.r.store.context(f.id),prompt=boundedContext(context),read=prompt.changeAssociations.reads.find(r=>r.number==='72');assert.equal(read.ci.status,null);assert.match((await f.r.casework.createPlan(f.id)).markdown,/CI unknown/);
      const revision=context.incident.revision,jobs=await f.r.store.db.query('SELECT id FROM sre_jobs ORDER BY id');await f.r.poller.runOnce();assert.equal((await f.receipt(72)).version,2);assert.equal((await f.receipt(72)).ci.status,'success');assert.equal((await f.r.store.context(f.id)).incident.revision,revision);assert.deepEqual(await f.r.store.db.query('SELECT id FROM sre_jobs ORDER BY id'),jobs);
    }finally{await f.r.close();}
  });
  test(dialect+': a missing or altered CI source cannot support a passing reader receipt',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);f.states.set(72,{...f.states.get(72),head_pipeline:{id:94,project_id:17,sha:a,status:'success',updated_at:new Date(f.advance()).toISOString()}});await f.r.poller.runOnce();const receipt=await f.receipt(72),[fact]=await f.r.store.db.query('SELECT payload,body_hash FROM sre_events WHERE id=?',[receipt.ci.eventId]);
      const changed=JSON.parse(fact.payload);changed.payload.pipeline.status='failed';await f.r.store.db.query('UPDATE sre_events SET payload=? WHERE id=?',[JSON.stringify(changed),receipt.ci.eventId]);await assert.rejects(f.receipt(72),e=>e instanceof StorageError);
      await f.r.store.db.query('UPDATE sre_events SET body_hash=? WHERE id=?',[hash(changed),receipt.ci.eventId]);await assert.rejects(f.receipt(72),e=>e instanceof StorageError,'Even a recomputed source hash cannot bind failed CI to a passing receipt');
      await f.r.store.db.query('DELETE FROM sre_events WHERE id=?',[receipt.ci.eventId]);await assert.rejects(f.receipt(72),e=>e instanceof StorageError);
    }finally{await f.r.close();}
  });
  test(dialect+': invalid pipeline clocks stay unknown and a rejected MR cannot publish its CI',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const future=new Date(Date.now()+600000).toISOString();f.states.set(72,f.raw(72,b,{pipeline:{id:95,project_id:17,sha:b,status:'success',updated_at:future}}));await f.r.poller.runOnce();const read=await f.receipt(72);assert.equal(read.complete,true);assert.equal(read.headSha,b);assert.equal(read.ci.state,'unknown');assert.equal(read.ci.status,null);assert.match(read.ci.note,/clock/);assert.equal((await f.r.casework.timeline(f.id)).items.filter(e=>e.stage==='ci-update').length,0);
      const latest=Date.now()-1000;await f.webhook(72,c,{updatedAt:latest});const revision=(await f.r.store.context(f.id)).incident.revision;f.states.set(72,f.raw(72,b,{updatedAt:latest-100,pipeline:{id:96,project_id:17,sha:b,status:'success',updated_at:new Date(latest).toISOString()}}));await f.r.poller.runOnce();const rejected=await f.receipt(72);assert.equal(rejected.complete,false);assert.equal(rejected.ci.state,'unknown');assert.equal(rejected.ci.status,null);assert.match(rejected.error,/older/);assert.equal((await f.r.store.context(f.id)).incident.revision,revision);assert.equal((await f.r.casework.timeline(f.id)).items.filter(e=>e.stage==='ci-update').length,0);
    }finally{await f.r.close();}
  });
}

test('an in-flight provider read cannot certify a newly configured project',async()=>{
  const f=await fixture('sqlite');try{
    await f.link(72);const client=f.r.poller.connectors.get(f.service.key).gitlab,change=client.change.bind(client),waiting=gate();client.change=async(...args)=>{const result=await change(...args);waiting.enter();await waiting.waiting;return result;};
    const poll=readTrackedChanges(f.r.store,f.service,'gitlab',client,new AbortController().signal);await waiting.started;f.service.gitlab={...f.service.gitlab,project:'18'};waiting.release();await assert.rejects(poll,/scope changed|boundary/);assert.equal(await f.receipt(72),null);assert.equal(Number((await f.r.store.db.query("SELECT COUNT(*) AS count FROM sre_events WHERE external_id LIKE 'change-read:%'"))[0].count),0);
  }finally{await f.r.close();}
});

test('reopening SQLite after a failed CI-only update retains the accepted source and recovers the new result once',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sre-ci-read-restart-'));let f,r;try{
    f=await fixture('sqlite',{path:join(dir,'agent.sqlite')});await f.link(72);const original=f.states.get(72),pipeline={id:97,project_id:17,sha:a,status:'running',updated_at:new Date(f.advance()).toISOString()};f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();const accepted=await f.receipt(72),context=await f.r.store.context(f.id),transaction=f.r.store.db.transaction.bind(f.r.store.db);
    f.states.set(72,{...original,head_pipeline:{...pipeline,status:'success',updated_at:new Date(f.advance()).toISOString()}});f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const rows=await q(sql,args);if(sql.startsWith('INSERT INTO sre_events')&&args[4]==='change'&&JSON.parse(args[8]).payload?.stage==='ci-update')throw new StorageError(new Error('Fictional failure before restart'));return rows;}));await f.r.poller.runOnce();await f.r.close();
    r=await createSreRuntime({config:f.config,connectors:f.r.poller.connectors,autoStart:false});assert.deepEqual(await changeReadReceipt(r.store.db.query,f.service,'gitlab',72),accepted);const reopened=await r.store.context(f.id);assert.equal(reopened.incident.revision,context.incident.revision);assert.equal(reopened.session.agent_id,context.session.agent_id);assert.equal(reopened.collaboration.rooms.length,3);
    await r.poller.runOnce();const updated=await changeReadReceipt(r.store.db.query,f.service,'gitlab',72);assert.equal(updated.ci.status,'success');const revision=(await r.store.context(f.id)).incident.revision;assert.equal(Number(revision),Number(context.incident.revision)+1);await r.poller.runOnce();assert.equal((await r.store.context(f.id)).incident.revision,revision);assert.equal(Number((await r.store.db.query('SELECT COUNT(*) AS count FROM sre_events WHERE id=?',[updated.ci.eventId]))[0].count),1);
  }finally{await r?.close();await f?.r.close();await rm(dir,{recursive:true,force:true});}
});

for(const dialect of ['sqlite','postgres']){
  test(dialect+': a newer read of older pipeline success cannot hide an accepted failure',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const original=f.states.get(72),at=f.advance(),pipeline={id:101,project_id:17,sha:a,status:'failed',updated_at:new Date(at).toISOString()};f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();const failure=await f.receipt(72);assert.equal(failure.ci.status,'failed');
      f.states.set(72,{...original,head_pipeline:{...pipeline,status:'success',updated_at:new Date(at-100).toISOString()}});await f.r.poller.runOnce();const delayed=await f.receipt(72);assert.equal(delayed.complete,true);assert.equal(delayed.ci.state,'unknown','A fresh transport read cannot certify an older passing pipeline status');assert.equal(delayed.ci.status,null);assert.equal(delayed.ci.consistency.state,'stale');assert.equal(delayed.ci.consistency.observed.status,'success');assert.equal(delayed.ci.consistency.latest[0].status,'failed');assert.equal(delayed.ci.consistency.latest[0].eventId,failure.ci.eventId);assert.equal((await f.r.store.context(f.id)).incident.status,'open');assert.equal((await f.r.store.context(f.id)).deployments.length,0);
      f.states.set(72,{...original,head_pipeline:{...pipeline,updated_at:new Date(at+100).toISOString()}});await f.r.poller.runOnce();assert.equal((await f.receipt(72)).ci.status,'failed');
    }finally{await f.r.close();}
  });
  test(dialect+': webhook conflicts invalidate CI visibility without waiting for another MR poll and cannot be hidden by repeats',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const original=f.states.get(72),at=f.advance(),pipeline={id:102,project_id:17,sha:a,status:'success',updated_at:new Date(at).toISOString()};f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();await f.settle();const priorOutbox=new Set((await f.r.store.snapshot()).outbox.map(o=>o.id)),otherRevision=(await f.r.store.context(f.other)).incident.revision;
      const webhook=async(status,index)=>f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{...pipeline,status}},f.service,{deliveryId:'pipeline-conflict-'+index}));
      await webhook('failed','other-status');for(let i=0;i<24;i++)await webhook('success',i);const ambiguous=await f.receipt(72);assert.equal(ambiguous.ci.state,'unknown','Equal source timestamps with different statuses need reconciliation');assert.equal(ambiguous.ci.status,null);assert.equal(ambiguous.ci.consistency.state,'conflict');assert.deepEqual(ambiguous.ci.consistency.latest.map(o=>o.status).sort(),['failed','success']);
      await f.settle();const context=await f.r.store.context(f.id),prompt=boundedContext(context);assert.equal(prompt.changeAssociations.reads.find(r=>r.number==='72').ci.status,null);assert.match((await f.r.casework.createPlan(f.id)).markdown,/CI unknown/);const notices=(await f.r.store.snapshot()).outbox.filter(m=>m.incident_id===f.id&&!priorOutbox.has(m.id)&&m.text.includes('Pipeline reconciliation conflict'));assert.equal(notices.length,3,'Each joined team receives the changed CI understanding once');assert.deepEqual(notices.map(m=>m.conversation_key).sort(),context.collaboration.rooms.map(r=>r.key).sort());assert.equal((await f.r.store.context(f.other)).incident.revision,otherRevision);const outboxCount=(await f.r.store.snapshot()).outbox.length;await f.r.poller.runOnce();await f.settle();assert.equal((await f.r.store.snapshot()).outbox.length,outboxCount,'Re-reading the same conflict stays quiet');
      f.states.set(72,{...original,head_pipeline:{...pipeline,status:'failed',updated_at:new Date(at+100).toISOString()}});await f.r.poller.runOnce();assert.equal((await f.receipt(72)).ci.status,'failed');
    }finally{await f.r.close();}
  });
  test(dialect+': official-shaped pipeline hooks without update versions require a fresh provider observation',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const original=f.states.get(72),at=f.advance(),pipeline={id:103,project_id:17,sha:a,status:'success',updated_at:new Date(at).toISOString()};f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();
      // GitLab's documented hook shape supplies project at the top level and
      // may supply finished_at/created_at without updated_at or project_id.
      const hook=normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{id:103,sha:a,status:'failed',created_at:new Date(at-100).toISOString(),finished_at:new Date(at+100).toISOString()}},f.service,{deliveryId:'official-shaped-hook'});await f.r.store.ingest(hook);assert.equal((await f.r.store.ingest(hook)).duplicate,true);
      const stale=await f.receipt(72);assert.equal(stale.ci.state,'unknown');assert.equal(stale.ci.consistency.state,'unversioned');assert.equal(stale.ci.consistency.latest[0].timeKind,'finished');assert.equal(stale.ci.consistency.latest[0].projectId,17);
      f.states.set(72,{...original,head_pipeline:{...pipeline,status:'failed',updated_at:new Date(at+200).toISOString()}});await f.r.poller.runOnce();assert.equal((await f.receipt(72)).ci.status,'failed');
    }finally{await f.r.close();}
  });
  test(dialect+': another pipeline on the same commit and a prior provider scope do not replace the selected run',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const original=f.states.get(72),at=f.advance(),pipeline={id:104,project_id:17,sha:a,status:'success',updated_at:new Date(at).toISOString()};f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();
      await f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{...pipeline,id:105,status:'failed',updated_at:new Date(at+100).toISOString()}},f.service,{deliveryId:'other-pipeline'}));assert.equal((await f.receipt(72)).ci.status,'success');
      const configured=f.service.gitlab;f.service.gitlab={...configured,base:'https://old-provider-fixture.invalid'};await f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{...pipeline,status:'failed',updated_at:new Date(at+200).toISOString()}},f.service,{deliveryId:'different-provider-scope'}));f.service.gitlab=configured;assert.equal((await f.receipt(72)).ci.status,'success');assert.equal((await f.receipt(72)).ci.pipelineId,104);
    }finally{await f.r.close();}
  });
  test(dialect+': legacy reader facts retain their scope proof and corrupt CI projections fail closed',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const original=f.states.get(72),at=f.advance(),pipeline={id:106,project_id:17,sha:a,status:'failed',updated_at:new Date(at).toISOString()};f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();const accepted=await f.receipt(72),[row]=await f.r.store.db.query('SELECT payload FROM sre_change_events WHERE id=?',[accepted.ci.eventId]),projection=JSON.parse(row.payload),{observationOrigin,...legacy}=projection;
      await f.r.store.db.query('UPDATE sre_change_events SET payload=? WHERE id=?',[JSON.stringify(legacy),accepted.ci.eventId]);assert.equal((await f.receipt(72)).ci.status,'failed');f.states.set(72,{...original,head_pipeline:{...pipeline,status:'success',updated_at:new Date(at-100).toISOString()}});await f.r.poller.runOnce();assert.equal((await f.receipt(72)).ci.consistency.state,'stale');
      await f.r.store.db.query('UPDATE sre_change_events SET payload=? WHERE id=?',[JSON.stringify({...legacy,observationOrigin:{...observationOrigin,checksum:'f'.repeat(64)}}),accepted.ci.eventId]);await assert.rejects(f.receipt(72),e=>e instanceof StorageError);
    }finally{await f.r.close();}
  });
  test(dialect+': CI changes notify each joined team even when the reasoner returns identical prose, and unchanged status stays quiet',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const original=f.states.get(72),at=f.advance(),pipeline={id:107,project_id:17,sha:a,status:'running',updated_at:new Date(at).toISOString()};f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();const reasoner=f.r.worker.reasoner;let stable;
      f.r.worker.reasoner={investigate:async context=>{stable||=(await reasoner.investigate(context)).analysis;return {analysis:structuredClone(stable)};}};await f.settle();const before=new Set((await f.r.store.snapshot()).outbox.map(m=>m.id));
      f.states.set(72,{...original,head_pipeline:{...pipeline,status:'failed',updated_at:new Date(at+100).toISOString()}});await f.r.poller.runOnce();await f.settle();const notices=(await f.r.store.snapshot()).outbox.filter(m=>m.incident_id===f.id&&!before.has(m.id));assert.equal(notices.length,3);assert.ok(notices.every(m=>m.text.includes('CI failed')));
      const count=(await f.r.store.snapshot()).outbox.length;f.states.set(72,{...original,head_pipeline:{...pipeline,status:'failed',updated_at:new Date(at+200).toISOString()}});await f.r.poller.runOnce();await f.settle();assert.equal((await f.r.store.snapshot()).outbox.length,count,'A new source version with unchanged status must not broadcast the same understanding again');
    }finally{await f.r.close();}
  });
  test(dialect+': a long pipeline history does not make a current complete observation permanently unknown',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const original=f.states.get(72),at=f.advance(),pipeline={id:108,project_id:17,sha:a,status:'running',updated_at:new Date(at).toISOString()};
      for(let i=0;i<55;i++)await f.r.store.ingest(normalize('gitlab',{project:{id:17},object_kind:'pipeline',object_attributes:{...pipeline,updated_at:new Date(at+i).toISOString()}},f.service,{deliveryId:'pipeline-progress-'+i}));
      f.states.set(72,{...original,head_pipeline:{...pipeline,status:'failed',updated_at:new Date(at+100).toISOString()}});await f.r.poller.runOnce();assert.equal((await f.receipt(72)).ci.state,'observed');assert.equal((await f.receipt(72)).ci.status,'failed');
    }finally{await f.r.close();}
  });
  test(dialect+': losing and regaining CI visibility informs joined teams even when the MR and source events are unchanged',async()=>{
    const f=await fixture(dialect);try{
      await f.link(72);const original=f.states.get(72),pipeline={id:109,project_id:17,sha:a,status:'running',updated_at:new Date(f.advance()).toISOString()};f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();await f.settle();const prior=new Set((await f.r.store.snapshot()).outbox.map(m=>m.id)),other=(await f.r.store.context(f.other)).incident.revision;
      f.states.set(72,{...original,head_pipeline:null});await f.r.poller.runOnce();await f.settle();const unknown=(await f.r.store.snapshot()).outbox.filter(m=>m.incident_id===f.id&&!prior.has(m.id));assert.equal(unknown.length,3,'Loss of CI visibility must reach each joined team');assert.ok(unknown.every(m=>m.text.includes('CI unknown')));const count=(await f.r.store.snapshot()).outbox.length;
      await f.r.poller.runOnce();await f.settle();assert.equal((await f.r.store.snapshot()).outbox.length,count);const beforeReturn=new Set((await f.r.store.snapshot()).outbox.map(m=>m.id));f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();await f.settle();const restored=(await f.r.store.snapshot()).outbox.filter(m=>m.incident_id===f.id&&!beforeReturn.has(m.id));assert.equal(restored.length,3);assert.ok(restored.every(m=>m.text.includes('CI running')));assert.equal((await f.r.store.context(f.other)).incident.revision,other);assert.equal((await f.r.store.context(f.id)).deployments.length,0);
    }finally{await f.r.close();}
  });
  test(dialect+': a failed visibility transition rolls back its receipt, incident revision and reassessment work',async()=>{
    const f=await fixture(dialect),transaction=f.r.store.db.transaction.bind(f.r.store.db);try{
      await f.link(72);const original=f.states.get(72),pipeline={id:110,project_id:17,sha:a,status:'running',updated_at:new Date(f.advance()).toISOString()};f.states.set(72,{...original,head_pipeline:pipeline});await f.r.poller.runOnce();await f.settle();const receipt=await f.receipt(72),revision=(await f.r.store.context(f.id)).incident.revision,events=await f.r.store.db.query('SELECT id FROM sre_events ORDER BY id'),jobs=await f.r.store.db.query('SELECT id FROM sre_jobs ORDER BY id');f.states.set(72,{...original,head_pipeline:null});
      f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args)=>{const rows=await q(sql,args);if(sql.startsWith('INSERT INTO sre_events')&&args[1]==='system'&&JSON.parse(args[8]).payload?.stage==='ci-visibility')throw new StorageError(new Error('Injected CI-visibility persistence failure'));return rows;}));await f.r.poller.runOnce();f.r.store.db.transaction=transaction;
      assert.deepEqual(await f.receipt(72),receipt);assert.equal((await f.r.store.context(f.id)).incident.revision,revision);assert.deepEqual(await f.r.store.db.query('SELECT id FROM sre_events ORDER BY id'),events);assert.deepEqual(await f.r.store.db.query('SELECT id FROM sre_jobs ORDER BY id'),jobs);await f.r.poller.runOnce();await f.settle();assert.equal((await f.receipt(72)).ci.state,'unknown');
    }finally{f.r.store.db.transaction=transaction;await f.r.close();}
  });
}
