// Short database transactions serialize admission and account-wide backpressure.
// Model calls run outside the transaction, bounded by durable slot/job leases.
const policyKey='agent-scheduler-policy';
export const investigatorSlots=['single-agent','agent-slot:1','agent-slot:2','agent-slot:3'];

export function investigatorLimit(value=1){
  if(!Number.isInteger(value)||value<1||value>investigatorSlots.length)throw Error('Investigation concurrency must be an integer from 1 to 4');
  return value;
}

export async function lockInvestigationScheduler(store,q){
  if(store.db.dialect==='postgres')await q('SELECT pg_advisory_xact_lock(?::integer,?::integer)',[0x535245,2]);
}

export async function configureInvestigationScheduler(store){
  return store.db.transaction(async q=>{
    await lockInvestigationScheduler(store,q);
    const now=await store.coordinationNow(q),[row]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[policyKey]);
    const prior=row?JSON.parse(row.value):null;
    // A schema-only database must remain empty for an offline import. Admission
    // establishes the first policy; initialization only reviews an existing one.
    if(!prior)return;
    if(prior&&(prior.version!==1||investigatorLimit(prior.concurrency)!==prior.concurrency))throw Error('Invalid durable investigation concurrency policy');
    if(prior?.concurrency===store.investigationConcurrency)return;
    // A stopped/idle deployment may change capacity. An older idle process
    // fails its next admission if its configured capacity no longer agrees.
    const [active]=await q("SELECT COUNT(*) AS count FROM sre_locks WHERE name IN ('single-agent','agent-slot:1','agent-slot:2','agent-slot:3') AND expires_at>?",[now]);
    const [jobs]=await q("SELECT COUNT(*) AS count FROM sre_jobs WHERE status='running' AND lease_until>?",[now]);
    if(Number(active.count)||Number(jobs.count))throw Error('Stop active investigators before changing investigation concurrency');
    const value={version:1,concurrency:store.investigationConcurrency,previousConcurrency:prior?.concurrency??1};
    await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[policyKey,JSON.stringify(value),now]);
  });
}

export async function assertInvestigationScheduler(store,q){
  const [row]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[policyKey]);
  const policy=row?JSON.parse(row.value):null;
  if(!policy){
    const now=await store.coordinationNow(q);
    const [active]=await q("SELECT COUNT(*) AS count FROM sre_locks WHERE name IN ('single-agent','agent-slot:1','agent-slot:2','agent-slot:3') AND expires_at>?",[now]);
    if(store.investigationConcurrency>1&&Number(active.count))throw Error('Stop active investigators before changing investigation concurrency');
    await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?)',[policyKey,JSON.stringify({version:1,concurrency:store.investigationConcurrency,previousConcurrency:1}),now]);return;
  }
  if(policy?.version!==1||policy.concurrency!==store.investigationConcurrency)throw Error('Investigation concurrency changed; restart this worker with the current configuration');
}

export function investigatorLeaseName(job){
  const name=job.lease_name??'single-agent';
  if(!investigatorSlots.includes(name))throw Error('Invalid investigator slot');
  return name;
}
