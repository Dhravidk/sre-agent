import test from 'node:test';import assert from 'node:assert/strict';
import {hash} from '../src/sre/security.mjs';
import {sourceInventoryWindow,materialSourceInventory} from '../src/sre/source-inventory.mjs';
import {boundedContext,modelContextLimits} from '../src/sre/model-context.mjs';
const projects=['approved/ledger','approved/worker','approved/edge','approved/intake'],sha='a'.repeat(40),scope='f'.repeat(64);
const entry=(path,id='b'.repeat(40))=>({id,path,name:path.split('/').at(-1),type:'blob',mode:'100644'});
const context=rows=>({incident:{id:'inc_1234567890abcdef1234',service_key:'inventory-review',issue_key:'inventory-review-1',revision:1,title:'Synthetic directory reconciliation',status:'open',started_at:1000,updated_at:2000},sourceScope:{provider:'gitlab',discovery:{projects,scopeKey:scope,history:false}},evidence:rows,deployments:[],assessmentHistory:[],session:{agent_id:'fixture-agent'}});
function observation(entries,{project=projects[0],path='src',complete=false,at=1000,tag='observation'}={}){const request={kind:'gitlab_tree',reason:'Retained synthetic '+tag,project,sha,path},sourceInventory={version:1,project,sha,path,recursive:false,entries,invalidEntries:0,complete,discoveryScopeKey:scope,request,hostRead:{requestId:hash(['start',tag]),jobId:hash(['job',tag]),attempt:1}},content={sourceInventory},row={source:'gitlab',kind:'source_inventory',observed_at:at,content};return{...row,id:hash([context([]).incident.id,row.source,row.kind,content])};}
const paths=window=>window.inventories[0].entries.map(entry=>entry.path);

