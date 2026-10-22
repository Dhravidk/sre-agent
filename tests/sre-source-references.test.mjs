import test from 'node:test';
import assert from 'node:assert/strict';
import {collectSourceEvidence,sourceScopeForService,sourceReadBudget,sourceInspectionLimits} from '../src/sre/source-evidence.mjs';
import {sourceReferenceWindow,validateSourceFindings,sourceReferenceLimits} from '../src/sre/source-references.mjs';
import {boundedContext,modelContextLimits} from '../src/sre/model-context.mjs';
import {validateInvestigation} from '../src/sre/reasoner.mjs';
import {fixtureRisk} from '../src/sre/analytic-risk.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {rehearsalProfile} from '../fixtures/sre-rehearsal.mjs';
import {hash} from '../src/sre/security.mjs';

const base='a'.repeat(40),head='b'.repeat(40),project='fixture/ledger',path='src/ledger/repository.py';
const service=()=>({gitlab:{project,sourceInspection:{enabled:true}}});
const change=(extra={})=>({old_path:path,new_path:path,new_file:false,deleted_file:false,renamed_file:false,diff:'@@ -2,3 +2,3 @@\n expected = request.version\n- update_if_version(expected)\n+ update_without_version()\n return response',...extra});
const proof=(diffs=[change()])=>({provider:'gitlab',comparisonKind:'deployment',baseSha:base,headSha:head,complete:true,comparison:{diffs}});
const content='class Ledger:\n    expected = request.version\n    update_without_version()\n    return response\n';
async function materialize({value=content,request=proof(),owner=service(),reader,budget}={}){
 const calls=[],client={file:async(p,s,options)=>{calls.push([p,s]);return reader?reader(p,s,options):{path:p,sha:s,complete:true,content:value};}};
 const inspection=await collectSourceEvidence(request,{service:owner,client,budget});
 const row={id:'e'.repeat(64),source:'gitlab',kind:'release_diff',observed_at:1000,content:{...request,sourceInspection:inspection}};
 const context={incident:{id:'inc-source',service_key:'source-fixture',started_at:1000,status:'open'},session:{agent_id:'source-fixture'},sourceScope:sourceScopeForService(owner),evidence:[row],deployments:[]};
 return {calls,inspection,context,row};
}
const finding=f=>({evidenceId:f.row.id,provider:'gitlab',project,sha:head,path,startLine:3,endLine:3,quote:'    update_without_version()',explanation:'The update omits the observed version in this exact source; reproduce the request before treating it as cause.'});

