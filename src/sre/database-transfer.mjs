import {schema} from './database.mjs';
import {hash,assertText} from './security.mjs';
import {prepareRestore} from './restore-recovery.mjs';

const tableNames=schema.map(sql=>/^CREATE TABLE IF NOT EXISTS (sre_[a-z0-9_]+) /.exec(sql)?.[1]).filter(Boolean);
const limits=Object.freeze({rows:200000,bytes:64*1024*1024});
const mapping=services=>services.map(s=>({key:s.key,tenant:s.tenant,environment:s.environment,teams:s.teams,github:s.github,gitlab:s.gitlab,servicenow:s.servicenow,dynatrace:s.dynatrace,dynatraceLogs:s.dynatraceLogs,jira:s.jira,releases:s.releases,logs:s.logs,verification:s.verification,rollback:s.rollback}));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const mappingHash=services=>hash(canonical(mapping(services)));
const actorId=actor=>{if(actor?.kind!=='local-operator')throw Error('Database transfer requires a local operator');return assertText(actor.id,'operator identity',512);};
const identifier=value=>{if(typeof value!=='string'||!/^[a-z_][a-z0-9_]*$/.test(value))throw Error('Invalid schema identifier');return '"'+value+'"';};
async function columns(db,q,name){
  const rows=db.dialect==='postgres'?await q("SELECT column_name AS name,data_type AS type FROM information_schema.columns WHERE table_schema='public' AND table_name=? ORDER BY ordinal_position",[name]):await q('PRAGMA table_info('+identifier(name)+')');
  if(!rows.length)throw Error('Missing transfer table '+name);
  return rows.map(r=>({name:r.name,integer:/int/i.test(r.type)}));
}
function cell(value,column){
  if(value===null)return null;
  if(column.integer){
    const numeric=typeof value==='number'||typeof value==='bigint'||typeof value==='string'&&/^-?\d+$/.test(value),n=numeric?Number(value):NaN;
    if(!Number.isSafeInteger(n))throw Error('Unsafe integer in transfer column '+column.name);return n;
  }
  if(typeof value!=='string')throw Error('Expected text in transfer column '+column.name);
  return value;
}
export {tableNames as transferTables,limits as transferLimits};
export async function assertApplicationDatabase(db,q=db.query){
  const rows=db.dialect==='postgres'?await q("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"):await q("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  if(rows.some(r=>!tableNames.includes(r.name)))throw Error('Database transfer requires a dedicated application database; unrelated tables are preserved');
}

// This is a bounded offline cutover, not a streaming migration or a generic SQL
// importer. Application table/column names come only from this schema version.
export async function exportDatabase(store,{offline,actor}){
  if(offline!==true)throw Error('Stop old writers and explicitly select offline database transfer');
  const operator=actorId(actor);
  return store.db.transaction(async q=>{
    if(store.db.dialect==='postgres')await q('LOCK TABLE '+tableNames.map(identifier).join(',')+' IN SHARE MODE NOWAIT');
    await assertApplicationDatabase(store.db,q);
    const fence=await store.restoreFence(q);if(fence?.active)throw Error('Reconcile the active restore before database cutover');
    const createdAt=await store.coordinationNow(q),tables={};let count=0;
    for(const name of tableNames){
      const meta=await columns(store.db,q,name),rows=await q('SELECT * FROM '+identifier(name)+' LIMIT '+String(limits.rows-count+1));
      count+=rows.length;if(count>limits.rows)throw Error('Offline transfer exceeds the 200000-row budget; use a planned bulk migration');
      const values=rows.map(row=>meta.map(c=>cell(row[c.name],c))).sort((a,b)=>{const left=JSON.stringify(a),right=JSON.stringify(b);return left<right?-1:left>right?1:0;});
      tables[name]={columns:meta.map(c=>c.name),rows:values};
    }
    const snapshot={version:1,schemaHash:hash(schema),mappingHash:mappingHash(store.services),sourceDialect:store.db.dialect,createdAt,operator,rows:count,tables};
    if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')>limits.bytes)throw Error('Offline transfer exceeds the 64 MiB budget; use a planned bulk migration');
    return {snapshot,sha256:hash(snapshot),rows:count,tables:tableNames.length};
  });
}

function validateSnapshot(snapshot,expectedSha256,services){
  if(!snapshot||snapshot.version!==1||snapshot.schemaHash!==hash(schema)||snapshot.mappingHash!==mappingHash(services)||!['sqlite','postgres'].includes(snapshot.sourceDialect)||!Number.isSafeInteger(snapshot.createdAt)||snapshot.createdAt<0)throw Error('Snapshot schema, mapping or version is incompatible');
  if(!/^[a-f0-9]{64}$/.test(expectedSha256||'')||hash(snapshot)!==expectedSha256)throw Error('Snapshot digest does not match the reviewed export');
  if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')>limits.bytes)throw Error('Snapshot exceeds the transfer size budget');
  if(!snapshot.tables||Object.keys(snapshot.tables).sort().join('|')!==[...tableNames].sort().join('|'))throw Error('Snapshot must contain exactly the application tables');
  let count=0;
  for(const name of tableNames){const table=snapshot.tables[name];if(!Array.isArray(table?.columns)||!Array.isArray(table.rows))throw Error('Invalid transfer table '+name);for(const c of table.columns)identifier(c);if(new Set(table.columns).size!==table.columns.length)throw Error('Duplicate transfer column');for(const row of table.rows)if(!Array.isArray(row)||row.length!==table.columns.length)throw Error('Invalid transfer row');count+=table.rows.length;if(count>limits.rows)throw Error('Snapshot exceeds the transfer row budget');}
  if(count!==snapshot.rows)throw Error('Snapshot row count does not match its contents');
}

export async function importDatabase(store,{snapshot,expectedSha256,restoreId,reason,offline,actor}){
  if(offline!==true)throw Error('Select an empty offline destination; old writers must be stopped');
  const operator=actorId(actor);validateSnapshot(snapshot,expectedSha256,store.services);
  return store.db.transaction(async q=>{
    if(store.db.dialect==='postgres')await q('LOCK TABLE '+tableNames.map(identifier).join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT');
    await assertApplicationDatabase(store.db,q);
    const input={restoreId,backupSha256:expectedSha256,backupAt:snapshot.createdAt,reason,actor:{kind:'local-operator',id:operator},offline:true};
    const current=await store.restoreFence(q);
    if(current?.restoreId===restoreId){const prior=await prepareRestore(store,input,{query:q});return {importedRows:snapshot.rows,tables:tableNames.length,sourceDialect:snapshot.sourceDialect,targetDialect:store.db.dialect,sha256:expectedSha256,restoreId:prior.restoreId,held:prior.active,counts:prior.counts,duplicate:true};}
    for(const name of tableNames){const [row]=await q('SELECT COUNT(*) AS count FROM '+identifier(name));if(Number(row.count)!==0)throw Error('Destination is not empty; preserve existing data and choose a new database');}
    for(const name of tableNames){
      const table=snapshot.tables[name],meta=await columns(store.db,q,name);
      if(JSON.stringify(meta.map(c=>c.name))!==JSON.stringify(table.columns))throw Error('Destination columns differ for '+name);
      const sql='INSERT INTO '+identifier(name)+'('+table.columns.map(identifier).join(',')+') VALUES('+meta.map(()=>'?').join(',')+')';
      for(const row of table.rows)await q(sql,row.map((value,i)=>cell(value,meta[i])));
    }
    // Quarantine and import commit together. No process can see imported old
    // approvals or delivery intents before the global hold exists.
    const fence=await prepareRestore(store,input,{query:q});
    return {importedRows:snapshot.rows,tables:tableNames.length,sourceDialect:snapshot.sourceDialect,targetDialect:store.db.dialect,sha256:expectedSha256,restoreId:fence.restoreId,held:fence.active,counts:fence.counts};
  });
}
