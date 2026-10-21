import {randomUUID} from 'node:crypto';
import {assertText,redact} from './security.mjs';

const key='agent-model-quota';
const conflict=message=>Object.assign(new Error(message),{status:409});

// Only the host's provider protocol parser can raise this condition. A model's
// assessment or incident text cannot set a shared scheduling hold.
export class ModelQuotaError extends Error {
  constructor(provider,{resetLabel=null,retryAt=null}={}) {
    if(!['claude-cli','codex-cli'].includes(provider)||resetLabel!==null&&(typeof resetLabel!=='string'||resetLabel.length>100)||retryAt!==null&&(!Number.isSafeInteger(retryAt)||retryAt<0))throw Error('Invalid model quota metadata');
    const name=provider==='claude-cli'?'Claude':'Codex';
    super(name+' usage limit reached'+(resetLabel?' (resets '+resetLabel+')':'')+'. Investigations are paused; check the provider account, then resume the model queue.');
    this.name='ModelQuotaError';this.provider=provider;this.resetLabel=resetLabel;this.retryAt=retryAt;this.retryable=false;
  }
}

export async function modelQuota(store,q=store.db.query) {
  const [row]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[key]);
  if(!row)return null;
  const hold=JSON.parse(row.value);
  if(hold.version!==1||!['held','released'].includes(hold.state)||typeof hold.id!=='string'||!['claude-cli','codex-cli'].includes(hold.provider)||hold.retryAt!==null&&(!Number.isSafeInteger(hold.retryAt)||hold.retryAt<0))throw Error('Invalid stored model quota hold');
  return hold;
}

async function save(store,q,value,now){
  for(const id of [key,key+':'+value.id])await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[id,JSON.stringify(value),now]);
}

// One database has one configured investigator account. The store holds the
// single-investigator lock here; the hold covers every incident and room and
// survives a process restart or worker takeover.
export async function holdModelQuota(store,q,job,error,now){
  const hold={version:1,id:randomUUID(),state:'held',provider:error.provider,resetLabel:error.resetLabel,retryAt:error.retryAt,heldAt:now,jobId:job.id};
  await save(store,q,hold,now);
  await q("UPDATE sre_jobs SET status='pending',attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END,error=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND status='running'",[error.message,job.id,job.lease_owner]);
}

export async function quotaBlocksClaim(store,q,now){
  const hold=await modelQuota(store,q);
  if(!hold||hold.state!=='held')return false;
  if(hold.retryAt===null||hold.retryAt>now)return true;
  await save(store,q,{...hold,state:'released',releasedAt:now,release:{kind:'provider-reset-deadline'}},now);
  return false;
}

export async function resumeModelQuota(store,{holdId,reason,actor}){
  if(!['operator-api','local-operator'].includes(actor?.kind))throw Error('Authenticated local/API operator identity required');
  assertText(actor.id,'operator identity',512);assertText(reason,'quota resume reason',1000);assertText(holdId,'quota hold ID',100);
  const release={kind:'operator',actor:redact(actor),reason:redact(reason.trim())};
  return store.db.transaction(async q=>{
    await q('SELECT name FROM sre_locks WHERE name=?'+(store.db.dialect==='postgres'?' FOR UPDATE':''),['single-agent']);
    const hold=await modelQuota(store,q);
    if(!hold||hold.id!==holdId)throw conflict('Model quota hold changed; inspect the current hold before resuming');
    if(hold.state==='released'){
      if(JSON.stringify(hold.release)!==JSON.stringify(release))throw conflict('This quota hold was already released with different details');
      return {...hold,duplicate:true};
    }
    const now=await store.coordinationNow(q),value={...hold,state:'released',releasedAt:now,release};
    await save(store,q,value,now);return {...value,duplicate:false};
  });
}
