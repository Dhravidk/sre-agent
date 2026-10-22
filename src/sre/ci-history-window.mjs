import {pollScopeHash} from './poll-scope.mjs';
import {parseSavedPipelineFact} from './ci-observations.mjs';
import {StorageError} from './database.mjs';

export const ciHistoryLimits=Object.freeze({runs:100,factsPerRun:3});
const sha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const bad=status=>/^(?:failed|failure|error|timed_out|cancelled|canceled)$/i.test(status||'');
const key=(head,id)=>head+':'+id;
const integer=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new StorageError(new Error('Invalid saved CI window count or time'));return n;};

// This reads the immutable scoped ledger. SQL reduces repeated deliveries and
// compares versions before bounding run identities or source representatives.
// It checks saved observations, not current provider visibility or recovery.
export async function reserveCiHistory(store,service,heads,context){
  heads=[...new Set(heads.filter(sha))].slice(0,100);
  const project=String(service.gitlab?.project||''),scopeHash=service.gitlab?pollScopeHash(service,'gitlab'):null;
  const empty={rows:[],runs:[],heads:[],scopeHash,project,limited:false,versionsLimited:false};
  if(!heads.length||!/^[1-9][0-9]*$/.test(project)||!Number.isSafeInteger(Number(project)))return empty;
  const field=(base,...path)=>store.db.dialect==='postgres'?base+'::jsonb'+path.map((part,i)=>(i===path.length-1?'->>':'->')+"'"+part+"'").join(''):"json_extract("+base+",'$."+path.join('.')+"')";
  const rawId=field('e.payload','payload','pipeline','id'),rawStatus=field('e.payload','payload','pipeline','status'),rawProject=field('e.payload','payload','pipeline','project_id'),originScope=field('c.payload','observationOrigin','scopeHash'),originProject=field('c.payload','observationOrigin','projectId'),originAt=field('c.payload','observationOrigin','at'),originKind=field('c.payload','observationOrigin','kind');
  const previous=new Map();
  const priorChanges=context.incident.analysis?.observedChanges;
  for(const change of (Array.isArray(priorChanges)?priorChanges:[]).slice(0,100)){
    if(!change||change.provider!=='gitlab'||!heads.includes(change.headSha))continue;
    for(const run of (Array.isArray(change.ci)?change.ci:[]).slice(0,3)){
      if(!run||!/^[1-9][0-9]*$/.test(run.id||'')||!Number.isSafeInteger(Number(run.id))||!(run.attention===true||run.state!=='observed-version'||bad(run.status)))continue;
      previous.set(key(change.headSha,run.id),[change.headSha,String(run.id),run.status||null,run.state||'unknown']);
    }
  }
  const priors=[...previous.values()].slice(0,100),priorSql=priors.length?'VALUES '+priors.map(()=>'(?,?,?,?)').join(','):'SELECT CAST(NULL AS TEXT),CAST(NULL AS TEXT),CAST(NULL AS TEXT),CAST(NULL AS TEXT) WHERE 1=0';
  const adverse="('failed','failure','error','timed_out','cancelled','canceled')";
  const sql='WITH prior(head_sha,pipeline_id,previous_status,previous_state) AS ('+priorSql+'), '+
    'raw AS MATERIALIZED (SELECT c.id,c.head_sha,CAST('+rawId+' AS TEXT) AS pipeline_id,COALESCE('+rawStatus+",'unknown') AS status,COALESCE("+originKind+",'updated') AS time_kind,COALESCE(CAST("+originAt+' AS BIGINT),c.observed_at) AS source_at,e.received_at FROM sre_change_events c JOIN sre_events e ON e.id=c.id WHERE c.service_key=? AND c.provider=\'gitlab\' AND c.stage=\'ci-update\' AND c.head_sha IN ('+heads.map(()=>'?').join(',')+') AND (('+originScope+'=? AND CAST('+originProject+' AS TEXT)=?) OR ('+originScope+' IS NULL AND CAST('+rawProject+" AS TEXT)=? AND e.external_id LIKE 'change-read-ci:%'))), "+
    'versions AS MATERIALIZED (SELECT head_sha,pipeline_id,time_kind,source_at,status,MIN(id) AS sample_id,MIN(received_at) AS first_received FROM raw GROUP BY head_sha,pipeline_id,time_kind,source_at,status), '+
    "latest AS MATERIALIZED (SELECT head_sha,pipeline_id,MAX(CASE WHEN time_kind='updated' THEN source_at END) AS latest_at,MAX(CASE WHEN LOWER(status) IN "+adverse+' THEN 1 ELSE 0 END) AS history_adverse FROM versions GROUP BY head_sha,pipeline_id), '+
    "current_states AS MATERIALIZED (SELECT v.head_sha,v.pipeline_id,COUNT(*) AS status_count,MIN(v.status) AS latest_status,MIN(v.sample_id) AS first_id,MAX(v.sample_id) AS second_id,MAX(v.first_received) AS conflict_at FROM versions v JOIN latest l ON l.head_sha=v.head_sha AND l.pipeline_id=v.pipeline_id WHERE v.time_kind='updated' AND v.source_at=l.latest_at GROUP BY v.head_sha,v.pipeline_id), "+
    "unversioned AS MATERIALIZED (SELECT head_sha,pipeline_id,COUNT(DISTINCT status) AS status_count,MIN(sample_id) AS sample_id,MIN(first_received) AS first_received FROM versions WHERE time_kind<>'updated' GROUP BY head_sha,pipeline_id), "+
    "different AS MATERIALIZED (SELECT l.head_sha,l.pipeline_id,MAX(CASE WHEN v.time_kind='updated' AND v.status<>s.latest_status THEN v.source_at ELSE -1 END) AS last_other FROM latest l JOIN current_states s ON s.head_sha=l.head_sha AND s.pipeline_id=l.pipeline_id JOIN versions v ON v.head_sha=l.head_sha AND v.pipeline_id=l.pipeline_id GROUP BY l.head_sha,l.pipeline_id), "+
    "segments AS MATERIALIZED (SELECT v.head_sha,v.pipeline_id,MIN(v.first_received) AS first_received FROM versions v JOIN current_states s ON s.head_sha=v.head_sha AND s.pipeline_id=v.pipeline_id JOIN different d ON d.head_sha=v.head_sha AND d.pipeline_id=v.pipeline_id WHERE v.time_kind='updated' AND v.status=s.latest_status AND v.source_at>d.last_other GROUP BY v.head_sha,v.pipeline_id), "+
    'summaries AS MATERIALIZED (SELECT l.*,COALESCE(s.status_count,0) AS latest_status_count,s.latest_status,s.first_id,s.second_id,u.sample_id AS unknown_id,COALESCE(u.status_count,0) AS unknown_status_count,COALESCE(u.first_received,g.first_received,s.conflict_at,0) AS attention_at,CASE WHEN COALESCE(u.status_count,0)>0 THEN \'unversioned\' WHEN COALESCE(s.status_count,0)>1 THEN \'conflicting\' WHEN s.status_count=1 THEN \'observed-version\' ELSE \'unknown\' END AS summary_state FROM latest l LEFT JOIN current_states s ON s.head_sha=l.head_sha AND s.pipeline_id=l.pipeline_id LEFT JOIN unversioned u ON u.head_sha=l.head_sha AND u.pipeline_id=l.pipeline_id LEFT JOIN segments g ON g.head_sha=l.head_sha AND g.pipeline_id=l.pipeline_id), '+
    'ranked AS MATERIALIZED (SELECT s.*,CASE WHEN p.pipeline_id IS NOT NULL AND (COALESCE(s.latest_status,\'\')<>COALESCE(p.previous_status,\'\') OR s.summary_state<>p.previous_state) THEN 0 WHEN s.summary_state<>\'observed-version\' THEN 1 WHEN LOWER(s.latest_status) IN '+adverse+' THEN 2 WHEN s.history_adverse=1 THEN 3 ELSE 4 END AS selection_rank,COUNT(*) OVER() AS available_runs,COUNT(*) OVER(PARTITION BY s.head_sha) AS head_runs,SUM(CASE WHEN s.summary_state=\'observed-version\' AND LOWER(s.latest_status) IN '+adverse+' THEN 1 ELSE 0 END) OVER(PARTITION BY s.head_sha) AS head_adverse,SUM(CASE WHEN s.summary_state<>\'observed-version\' THEN 1 ELSE 0 END) OVER(PARTITION BY s.head_sha) AS head_uncertain FROM summaries s LEFT JOIN prior p ON p.head_sha=s.head_sha AND p.pipeline_id=s.pipeline_id) '+
    'SELECT * FROM ranked ORDER BY selection_rank,attention_at DESC,head_sha,pipeline_id LIMIT '+(ciHistoryLimits.runs+1);
  const read=async query=>{
    const candidates=await query(sql,[...priors.flat(),service.key,...heads,scopeHash,project,project]),selected=candidates.slice(0,ciHistoryLimits.runs);
    const ids=[...new Set(selected.flatMap(row=>[row.first_id,row.latest_status_count>1?row.second_id:null,row.unknown_id].filter(Boolean)))];
    const rows=ids.length?await query('SELECT c.*,c.payload AS projection,e.payload AS source_event,e.body_hash,e.received_at FROM sre_change_events c JOIN sre_events e ON e.id=c.id WHERE c.service_key=? AND c.provider=\'gitlab\' AND c.id IN ('+ids.map(()=>'?').join(',')+')',[service.key,...ids]):[],byId=new Map(rows.map(row=>[row.id,row])),runs=[],coverage=new Map();
    for(const row of selected){
      const pipelineId=integer(row.pipeline_id);if(pipelineId<1||!sha(row.head_sha))throw new StorageError(new Error('Invalid reserved pipeline identity'));
      const samples=[...new Set([row.first_id,integer(row.latest_status_count)>1?row.second_id:null,row.unknown_id].filter(Boolean))],facts=[];
      for(const id of samples){const source=byId.get(id);if(!source)throw new StorageError(new Error('Reserved CI source fact is missing'));facts.push(parseSavedPipelineFact(source,service,scopeHash,{sha:row.head_sha,pipelineId,projectId:Number(project)}));}
      const latestAt=row.latest_at===null?null:integer(row.latest_at),current=facts.filter(fact=>fact.timeKind==='updated'&&fact.providerUpdatedAt===latestAt),states=[...new Set(current.map(fact=>fact.status))].sort();
      if(row.latest_at!==null&&(!current.length||integer(row.latest_status_count)===1&&states[0]!==row.latest_status))throw new StorageError(new Error('Reserved CI version does not match its source facts'));
      runs.push({headSha:row.head_sha,pipelineId:String(pipelineId),latestAt,statuses:latestAt===null?[...new Set(facts.map(fact=>fact.status))].sort():states,hasUnversioned:integer(row.unknown_status_count)>0,checked:facts.every(fact=>fact.scoped)&&states.length===integer(row.latest_status_count)&&integer(row.unknown_status_count)<=1,selectionRank:integer(row.selection_rank),attentionAt:integer(row.attention_at),sourceIds:samples});
      coverage.set(row.head_sha,{headSha:row.head_sha,runs:integer(row.head_runs),adverse:integer(row.head_adverse),uncertain:integer(row.head_uncertain)});
    }
    const limited=candidates.length>ciHistoryLimits.runs;
    return {rows,runs,heads:heads.map(headSha=>coverage.get(headSha)||{headSha,runs:limited?null:0,adverse:limited?null:0,uncertain:limited?null:0}),scopeHash,project,limited,availableRuns:candidates.length?integer(candidates[0].available_runs):0,versionsLimited:selected.some(row=>integer(row.latest_status_count)>2||integer(row.unknown_status_count)>1)};
  };
  if(store.db.dialect!=='postgres')return read(store.db.query);
  return store.db.transaction(async query=>{
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await query("SET LOCAL statement_timeout = '10s'");await query("SET LOCAL lock_timeout = '3s'");
    return read(query);
  });
}

export function applyCiReservation(group,window){
  if(group.provider!=='gitlab'||group.stage!=='ci-update'||group.scopeHash!==window?.scopeHash||String(group.projectId)!==window.project)return;
  const run=window.runs.find(run=>run.headSha===group.headSha&&run.pipelineId===group.run?.id);if(!run)return;
  group.ciReserved=true;group.ciSelectionRank=run.selectionRank;group.ciSelectionAt=run.attentionAt;
  group.ciVersionChecked=run.checked&&group.latest.at===run.latestAt&&JSON.stringify(group.latest.statuses)===JSON.stringify(run.statuses)&&Boolean(group.unversionedCount)===run.hasUnversioned;
}
