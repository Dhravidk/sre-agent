import { createReadStream,openSync,closeSync,readSync,fstatSync,constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { loadAdministrationConfig } from '../src/sre/config.mjs';
import { postgresDatabase,sqliteDatabase } from '../src/sre/database.mjs';
import { SreStore } from '../src/sre/store.mjs';
import { prepareRestore,releaseRestore } from '../src/sre/restore-recovery.mjs';
import { restoreProviderRetries } from '../src/sre/restore-provider-retries.mjs';
import { configuredRetryScopes } from '../src/sre/provider-retry.mjs';

function readAttestation(path) {
  let fd;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK);
    if(!fstatSync(fd).isFile())throw new Error();
    const bytes=Buffer.alloc(256*1024+1);let size=0,count;
    while(size<bytes.length&&(count=readSync(fd,bytes,size,bytes.length-size,null)))size+=count;
    if(size>256*1024)throw new Error();
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));
  } catch {throw new Error('Attestation must be a readable regular UTF-8 JSON file within 256 KiB');}
  finally {if(fd!==undefined)closeSync(fd);}
}

const [action,...args]=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++) {
  const key=args[i];
  if(key==='--offline-restored-database'){options.offline=true;continue;}
  if(!['--archive','--restore-id','--backup-at','--reason','--attestation'].includes(key)||!args[i+1]||args[i+1].startsWith('--')||options[key]!==undefined)throw new Error('Invalid restore administration option');
  options[key]=args[++i];
}
if(!['status','prepare','release','retry-facts','retry-scopes'].includes(action))throw new Error('Use sre:restore status | prepare --offline-restored-database --archive <file> --restore-id <id> --backup-at <ISO-time> --reason <reason> | release --attestation <file> | retry-scopes | retry-facts --attestation <file>');
if(['retry-scopes','retry-facts'].includes(action)&&!process.env.SRE_CONFIG)throw new Error('Explicitly select SRE_CONFIG for provider retry recovery');
if(action!=='retry-scopes'&&!process.env.DATABASE_URL&&!process.env.SRE_SQLITE_PATH)throw new Error('Explicitly configure the restored DATABASE_URL or SRE_SQLITE_PATH; no default database is selected');
if(action==='prepare'&&(!options.offline||!options['--archive']||!options['--restore-id']||!options['--backup-at']||!options['--reason']))throw new Error('Preparation requires offline restored-database selection, archive, restore ID, backup time and reason');
if(['release','retry-facts'].includes(action)&&!options['--attestation'])throw new Error('Provide the reviewed local-operator reconciliation attestation JSON');
const input=options['--attestation']?readAttestation(options['--attestation']):undefined,config=loadAdministrationConfig();
if(action==='retry-scopes')console.log(JSON.stringify({networkCalls:0,providerVerified:false,scopes:configuredRetryScopes(undefined,config.services,{includeDisabled:true})},null,2));
else {
 const db=config.databaseUrl?await postgresDatabase(config.databaseUrl):sqliteDatabase(config.sqlitePath);
 try {
  const store=await new SreStore(db,{services:config.services}).initialize(),actor={kind:'local-operator',id:userInfo().username};
  let result;
  if(action==='status')result=await store.restoreFence();
  if(action==='prepare') {
    const digest=createHash('sha256');for await(const chunk of createReadStream(options['--archive']))digest.update(chunk);
    result=await prepareRestore(store,{restoreId:options['--restore-id'],backupSha256:digest.digest('hex'),backupAt:Date.parse(options['--backup-at']),reason:options['--reason'],actor,offline:true});
  }
  if(action==='release') {
    result=await releaseRestore(store,{...input,actor});
  }
  if(action==='retry-facts')result=await restoreProviderRetries(store,config.services,{...input,actor});
  console.log(JSON.stringify(result,null,2));
 } finally {await db.close();}
}
