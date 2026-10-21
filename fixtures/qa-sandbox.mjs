import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {parse} from 'acorn';
import {seedPilot,pilotFiles} from '../scripts/seed-pilot.mjs';
import {reviewPolicySources} from '../src/sre/policy-catalog.mjs';
import {hash} from '../src/sre/security.mjs';

const exec=promisify(execFile);
const testSource=`import test from 'node:test';
import assert from 'node:assert/strict';
import {Auction} from '../src/auction/service.mjs';
test('concurrent bids retain the highest accepted winner',async()=>{const a=new Auction(),lot=a.lots[0],base=lot.currentBidCents;await Promise.all([a.bid(lot.id,base+30000,'A','higher',1),a.bid(lot.id,base+20000,'B','lower',40)]);assert.equal(lot.currentBidCents,base+30000);assert.deepEqual(a.telemetry().violations,[]);});
test('normal credit lookup accepts valid bid',async()=>{const a=new Auction(),lot=a.lots[0];assert.equal((await a.bid(lot.id,lot.currentBidCents+10000)).status,201);});
test('closed auction rejects bid',async()=>{const a=new Auction(),lot=a.lots[0];lot.endsAt=Date.now()-1000;assert.equal((await a.bid(lot.id,lot.currentBidCents+10000)).code,'AUCTION_CLOSED');});
test('catalog stays below the fixture latency budget',async()=>{const a=new Auction(),at=performance.now();await a.catalog();assert.ok(performance.now()-at<250);});
`;

