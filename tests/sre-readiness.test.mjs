import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessReadiness } from '../src/sre/readiness.mjs';

test('readiness inventories missing vendor setup without making network calls or exposing secrets',()=>{
  const config=JSON.parse(readFileSync(new URL('../config/sre.connected.example.json',import.meta.url),'utf8'));
  const token='credential-that-must-not-appear';
  const report=assessReadiness(config,{GITHUB_READ_TOKEN:token,SRE_API_TOKEN:token,SRE_CAPABILITY_SECRET:'c'.repeat(32),SRE_AGENT_MODE:'rules'});
  assert.equal(report.networkCalls,0);
  assert.equal(report.liveValidated,false);
  assert.equal(report.core.configurationReady,true);
  assert.equal(report.checks.find(x=>x.source==='github').configurationReady,false);
  assert.ok(report.checks.find(x=>x.source==='github').missing.includes('github.repository'));
  assert.equal(JSON.stringify(report).includes(token),false);
  assert.ok(report.checks.find(x=>x.source==='servicenow').missing.includes('servicenow.cmdbCi'));
});

test('configured credentials remain distinct from verified live access',()=>{
  const config={mode:'connected',services:[{key:'test',github:{enabled:true,repository:'test/auction',tokenEnv:'READ',webhookSecretEnv:'HOOK'},teams:{tenantId:'tenant',conversations:['conversation'],approvers:['user']}}]};
  const report=assessReadiness(config,{READ:'secret-read',HOOK:'secret-hook',SRE_API_TOKEN:'secret-api',SRE_CAPABILITY_SECRET:'c'.repeat(32)});
  const github=report.checks.find(x=>x.source==='github');
  assert.equal(github.enabled,true);
  assert.equal(github.configurationReady,true);
  assert.equal(github.liveValidated,false);
});

test('Grail readiness requires separate verified recent and open-problem queries',()=>{
  const config={mode:'connected',services:[{key:'test',dynatrace:{enabled:true,mode:'grail',base:'https://tenant.dynatrace.com',entityId:'SERVICE-A',tokenEnv:'TOKEN',webhookSecretEnv:'HOOK'},teams:{}}]};
  const result=assessReadiness(config,{TOKEN:'fixture',HOOK:'fixture'}).checks.find(x=>x.source==='dynatrace');
  assert.ok(result.missing.includes('dynatrace.problemQuery'));
  assert.ok(result.missing.includes('dynatrace.openProblemQuery'));
  assert.equal(result.configurationReady,false);
});

function credentialsFixture(source='github') {
  const connector={enabled:true,tokenEnv:'READ',oauth:{tokenUrl:'https://issuer.test-org.org/oauth/token',clientIdEnv:'ID',clientSecretEnv:'SECRET'},webhookSecretEnv:'HOOK',...(source==='jira'?{base:'https://tickets.test-org.org',auth:'basic',projects:['SA'],emailEnv:'EMAIL'}:{repository:'team/auction'})};
  return {config:{mode:'connected',services:[{key:'test',name:'Auction test',tenant:'test-tenant',environment:'staging',[source]:connector,teams:{}}]},connector,env:{ID:'synthetic-client',SECRET:'synthetic-secret',HOOK:'synthetic-hook',EMAIL:'synthetic@example.org'}};
}

test('readiness selects runtime OAuth fallback when the configured static-token variable is empty',()=>{
  const f=credentialsFixture();const check=assessReadiness(f.config,f.env).checks.find(item=>item.source==='github');
  assert.equal(check.configurationReady,true);assert.equal(check.credentialMode,'oauth');assert.ok(!check.missing.includes('READ'));
});

test('a present static token takes precedence over unconfigured OAuth in readiness',()=>{
  const f=credentialsFixture();f.env.READ='synthetic-static';delete f.env.ID;delete f.env.SECRET;
  const check=assessReadiness(f.config,f.env).checks.find(item=>item.source==='github');assert.equal(check.configurationReady,true);assert.equal(check.credentialMode,'static-token');
});

test('readiness names the missing OAuth credential instead of the unused token variable',()=>{
  const f=credentialsFixture();delete f.env.SECRET;
  const check=assessReadiness(f.config,f.env).checks.find(item=>item.source==='github');assert.equal(check.credentialMode,'oauth');assert.ok(check.missing.includes('SECRET'));assert.ok(!check.missing.includes('READ'));
  assert.ok(!JSON.stringify(check).includes(f.env.ID));
});

