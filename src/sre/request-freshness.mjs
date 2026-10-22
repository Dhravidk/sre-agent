// A stale draft cannot answer a current request. Let the input burst settle,
// then recover the request's earlier fair position once, without a retry loop
// monopolizing admission. Only the host writes this scheduling metadata.
export const requestFreshnessLimits=Object.freeze({quietMs:5000,maxWaitMs:60000,priorityRecoveries:1});
const gateKey=id=>'agent-freshness-ready:'+id;
const scheduleKey=id=>'agent-request-schedule:'+id;
const integer=value=>Number.isSafeInteger(value)&&value>=0;

function schedule(value){
  if(!value||value.version!==1||typeof value.incidentId!=='string'||!integer(value.scheduledAt)||value.previousAt!==null&&!integer(value.previousAt)||typeof value.recovered!=='boolean')throw Error('Invalid saved request scheduling metadata');
  return value;
}
function gate(row){
  const value=JSON.parse(row.value);
  if(value?.version!==1||typeof value.jobId!=='string'||!value.jobId||!integer(value.deadline)||!integer(Number(row.updated_at))||Number(row.updated_at)>value.deadline)throw Error('Invalid saved request freshness gate');
  return value;
}
export async function requestSchedule(q,job,previousAt,now){
  const id=scheduleKey(job.id),[row]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[id]);
  const previous=row?schedule(JSON.parse(row.value)):{version:1,incidentId:job.incident_id,previousAt:previousAt==null?null:Number(previousAt),recovered:false};
  if(previous.incidentId!==job.incident_id)throw Error('Request scheduling scope changed');
  const value={...previous,scheduledAt:now};
  await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[id,JSON.stringify(value),now]);
  return value;
}
export async function extendRequestFreshness(q,incidentId,now){
  const id=gateKey(incidentId),[row]=await q('SELECT value,updated_at FROM sre_checkpoints WHERE id=?',[id]);
  if(!row)return;
  const value=gate(row),until=Math.min(value.deadline,Math.max(Number(row.updated_at),now+requestFreshnessLimits.quietMs));
  if(until!==Number(row.updated_at))await q('UPDATE sre_checkpoints SET updated_at=? WHERE id=?',[until,id]);
}
export async function claimRequestFreshness(q,incidentId,now,dialect){
  // A fresh intake transaction can extend readiness after candidate selection.
  // Recheck under the row lock before mutating scheduling or batching jobs.
  const id=gateKey(incidentId),[row]=await q('SELECT value,updated_at FROM sre_checkpoints WHERE id=?'+(dialect==='postgres'?' FOR UPDATE':''),[id]);
  if(row){gate(row);if(Number(row.updated_at)>now)return false;await q('DELETE FROM sre_checkpoints WHERE id=?',[id]);}
  return true;
}
export async function requeueStaleRequest(q,job,now){
  const [record]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[scheduleKey(job.id)]),saved=record?schedule(JSON.parse(record.value)):null;
  if(saved&&saved.incidentId!==job.incident_id)throw Error('Request scheduling scope changed');
  if(saved&&!saved.recovered&&saved.previousAt!==null){
    const id='agent-scheduled:'+job.incident_id,[row]=await q('SELECT value,updated_at FROM sre_checkpoints WHERE id=?',[id]);
    if(!row||JSON.parse(row.value)?.jobId!==job.id||Number(row.updated_at)!==saved.scheduledAt)throw Error('Request scheduling ownership changed');
    await q('UPDATE sre_checkpoints SET updated_at=? WHERE id=?',[saved.previousAt,id]);
    await q('UPDATE sre_checkpoints SET value=?,updated_at=? WHERE id=?',[JSON.stringify({...saved,recovered:true}),now,scheduleKey(job.id)]);
  }
  // updated_at is explicitly the gate's indexed readiness time, while the
  // JSON deadline is fixed for this stale turn. Source event time is unused.
  await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[gateKey(job.incident_id),JSON.stringify({version:1,jobId:job.id,deadline:now+requestFreshnessLimits.maxWaitMs}),now+requestFreshnessLimits.quietMs]);
  await q("UPDATE sre_jobs SET status='pending',next_at=? WHERE id=?",[now,job.id]);
}

export function freshnessClaimSql(dialect){
  const parent=dialect==='postgres'?"(g.value::jsonb->>'jobId')":"json_extract(g.value,'$.jobId')";
  return {join:" LEFT JOIN sre_checkpoints g ON g.id='agent-freshness-ready:'||j.incident_id",eligible:" AND (j.status='running' OR COALESCE(g.updated_at,0)<=?)",parentOrder:`CASE WHEN j.id=${parent} THEN 0 ELSE 1 END,`};
}
