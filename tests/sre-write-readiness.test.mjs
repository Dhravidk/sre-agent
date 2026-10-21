import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessReadiness } from '../src/sre/readiness.mjs';

function fixture(provider='github') {
  return {config:{mode:'connected',services:[{key:'auction-test',name:'Auction test',tenant:'synthetic-tenant',environment:'staging',
    [provider]:{enabled:true,base:'https://code.test-org.org',repository:'team/auction',project:'17',tokenEnv:'READ',webhookSecretEnv:'HOOK'},
    rollback:{enabled:true,provider,workflow:'rollback.yml',ref:'main',tokenEnv:'WRITE'},teams:{},
  }]},env:{READ:'private-synthetic-read',HOOK:'private-synthetic-hook',SRE_API_TOKEN:'private-synthetic-api',SRE_CAPABILITY_SECRET:'c'.repeat(32)}};
}
const writer=report=>report.checks.find(check=>check.source==='rollback');
function cli(f) {
  const directory=mkdtempSync(join(tmpdir(),'sre-write-readiness-')),path=join(directory,'config.json');writeFileSync(path,JSON.stringify(f.config));
  try {return spawnSync(process.execPath,['scripts/sre-readiness.mjs','--json','--strict'],{env:{...f.env,SRE_CONFIG:path},encoding:'utf8'});}
  finally {rmSync(directory,{recursive:true,force:true});}
}

for(const provider of ['github','gitlab'])test(provider+': strict setup cannot pass an enabled rollback with no write credential',()=>{
  const f=fixture(provider),result=cli(f);assert.equal(result.status,1,result.stderr);const report=JSON.parse(result.stdout),check=writer(report);
  assert.equal(report.core.runtimeConfigurationValid,true);assert.equal(check.enabled,true);assert.equal(check.configurationReady,false);assert.ok(check.missing.includes('WRITE'));
  assert.equal(report.networkCalls,0);for(const value of Object.values(f.env))assert.ok(!result.stdout.includes(value));
});

test('an explicitly configured static writer remains live-unverified and the strict CLI does not call providers',()=>{
  const f=fixture();f.env.WRITE='private-synthetic-writer';let calls=0;const original=global.fetch;global.fetch=()=>{calls++;throw Error('Unexpected write');};
  try {
    const report=assessReadiness(f.config,f.env),check=writer(report);assert.equal(check.configurationReady,true);assert.equal(check.credentialMode,'static-token');assert.equal(check.liveValidated,false);assert.equal(calls,0);
    const result=cli(f);assert.equal(result.status,0,result.stderr);assert.ok(!result.stdout.includes(f.env.WRITE));
  } finally {global.fetch=original;}
});

test('writer OAuth fallback uses only its explicit credentials and does not require the unused static token',()=>{
  const f=fixture(),service=f.config.services[0];service.rollback.oauth={tokenUrl:'https://write-issuer.test-org.org/token',clientIdEnv:'WRITE_ID',clientSecretEnv:'WRITE_SECRET'};
  Object.assign(f.env,{WRITE_ID:'private-write-client',WRITE_SECRET:'private-write-secret'});
  const report=assessReadiness(f.config,f.env),check=writer(report);assert.equal(check.configurationReady,true);assert.equal(check.credentialMode,'oauth');assert.ok(!check.missing.includes('WRITE'));assert.equal(check.liveValidated,false);
  const result=cli(f);assert.equal(result.status,0,result.stderr);for(const value of Object.values(f.env))assert.ok(!result.stdout.includes(value));
});

test('reader OAuth credentials cannot certify an unconfigured writer',()=>{
  const f=fixture(),service=f.config.services[0];service.github.oauth={tokenUrl:'https://read-issuer.test-org.org/token',clientIdEnv:'READ_ID',clientSecretEnv:'READ_SECRET'};
  delete f.env.READ;Object.assign(f.env,{READ_ID:'private-read-client',READ_SECRET:'private-read-secret'});
  const check=writer(assessReadiness(f.config,f.env));assert.equal(check.credentialMode,'static-token');assert.ok(check.missing.includes('WRITE'));assert.ok(!check.missing.includes('READ_ID'));
});

test('malformed writer issuer configuration is reported by field name without its embedded credential',()=>{
  const f=fixture();f.config.services[0].rollback.oauth={tokenUrl:'https://name:private-url-secret@write-issuer.test-org.org/token',clientIdEnv:'WRITE_ID',clientSecretEnv:'WRITE_SECRET'};
  Object.assign(f.env,{WRITE_ID:'private-write-client',WRITE_SECRET:'private-write-secret'});
  const result=cli(f);assert.equal(result.status,1,result.stderr);const check=writer(JSON.parse(result.stdout));assert.ok(check.missing.includes('rollback.oauth.tokenUrl'));assert.ok(!result.stdout.includes('private-url-secret'));
});

for(const source of ['github','rollback'])test(source+': explicit placeholder account labels prevent strict readiness',()=>{
  const f=fixture();f.env.WRITE='private-synthetic-write';f.config.services[0][source].retryScope='REPLACE-WITH-ACCOUNT-LABEL';
  const result=cli(f);assert.equal(result.status,1,result.stderr);const check=JSON.parse(result.stdout).checks.find(check=>check.source===source);assert.ok(check.missing.includes(source+'.retryScope'));
});

test('a selected OAuth issuer placeholder quota label is incomplete, while absent optional labels are allowed',()=>{
  const f=fixture();f.env.WRITE='private-synthetic-write';const service=f.config.services[0];
  service.github.oauth={tokenUrl:'https://read-issuer.test-org.org/token',clientIdEnv:'READ_ID',clientSecretEnv:'READ_SECRET',retryScope:'REPLACE-WITH-ISSUER-LABEL'};
  delete f.env.READ;Object.assign(f.env,{READ_ID:'private-read-client',READ_SECRET:'private-read-secret'});
  const result=cli(f);assert.equal(result.status,1,result.stderr);assert.ok(JSON.parse(result.stdout).checks.find(check=>check.source==='github').missing.includes('github.oauth.retryScope'));
  delete service.github.oauth.retryScope;assert.equal(cli(f).status,0);
});

test('disabled rollback can be staged with missing write credentials without failing a read-only setup',()=>{
  const f=fixture();f.config.services[0].rollback.enabled=false;const result=cli(f);assert.equal(result.status,0,result.stderr);const check=writer(JSON.parse(result.stdout));assert.equal(check.enabled,false);assert.equal(check.configurationReady,false);
});

test('legitimate environment names in quota labels and workflow refs are not mistaken for templates',()=>{
  const f=fixture();f.env.WRITE='private-synthetic-write';const service=f.config.services[0];
  service.github.retryScope='production-environment';service.rollback.ref='fix/environment-parser';service.rollback.workflow='environment-check.yml';
  assert.equal(cli(f).status,0);
});

test('a string rollback enabled flag cannot bypass strict setup while the runtime treats it as enabled',()=>{
  const f=fixture();f.config.services[0].rollback.enabled='true';const result=cli(f);assert.equal(result.status,1,result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.core.runtimeConfigurationValid,false);assert.ok(report.core.missing.some(item=>item.includes('rollback.enabled must be a boolean')));
});