test('Jira basic authentication cannot be certified by unrelated OAuth credentials',()=>{
  const f=credentialsFixture('jira');delete f.connector.tokenEnv;
  const check=assessReadiness(f.config,f.env).checks.find(item=>item.source==='jira');assert.equal(check.configurationReady,false);assert.equal(check.credentialMode,'basic');assert.ok(check.missing.includes('jira.tokenEnv'));
});

test('invalid OAuth URL is reported by field name with no network calls or credential disclosure',()=>{
  const f=credentialsFixture();f.connector.oauth.tokenUrl='https://user:private-url-credential@issuer.test-org.org/token';
  const original=global.fetch;let calls=0;global.fetch=()=>{calls++;throw new Error('Unexpected network call');};
  try {
    const report=assessReadiness(f.config,f.env),check=report.checks.find(item=>item.source==='github');
    assert.equal(check.configurationReady,false);assert.ok(check.missing.includes('github.oauth.tokenUrl'));assert.equal(calls,0);
    assert.ok(!JSON.stringify(report).includes('private-url-credential'));assert.ok(!JSON.stringify(report).includes(f.env.SECRET));
  } finally {global.fetch=original;}
});

test('the actual strict readiness CLI accepts configured OAuth fallback without printing credential values',()=>{
  const f=credentialsFixture(),directory=mkdtempSync(join(tmpdir(),'sre-readiness-'));
  const path=join(directory,'config.json');writeFileSync(path,JSON.stringify(f.config));
  const env={SRE_CONFIG:path,...f.env,SRE_API_TOKEN:'private-synthetic-api',SRE_CAPABILITY_SECRET:'c'.repeat(32),READ:''};
  try {
    const result=spawnSync(process.execPath,['scripts/sre-readiness.mjs','--json','--strict'],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout),check=report.checks.find(item=>item.source==='github');assert.equal(check.configurationReady,true);assert.equal(check.credentialMode,'oauth');assert.equal(report.networkCalls,0);assert.equal(report.liveValidated,false);
    assert.ok(!result.stdout.includes(f.env.SECRET));assert.ok(!result.stdout.includes(env.SRE_API_TOKEN));
  } finally {rmSync(directory,{recursive:true,force:true});}
});

for(const variant of ['empty-services','invalid-services','missing-service-name','missing-eve-config'])test(variant+': runtime-invalid profiles cannot pass core readiness',()=>{
  const f=credentialsFixture();
  if(variant==='empty-services')f.config.services=[];
  if(variant==='invalid-services')f.config.services={};
  if(variant==='missing-service-name')delete f.config.services[0].name;
  if(variant==='missing-eve-config')f.config.agentMode='eve';
  const report=assessReadiness(f.config,{...f.env,SRE_API_TOKEN:'private-synthetic-api',SRE_CAPABILITY_SECRET:'c'.repeat(32)});
  assert.equal(report.core.configurationReady,false);assert.equal(report.core.runtimeConfigurationValid,false);assert.ok(report.core.missing.some(item=>item.startsWith('Runtime configuration:')));
});

test('readiness uses the runtime Teams tenant default without mutating the input configuration',()=>{
  const f=credentialsFixture();f.config.services[0].teams={conversations:['19:ops-thread@thread.v2'],approvers:['11111111-2222-3333-4444-555555555555']};
  const env={...f.env,SRE_API_TOKEN:'private-synthetic-api',SRE_CAPABILITY_SECRET:'c'.repeat(32),CLIENT_ID:'synthetic-bot',CLIENT_SECRET:'synthetic-bot-secret',TENANT_ID:'11111111-2222-3333-4444-666666666666',SRE_TEAMS_MODE:'live'};
  const report=assessReadiness(f.config,env),teams=report.checks.find(item=>item.source==='teams');
  assert.equal(report.core.runtimeConfigurationValid,true);assert.equal(teams.configurationReady,true);assert.equal(teams.enabled,true);assert.equal(f.config.services[0].teams.tenantId,undefined);
  assert.ok(!JSON.stringify(report).includes(env.CLIENT_SECRET));
});
