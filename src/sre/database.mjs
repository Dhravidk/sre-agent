import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class StorageError extends Error {
  constructor(cause) {super('SRE storage is temporarily unavailable',{cause});this.name='StorageError';this.status=503;this.code='SRE_STORAGE_UNAVAILABLE';}
}
const storageFailure=error=>error instanceof StorageError?error:new StorageError(error);
async function storageCall(fn) {try{return await fn();}catch(error){throw storageFailure(error);}}

function serialized(run) {
  let tail = Promise.resolve();
  return (fn) => {
    const next = tail.then(() => run(fn));
    tail = next.catch(() => {});
    return next;
  };
}

export function sqliteDatabase(path = '.local/sre.sqlite') {
  let db;
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  } catch(error) {try{db?.close();}catch{}throw storageFailure(error);}
  const execute=sql=>{try{return db.exec(sql);}catch(error){throw storageFailure(error);}};
  const queue = serialized((fn) => fn());
  const query = async (sql, args = []) => {
    try {
      const statement = db.prepare(sql);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql)) return statement.all(...args);
      statement.run(...args);return [];
    } catch(error) {throw storageFailure(error);}
  };
  return {
    dialect: 'sqlite',
    query: (sql, args) => queue(() => query(sql, args)),
    transaction: (fn) => queue(async () => {
      execute('BEGIN IMMEDIATE');
      try { const value = await fn(query); execute('COMMIT'); return value; }
      catch (error) { execute('ROLLBACK'); throw error; }
    }),
    close: () => queue(() => storageCall(()=>db.close())),
  };
}

export function postgresSql(sql) {
  let index = 0;
  // Application queries never contain literal '?' characters.
  return sql.replace(/\?/g, () => '$' + (++index));
}

export async function postgresDatabase(connectionString) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000 });
  // pg removes a failed idle connection itself. Handle its background event so
  // a transient server disconnect does not become an uncaught process error.
  // Query failures still propagate as StorageError; requests are never replayed.
  pool.on('error',()=>console.error('SRE PostgreSQL idle connection lost; the next request will reconnect.'));
  const run = async (client, sql, args = []) => (await storageCall(()=>client.query(postgresSql(sql), args))).rows;
  return {
    dialect: 'postgres',
    query: (sql, args) => run(pool, sql, args),
    transaction: async (fn) => {
      const client = await storageCall(()=>pool.connect());
      let connectionFailure;
      const disconnected=error=>{connectionFailure=storageFailure(error);};
      client.on('error',disconnected);
      try {
        await storageCall(()=>client.query('BEGIN'));
        const value = await fn((sql, args) => run(client, sql, args));
        if(connectionFailure)throw connectionFailure;
        await storageCall(()=>client.query('COMMIT'));
        return value;
      } catch (error) {
        if(!connectionFailure)await storageCall(()=>client.query('ROLLBACK'));
        throw connectionFailure||error;
      } finally {client.removeListener('error',disconnected);client.release(Boolean(connectionFailure));}
    },
    close: () => storageCall(()=>pool.end()),
  };
}

