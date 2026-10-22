import {hash} from './security.mjs';
import {canonicalLogValue} from './log-observation.mjs';

export const logWindowRecordLimit=200;
const requestKeys=['request.id','requestId','request_id'],traceKeys=['trace.id','trace_id','traceId'];
const correlationKeys=[...requestKeys,...traceKeys],messageKeys=['content','message','text'];
const flags=['complete','partial','sampled','truncated','metadata.grail.sampled','metadata.grail.notifications'];
const logRow=row=>['dynatrace','dynatrace-logs','logs'].includes(row.source)&&['log','logs'].includes(row.kind);
const scalar=value=>typeof value==='string'||typeof value==='number'?String(value):'';
const correlation=(record,keys)=>keys.map(key=>scalar(record?.[key])).find(Boolean)||'';
function semanticRecord(record){
 if(!record||typeof record!=='object'||Array.isArray(record))return canonicalLogValue(record);
 const ids=[[correlation(record,requestKeys),'<request-id>'],[correlation(record,traceKeys),'<trace-id>']];
 return Object.fromEntries(Object.keys(record).sort().filter(key=>!['timestamp','at'].includes(key)&&!(correlationKeys.includes(key)&&['string','number'].includes(typeof record[key]))).map(key=>{
  let value=record[key];if(messageKeys.includes(key)&&typeof value==='string')for(const[id,label]of ids)if(id.length>=8)value=value.split(id).join(label);
  return[key,canonicalLogValue(value)];
 }));
}
function flag(content,path){let value=content;for(const key of path.split('.')){if(!value||typeof value!=='object'||!Object.hasOwn(value,key))return['missing'];value=value[key];}return[value===null?'null':Array.isArray(value)?'array':typeof value,canonicalLogValue(value)];}

// Selection families reserve distinct retained samples before recent repeats.
// They are not observation identity, event deduplication, scope or a count of
// failures. Raw rows remain stored and the existing coverage limits still apply.
export function logSnapshotFamily(row){
 if(!logRow(row))return null;
 const records=Array.isArray(row.content?.records)?row.content.records:[row.content];
 if(records.length>logWindowRecordLimit)return null;
 const signatures=[...new Set(records.map(record=>JSON.stringify(semanticRecord(record))))].sort();
 return hash([row.source,row.kind,flags.map(path=>flag(row.content,path)),signatures]);
}

// Derive the same conservative families from stored JSON before the candidate
// LIMIT, without trusting a provider-supplied signature or persisting an index.
// All record fields except observation time and scalar correlation IDs, plus
// recognized completeness flags, remain part of the family. Only explicit IDs
// are replaced in top-level message strings.
// Nested object formatting can create extra SQLite families, never merge them.
export function logCandidateLaneSql(dialect){
 const pg=dialect==='postgres',root='log_document.payload';
 const field=(base,key)=>pg?base+"->'"+key+"'":"json_extract("+base+",'$.\""+key+"\"')";
 const type=(base,key)=>pg?'jsonb_typeof('+field(base,key)+')':"json_type("+base+",'$.\""+key+"\"')";
 const array=pg?"CASE WHEN jsonb_typeof("+root+"->'records')='array' THEN "+root+"->'records' ELSE jsonb_build_array("+root+") END":"CASE WHEN json_type("+root+",'$.records')='array' THEN jsonb_extract("+root+",'$.records') ELSE json_array(json("+root+")) END";
 const id=keys=>'COALESCE('+keys.map(key=>"CASE WHEN "+type('r.value',key)+(pg?" IN ('string','number')":" IN ('text','integer','real')")+" THEN NULLIF("+(pg?"r.value->>'"+key+"'":'CAST('+field('r.value',key)+' AS TEXT)')+",'') END").join(',')+",'')";
 let message=pg?"j.value#>>'{}'":'CAST(j.value AS TEXT)';
 for(const[keys,label]of[[requestKeys,'<request-id>'],[traceKeys,'<trace-id>']]){const value=id(keys);message='CASE WHEN length('+value+')>=8 THEN replace(('+message+'),'+value+",'"+label+"') ELSE ("+message+') END';}
 const excluded="j.key NOT IN ('timestamp','at') AND (j.key NOT IN ('"+correlationKeys.join("','")+"') OR "+(pg?"jsonb_typeof(j.value) NOT IN ('string','number')":"j.type NOT IN ('text','integer','real')")+')';
 const normalize=pg?"CASE WHEN j.key IN ('content','message','text') AND jsonb_typeof(j.value)='string' THEN to_jsonb(("+message+")) ELSE j.value END":"CASE WHEN j.key IN ('content','message','text') AND j.type='text' THEN ("+message+') ELSE j.value END';
 const record=pg?"CASE WHEN jsonb_typeof(r.value)='object' THEN (SELECT COALESCE(jsonb_agg(jsonb_build_array(j.key,jsonb_typeof(j.value),"+normalize+") ORDER BY j.key),'[]'::jsonb)::text FROM jsonb_each(r.value) j WHERE "+excluded+") ELSE jsonb_build_array(jsonb_typeof(r.value),r.value)::text END":"CASE WHEN r.type='object' THEN (SELECT json_group_array(pair) FROM (SELECT json_array(j.key,j.type,"+normalize+") AS pair FROM json_each(r.value) j WHERE "+excluded+" ORDER BY j.key)) ELSE json_array(r.type,r.value) END";
 const records=pg?"(SELECT COALESCE(jsonb_agg(signature ORDER BY signature),'[]'::jsonb)::text FROM (SELECT DISTINCT ("+record+") AS signature FROM jsonb_array_elements("+array+" ) r(value)) patterns)":"(SELECT json_group_array(signature) FROM (SELECT DISTINCT ("+record+") AS signature FROM json_each("+array+") r ORDER BY signature))";
 const flagExpressions=flags.map(path=>{const value=pg?root+"#>'{"+path.split('.').join(',')+"}'":"json_extract("+root+",'$."+path+"')",kind=pg?'jsonb_typeof('+value+')':"json_type("+root+",'$."+path+"')";return pg?"jsonb_build_array(COALESCE("+kind+",'missing'),"+value+")":"json_array(COALESCE("+kind+",'missing'),"+value+")";});
 const family=pg?'jsonb_build_array('+[...flagExpressions,records].join(',')+')::text':'json_array('+[...flagExpressions,records].join(',')+')';
 // Materialize one parsed document per row, rather than parsing the complete
 // page for every flag and record expression. Raw stored JSON is unchanged.
 const lane='CASE WHEN '+(pg?'jsonb_array_length(':'json_array_length(')+array+')<='+logWindowRecordLimit+" THEN "+family+" ELSE 'oversize:'||e.id END";
 return "CASE WHEN e.source IN ('dynatrace','dynatrace-logs','logs') AND e.kind IN ('log','logs') THEN (WITH log_document AS MATERIALIZED (SELECT "+(pg?'e.content::jsonb':'jsonb(e.content)')+' AS payload) SELECT '+lane+" FROM log_document) ELSE '' END";
}
