import test from 'node:test';import assert from 'node:assert/strict';
import {sourceDiscoveryFixture,discoveryProjects} from '../fixtures/sre-source-discovery.mjs';
import {GitlabConnector} from '../src/sre/connectors.mjs';
import {sourceInventoryLimits,sourceDirectoryPath,validatedSourceInventory,sourceInventoryWindow,materialSourceInventory} from '../src/sre/source-inventory.mjs';
import {validateEvidenceRequests} from '../src/sre/evidence-request.mjs';
import {EvidenceFollowup} from '../src/sre/evidence-followup.mjs';
import {collectDiscoveryEvidence} from '../src/sre/source-discovery.mjs';
import {sourceReadBudget,readImmutableSource} from '../src/sre/source-evidence.mjs';
import {boundedContext,modelContextLimits} from '../src/sre/model-context.mjs';
import {hash} from '../src/sre/security.mjs';
const sha='a'.repeat(40),entry=(path,id=sha,type='blob')=>({id,path,name:path.split('/').at(-1),type,mode:type==='tree'?'040000':'100644'}),tree=(sha,extra={})=>({kind:'gitlab_tree',project:discoveryProjects[0],sha,path:'src/ledger',reason:'Locate the caller and input conversion helper within this candidate revision.',...extra});
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
function connector(handle,extra={}){const calls=[],client=new GitlabConnector({base:'https://directory-fixture.invalid',tokenEnv:'DIRECTORY_TEST_TOKEN',project:'approved/ledger',...extra},{env:{DIRECTORY_TEST_TOKEN:'fictional-reader'},retries:0,fetcher:async(url,options)=>{const u=new URL(url);calls.push({url:u.href,method:options.method});return handle(u,options,calls);}});return{client,calls};}
async function harness({history=false}={}){const f=await sourceDiscoveryFixture('sqlite',{history});await f.question();await f.r.store.release(f.r.worker.owner);const job=await f.r.store.claim('directory-reviewer'),context=await f.r.store.context(f.id),budget=sourceReadBudget(),controller=new AbortController(),followup=new EvidenceFollowup({store:f.r.store,job,service:f.service,clients:f.r.worker.connectors.get(f.service.key),sourceBudget:budget,signal:controller.signal});await followup.policy(context,0);return{f,job,context,budget,controller,followup};}

