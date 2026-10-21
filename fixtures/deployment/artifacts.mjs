import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedPilot,loadRelease } from '../../scripts/seed-pilot.mjs';

export const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
export const artifactFiles=['runtime.mjs','src/auction/rules.mjs','src/auction/service.mjs'];
const artifactDigest=manifest=>digest(JSON.stringify({format:manifest.format,sha:manifest.sha,policy:manifest.policy,files:manifest.files}));

// Only the generated, allowlisted auction revisions can enter this fixture.
// This executes no external repository/PR code and produces no container image.
export async function buildArtifact(directory,sha) {
  const pilot=seedPilot();
  if(sha!==pilot.baseline&&!Object.values(pilot.releases).some(item=>item.sha===sha))throw new Error('Unknown local auction fixture revision');
  const source={
    'runtime.mjs':readFileSync(fileURLToPath(new URL('./auction-runtime.mjs',import.meta.url))),
    'src/auction/rules.mjs':execFileSync('git',['-C',pilot.repository,'show',sha+':src/auction/rules.mjs']),
    'src/auction/service.mjs':execFileSync('git',['-C',pilot.repository,'show',sha+':src/auction/service.mjs']),
  };
  const {policy}=await loadRelease(sha);
  const manifest={format:'local-auction-source-bundle-v1',sha,policy,files:Object.fromEntries(artifactFiles.map(name=>[name,digest(source[name])]))};
  const artifact=artifactDigest(manifest),path=join(directory,artifact.slice(7));
  if(!existsSync(path)) {
    for(const name of artifactFiles){const target=join(path,name);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,source[name],{mode:0o444});}
    writeFileSync(join(path,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o444});
  }
  const result={sha,artifact,path,policy};verifyArtifact(result);return result;
}

export function verifyArtifact(expected) {
  const manifest=JSON.parse(readFileSync(join(expected.path,'manifest.json'),'utf8'));
  if(manifest.format!=='local-auction-source-bundle-v1'||manifest.sha!==expected.sha||JSON.stringify(Object.keys(manifest.files))!==JSON.stringify(artifactFiles)||artifactDigest(manifest)!==expected.artifact)throw new Error('Local artifact manifest/provenance does not match its retained digest');
  for(const name of artifactFiles) {
    const path=join(expected.path,name);
    if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||digest(readFileSync(path))!==manifest.files[name])throw new Error('Local artifact bytes changed: '+name);
  }
  return manifest;
}