test('compatible partial inventories retain the union of paths with their actual supporting observation IDs',()=>{
 const a=observation([entry('src/caller.py'),entry('src/retry.py')],{tag:'early'}),b=observation([entry('src/retry.py'),entry('src/amounts.py')],{tag:'later',at:2000}),window=sourceInventoryWindow(context([b,a]));assert.deepEqual(paths(window),['src/amounts.py','src/caller.py','src/retry.py']);assert.equal(window.inventories[0].complete,false);assert.deepEqual(window.inventories[0].entries.find(entry=>entry.path==='src/caller.py').evidenceIds,[a.id]);assert.deepEqual(new Set(window.inventories[0].entries.find(entry=>entry.path==='src/retry.py').evidenceIds),new Set([a.id,b.id]));
});
test('a compatible later subset does not erase a retained complete witness or its caller path',()=>{
 const full=observation([entry('src/caller.py'),entry('src/retry.py')],{complete:true,tag:'full'}),part=observation([entry('src/retry.py')],{at:2000,tag:'subset'}),value=sourceInventoryWindow(context([part,full])).inventories[0];assert.equal(value.complete,true);assert.equal(value.evidenceId,full.id);assert.equal(value.latestObservationPartial,true);assert.deepEqual(value.entries.map(entry=>entry.path),['src/caller.py','src/retry.py']);
});
test('a complete listing conflicts with a later partial listing that introduces a new immutable path',()=>{
 const full=observation([entry('src/caller.py')],{complete:true,tag:'full'}),part=observation([entry('src/foreign.py')],{at:2000,tag:'new-path'}),value=sourceInventoryWindow(context([part,full])).inventories[0];assert.equal(value.conflicting,true);assert.equal(value.complete,false);assert.deepEqual(value.entries,[]);
});
test('partial identity conflicts and incompatible complete witnesses withhold entries',()=>{
 const a=observation([entry('src/caller.py')],{tag:'first'}),b=observation([entry('src/caller.py','c'.repeat(40))],{at:2000,tag:'changed'});assert.equal(sourceInventoryWindow(context([a,b])).inventories[0].conflicting,true);
 const full=observation([entry('src/other.py')],{complete:true,tag:'other-full'}),other=observation([entry('src/caller.py')],{complete:true,tag:'first-full'});assert.equal(sourceInventoryWindow(context([full,other])).inventories[0].conflicting,true);
});
test('the shared display byte budget gives every selected project entries before any second entry round',()=>{
 const folder='p'.repeat(180),rows=projects.map((project,n)=>observation(Array.from({length:40},(_,i)=>entry(folder+'/'+String(i).padStart(3,'0')+'_'+('a'.repeat(245))+'.py')),{project,path:folder,at:1000+n,tag:project})),window=sourceInventoryWindow(context(rows));assert.equal(window.inventories.length,4);assert.ok(window.inventories.every(value=>value.entries.length>0));assert.ok(window.coverage.entriesOmitted>0);const counts=window.inventories.map(value=>value.entries.length);assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
});
test('receipt time, input order and repeated same facts cannot change material inventory identity',()=>{
 const a=observation([entry('src/z.py'),entry('src/a.py')],{tag:'one'}),b=observation([entry('src/a.py'),entry('src/z.py')],{tag:'two',at:9000});assert.deepEqual(materialSourceInventory(sourceInventoryWindow(context([a]))),materialSourceInventory(sourceInventoryWindow(context([b,a]))));
});
test('delivered projection drops unsupported entries and cannot cite a hidden complete witness',()=>{
 const full=observation([entry('src/a.py'),entry('src/b.py')],{complete:true,tag:'hidden-full'}),partial=observation([entry('src/b.py')],{at:2000,tag:'visible-partial'}),window=sourceInventoryWindow(context([partial,full]),{evidenceIds:new Set([partial.id])}),value=window.inventories[0];assert.equal(value.complete,false);assert.deepEqual(value.entries.map(entry=>entry.path),['src/b.py']);assert.ok(value.entries.every(entry=>entry.evidenceIds.every(id=>id===partial.id)));assert.equal(value.completenessEvidenceOmitted,true);
});
test('a hidden contradiction remains a host conflict and never turns a visible packet into safe navigation',()=>{
 const full=observation([entry('src/a.py')],{complete:true,tag:'visible-full'}),bad=observation([entry('src/b.py')],{at:2000,tag:'hidden-conflict'}),value=sourceInventoryWindow(context([bad,full]),{evidenceIds:new Set([full.id])}).inventories[0];assert.equal(value.conflicting,true);assert.equal(value.conflictEvidenceOmitted,true);assert.deepEqual(value.entries,[]);
});
test('equal revisions in different projects remain distinct and no partial union certifies completeness',()=>{
 const rows=projects.slice(0,2).flatMap(project=>[observation([entry('src/a.py')],{project,tag:project+'-a'}),observation([entry('src/b.py')],{project,at:2000,tag:project+'-b'})]),window=sourceInventoryWindow(context(rows));assert.equal(window.inventories.length,2);assert.ok(window.inventories.every(value=>value.entries.length===2&&!value.complete));assert.ok(window.inventories.every(value=>value.entries.every(entry=>entry.evidenceIds.every(id=>rows.find(row=>row.id===id).content.sourceInventory.project===value.project))));
});
test('bounded model context includes only delivered inventory support IDs and remains within its total byte bound',()=>{
 const rows=[observation([entry('src/a.py')],{tag:'first'}),observation([entry('src/b.py')],{at:2000,tag:'second'})],noise=Array.from({length:140},(_,i)=>({id:hash(['model-noise',i]),source:'gitlab',kind:'change',observed_at:10000+i,content:{text:'x'.repeat(14000)}})),view=boundedContext(context([...noise,...rows]));assert.ok(Buffer.byteLength(JSON.stringify(view))<=modelContextLimits.totalBytes);const ids=new Set(view.evidence.map(row=>row.id));assert.ok((view.sourceInventories?.inventories||[]).every(value=>ids.has(value.evidenceId)&&value.entries.every(entry=>Array.isArray(entry.evidenceIds)&&entry.evidenceIds.length>0&&entry.evidenceIds.every(id=>ids.has(id)))));
});
test('more identical supporting receipts cannot shrink displayed navigation or repeat a material change',()=>{
 const folder='p'.repeat(180),entries=Array.from({length:40},(_,i)=>entry(folder+'/'+String(i).padStart(3,'0')+'_'+('a'.repeat(245))+'.py')),first=observation(entries,{path:folder,tag:'first'}),more=Array.from({length:8},(_,i)=>observation(entries,{path:folder,tag:'repeat-'+i,at:2000+i}));assert.deepEqual(materialSourceInventory(sourceInventoryWindow(context([first]))),materialSourceInventory(sourceInventoryWindow(context([...more,first]))));
});
test('a hot project cannot crowd a quiet directory out of the reserved model code budget',()=>{
 const quiet=observation([entry('src/quiet_caller.py')],{project:projects[1],tag:'quiet',at:500}),hot=Array.from({length:140},(_,i)=>observation([entry('src/hot.py')],{tag:'hot-'+i,at:2000+i})),view=boundedContext(context([...hot,quiet]));assert.ok(view.sourceInventories.inventories.some(value=>value.project===projects[1]&&value.entries.some(entry=>entry.path==='src/quiet_caller.py')));assert.ok(Buffer.byteLength(JSON.stringify(view))<=modelContextLimits.totalBytes);
});
test('omitted duplicate receipts do not falsely imply the actual conflict witnesses are hidden',()=>{
 const a=observation([entry('src/a.py')],{complete:true,tag:'conflict-a'}),b=observation([entry('src/b.py')],{tag:'conflict-b',at:2000}),duplicate=observation([entry('src/a.py')],{complete:true,tag:'duplicate-a',at:3000}),value=sourceInventoryWindow(context([duplicate,b,a]),{evidenceIds:new Set([a.id,b.id])}).inventories[0];assert.equal(value.conflicting,true);assert.equal(value.conflictEvidenceOmitted,undefined);assert.deepEqual(value.entries,[]);
});
