import { execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { pilotFiles,seedPilot,isMainModule } from './seed-pilot.mjs';
import { scenarios } from '../src/scenarios.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function git(repository,...args) {
  try{return execFileSync('git',['-C',repository,'-c','core.hooksPath=/dev/null',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:2*1024*1024});}
  catch{throw new Error('Pilot Git operation failed; no publication occurred');}
}
function verifyCommit(repository,revision,files,{parent,message}) {
  if(!sha(revision))throw new Error('Invalid pilot revision');
  const commit=git(repository,'cat-file','commit',revision),split=commit.indexOf('\n\n');
  const headers=commit.slice(0,split).split('\n');
  const identity=(header,kind)=>header?.startsWith(kind+' ')&&/^Auction Lab <auction-lab@example\.invalid> \d+ [+-]\d{4}$/.test(header.slice(kind.length+1));
  if(split<0||commit.slice(split+2)!==message+'\n'||headers.length!==(parent?4:3)||!/^tree [a-f0-9]+$/.test(headers[0])||!identity(headers.at(-2),'author')||!identity(headers.at(-1),'committer')||(parent&&headers[1]!=='parent '+parent))throw new Error('Pilot commit history or metadata differs from the generated fixture');
  const rows=git(repository,'ls-tree','-r','-z',revision).split('\0').filter(Boolean).map(row=>row.match(/^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/));
  if(rows.some(row=>!row)||JSON.stringify(rows.map(row=>row[4]).sort())!==JSON.stringify(Object.keys(files).sort()))throw new Error('Pilot tree contains unexpected files');
  for(const row of rows) {
    if(row[1]!=='100644'||row[2]!=='blob')throw new Error('Pilot tree contains unsupported file modes');
    // Compare bytes, not a working tree that may have changed after review.
    let actual;try{actual=execFileSync('git',['-C',repository,'cat-file','blob',row[3]],{stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:2*1024*1024});}
    catch{throw new Error('Pilot blob could not be read within its source budget');}
    if(!actual.equals(files[row[4]]))throw new Error('Pilot bytes differ from the trusted generator');
  }
}

