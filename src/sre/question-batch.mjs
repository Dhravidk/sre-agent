// Coalesce inference, never intake. Every original event/job stays in SQL.
// A persisted parent retains the complete bounded request batch across retry.
export async function batchQuestions(q,job,payload,limit,{dialect='sqlite',now=Date.now()}={}){
  if(!payload.question||payload.requests||limit<2)return payload;
  // Rank within each room before limiting rows. An older flood from one room
  // must not hide all quieter rooms beyond a global oldest-128 window. Service
  // order is durable and scoped to this incident, while every event stays in SQL.
  const field=name=>dialect==='postgres'?`(j.payload::jsonb->>'${name}')`:`json_extract(j.payload,'$.${name}')`;
  const room=`COALESCE(${field('conversationKey')},'')`,question=field('question'),batch=field('requests');
  const pending=await q(`SELECT id,payload FROM (SELECT j.id,j.payload,j.next_at,j.created_at,COALESCE(f.updated_at,0) AS room_served,ROW_NUMBER() OVER(PARTITION BY ${room} ORDER BY j.next_at,j.created_at,j.id) AS room_rank FROM sre_jobs j LEFT JOIN sre_checkpoints f ON f.id='agent-room-scheduled:'||j.incident_id||':'||${room} WHERE j.incident_id=? AND j.status='pending' AND j.id<>? AND j.next_at<=? AND ${question} IS NOT NULL AND ${question}<>'' AND ${batch} IS NULL) ranked ORDER BY room_rank,room_served,next_at,created_at,id LIMIT 128`,[job.incident_id,job.id,now]);
  const buckets=new Map();
  for(const row of pending){
    const other=JSON.parse(row.payload);if(!other.question||other.requests)continue;
    const key=other.conversationKey||'',bucket=buckets.get(key)||[];bucket.push({row,payload:other});buckets.set(key,bucket);
  }
  const requests=[{jobId:job.id,question:payload.question,conversationKey:payload.conversationKey||null}];
  while(requests.length<limit&&[...buckets.values()].some(b=>b.length)){
    const fair=[...buckets].sort(([a],[b])=>(a===(payload.conversationKey||'')?1:0)-(b===(payload.conversationKey||'')?1:0));
    for(const [,bucket]of fair){
      if(!bucket.length||requests.length>=limit)continue;
      const {row,payload:other}=bucket.shift();requests.push({jobId:row.id,question:other.question,conversationKey:other.conversationKey||null});
      await q("UPDATE sre_jobs SET status='superseded',payload=? WHERE id=? AND status='pending'",[JSON.stringify({...other,batchJobId:job.id}),row.id]);
    }
  }
  for(const key of new Set(requests.map(request=>request.conversationKey||'')))await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',['agent-room-scheduled:'+job.incident_id+':'+key,JSON.stringify({jobId:job.id}),now]);
  return requests.length>1?{...payload,requests}:payload;
}