test('directory proposals have an exact read-only shape and an explicit root path',()=>{
 assert.deepEqual(validateEvidenceRequests([tree(sha,{path:''})])[0],tree(sha,{path:''}));
 for(const extra of [{recursive:true},{page:3},{url:'https://foreign'},{query:'read all tenants'},{startLine:1},{path:null},{project:'../foreign'},{sha:12},{reason:''}])assert.throws(()=>validateEvidenceRequests([tree(sha,extra)]));
 assert.equal(sourceDirectoryPath(''),true);assert.equal(sourceDirectoryPath('src/ledger'),true);for(const path of ['../secret','src/../secret','/src','src/','https://foreign','src\\secret'])assert.equal(sourceDirectoryPath(path),false);
});
test('directory validation keeps only direct safe tree/blob entries and marks rejected or duplicate entries partial',()=>{
 const value={project:'approved/ledger',sha,path:'src',recursive:false,complete:true,invalidEntries:0,entries:[entry('src/handler.py'),entry('src/helpers',sha,'tree'),entry('src/nested/secret.py'),{...entry('src/link.py'),mode:'120000'},{...entry('src/module'),type:'commit',mode:'160000'},entry('src/handler.py')]};
 const checked=validatedSourceInventory(value,{project:value.project,sha,path:'src'});assert.equal(checked.complete,false);assert.equal(checked.invalidEntries,4);assert.equal(checked.entries.length,2);
 for(const changes of [{project:'foreign/project'},{sha:'b'.repeat(40)},{path:'src/elsewhere'},{recursive:true},{complete:'true'},{entries:Array(201).fill(entry('src/a.py'))}])assert.throws(()=>validatedSourceInventory({...value,...changes},{project:value.project,sha,path:'src'}));
});
test('fixed-project directory transport uses an exact SHA and a bounded non-recursive tree route',async()=>{
 const f=connector(url=>{assert.equal(url.searchParams.get('ref'),sha);assert.equal(url.searchParams.get('recursive'),'false');assert.equal(url.searchParams.get('path'),'src/ledger');return response([entry('src/ledger/handler.py')]);});const value=await f.client.directory('src/ledger',sha);assert.equal(value.complete,true);assert.equal(value.entries[0].path,'src/ledger/handler.py');assert.equal(f.calls[0].method,'GET');assert.equal(f.calls.length,1);await assert.rejects(()=>f.client.directory('src','main'),/immutable/);await assert.rejects(()=>f.client.directory('../secret',sha),/safe directory/);assert.equal(f.calls.length,1);
});
test('root inventory omits the path parameter, while missing and denied directories remain unavailable',async()=>{
 const root=connector(url=>{assert.equal(url.searchParams.has('path'),false);return response([entry('src',sha,'tree')]);});assert.equal((await root.client.directory('',sha)).entries[0].type,'tree');
 for(const code of [403,404,429]){const f=connector(()=>response({message:'Fictional denial'},code));await assert.rejects(()=>f.client.directory('missing',sha));assert.equal(f.calls.length,1);}
});
test('a large directory stops after two pages and does not claim an absent file',async()=>{
 const f=connector(url=>{const page=Number(url.searchParams.get('page'));return response(Array.from({length:100},(_,n)=>entry('src/file-'+((page-1)*100+n)+'.py')));});const value=await f.client.directory('src',sha);assert.equal(value.entries.length,200);assert.equal(value.complete,false);assert.equal(value.limitReached,true);assert.equal(f.calls.length,sourceInventoryLimits.pages);assert.ok(f.calls.every(row=>new URL(row.url).searchParams.get('ref')===sha));
});
test('a foreign pagination link cannot change the scoped directory transport',async()=>{
 const f=connector(()=>response([entry('src/a.py')],200,{link:'<https://foreign.invalid/secret>; rel="next"'}));await assert.rejects(()=>f.client.directory('src',sha));assert.equal(f.calls.length,1);
});
test('a scoped directory read commits with its receipt, exposes paths as metadata and does not spend a file attempt',async()=>{
 const h=await harness();try{const request=tree(h.f.manifest.projects[discoveryProjects[0]].head),before=h.f.calls.length;assert.equal(await h.followup.run([request],h.context,0),true);const c=await h.f.r.store.context(h.f.id),inventory=c.sourceInventories.inventories[0];assert.equal(inventory.path,'src/ledger');assert.equal(inventory.mappingCandidate,true);assert.ok(inventory.entries.some(row=>row.path==='src/ledger/handler.py'));assert.equal(h.budget.reads,8);assert.equal(h.budget.discovery.remaining,15);assert.equal(h.f.calls.length-before,1);const view=boundedContext(c);assert.equal(view.sourceInventories.inventories.length,1);assert.equal(view.evidence.find(row=>row.kind==='source_inventory').content.sourceInventory.entries,undefined);assert.equal(view.sourceCode.files.some(file=>file.path==='src/ledger/handler.py'),false);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_inventory'")).length,1);
 }finally{await h.f.close();}
});
test('unseen project/revision, traversal and mutable directory selectors make no provider request',async()=>{
 const h=await harness();try{const count=h.f.calls.length;for(const request of [tree(sha),tree(h.f.manifest.projects[discoveryProjects[0]].head,{project:discoveryProjects[1]}),tree(h.f.manifest.projects[discoveryProjects[0]].head,{path:'../secret'}),tree(h.f.manifest.projects[discoveryProjects[0]].head,{sha:'main'})])await h.followup.run([request],h.context,0);assert.equal(h.f.calls.length,count);assert.ok(h.followup.results.every(row=>row.phase==='refused'));
 }finally{await h.f.close();}
});
test('tree requests share metadata limits with discovery and duplicate directory selectors do not retry',async()=>{
 const h=await harness();try{const request=tree(h.f.manifest.projects[discoveryProjects[0]].head);await collectDiscoveryEvidence(h.context,{service:h.f.service,client:h.f.client,budget:h.budget});assert.equal(h.budget.discovery.remaining,12);const count=h.f.calls.length;await h.followup.run([request,{...request,reason:'Duplicate request despite the same directory selector.'}],h.context,0);assert.equal(h.f.calls.length-count,1);assert.equal(h.followup.results[1].phase,'duplicate');assert.equal(h.budget.discovery.remaining,11);h.budget.discovery.remaining=0;const c=await h.f.r.store.context(h.f.id);await h.followup.policy(c,1);await h.followup.run([tree(request.sha,{path:'src'})],c,1);assert.equal(h.f.calls.length-count,1);assert.equal(h.followup.results.at(-1).phase,'unavailable');
 }finally{await h.f.close();}
});
test('a later denied read retains immutable directory data but reports the unavailable attempt separately',async()=>{
 const h=await harness();try{const request=tree(h.f.manifest.projects[discoveryProjects[0]].head);await h.followup.run([request],h.context,0);const before=await h.f.r.store.context(h.f.id);h.f.controls.deniedProjects.add(discoveryProjects[0]);const again=new EvidenceFollowup({store:h.f.r.store,job:h.job,service:h.f.service,clients:h.f.r.worker.connectors.get(h.f.service.key),signal:h.controller.signal});await again.policy(before,1);await again.run([request],before,1);const c=await h.f.r.store.context(h.f.id);assert.deepEqual(c.sourceInventories.inventories[0].entries,before.sourceInventories.inventories[0].entries);assert.equal(again.results[0].phase,'unavailable');assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_inventory'")).length,1);
 }finally{await h.f.close();}
});
test('a directory result arriving after a responder update is fenced out without accepting its inventory',async()=>{
 const h=await harness();let release;try{let enter;const wait=new Promise(ok=>release=ok),entered=new Promise(ok=>enter=ok),original=h.f.client.discoveryDirectory.bind(h.f.client);h.f.client.discoveryDirectory=async(...args)=>{enter();await wait;return original(...args);};const pending=h.followup.run([tree(h.f.manifest.projects[discoveryProjects[0]].head)],h.context,0);await entered;await h.f.message(h.f.rooms[1],'report blocked TREE-RACE: probes are green but conversion still fails.','noor');release();assert.equal(await pending,false);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_inventory'")).length,0);
 }finally{release?.();await h.f.close();}
});
test('cancellation and lease loss cannot accept a late directory result',async()=>{
 for(const mode of ['cancel','lease']){const h=await harness();let release;try{let enter;const wait=new Promise(ok=>release=ok),entered=new Promise(ok=>enter=ok),original=h.f.client.discoveryDirectory.bind(h.f.client);h.f.client.discoveryDirectory=async(...args)=>{enter();await wait;return original(...args);};const pending=h.followup.run([tree(h.f.manifest.projects[discoveryProjects[0]].head)],h.context,0);await entered;if(mode==='cancel')h.controller.abort(Error('Cancelled directory read'));else await h.f.r.store.db.query("UPDATE sre_locks SET owner='other-reviewer' WHERE name='single-agent'");release();await assert.rejects(()=>pending,/Cancelled|lease lost/);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_inventory'")).length,0);
 }finally{release?.();await h.f.close();}}
});
test('contradictory immutable directory observations withhold entries and do not manufacture source text',async()=>{
 const h=await harness();try{const request=tree(h.f.manifest.projects[discoveryProjects[0]].head);await h.followup.run([request],h.context,0);const c=await h.f.r.store.context(h.f.id),row=c.evidence.find(row=>row.kind==='source_inventory'),changed=structuredClone(row);changed.content.sourceInventory.entries[0].id='f'.repeat(40);changed.id=hash([c.incident.id,changed.source,changed.kind,changed.content]);const window=sourceInventoryWindow({...c,evidence:[changed,...c.evidence]});assert.equal(window.inventories[0].conflicting,true);assert.equal(window.inventories[0].entries.length,0);assert.equal(window.inventories[0].complete,false);assert.notDeepEqual(materialSourceInventory(window),materialSourceInventory(c.sourceInventories));
 }finally{await h.f.close();}
});
test('changed directory request provenance is rejected and oversized model inputs retain only delivered inventory citations',async()=>{
 const h=await harness();try{await h.followup.run([tree(h.f.manifest.projects[discoveryProjects[0]].head)],h.context,0);const c=await h.f.r.store.context(h.f.id),row=c.evidence.find(row=>row.kind==='source_inventory'),changed=structuredClone(row);changed.content.sourceInventory.request.path='tools';changed.id=hash([c.incident.id,changed.source,changed.kind,changed.content]);assert.equal(sourceInventoryWindow({...c,evidence:[changed]}).inventories.length,0);const view=boundedContext({...c,evidence:[...Array.from({length:150},(_,n)=>({id:'noise-'+n,source:'system',kind:'code_review',content:{text:'x'.repeat(15000)}})),...c.evidence]});assert.ok(Buffer.byteLength(JSON.stringify(view))<=modelContextLimits.totalBytes);assert.ok((view.sourceInventories?.inventories||[]).every(item=>view.evidence.some(row=>row.id===item.evidenceId)));
 }finally{await h.f.close();}
});
test('both requested source files get a read before optional history spends their remaining budget',async()=>{
 const h=await harness({history:true});try{await collectDiscoveryEvidence(h.context,{service:h.f.service,client:h.f.client,budget:h.budget});assert.equal(h.budget.reads,2);const requests=discoveryProjects.map(project=>({kind:'gitlab_file',project,sha:h.f.manifest.projects[project].head,path:'src/ledger/handler.py',startLine:1,endLine:4,reason:'Inspect the caller in both unresolved candidate repositories.'}));await h.followup.run(requests,h.context,0);assert.equal(h.followup.results.filter(row=>row.phase==='collected').length,2);assert.equal(h.budget.reads,0);
 }finally{await h.f.close();}
});
test('an optional deferred source read does not poison a later primary file cache or consume its reserved bytes',async()=>{
 const h=await harness();try{const service={...h.f.service,gitlab:{...h.f.service.gitlab,project:discoveryProjects[0],sourceInspection:{enabled:true}}},options={service,client:{file:(path,sha,extra)=>h.f.client.discoveryFile(discoveryProjects[0],path,sha,extra)},budget:h.budget},revision=h.f.manifest.projects[discoveryProjects[0]].head;h.budget.reads=1;h.budget.bytes=16000;const count=h.f.calls.length,deferred=await readImmutableSource('src/ledger/handler.py',revision,{...options,reserveReads:1,reserveBytes:16000});assert.equal(deferred.state,'unavailable');assert.equal(h.f.calls.length,count);assert.equal(h.budget.files.size,0);assert.equal(h.budget.reads,1);assert.equal(h.budget.bytes,16000);const primary=await readImmutableSource('src/ledger/handler.py',revision,options);assert.equal(primary.state,'available');assert.equal(h.budget.reads,0);
 }finally{await h.f.close();}
});
test('a provider directory with a foreign identity produces no retained artifact or expanded revision authority',async()=>{
 const h=await harness();try{const request=tree(h.f.manifest.projects[discoveryProjects[0]].head),original=h.f.client.discoveryDirectory.bind(h.f.client);h.f.client.discoveryDirectory=async(...args)=>({...await original(...args),sha:'f'.repeat(40)});await h.followup.run([request],h.context,0);assert.equal(h.followup.results[0].phase,'unavailable');assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_inventory'")).length,0);h.f.client.discoveryDirectory=original;const fresh=await h.f.r.store.context(h.f.id),policy=await h.followup.policy(fresh,1);assert.equal(policy.source.additionalProjects.some(item=>item.allowedRevisions.includes('f'.repeat(40))),false);
 }finally{await h.f.close();}
});
test('directory artifact and terminal receipt roll back together if terminal insertion fails',async()=>{
 const h=await harness();try{const transaction=h.f.r.store.db.transaction;h.f.r.store.db.transaction=fn=>transaction(q=>fn(async(sql,args=[])=>{if(sql.startsWith('INSERT INTO sre_evidence')&&args[3]==='evidence_read'&&JSON.parse(args[5]).phase==='collected')throw Error('Injected directory receipt failure');return q(sql,args);}));await assert.rejects(()=>h.followup.run([tree(h.f.manifest.projects[discoveryProjects[0]].head)],h.context,0),/receipt failure/);assert.equal((await h.f.r.store.db.query("SELECT id FROM sre_evidence WHERE kind='source_inventory'")).length,0);const rows=await h.f.r.store.db.query("SELECT content FROM sre_evidence WHERE kind='evidence_read'");assert.deepEqual(rows.map(row=>JSON.parse(row.content)).filter(row=>row.request?.kind==='gitlab_tree').map(row=>row.phase),['started']);
 }finally{await h.f.close();}
});
test('restore holds block directory reads before provider access',async()=>{
 const h=await harness();try{await h.f.r.store.checkpoint('recovery:database-restore',{version:1,active:true,restoreId:'directory-hold',backupSha256:'e'.repeat(64),preparedAt:await h.f.r.store.coordinationNow()});const count=h.f.calls.length;await assert.rejects(()=>h.followup.run([tree(h.f.manifest.projects[discoveryProjects[0]].head)],h.context,0),/held/);assert.equal(h.f.calls.length,count);
 }finally{await h.f.close();}
});
test('a directory blob identity never becomes an allowed commit or a verified source line',async()=>{
 const h=await harness();try{await h.followup.run([tree(h.f.manifest.projects[discoveryProjects[0]].head)],h.context,0);const c=await h.f.r.store.context(h.f.id),inventory=c.sourceInventories.inventories[0],policy=await h.followup.policy(c,1),blob=inventory.entries.find(entry=>entry.path==='src/ledger/handler.py');assert.ok(blob);assert.equal(policy.source.additionalProjects.find(item=>item.project===inventory.project).allowedRevisions.includes(blob.id),false);assert.equal(c.sourceCode.files.some(file=>file.evidenceId===inventory.evidenceId),false);const count=h.f.calls.length;await h.followup.run([tree(blob.id)],c,1);assert.equal(h.followup.results.at(-1).phase,'refused');assert.equal(h.f.calls.length,count);
 }finally{await h.f.close();}
});
