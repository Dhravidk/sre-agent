import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pilotFiles,isMainModule} from './seed-pilot.mjs';

// GitLab validates that at least one visible job exists even when the workflow
// is disabled. Both gates prevent hosted execution for this code-only drill.
export const sandboxCi='# Fictional code-only drill: hosted pipelines and jobs stay disabled.\nworkflow:\n  rules:\n    - when: never\nsandbox_checks_disabled:\n  script:\n    - echo "Run npm test locally for this fictional drill"\n  rules:\n    - when: never\n';

// Local preparation only. Publishing requires an explicitly selected remote and
// a separate, temporary writer; the agent's persistent reader remains read-only.
export function seedGitlabSandbox(directory=resolve('.local/gitlab-history-sandbox')) {
  const repo=resolve(directory),manifestPath=resolve(repo,'../gitlab-history-manifest.json');
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if(existsSync(manifestPath)) {
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    if(manifest.repository!==repo)throw Error('Existing sandbox manifest belongs to another path');
    for(const [ref,sha] of Object.entries(manifest.refs))if(git('rev-parse',ref)!==sha)throw Error('Sandbox ref changed; preserve the existing drill');
    if(git('status','--porcelain'))throw Error('Sandbox has local changes; preserve them');
    for(const [path,digest] of Object.entries(manifest.mainFiles))if(createHash('sha256').update(readFileSync(resolve(repo,path))).digest('hex')!==digest)throw Error('Sandbox source differs from the retained manifest');
    return manifest;
  }
  if(existsSync(repo))throw Error('Choose a new sandbox directory; existing files are preserved');
  mkdirSync(repo,{recursive:true,mode:0o700});
  git('init','-b','main');git('config','core.hooksPath','/dev/null');
  const put=(path,content)=>{const dest=resolve(repo,path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,content);};
  const commit=message=>{git('add','--all');git('-c','user.name=SRE Sandbox','-c','user.email=sre-sandbox@example.invalid','commit','-m',message);return git('rev-parse','HEAD');};
  for(const [path,bytes] of Object.entries(pilotFiles()))put(path,bytes);
  put('.gitignore','node_modules/\n.env*\n*.sqlite*\n');
  put('.gitlab-ci.yml',sandboxCi);
  put('package.json',JSON.stringify({name:'sre-auction-gitlab-sandbox',private:true,type:'module',engines:{node:'>=24'},scripts:{start:'node server.mjs',test:'node --test tests/*.test.mjs',probe:'node scripts/probe.mjs'}},null,2)+'\n');
  put('README.md','# Auction incident sandbox\n\nFictional dealer auction API for the SRE integration drill. No Ally code, customer data, model calls or deployment automation. All commits were created for this exercise; ticket identifiers are fictional.\n\nRun `npm test` for business-invariant checks, `npm start` for the loopback API, or `npm run probe -- race` to capture a structured observation. The healthy main branch includes a historical concurrency regression and its fix. Branches named `codex/drill-*` deliberately retain defects; do not deploy them.\n\nThe agent must use the exact runtime SHA and comparison, separate competing failure classes, retain the human reports from both teams, and withhold conclusions when source or telemetry coverage is incomplete. A successful health probe does not verify winning-bid correctness.\n');
  put('tests/auction.test.mjs',`import test from 'node:test';
import assert from 'node:assert/strict';
import {Auction} from '../src/auction/service.mjs';
test('concurrent dealers cannot replace an accepted higher bid',async()=>{
 const a=new Auction();const lot=a.lots[0];const first=lot.currentBidCents;
 await Promise.all([a.bid(lot.id,first+30000,'Dealer A','higher',1),a.bid(lot.id,first+20000,'Dealer B','lower',40)]);
 assert.equal(lot.currentBidCents,first+30000);assert.deepEqual(a.telemetry().violations,[]);
});
test('normal credit latency accepts a valid bid',async()=>{const a=new Auction();const lot=a.lots[0];assert.equal((await a.bid(lot.id,lot.currentBidCents+10000)).status,201);});
test('expired auction rejects a bid',async()=>{const a=new Auction();const lot=a.lots[0];lot.endsAt=Date.now()-1000;assert.equal((await a.bid(lot.id,lot.currentBidCents+10000)).code,'AUCTION_CLOSED');});
test('catalog latency stays within the local drill budget',async()=>{const a=new Auction();const start=performance.now();await a.catalog();assert.ok(performance.now()-start<250);});
`);
  put('scripts/probe.mjs',`import {Auction} from '../src/auction/service.mjs';
import {policy} from '../src/auction/rules.mjs';
import {execFileSync} from 'node:child_process';
const scenario=process.argv[2]||'race';const a=new Auction();const lot=a.lots[0];const amount=lot.currentBidCents;
if(scenario==='race')await Promise.all([a.bid(lot.id,amount+30000,'Fictional dealer A','high',1),a.bid(lot.id,amount+20000,'Fictional dealer B','low',40)]);
else if(scenario==='catalog')for(let i=0;i<3;i++)await a.catalog();
else {if(scenario==='dependency')a.creditDown=true;if(scenario==='late')lot.endsAt=Date.now()-1000;await a.bid(lot.id,amount+10000);}
const telemetry=a.telemetry();const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const codes=[...telemetry.codes,...telemetry.violations];
console.log(JSON.stringify({synthetic:true,scenario,sha,release:policy.release,metrics:telemetry,records:codes.map(code=>({timestamp:new Date().toISOString(),loglevel:'ERROR','service.name':'auction-gitlab-sandbox','deployment.environment':'sandbox-eu','cloud.region':'eu','error.code':code,'service.version':sha,content:'Fictional sandbox observation: '+code}))},null,2));
`);
  const history=[{sha:commit('SA-200 Add fictional auction API and business-invariant tests'),purpose:'healthy foundation'}];
  put('src/observability.mjs',`export function requestSummary({operation,status,code,sha,at=Date.now()}) {
 return {timestamp:new Date(at).toISOString(),loglevel:status>=500?'ERROR':'INFO','service.name':'auction-gitlab-sandbox','deployment.environment':'sandbox-eu',operation,status,'error.code':code||'','service.version':sha,content:'Fictional auction request completed'};
}
`);
  put('docs/runbook.md','# Fictional auction runbook\n\nBidding owns accepted-bid invariants and auction close times. Platform owns credit dependency health and release identity. Use the same incident, exact SHA, region and time window. Select a single recovery owner. Never infer transaction correctness from `/health` alone. All logs in this exercise are generated locally; Dynatrace is not connected.\n');
  history.push({sha:commit('SA-201 Add scoped structured telemetry and Bidding/Platform runbook'),purpose:'benign observability change'});
  const path='src/auction/rules.mjs';const original=readFileSync(resolve(repo,path),'utf8');
  put(path,original.replace("release: 'baseline'","release: 'auction-1.1.0'").replace('checkVersion: true','checkVersion: false'));
  history.push({sha:commit('SA-202 Reduce bid retries during concurrent auction traffic'),purpose:'historical deliberate concurrency defect'});
  put(path,original.replace("release: 'baseline'","release: 'auction-1.1.1'"));
  history.push({sha:commit('SA-203 Restore optimistic version check after winner regression'),purpose:'fix the historical concurrency defect'});
  put(path,original.replace("release: 'baseline'","release: 'auction-1.2.0'"));
  const baseline=commit('SA-204 Release healthy auction policy after concurrency fix');history.push({sha:baseline,purpose:'current healthy main; old defect is fixed'});
  const healthy=readFileSync(resolve(repo,path),'utf8');
  const cases=[
    {id:'bid-race',ticket:'SA-301',title:'Reduce bid contention retries for busy auctions',replace:['checkVersion: true','checkVersion: false'],probe:'race',expected:'WINNING_BID_REGRESSED'},
    {id:'credit-timeout',ticket:'SA-302',title:'Tighten credit lookup timeout to meet request budget',replace:['creditTimeoutMs: 100','creditTimeoutMs: 1'],probe:'bid',expected:'CREDIT_TIMEOUT'},
    {id:'catalog-latency',ticket:'SA-303',title:'Wait for catalog enrichment before responding',replace:['catalogDelayMs: 5','catalogDelayMs: 350'],probe:'catalog',expected:'CATALOG_LATENCY'},
    {id:'late-bid',ticket:'SA-304',title:'Allow in-flight bids to finish after auction close',replace:['enforceCloseTime: true','enforceCloseTime: false'],probe:'late',expected:'BID_ACCEPTED_AFTER_CLOSE'},
    {id:'schema-v2',ticket:'SA-305',title:'Switch reserve representation to schema v2',replace:['schemaVersion: 1','schemaVersion: 2'],probe:'bid',expected:'SCHEMA_MISMATCH',irreversible:true},
    {id:'healthy-release',ticket:'SA-306',title:'Bump the release label without behavior changes',probe:'race',expected:null},
    {id:'unknown-service-change',ticket:'SA-307',title:'Normalize bid amount units at the service boundary',probe:'bid',expected:null,unsupported:true},
  ];
  const refs={'refs/heads/main':baseline};const scenarios={};
  for(const item of cases) {
    const branch='codex/drill-'+item.id;git('checkout','-b',branch,baseline);
    let source=healthy.replace("release: 'auction-1.2.0'","release: 'drill-"+item.id+"'");if(item.replace)source=source.replace(...item.replace);
    if(item.irreversible){source=source.replace('rollbackCompatible: true','rollbackCompatible: false');put('migrations/002-reserve.sql','-- Deliberately incompatible fictional migration. Never execute.\nALTER TABLE lots DROP COLUMN reserve_cents;\nALTER TABLE lots ADD COLUMN reserve_amount_cents BIGINT NOT NULL DEFAULT 0;\n');}
    put(path,source);
    if(item.unsupported)put('src/auction/service.mjs',readFileSync(resolve(repo,'src/auction/service.mjs'),'utf8').replace('lot.currentBidCents = amountCents;','lot.currentBidCents = amountCents * 100;'));
    const sha=commit(item.ticket+' '+item.title);refs['refs/heads/'+branch]=sha;scenarios[item.id]={...item,branch,sha};
  }
  git('checkout','main');
  const mainFiles=Object.fromEntries(git('ls-files').split('\n').map(path=>[path,createHash('sha256').update(readFileSync(resolve(repo,path))).digest('hex')]));
  const manifest={repository:repo,createdAt:new Date().toISOString(),synthetic:true,remote:null,baseline,history,refs,scenarios,mainFiles,hostedDeployments:false};
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(isMainModule(import.meta.url))console.log(JSON.stringify(seedGitlabSandbox(process.argv[2]),null,2));
