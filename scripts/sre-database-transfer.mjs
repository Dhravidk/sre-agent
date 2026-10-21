import {openSync,readSync,writeSync,closeSync,fstatSync,constants,existsSync} from 'node:fs';
import {userInfo} from 'node:os';
import {loadAdministrationConfig} from '../src/sre/config.mjs';
import {postgresDatabase,sqliteDatabase} from '../src/sre/database.mjs';
import {SreStore} from '../src/sre/store.mjs';
import {exportDatabase,importDatabase,transferLimits,assertApplicationDatabase} from '../src/sre/database-transfer.mjs';
import {redact} from '../src/sre/security.mjs';

async function main(){
const [action,...args]=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++){
  const key=args[i];
  if(key==='--offline'){if(options.offline)throw Error('Duplicate offline option');options.offline=true;continue;}
  if(!['--file','--sha256','--restore-id','--reason'].includes(key)||options[key]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('Invalid database transfer option');
  options[key]=args[++i];
}
if(!['export','import'].includes(action)||!options.offline||!options['--file'])throw Error('Use export --offline --file <new-private-file> | import --offline --file <reviewed-file> --sha256 <digest> --restore-id <id> --reason <reason>');
if(!process.env.SRE_CONFIG||Boolean(process.env.DATABASE_URL)===Boolean(process.env.SRE_SQLITE_PATH))throw Error('Explicitly select SRE_CONFIG and exactly one DATABASE_URL or SRE_SQLITE_PATH');
if(action==='import'&&(!options['--sha256']||!options['--restore-id']||!options['--reason']))throw Error('Import requires the reviewed digest, restore ID and cutover reason');
if(action==='export'&&['--sha256','--restore-id','--reason'].some(k=>options[k]))throw Error('Export accepts only --offline and --file');
const config=loadAdministrationConfig(),actor={kind:'local-operator',id:userInfo().username};
if(action==='export'&&!config.databaseUrl&&!existsSync(config.sqlitePath))throw Error('The explicit source SQLite database does not exist');
let snapshot;
if(action==='import'){
  let fd;
  try{
    fd=openSync(options['--file'],constants.O_RDONLY|constants.O_NONBLOCK|(constants.O_NOFOLLOW||0));
    if(!fstatSync(fd).isFile())throw Error('Snapshot must be a regular file');
    const buffer=Buffer.alloc(transferLimits.bytes+1);let count=0,n;
    while(count<buffer.length&&(n=readSync(fd,buffer,count,buffer.length-count,null)))count+=n;
    if(count>transferLimits.bytes)throw Error('Snapshot exceeds 64 MiB');
    snapshot=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count)));
  }catch{throw Error('Snapshot must be a readable regular UTF-8 JSON file within 64 MiB');}
  finally{if(fd!==undefined)closeSync(fd);}
}
const db=config.databaseUrl?await postgresDatabase(config.databaseUrl):sqliteDatabase(config.sqlitePath);
try{
  // Refuse an unrelated database before schema initialization can add tables.
  await assertApplicationDatabase(db);
  const store=await new SreStore(db,{services:config.services,investigationConcurrency:config.investigationConcurrency}).initialize();
  if(action==='export'){
    const result=await exportDatabase(store,{offline:true,actor});
    const fd=openSync(options['--file'],constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    try{const bytes=Buffer.from(JSON.stringify(result.snapshot));let written=0;while(written<bytes.length)written+=writeSync(fd,bytes,written,bytes.length-written);}finally{closeSync(fd);}
    console.log(JSON.stringify({file:options['--file'],sha256:result.sha256,rows:result.rows,tables:result.tables,sourceDialect:db.dialect,privateSnapshot:true,providerCalls:0,modelCalls:0}));
  }else console.log(JSON.stringify(await importDatabase(store,{snapshot,expectedSha256:options['--sha256'],restoreId:options['--restore-id'],reason:options['--reason'],offline:true,actor})));
}finally{await db.close();}
}
main().catch(error=>{console.error(redact(error.message));process.exitCode=1;});