export const schema = [
  `CREATE TABLE IF NOT EXISTS sre_events (id TEXT PRIMARY KEY, source TEXT NOT NULL, service_key TEXT NOT NULL, external_id TEXT NOT NULL, kind TEXT NOT NULL, occurred_at BIGINT NOT NULL, received_at BIGINT NOT NULL, body_hash TEXT NOT NULL, incident_id TEXT, payload TEXT NOT NULL, UNIQUE(source, service_key, external_id))`,
  `CREATE TABLE IF NOT EXISTS sre_incidents (id TEXT PRIMARY KEY, service_key TEXT NOT NULL, issue_key TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, started_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, revision INTEGER NOT NULL, source_states TEXT NOT NULL DEFAULT '{}', analysis TEXT, UNIQUE(service_key, issue_key))`,
  `CREATE TABLE IF NOT EXISTS sre_sessions (incident_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, remote_state TEXT NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_jobs (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, next_at BIGINT NOT NULL, lease_owner TEXT, lease_until BIGINT, error TEXT, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_job_retries (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE, replacement_job_id TEXT NOT NULL UNIQUE, body_hash TEXT NOT NULL, requested_by TEXT NOT NULL, reason TEXT NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_evidence (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, observed_at BIGINT NOT NULL, content TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_deployments (id TEXT PRIMARY KEY, service_key TEXT NOT NULL, occurred_at BIGINT NOT NULL, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_outbox (id TEXT PRIMARY KEY, incident_id TEXT, conversation_key TEXT, text TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, next_at BIGINT NOT NULL, lease_owner TEXT, lease_until BIGINT, remote_id TEXT, error TEXT, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_delivery_inspections (id TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES sre_outbox(id), generation BIGINT NOT NULL CHECK(generation>=1), request_id TEXT NOT NULL, request_hash TEXT NOT NULL, service_key TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, finding TEXT NOT NULL CHECK(finding IN ('observed','not_found','inconclusive')), follow_up TEXT NOT NULL CHECK(follow_up IN ('required','handled')), reason TEXT NOT NULL, observed_at BIGINT NOT NULL, recorded_at BIGINT NOT NULL, restore_id TEXT, facts_hash TEXT NOT NULL, tenant_id_snapshot TEXT, conversation_service_snapshot TEXT, status_snapshot TEXT NOT NULL, attempts_snapshot BIGINT NOT NULL, text_snapshot TEXT NOT NULL, error_snapshot TEXT, remote_id_snapshot TEXT, conversation_key_snapshot TEXT, incident_id_snapshot TEXT, created_at_snapshot BIGINT NOT NULL, prepared_snapshot TEXT, outcome_snapshot TEXT, late_snapshot TEXT, references_json TEXT NOT NULL, UNIQUE(outbox_id,generation), UNIQUE(outbox_id,request_id))`,
  `CREATE TABLE IF NOT EXISTS sre_conversations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, service_key TEXT NOT NULL, incident_id TEXT, reference TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_checkpoints (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_provider_retries (scope_hash TEXT PRIMARY KEY, retry_until BIGINT NOT NULL, http_status INTEGER NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_rollbacks (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, proposal TEXT NOT NULL, nonce_hash TEXT NOT NULL, expires_at BIGINT NOT NULL, status TEXT NOT NULL, approved_by TEXT, approved_at BIGINT, external_ref TEXT, error TEXT, lease_until BIGINT, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_commands (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, lease_until BIGINT, error TEXT, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_assessments (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, revision INTEGER NOT NULL, evaluated_at BIGINT NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_responder_rooms (evidence_id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, conversation_key TEXT NOT NULL, kind TEXT NOT NULL, ordinal BIGINT NOT NULL, reported_status TEXT, UNIQUE(incident_id, ordinal))`,
  `CREATE TABLE IF NOT EXISTS sre_responder_people (evidence_id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, conversation_key TEXT NOT NULL, author_key TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_incident_audiences (incident_id TEXT PRIMARY KEY, service_key TEXT NOT NULL, tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_coordination (incident_id TEXT PRIMARY KEY, last_hash TEXT, published_at BIGINT NOT NULL, generation INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_coordination_items (evidence_id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, conversation_key TEXT NOT NULL, kind TEXT NOT NULL, item_key TEXT NOT NULL, item_state TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_coordination_receipts (incident_id TEXT NOT NULL, generation INTEGER NOT NULL, conversation_key TEXT NOT NULL, outbox_id TEXT NOT NULL UNIQUE, created_at BIGINT NOT NULL, acknowledged_by TEXT, acknowledged_at BIGINT, PRIMARY KEY(incident_id,generation,conversation_key))`,
  `CREATE TABLE IF NOT EXISTS sre_directory_snapshots (id TEXT PRIMARY KEY, service_key TEXT NOT NULL, source TEXT NOT NULL, observed_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_fix_plans (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, context_hash TEXT NOT NULL, revision INTEGER NOT NULL, markdown TEXT NOT NULL, payload TEXT NOT NULL, created_at BIGINT NOT NULL, UNIQUE(incident_id,context_hash))`,
  `CREATE TABLE IF NOT EXISTS sre_fix_requests (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, incident_id TEXT NOT NULL, conversation_key TEXT NOT NULL, requested_by TEXT NOT NULL, nonce_hash TEXT NOT NULL, expires_at BIGINT NOT NULL, status TEXT NOT NULL, approved_by TEXT, created_at BIGINT NOT NULL, result TEXT, error TEXT, lease_owner TEXT, lease_until BIGINT)`,
  `CREATE TABLE IF NOT EXISTS sre_fix_events (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, status TEXT NOT NULL, at BIGINT NOT NULL, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_change_events (id TEXT PRIMARY KEY, service_key TEXT NOT NULL, provider TEXT NOT NULL, change_number TEXT, head_sha TEXT NOT NULL, stage TEXT NOT NULL, observed_at BIGINT NOT NULL, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_incident_change_links (incident_id TEXT NOT NULL, provider TEXT NOT NULL, change_number TEXT NOT NULL, linked_at BIGINT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY(incident_id,provider,change_number))`,
  `CREATE TABLE IF NOT EXISTS sre_alert_threads (event_id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, conversation_key TEXT NOT NULL, provider TEXT NOT NULL, alert_id TEXT NOT NULL, created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sre_log_samples (id TEXT PRIMARY KEY, service_key TEXT NOT NULL, rule_key TEXT NOT NULL, scope_key TEXT NOT NULL, observed_at BIGINT NOT NULL, payload TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sre_jobs_ready ON sre_jobs(status, next_at)`,
  `CREATE INDEX IF NOT EXISTS sre_jobs_incident_status ON sre_jobs(incident_id, status)`,
  `CREATE INDEX IF NOT EXISTS sre_assessment_review ON sre_assessments(incident_id, revision)`,
  `CREATE INDEX IF NOT EXISTS sre_job_retries_incident ON sre_job_retries(incident_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS sre_events_scope ON sre_events(service_key, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS sre_evidence_source_window ON sre_evidence(incident_id,source,kind,observed_at DESC,id DESC)`,
  `CREATE INDEX IF NOT EXISTS sre_evidence_incident ON sre_evidence(incident_id, observed_at)`,
  `CREATE INDEX IF NOT EXISTS sre_outbox_ready ON sre_outbox(status, next_at)`,
  `CREATE INDEX IF NOT EXISTS sre_outbox_attention ON sre_outbox(status,created_at DESC,id DESC)`,
  `CREATE INDEX IF NOT EXISTS sre_rollbacks_status ON sre_rollbacks(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS sre_responder_room_scope ON sre_responder_rooms(incident_id, conversation_key)`,
  `CREATE INDEX IF NOT EXISTS sre_responder_people_scope ON sre_responder_people(incident_id,conversation_key,author_key)`,
  `CREATE INDEX IF NOT EXISTS sre_coordination_item_scope ON sre_coordination_items(incident_id,conversation_key,kind,item_key)`,
  `CREATE INDEX IF NOT EXISTS sre_directory_scope ON sre_directory_snapshots(service_key,observed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS sre_fix_plan_scope ON sre_fix_plans(incident_id,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS sre_fix_request_status ON sre_fix_requests(status,created_at)`,
  `CREATE INDEX IF NOT EXISTS sre_change_scope ON sre_change_events(service_key,observed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS sre_log_monitor_scope ON sre_log_samples(service_key,rule_key,scope_key,observed_at DESC)`,
];
