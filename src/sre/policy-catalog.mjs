import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

export const auctionPolicyPath='src/auction/rules.mjs';
const fieldTypes={release:'string',checkVersion:'boolean',enforceCloseTime:'boolean',creditTimeoutMs:'number',catalogDelayMs:'number',schemaVersion:'number',rollbackCompatible:'boolean'};
const parsed=source=>parse(source,{ecmaVersion:'latest',sourceType:'module'});
const policyDeclaration=ast=>ast.body.find(node=>node.type==='ExportNamedDeclaration'&&node.declaration?.type==='VariableDeclaration'&&node.declaration.declarations.some(item=>item.id.type==='Identifier'&&item.id.name==='policy'))?.declaration.declarations.find(item=>item.id.name==='policy');
function shape(value,policyObject) {
  if(value===policyObject)return {type:'KnownAuctionPolicyObject'};
  if(Array.isArray(value))return value.map(item=>shape(item,policyObject));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['start','end','raw','loc','range'].includes(key)).map(([key,item])=>[key,shape(item,policyObject)]));
  return value;
}
const reference=parsed(readFileSync(new URL('../auction/rules.mjs',import.meta.url),'utf8'));
const knownShape=JSON.stringify(shape(reference,policyDeclaration(reference).init));

function policy(source) {
  if(typeof source!=='string'||Buffer.byteLength(source,'utf8')>65536)throw new Error('Policy source is missing or exceeds the 64 KiB analysis budget');
  const ast=parsed(source),declaration=policyDeclaration(ast);
  if(!declaration||declaration.init?.type!=='ObjectExpression'||JSON.stringify(shape(ast,declaration.init))!==knownShape)throw new Error('Source is outside the known auction module structure');
  const values={};
  for(const property of declaration.init.properties) {
    if(property.type!=='Property'||property.kind!=='init'||property.computed||property.method||property.shorthand||property.value.type!=='Literal')throw new Error('Dynamic/spread/accessor policy values require a broader code investigation');
    const key=property.key.type==='Identifier'?property.key.name:property.key.type==='Literal'?property.key.value:null;
    if(!Object.hasOwn(fieldTypes,key)||typeof property.value.value!==fieldTypes[key])throw new Error('Unknown or nonliteral auction policy field');
    values[key]=property.value.value; // JavaScript object duplicate keys use the last value.
  }
  if(Object.keys(values).length!==Object.keys(fieldTypes).length||Object.values(values).some(value=>typeof value==='number'&&!Number.isFinite(value)))throw new Error('Incomplete auction policy');
  return values;
}

export function reviewPolicySources(sources) {
  if(sources?.complete!==true||sources.path!==auctionPolicyPath)return {supported:false,findings:[],reason:sources?.error||'Exact before/after auction policy sources are unavailable'};
  if(sources.changed===false)return {supported:true,findings:[],reason:'The comparison does not change the known auction policy path'};
  try {
    const before=policy(sources.base),after=policy(sources.head),findings=[];
    const add=(condition,signal,severity,issue,check)=>{if(condition)findings.push({signal,severity,issue,check,path:auctionPolicyPath});};
    add(before.checkVersion&&!after.checkVersion,'WINNING_BID_REGRESSED','high','Concurrent bids can overwrite one another.','Run concurrent bids and retain the highest accepted winner.');
    add(before.enforceCloseTime&&!after.enforceCloseTime,'BID_ACCEPTED_AFTER_CLOSE','high','Bids can be accepted after auction close.','Submit a bid after the real closing time and inspect retained transactions.');
    add(before.creditTimeoutMs>=25&&after.creditTimeoutMs<25,'CREDIT_TIMEOUT','high','The credit timeout is below the fixture provider latency.','Replay the documented 25 ms fixture response.');
    add(before.schemaVersion!==after.schemaVersion,'SCHEMA_MISMATCH','high','This release changes the required schema version.','Verify actual schema state and deployment compatibility.');
    add(before.catalogDelayMs<=250&&after.catalogDelayMs>250,'CATALOG_LATENCY','medium','The catalog introduces latency above the fixture threshold.','Measure actual catalog responses against the healthy version.');
    return {supported:true,findings,before,after,reason:'Known module structure and literal effective policy values compared without executing source'};
  } catch(cause){return {supported:false,findings:[],reason:cause.message};}
}