export function packageSandbox({output,manifest=seedPilot()}={}) {
  if(!manifest||typeof manifest.repository!=='string'||!sha(manifest.baseline)||!manifest.releases||JSON.stringify(Object.keys(manifest.releases).sort())!==JSON.stringify(scenarios.map(item=>item.id).sort()))throw new Error('Invalid pilot manifest');
  const refs={'refs/heads/main':manifest.baseline};
  verifyCommit(manifest.repository,manifest.baseline,pilotFiles(),{message:'Healthy auction baseline'});
  for(const scenario of scenarios) {
    const release=manifest.releases[scenario.id];if(release.branch!=='scenarios/'+scenario.id||!sha(release.sha))throw new Error('Invalid scenario branch mapping');
    verifyCommit(manifest.repository,release.sha,pilotFiles(scenario.id),{parent:manifest.baseline,message:scenario.ticket+' '+scenario.title});refs['refs/heads/'+release.branch]=release.sha;
  }
  for(const [ref,revision] of Object.entries(refs))if(git(manifest.repository,'rev-parse','--verify',ref).trim()!==revision)throw new Error('Pilot branch moved from its recorded fixture revision');
  const directory=resolve(output||join('.local/github-sandbox-packages',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8)));
  if(existsSync(directory))throw new Error('Sandbox package output already exists');
  mkdirSync(dirname(directory),{recursive:true});mkdirSync(directory,{mode:0o700});
  try {
    const internal=mkdtempSync(join(directory,'.git-validation-')),bare=join(internal,'export.git'),clone=join(internal,'roundtrip.git'),bundle=join(directory,'pilot.bundle');
    const format=git(manifest.repository,'rev-parse','--show-object-format').trim();if(!['sha1','sha256'].includes(format))throw new Error('Unsupported pilot object format');
    git(directory,'init','--bare','-b','main','--object-format='+format,bare);
    // Select immutable reviewed OIDs, never mutable --all refs or local files.
    git(bare,'fetch','--atomic','--no-tags',resolve(manifest.repository),...Object.entries(refs).map(([ref,revision])=>revision+':'+ref));
    git(bare,'bundle','create',bundle,'HEAD',...Object.keys(refs));git(bare,'bundle','verify',bundle);
    git(directory,'clone','--bare','--no-local',bundle,clone);
    const observed=Object.fromEntries(git(clone,'for-each-ref','--format=%(refname) %(objectname)').trim().split('\n').map(line=>line.split(' ')));
    if(JSON.stringify(Object.entries(observed).sort())!==JSON.stringify(Object.entries(refs).sort()))throw new Error('Bundle roundtrip changed its refs');
    const reachable=new Set(git(clone,'rev-list','--objects','--no-object-names','--all').trim().split('\n'));
    const objects=git(clone,'cat-file','--batch-all-objects','--batch-check=%(objectname)').trim().split('\n');
    if(objects.length!==reachable.size||objects.some(id=>!reachable.has(id)))throw new Error('Bundle contains objects outside the approved commit graph');
    verifyCommit(clone,manifest.baseline,pilotFiles(),{message:'Healthy auction baseline'});
    for(const scenario of scenarios)verifyCommit(clone,manifest.releases[scenario.id].sha,pilotFiles(scenario.id),{parent:manifest.baseline,message:scenario.ticket+' '+scenario.title});
    const bytes=statSync(bundle).size;if(bytes>5*1024*1024)throw new Error('Pilot bundle exceeds its synthetic-source budget');
    rmSync(internal,{recursive:true,force:true});
    const report={format:'sre-auction-github-sandbox-v1',createdAt:new Date().toISOString(),requiredVisibility:'private',baseline:manifest.baseline,refs,bundle:{file:'pilot.bundle',bytes,sha256:digest(readFileSync(bundle))},verifiedCommitCount:8,verifiedRefs:8,verifiedObjectCount:objects.length,roundtripVerified:true,networkCalls:0,repositoryPublished:false,limits:['Generated synthetic Git history only; no live GitHub API, webhook, CI, deployment, model or vendor validation.','Scenario branches deliberately contain faulty code. Use only a dedicated private test repository.','The pilot server uses in-memory auction state. Durable local deployment/recovery is tested separately by the parent SRE harness.','The bundle installs no rollback workflow and supplies no credentials or hosted service.']};
    writeFileSync(join(directory,'README.md'),'# Private GitHub auction sandbox package\n\nThis bundle contains only the reviewed generated pilot: healthy main and seven deliberate scenario branches. It excludes the parent SRE workspace, configuration, credentials, extra branches/tags and unrelated history.\n\nCreate a dedicated private empty repository in the intended GitHub account. Authenticate Git locally, then replace OWNER/REPOSITORY below with that verified sandbox. Review manifest.json and keep deliberate faults away from production.\n\n```sh\ngit clone --bare pilot.bundle auction-sandbox.git\ncd auction-sandbox.git\ngit push --atomic --no-follow-tags https://github.com/OWNER/REPOSITORY.git '+Object.keys(refs).join(' ')+'\n```\n\nThe bare clone retains all eight local branch refs for this explicit push. The literal URL selects the verified destination; no-follow-tags overrides automatic annotated-tag publication. No push command is run by the packager. Preserve the recorded SHAs. Configure the SRE reader/webhook against the actual repository, then open one scenario PR at a time. Install a separately reviewed protected deployment workflow before enabling rollback. Publishing a branch is not a deployed service or proof of recovery.\n');
    writeFileSync(join(directory,'manifest.json'),JSON.stringify(report,null,2)+'\n');return {...report,directory,manifest:join(directory,'manifest.json')};
  } catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
}
if(isMainModule(import.meta.url)) {
  const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--output'&&args[1]))throw new Error('Use sre:sandbox:package [--output NEW_DIRECTORY]');
  console.log(JSON.stringify(packageSandbox({output:args[1]}),null,2));
}