test('generic source collection is explicitly off by default and cannot choose another provider',async()=>{
 let calls=0;const client={file:async()=>{calls++;throw Error('No source read expected');}};
 assert.equal(await collectSourceEvidence(proof(),{service:{gitlab:{project}},client}),null);
 assert.equal(await collectSourceEvidence({...proof(),provider:'github'},{service:service(),client}),null);assert.equal(calls,0);
});
test('exact immutable source sides retain their actual paths, content hashes and line windows',async()=>{
 const f=await materialize();assert.deepEqual(f.calls,[[path,base],[path,head]]);assert.equal(f.inspection.coverage.complete,true);
 assert.equal(f.inspection.files[0].head.content,content);assert.equal(f.inspection.files[0].head.lineCount,5);
 const window=sourceReferenceWindow(f.context);assert.equal(window.files.length,2);assert.ok(window.files.every(file=>file.project===project&&file.lines.some(l=>l.line===3)));
});
test('renames read the old path at base and the new path at head without guessing branch contents',async()=>{
 const f=await materialize({request:proof([change({old_path:'src/old_ledger.py'})])});assert.deepEqual(f.calls,[['src/old_ledger.py',base],[path,head]]);
 const w=sourceReferenceWindow(f.context);assert.ok(w.files.some(x=>x.path==='src/old_ledger.py'&&x.sha===base));assert.ok(w.files.some(x=>x.path===path&&x.sha===head));
});
for(const [name,extra,expected]of [['added',{new_file:true},head],['deleted',{deleted_file:true},base]])test(name+' source reads only the present diff side and cannot cite provider-reported absence',async()=>{
 const f=await materialize({request:proof([change(extra)])});assert.deepEqual(f.calls,[[path,expected]]);const window=sourceReferenceWindow(f.context);assert.equal(window.files.length,1);assert.equal(window.files[0].sha,expected);
});
test('unsafe, foreign URL, unsupported and contradictory changed paths stay omitted without a file request',async()=>{
 const paths=['../private.py','/src/private.py','src//file.py','src/file.py?ref=main','https://foreign.invalid/file.py','secrets.key'];
 const f=await materialize({request:proof([...paths.map(p=>change({old_path:p,new_path:p})),change({new_file:true,deleted_file:true})])});assert.equal(f.calls.length,0);assert.equal(f.inspection.coverage.omittedFiles,7);assert.equal(f.inspection.coverage.complete,false);
});
for(const [name,request]of [['mutable ref',{...proof(),headSha:'main'}],['partial comparison',{...proof(),complete:false}]])test(name+' cannot initiate generic source reads',async()=>{
 const f=await materialize({request});assert.equal(f.calls.length,0);assert.equal(f.inspection.coverage.complete,false);assert.ok(f.inspection.error);
});
test('one unavailable file does not erase another exact source response or manufacture an empty healthy file',async()=>{
 const f=await materialize({reader:async(p,s)=>{if(s===base)throw Error('Fictional denied source read');return {path:p,sha:s,content,complete:true};}});
 assert.equal(f.inspection.coverage.unavailableSides,1);assert.equal(f.inspection.coverage.complete,false);assert.equal(f.inspection.files[0].base.state,'unavailable');assert.equal(sourceReferenceWindow(f.context).files.length,1);
 assert.equal(sourceReferenceWindow(f.context).coverage.sourceReadsUnavailable,1);
});
for(const [name,changeValue]of [['revision',v=>({...v,sha:base})],['path',v=>({...v,path:'foreign.py'})],['coverage',v=>({...v,complete:false})],['type',v=>({...v,content:42})]])test('source '+name+' mismatch is unavailable rather than a verified excerpt',async()=>{
 const f=await materialize({reader:async(p,s)=>changeValue({path:p,sha:s,content,complete:true})});assert.ok(f.inspection.coverage.unavailableSides>0);
});
test('redacted source keeps original line numbers and separate original/display hashes',async()=>{
 const f=await materialize({value:'class Ledger:\n    secret=fictional-source-secret\n    return 1\n'}),entry=f.inspection.files[0].head;
 assert.equal(entry.redacted,true);assert.equal(entry.lineCount,4);assert.notEqual(entry.sourceContentHash,entry.contentHash);assert.ok(!JSON.stringify(f.inspection).includes('fictional-source-secret'));
 assert.equal(sourceReferenceWindow(f.context).files[0].lines.find(l=>l.line===3).text,'    return 1');
});
test('redaction that changes line layout and credential blocks cannot become plausible numbered source',async()=>{
 for(const value of ['secret=\nfictional-value\nreturn 1','-----BEGIN PRIVATE KEY-----\nfictional-not-a-key\n-----END PRIVATE KEY-----']){
  const f=await materialize({value});assert.equal(f.inspection.files[0].head.state,'unavailable');assert.equal(sourceReferenceWindow(f.context).files.length,0);
 }
});
test('accepted source bytes, changed-file count and turn-wide read budgets remain bounded',async()=>{
 const budget=sourceReadBudget(),diffs=Array.from({length:8},(_,n)=>change({old_path:'src/f'+n+'.py',new_path:'src/f'+n+'.py'})),f=await materialize({request:proof(diffs),value:'x'.repeat(15000),budget});
 assert.ok(f.calls.length<=sourceInspectionLimits.readsPerTurn);assert.equal(f.inspection.coverage.selectedFiles,4);assert.equal(f.inspection.coverage.omittedFiles,4);assert.ok(budget.bytes>=0);assert.equal(f.inspection.coverage.complete,false);
});
test('one turn reuses an exact source read across repeated comparisons without exhausting another file',async()=>{
 const budget=sourceReadBudget(),owner=service(),calls=[],client={file:async(p,s)=>{calls.push([p,s]);return{path:p,sha:s,content,complete:true};}};
 await Promise.all([collectSourceEvidence(proof(),{service:owner,client,budget}),collectSourceEvidence(proof(),{service:owner,client,budget})]);
 assert.equal(calls.length,2);assert.equal(budget.reads,sourceInspectionLimits.readsPerTurn-2);
});
test('a turn cache cannot reuse the same numeric project/path/revision across different configured hosts',async()=>{
 const budget=sourceReadBudget(),calls=[],client={file:async(p,s)=>{calls.push([p,s]);return{path:p,sha:s,content,complete:true};}};
 for(const base of ['https://one.invalid','https://two.invalid'])await collectSourceEvidence(proof(),{service:{...service(),gitlab:{...service().gitlab,project:'17',base}},client,budget});
 assert.equal(calls.length,4);
});
test('cancelled source reads cannot return a completed inspection package',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(()=>collectSourceEvidence(proof(),{service:service(),signal:controller.signal,client:{file:async(p,s,options)=>{calls++;assert.equal(options.signal,controller.signal);controller.abort(Error('Fictional source cancellation'));return{path:p,sha:s,content,complete:true};}}}),/cancellation/);assert.equal(calls,1);
});
test('source snippets near a distant changed hunk retain actual line numbers and explicit omitted lines',async()=>{
 const value=Array.from({length:220},(_,n)=>'line '+(n+1)).join('\n'),f=await materialize({value,request:proof([change({diff:'@@ -180,2 +180,2 @@\n code'})])}),window=sourceReferenceWindow(f.context);
 assert.ok(window.files[0].lines.some(l=>l.line===180&&l.text==='line 180'));assert.ok(window.files[0].omittedLines>0);assert.ok(!window.files[0].lines.some(l=>l.line===1));
 assert.ok(Buffer.byteLength(JSON.stringify(window))<=sourceReferenceLimits.totalBytes);
});
test('well formed exact quotes become location-verified hypotheses without manufacturing deployment identity',async()=>{
 const f=await materialize(),delivered=boundedContext(f.context),[checked]=validateSourceFindings([finding(f)],f.context,delivered);
 assert.equal(checked.verifiedLocation,true);assert.match(checked.interpretation,/not established cause/);assert.equal(f.context.deployments.length,0);
});
for(const [name,changeFinding]of [['foreign project',{project:'foreign/ledger'}],['foreign ref',{sha:'c'.repeat(40)}],['foreign file',{path:'src/other.py'}],['fabricated line',{startLine:100,endLine:100}],['wrong quote',{quote:'update_if_version()'}],['unseen evidence',{evidenceId:'d'.repeat(64)}],['fractional line',{startLine:1.5}],['reversed range',{startLine:4,endLine:2}],['extra authority field',{approved:true}]])test(name+' is rejected by the host source-reference validator',async()=>{
 const f=await materialize();assert.throws(()=>validateSourceFindings([{...finding(f),...changeFinding}],f.context,boundedContext(f.context)));
});
test('a raw retained line omitted from the actual delivered excerpt cannot be guessed and cited',async()=>{
 const f=await materialize(),delivered=boundedContext(f.context);for(const file of delivered.sourceCode.files)file.lines=file.lines.filter(l=>l.line!==3);
 assert.throws(()=>validateSourceFindings([finding(f)],f.context,delivered),/omitted/);
});
test('a source package from a different configured project or with changed saved bytes cannot validate a quote',async()=>{
 const f=await materialize(),delivered=boundedContext(f.context);f.context.sourceScope={provider:'gitlab',project:'different/project'};assert.throws(()=>validateSourceFindings([finding(f)],f.context,delivered));
 f.context.sourceScope={provider:'gitlab',project};f.row.content.sourceInspection.files[0].head.content+='\nchanged';assert.throws(()=>validateSourceFindings([finding(f)],f.context,delivered));
});
test('different retained bytes for one immutable file identity cannot supply an arbitrary verified citation',async()=>{
 const f=await materialize(),other=await materialize({value:content.replace('update_without_version','update_with_version')});other.row.id='f'.repeat(64);f.context.evidence.push(other.row);
 const view=boundedContext(f.context);assert.equal(view.sourceCode.coverage.conflictingFiles,2);assert.ok(view.sourceCode.files.every(file=>file.conflicting));
 assert.throws(()=>validateSourceFindings([finding(f)],f.context,view),/conflicting/);
 f.context.evidence.push({...f.row,id:'repeat'});assert.throws(()=>validateSourceFindings([finding(f)],f.context,boundedContext(f.context)),/conflicting/);
});
test('redacted responses cannot hide different original bytes under one immutable source identity',async()=>{
 const f=await materialize({value:'class Ledger:\n    secret=first-fictional-value\n    return 1\n'}),other=await materialize({value:'class Ledger:\n    secret=second-fictional-value\n    return 1\n'});other.row.id='f'.repeat(64);
 assert.equal(f.inspection.files[0].head.contentHash,other.inspection.files[0].head.contentHash);assert.notEqual(f.inspection.files[0].head.sourceContentHash,other.inspection.files[0].head.sourceContentHash);f.context.evidence.push(other.row);
 const view=boundedContext(f.context);assert.equal(view.sourceCode.coverage.conflictingFiles,2);
 assert.throws(()=>validateSourceFindings([{...finding(f),quote:'    return 1'}],f.context,view),/conflicting/);
});
test('different redaction representations of the same recorded source bytes do not invent a Git identity conflict',async()=>{
 const f=await materialize({value:'class Ledger:\n    secret=fictional-value\n    return 1\n'}),second=structuredClone(f.row);second.id='f'.repeat(64);
 for(const side of ['base','head']){const value=second.content.sourceInspection.files[0][side];value.content=value.content.replace('[redacted]','[masked]');value.contentHash=hash(value.content);}
 f.context.evidence.push(second);const view=boundedContext(f.context);assert.equal(view.sourceCode.coverage.conflictingFiles,0);
 assert.equal(validateSourceFindings([{...finding(f),quote:'    return 1'}],f.context,view)[0].verifiedLocation,true);
});
test('investigation output must cite the source artifact and keeps candidateSha tied to an observed deployment',async()=>{
 const f=await materialize(),data={summary:'Inspect the concurrent update',hypotheses:[],changeAssessment:'unknown',candidateSha:null,evidenceIds:[f.row.id],unknowns:[],nextSteps:[],risk:fixtureRisk(f.context),sourceFindings:[finding(f)]};
 const checked=validateInvestigation(data,f.context);assert.equal(checked.sourceFindings[0].verifiedLocation,true);assert.match(checked.text,/verified location; cause unverified/);
 assert.throws(()=>validateInvestigation({...data,evidenceIds:[]},f.context),/supporting/);assert.throws(()=>validateInvestigation({...data,candidateSha:head},f.context),/ineligible deployment/);
});
test('source inspection configuration is explicit, project scoped and cannot silently accept a requested larger budget',()=>{
 for(const [value,configuredProject]of [[true,project],[{},project],[{enabled:'true'},project],[{enabled:true,maxFiles:100},project],[{enabled:true},'../foreign'],[{enabled:true},undefined]]){
  const raw=rehearsalProfile();raw.services[0].gitlab={...raw.services[0].gitlab,project:configuredProject,sourceInspection:value};assert.throws(()=>validateConfig(raw,{SRE_CLAUDE_BIN:'/nonexistent-source-configuration'}));
 }
});
test('large model input keeps source references tied only to evidence IDs that actually fit the transport',async()=>{
 const f=await materialize();f.context.evidence.push(...Array.from({length:80},(_,n)=>({id:'noise-'+n,source:'dynatrace',kind:'logs',observed_at:n,content:{message:'🧪'.repeat(20000)}})));
 const view=boundedContext(f.context);assert.ok(Buffer.byteLength(JSON.stringify(view))<=modelContextLimits.totalBytes);assert.ok(view.sourceCode.files.every(file=>view.evidence.some(row=>row.id===file.evidenceId)));
});
