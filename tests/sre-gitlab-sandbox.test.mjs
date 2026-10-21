import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {seedGitlabSandbox} from '../scripts/seed-gitlab-sandbox.mjs';
import {reviewPolicySources} from '../src/sre/policy-catalog.mjs';

test('GitLab sandbox preserves a fixed historical bug and exact supported fault comparisons',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'sre-gitlab-history-'));
 try {
  const repo=resolve(dir,'repo'),m=seedGitlabSandbox(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  assert.equal(git('rev-list','--all','--count'),'12');assert.equal(Object.keys(m.refs).length,8);
  const policy=sha=>git('show',sha+':src/auction/rules.mjs');
  assert.match(policy(m.history[2].sha),/checkVersion: false/);assert.match(policy(m.baseline),/checkVersion: true/);
  for(const item of Object.values(m.scenarios)) {
   const review=reviewPolicySources({path:'src/auction/rules.mjs',complete:true,base:policy(m.baseline),head:policy(item.sha)});
   if(item.expected)assert.ok(review.findings.some(row=>row.signal===item.expected),item.id);
   else assert.deepEqual(review.findings,[]);
  }
  assert.match(readFileSync(resolve(repo,'.gitlab-ci.yml'),'utf8'),/when: never/);
  assert.match(readFileSync(resolve(repo,'.gitlab-ci.yml'),'utf8'),/^sandbox_checks_disabled:\n  script:/m);
  assert.deepEqual(seedGitlabSandbox(repo),m);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('GitLab preparation refuses to overwrite a preexisting checkout or local changes',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'sre-gitlab-preserve-'));
 try {
  const existing=resolve(dir,'existing');mkdirSync(existing);writeFileSync(resolve(existing,'keep.txt'),'owned file');
  assert.throws(()=>seedGitlabSandbox(existing),/existing files are preserved/);
  assert.equal(readFileSync(resolve(existing,'keep.txt'),'utf8'),'owned file');
  const repo=resolve(dir,'repo');seedGitlabSandbox(repo);writeFileSync(resolve(repo,'README.md'),'local edit');
  assert.throws(()=>seedGitlabSandbox(repo),/local changes/);assert.equal(readFileSync(resolve(repo,'README.md'),'utf8'),'local edit');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('GitLab preparation rejects moved refs instead of silently rewriting its history',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'sre-gitlab-ref-'));
 try {
  const repo=resolve(dir,'repo'),m=seedGitlabSandbox(repo);
  execFileSync('git',['-C',repo,'update-ref','refs/heads/codex/drill-bid-race',m.baseline]);
  assert.throws(()=>seedGitlabSandbox(repo),/Sandbox ref changed/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
