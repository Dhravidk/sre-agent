import { mkdirSync, readFileSync, writeFileSync, existsSync,realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scenarios } from '../src/scenarios.mjs';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const pilotPath = resolve(root, '.local/auction-pilot');
export const manifestPath = resolve(root, '.local/pilot-manifest.json');
function git(...args) { return execFileSync('git', ['-C', pilotPath, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim(); }
function commit(message) { git('-c','user.name=Auction Lab','-c','user.email=auction-lab@example.invalid','commit','-m',message); }

export function isMainModule(url) {
  try{return Boolean(process.argv[1])&&realpathSync(resolve(process.argv[1]))===realpathSync(fileURLToPath(url));}
  catch{return false;}
}

export function pilotFiles(scenarioId) {
  const files={
    'src/auction/rules.mjs':readFileSync(resolve(root,'src/auction/rules.mjs')),
    'src/auction/service.mjs':readFileSync(resolve(root,'src/auction/service.mjs')),
    'server.mjs':readFileSync(resolve(root,'fixtures/pilot/server.mjs')),
    'package.json':Buffer.from(JSON.stringify({name:'synthetic-smart-auction-pilot',private:true,type:'module',engines:{node:'>=24'},scripts:{start:'node server.mjs'}},null,2)),
    'README.md':Buffer.from('# Synthetic smart-auction pilot\n\nGenerated test repository. Fictional vehicles and dealers; no Ally data or integration.\n\nRun `node server.mjs` to serve the auction API at http://127.0.0.1:3100.\n\nBranches under scenarios/ contain deliberately faulty changes. main is the healthy baseline.\n'),
  };
  if(scenarioId===undefined)return files;
  const scenario=scenarios.find(item=>item.id===scenarioId);if(!scenario)throw new Error('Unknown pilot scenario');
  let source=files['src/auction/rules.mjs'].toString('utf8');
  if(scenario.replacement)source=source.replace(...scenario.replacement);
  if(scenario.id!=='healthy-release')source=source.replace("release: 'baseline'","release: '"+scenario.id+"'");
  if(scenario.irreversible) {
    source=source.replace('rollbackCompatible: true','rollbackCompatible: false');
    files['migrations/002-reserve.sql']=Buffer.from('-- Deliberately incompatible migration fixture; never run against real data.\nALTER TABLE lots DROP COLUMN reserve_cents;\nALTER TABLE lots ADD COLUMN reserve_amount_cents BIGINT NOT NULL DEFAULT 0;\n');
  }
  files['src/auction/rules.mjs']=Buffer.from(source);return files;
}
function writeFiles(files) {for(const [name,bytes] of Object.entries(files)){const path=resolve(pilotPath,name);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,bytes);}}

export function seedPilot() {
  if (existsSync(manifestPath)) return JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (existsSync(resolve(pilotPath, '.git'))) throw new Error('Pilot exists without a manifest. Preserve it and choose a clean lab directory.');
  mkdirSync(pilotPath, { recursive: true });
  // A standalone, dependency-free auction server. The parent lab consumes its commits.
  writeFiles(pilotFiles());
  git('init','-b','main'); git('add','.'); commit('Healthy auction baseline');
  const baseline = git('rev-parse','HEAD');
  const manifest = { repository:pilotPath, baseline, releases:{} };
  for (const scenario of scenarios) {
    git('checkout','-b','scenarios/'+scenario.id,baseline);
    const files=pilotFiles(scenario.id);writeFiles(files);
    git('add','.'); commit(scenario.ticket+' '+scenario.title);
    const sha = git('rev-parse','HEAD');
    manifest.releases[scenario.id] = { sha, branch:'scenarios/'+scenario.id, artifact:'fixture-sha256:'+createHash('sha256').update(files['src/auction/rules.mjs']).digest('hex'), ticket:scenario.ticket, rollbackCompatible:!scenario.irreversible };
  }
  git('checkout','main');
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}

export function pilotDiff(sha) {
  const manifest = seedPilot();
  if (!Object.values(manifest.releases).some(x=>x.sha===sha)) throw new Error('Unknown fixture revision');
  return git('diff',manifest.baseline,sha,'--','src/auction/rules.mjs','migrations');
}

export async function loadRelease(sha) {
  const source=pilotPolicySource(sha);
  // Only locally generated, allowlisted fixture revisions can be executed.
  return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}

export function pilotPolicySource(sha) {
  const manifest = seedPilot();
  if (sha !== manifest.baseline && !Object.values(manifest.releases).some(x=>x.sha===sha)) throw new Error('Unknown fixture revision');
  return git('show',sha+':src/auction/rules.mjs');
}
if (isMainModule(import.meta.url)) console.log(JSON.stringify(seedPilot(),null,2));
