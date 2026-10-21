import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync,spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { seedPilot } from '../scripts/seed-pilot.mjs';
import { packageSandbox } from '../scripts/package-sandbox.mjs';
import { scenarios } from '../src/scenarios.mjs';

const root=resolve('.');
function git(repo,args,input,env={}) {return execFileSync('git',['-C',repo,...args],{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],env:{...process.env,...env}}).trim();}
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'sre-publication-')),manifest=structuredClone(seedPilot()),repo=join(directory,'source.git');
  git(directory,['clone','--bare','--no-local',manifest.repository,repo]);manifest.repository=repo;
  return {directory,manifest,repo,output:join(directory,'package'),close:()=>rmSync(directory,{recursive:true,force:true})};
}
function changedCommit(f,{file,mode='100644',bytes='private-synthetic-marker',message,parent=f.manifest.baseline}={}) {
  const index=join(f.directory,'mutation-index'),env={GIT_INDEX_FILE:index,GIT_AUTHOR_NAME:'Auction Lab',GIT_AUTHOR_EMAIL:'auction-lab@example.invalid',GIT_COMMITTER_NAME:'Auction Lab',GIT_COMMITTER_EMAIL:'auction-lab@example.invalid'};
  git(f.repo,['read-tree',parent],undefined,env);
  let blob;
  if(file){blob=git(f.repo,['hash-object','-w','--stdin'],bytes);git(f.repo,['update-index','--add','--cacheinfo',mode,blob,file],undefined,env);}
  const tree=git(f.repo,['write-tree'],undefined,env),revision=git(f.repo,['commit-tree',tree,'-p',parent,'-m',message],undefined,env);
  return {revision,blob};
}
const heads=repo=>Object.fromEntries(git(repo,['for-each-ref','--format=%(refname) %(objectname)']).split('\n').map(line=>line.split(' ')));

test('a scoped bundle survives clone and atomic publication of all eight exact branches to a local bare target',()=>{
  const f=fixture();
  try {
    const before=git(f.repo,['config','--get','remote.origin.url']),report=packageSandbox(f),clone=join(f.directory,'publish.git'),remote=join(f.directory,'local-remote.git');
    git(f.directory,['clone','--bare',join(report.directory,'pilot.bundle'),clone]);git(f.directory,['init','--bare','-b','main',remote]);
    git(clone,['-c','user.name=Auction Lab','-c','user.email=auction-lab@example.invalid','tag','-a','private-local-tag',report.baseline,'-m','Private synthetic annotation after clone']);
    git(clone,['-c','push.followTags=true','push','--atomic','--no-follow-tags',remote,...Object.keys(report.refs)]);assert.deepEqual(heads(remote),report.refs);assert.equal(report.roundtripVerified,true);assert.equal(report.verifiedRefs,8);assert.equal(report.networkCalls,0);assert.equal(report.repositoryPublished,false);
    assert.equal(git(f.repo,['config','--get','remote.origin.url']),before);const instructions=readFileSync(join(report.directory,'README.md'),'utf8');assert.ok(instructions.includes('git clone --bare'));assert.ok(instructions.includes('git push --atomic --no-follow-tags https://github.com/OWNER/REPOSITORY.git'));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(report.directory,'manifest.json'),'utf8')).refs),Object.keys(report.refs));
  } finally {f.close();}
});

test('unrelated refs, tags and private objects never enter the approved bundle',()=>{
  const f=fixture();
  try {
    const secret=changedCommit(f,{file:'.env',message:'Private unrelated branch'});git(f.repo,['update-ref','refs/heads/unrelated-private',secret.revision]);git(f.repo,['update-ref','refs/tags/private-tag',secret.revision]);
    const report=packageSandbox(f),clone=join(f.directory,'inspect.git');git(f.directory,['clone','--bare',join(report.directory,'pilot.bundle'),clone]);assert.deepEqual(heads(clone),report.refs);
    const objects=git(clone,['cat-file','--batch-all-objects','--batch-check=%(objectname)']).split('\n');assert.ok(!objects.includes(secret.revision));assert.ok(!objects.includes(secret.blob));
  } finally {f.close();}
});