// Deliberately a fixture adapter, not a production code runner. Only exact
// locally generated pilot trees are accepted, before any repository code runs.
export function createPilotQaAdapter(directory) {
  const manifest=seedPilot(),base=resolve(directory);
  const environment={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
  const gitRaw=async(repo,...args)=>(await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',repo,...args],{env:environment,encoding:'utf8',timeout:15000,maxBuffer:512*1024})).stdout;
  const git=async(repo,...args)=>(await gitRaw(repo,...args)).trim();
  return {localOnly:true,async execute({requestId,plan,markdown}) {
    if(!/^fix_[a-f0-9]{24}$/.test(requestId)||plan.patch?.path!=='src/auction/rules.mjs')throw Error('Unsupported local QA request');
    const entry=Object.entries(manifest.releases).find(([,r])=>r.sha===plan.patch.headSha);
    if(!entry||plan.patch.baseSha!==manifest.baseline)throw Error('QA accepts only an exact generated pilot revision');
    const files=pilotFiles(entry[0]),repo=await realpath(manifest.repository);
    const tree=(await git(repo,'ls-tree','-r',plan.patch.headSha)).split('\n').map(line=>{const match=/^(100644) blob ([a-f0-9]+)\t(.+)$/.exec(line);if(!match)throw Error('QA tree contains a non-regular file');return match[3];});
    if(JSON.stringify(tree.sort())!==JSON.stringify(Object.keys(files).sort()))throw Error('QA tree contains unexpected files');
    for(const [path,bytes]of Object.entries(files))if(hash(await git(repo,'show',plan.patch.headSha+':'+path))!==hash(bytes.toString('utf8').trim()))throw Error('QA source differs from the trusted generated fixture: '+path);
    const source=(await git(repo,'show',plan.patch.headSha+':src/auction/rules.mjs'))+'\n';
    const before=reviewPolicySources({path:plan.patch.path,complete:true,base:pilotFiles()['src/auction/rules.mjs'].toString(),head:source});
    if(!before.supported||before.findings.length!==1||before.findings[0].signal!==plan.patch.signal)throw Error('QA plan does not match a single supported policy defect');
    const workspace=resolve(base,requestId);await mkdir(base,{recursive:true,mode:0o700});await mkdir(workspace,{mode:0o700});
    // Copy immutable trusted bytes; do not inherit a remote URL, hooks, local
    // config, credentials, dependencies or arbitrary repository test commands.
    for(const [path,bytes]of Object.entries(files)){await mkdir(dirname(resolve(workspace,path)),{recursive:true});await writeFile(resolve(workspace,path),bytes);}
    await git(workspace,'init','-b','codex/qa-'+requestId.slice(4));
    const branch=await git(workspace,'branch','--show-current');
    await mkdir(resolve(workspace,'tests'),{recursive:true});await writeFile(resolve(workspace,'tests/qa-invariants.test.mjs'),testSource);
    await git(workspace,'add','.');await git(workspace,'-c','user.name=Fictional QA Agent','-c','user.email=qa@example.invalid','commit','-m','Import exact trusted drill source '+plan.patch.headSha);
    const run=async()=>{try{const r=await exec(process.execPath,['--test','tests/qa-invariants.test.mjs'],{cwd:workspace,env:environment,encoding:'utf8',timeout:30000,maxBuffer:256*1024});return {exitCode:0,output:r.stdout+r.stderr};}catch(e){if(typeof e.code!=='number')throw e;return {exitCode:e.code,output:(e.stdout||'')+(e.stderr||'')};}};
    const reproduction=await run();if(reproduction.exitCode===0)throw Error('Expected business defect did not reproduce');
    const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),declaration=ast.body.find(n=>n.type==='ExportNamedDeclaration'&&n.declaration?.declarations?.some(d=>d.id.name==='policy')).declaration.declarations.find(d=>d.id.name==='policy');
    const property=declaration.init.properties.filter(p=>(p.key.name||p.key.value)===plan.patch.field).at(-1);
    if(!property||property.value.type!=='Literal')throw Error('QA patch target is not a literal policy field');
    const patched=source.slice(0,property.value.start)+JSON.stringify(plan.patch.value)+source.slice(property.value.end);
    const after=reviewPolicySources({path:plan.patch.path,complete:true,base:pilotFiles()['src/auction/rules.mjs'].toString(),head:patched});
    if(!after.supported||after.findings.length)throw Error('Proposed correction leaves a known policy regression');
    await writeFile(resolve(workspace,plan.patch.path),patched);
    const validation=await run();
    await mkdir(resolve(workspace,'docs'),{recursive:true});await writeFile(resolve(workspace,'docs/fix-plan.md'),markdown);
    await writeFile(resolve(workspace,'docs/merge-request.md'),'# Draft: correct '+plan.patch.signal+'\n\nIncident: '+plan.incidentId+'\nSource SHA: '+plan.patch.headSha+'\n\nRestore the known policy field '+plan.patch.field+' to '+JSON.stringify(plan.patch.value)+'. The faulty revision failed the local business checks; the proposed revision '+(validation.exitCode===0?'passes all four checks.':'still fails checks and is not ready for review.')+'\n\nReview docs/fix-plan.md and docs/qa-result.json. This is a local MR draft; nothing has been pushed, merged or deployed.\n');
    await writeFile(resolve(workspace,'docs/qa-result.json'),JSON.stringify({requestId,sourceSha:plan.patch.headSha,reproduction,validation},null,2)+'\n');
    await git(workspace,'add','.');await git(workspace,'-c','user.name=Fictional QA Agent','-c','user.email=qa@example.invalid','commit','-m','Propose reviewed policy correction for '+plan.incidentId);
    const commit=await git(workspace,'rev-parse','HEAD');
    const patch=await gitRaw(workspace,'diff','HEAD^','HEAD','--',plan.patch.path);
    return {status:validation.exitCode===0?'passed':'failed',branch,commit,workspace,sourceSha:plan.patch.headSha,changedPath:plan.patch.path,patch,markdown,mergeRequestDraft:await git(workspace,'show','HEAD:docs/merge-request.md'),reproduction,validation,summary:'The original revision failed a business check; '+(validation.exitCode===0?'all four checks pass after the proposed correction.':'the proposed correction still fails checks.')+' Markdown plan and evidence are committed locally. Production recovery and data repair remain separate.'};
  }};
}
