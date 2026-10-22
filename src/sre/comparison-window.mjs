// Selection lanes preserve a quiet change beside a busy change's older heads.
// They do not validate provider scope, current refs, completeness or causality.
const number=value=>{const s=typeof value==='string'||typeof value==='number'?String(value):'';return /^[1-9]\d{0,15}$/.test(s)&&Number.isSafeInteger(Number(s))?s:'';};
const role=row=>['github','gitlab'].includes(row.source)&&(['code_review','release_diff'].includes(row.kind)||row.kind==='change'&&['deployment','review'].includes(row.content?.comparisonKind))?(row.content?.comparisonKind?? (row.kind==='code_review'?'review':'deployment')):null;
export function comparisonFamily(row){
 const kind=role(row);if(!['deployment','review'].includes(kind))return null;
 const c=row.content||{},n=number(c.number??c.comparison?.mergeRequest?.iid??c.comparison?.review?.pull?.number??c.comparison?.review?.mergeRequest?.iid);
 const repo=c.comparison?.review?.pull?.base?.repo?.full_name,scope=row.source==='gitlab'?number(c.comparison?.mergeRequest?.project_id??c.comparison?.review?.mergeRequest?.project_id):typeof repo==='string'?repo.toLowerCase():'';
 return JSON.stringify([row.source,kind,scope,kind==='review'?n:'']);
}
export function orderComparisonEvidence(rows){
 const recent=(a,b)=>(Number(b.observed_at)||0)-(Number(a.observed_at)||0)||String(b.id||'').localeCompare(String(a.id||'')),buckets=new Map();
 for(const row of [...rows].sort(recent)){const key=comparisonFamily(row)||JSON.stringify([row.source,row.kind]),bucket=buckets.get(key)||[];bucket.push(row);buckets.set(key,bucket);}
 const priority=row=>role(row)==='deployment'?0:role(row)==='review'?1:2,ordered=[...buckets.values()].sort((a,b)=>priority(a[0])-priority(b[0])||recent(a[0],b[0])),result=[];
 while(ordered.some(bucket=>bucket.length))for(const bucket of ordered)if(bucket.length)result.push(bucket.shift());
 return result;
}

// Match the same families before the SQL candidate LIMIT. Incoming content is
// already JSON-encoded by the store; malformed stored JSON remains a DB error.
export function comparisonLaneSql(dialect){
 const field=path=>dialect==='postgres'?"e.content::jsonb#>>'{"+path.split('.').join(',')+"}'":"CAST(json_extract(e.content,'$."+path+"') AS TEXT)";
 const n='COALESCE('+['number','comparison.mergeRequest.iid','comparison.review.pull.number','comparison.review.mergeRequest.iid'].map(field).join(',')+",'')",p='COALESCE('+['comparison.mergeRequest.project_id','comparison.review.mergeRequest.project_id'].map(field).join(',')+",'')";
 const positive=x=>dialect==='postgres'?"CASE WHEN "+x+" ~ '^[1-9][0-9]{0,15}$' AND (length("+x+")<16 OR "+x+"<='9007199254740991') THEN "+x+" ELSE '' END":"CASE WHEN "+x+" GLOB '[1-9]*' AND "+x+" NOT GLOB '*[^0-9]*' AND length("+x+")<=16 AND (length("+x+")<16 OR "+x+"<='9007199254740991') THEN "+x+" ELSE '' END";
 const repoType=dialect==='postgres'?"jsonb_typeof(e.content::jsonb#>'{comparison,review,pull,base,repo,full_name}')='string'":"json_type(e.content,'$.comparison.review.pull.base.repo.full_name')='text'",repo="CASE WHEN "+repoType+" THEN lower("+field('comparison.review.pull.base.repo.full_name')+") ELSE '' END";
 const kind="COALESCE("+field('comparisonKind')+",CASE WHEN e.kind='code_review' THEN 'review' ELSE 'deployment' END)",scope="CASE WHEN e.source='gitlab' THEN "+positive(p)+" ELSE "+repo+" END",reference="CASE WHEN "+kind+"='review' THEN "+positive(n)+" ELSE '' END",array=dialect==='postgres'?'jsonb_build_array('+kind+','+scope+','+reference+')::text':'json_array('+kind+','+scope+','+reference+')';
 return "CASE WHEN e.source IN ('github','gitlab') AND "+kind+" IN ('deployment','review') AND (e.kind IN ('code_review','release_diff') OR e.kind='change' AND "+field('comparisonKind')+" IN ('deployment','review')) THEN "+array+" ELSE '' END";
}