test('an atomic publication conflict leaves every target ref unchanged',()=>{
  const f=fixture();
  try {
    const report=packageSandbox(f),clone=join(f.directory,'publish.git'),remote=join(f.directory,'nonempty-target.git');
    git(f.directory,['clone','--bare',join(report.directory,'pilot.bundle'),clone]);git(f.directory,['init','--bare','-b','main',remote]);
    git(remote,['fetch',join(report.directory,'pilot.bundle'),f.manifest.releases['healthy-release'].sha+':refs/heads/main']);const before=heads(remote);
    assert.throws(()=>git(clone,['push','--atomic',remote,...Object.keys(report.refs)]));assert.deepEqual(heads(remote),before);assert.equal(Object.keys(heads(remote)).length,1);
  } finally {f.close();}
});

for(const fault of ['extra-file','changed-code','symlink','private-message','extra-parent'])test(fault+': publication rejects an altered approved graph before producing a package',()=>{
  const f=fixture(),scenario=scenarios.find(item=>item.id==='credit-timeout');
  try {
    const normal=git(f.repo,['show',f.manifest.releases[scenario.id].sha+':src/auction/rules.mjs']);
    let change;
    if(fault==='extra-parent') {
      change=changedCommit(f,{message:'Healthy auction baseline'});f.manifest.baseline=change.revision;
    } else {
      const file=fault==='extra-file'?'.env':'src/auction/rules.mjs',bytes=fault==='changed-code'?'private-synthetic-marker':normal+'\n';
      change=changedCommit(f,{file,bytes,mode:fault==='symlink'?'120000':'100644',message:fault==='private-message'?'Private synthetic commit message':scenario.ticket+' '+scenario.title});
      f.manifest.releases[scenario.id].sha=change.revision;git(f.repo,['update-ref','refs/heads/'+scenario.id,change.revision]);
    }
    assert.throws(()=>packageSandbox(f),/Pilot (tree|bytes|commit)/);assert.equal(existsSync(f.output),false);
  } finally {f.close();}
});

test('branch drift and existing output are preserved and rejected',()=>{
  const f=fixture();
  try {
    git(f.repo,['update-ref','refs/heads/main',f.manifest.releases['healthy-release'].sha]);assert.throws(()=>packageSandbox(f),/branch moved/);assert.equal(existsSync(f.output),false);
    git(f.repo,['update-ref','refs/heads/main',f.manifest.baseline]);mkdirSync(f.output);writeFileSync(join(f.output,'keep.txt'),'keep');assert.throws(()=>packageSandbox(f),/already exists/);assert.equal(readFileSync(join(f.output,'keep.txt'),'utf8'),'keep');
  } finally {f.close();}
});

test('fresh pilot generation produces the same trusted source contracts and an exportable graph',()=>{
  const directory=mkdtempSync(join(tmpdir(),'sre-fresh-pilot-'));
  try {
    for(const file of ['scripts/seed-pilot.mjs','src/scenarios.mjs','src/auction/rules.mjs','src/auction/service.mjs','fixtures/pilot/server.mjs']){mkdirSync(dirname(join(directory,file)),{recursive:true});cpSync(join(root,file),join(directory,file));}
    const manifest=JSON.parse(execFileSync(process.execPath,[join(directory,'scripts/seed-pilot.mjs')],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    const report=packageSandbox({manifest,output:join(directory,'package')});assert.equal(report.verifiedCommitCount,8);assert.equal(report.roundtripVerified,true);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('the exported pilot serves a measurable credit fault and a healthy baseline after branch replacement',async()=>{
  const f=fixture();let child,exited;
  async function stop(){if(!child)return;child.kill('SIGTERM');await exited;child=null;}
  async function start(folder,branch) {
    git(folder,['checkout',branch]);const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
    child=spawn(process.execPath,['server.mjs'],{cwd:folder,env:{PATH:process.env.PATH,PORT:String(port)},stdio:['ignore','pipe','pipe']});exited=once(child,'exit');
    await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw Error('Pilot failed to start');})]);
    const base='http://127.0.0.1:'+port,health=await fetch(base+'/health',{signal:AbortSignal.timeout(3000)});assert.equal(health.status,200);
    const result=await fetch(base+'/api/lots/LOT-1042/bids',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amountCents:2200000,dealer:'Synthetic publication probe'}),signal:AbortSignal.timeout(3000)});
    return {status:result.status,code:(await result.json()).code};
  }
  try {
    const report=packageSandbox(f),folder=join(f.directory,'working');git(f.directory,['clone',join(report.directory,'pilot.bundle'),folder]);
    assert.deepEqual(await start(folder,'scenarios/credit-timeout'),{status:504,code:'CREDIT_TIMEOUT'});await stop();
    assert.deepEqual(await start(folder,'main'),{status:201,code:'BID_ACCEPTED'});await stop();
  } finally {await stop();f.close();}
});
