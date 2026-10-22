# Database restore and uncertain external effects

The native recovery drill reproduced a database-rollback hazard: a backup contained an approved workflow and a pending notice. After the backup, the workflow was submitted and the notice delivered. Restoring that snapshot without preparation repeated both operations. Database durability and inbox deduplication alone cannot preserve commits missing from a restored backup.

The recovery fence holds outbound work while an operator reconciles that missing interval. It is an explicit restore procedure, not automatic restore detection. A database cannot discover its own lost commits without independent state.

`initial-read-start:` and `initial-read-end:` checkpoints are preserved as descriptive observation history. An unfinished start has no proven accepted result; a completed read does not certify current provider visibility. Restore preparation still clears job ownership and holds external effects. A fresh read-only rules reconciliation may record evidence in the new held epoch, but an old job/read cannot use its historical receipt to resume or cross restore release. See [initial collection ownership](EVIDENCE-FOLLOWUP.md#initial-collection-ownership).

## Prepare an already restored database

1. Stop every old agent and revoke its write access. Prevent old processes from reaching either the providers or the new database. The fence cannot cancel an already running remote call or control an older binary.
2. Restore a trusted backup into an isolated target and retain an independent manifest identifying the archive, backup interval and source. Keep write credentials unavailable during preparation. The CLI below does not run a restore itself.
3. Explicitly select the restored DATABASE_URL or SRE_SQLITE_PATH and the correct SRE_CONFIG. No default database is accepted by this administration command. Use the actual archive and backup lower-bound timestamp from the recovery manifest:

~~~sh
pnpm sre:restore prepare --offline-restored-database \
  --archive /controlled/path/agent.pgdump \
  --restore-id YOUR-UNIQUE-RESTORE-ID \
  --backup-at ACTUAL-ISO-BACKUP-TIME \
  --reason "Describe the restored snapshot and missing interval"
pnpm sre:restore status
~~~

Preparation hashes the archive and atomically records a persistent fence and recovery history. The hash binds the operator's declared archive; it does not independently prove which archive was restored or authenticate its source. A repeated identical restore ID returns its receipt. Changed preparation under that ID, or a different restore while one is still active, is rejected. PostgreSQL preparation takes immediate exclusive table locks and fails if they cannot be acquired. This supports the offline requirement, but does not prove that every remote worker has stopped.

Preparation preserves the original rows and uncertainty:

| State from the snapshot | Recovery behavior |
| --- | --- |
| Pending/sending notifications | Become unknown. They may already have been delivered after the backup. |
| Pending/approved/checking/submitted rollbacks | Become unknown. Their proposal, original approval metadata and any saved receipt remain available. |
| Queued/running commands | Become discarded with a recovery reason. Identical old delivery IDs cannot execute those instructions again. |
| Running investigations | Return to pending, retaining job ID, attempt count and question. Old leases are cleared only as part of offline preparation. |
| Incident/session identity | Local agent IDs and audit remain. Stale external model-session cursors are cleared, because remote history may have advanced beyond the snapshot. |
| Prior analysis/resolution | Analysis is cleared, incidents require renewed verification, and an explicit missing-history record plus fresh read-only investigation are queued. |
| Poll/operations checkpoints | Reset so fresh source reads and active-issue inventories run. A lost post-backup event remains absent until redelivery or reimport. |
| Managed contact-message provenance and prepared send bodies | Retained as historical evidence. A prepared body is not proof of delivery. Positive contact-publication receipts reset; new notices require reconciliation and use the restore generation. |
| Teams prepared sends, outcomes and late transport observations | Retained as historical evidence. Late receipts do not automatically replace unknown state. Runtime delivery/conversation leases reset with other locks; stop old agents and reconcile the missing interval before release. |
| Model quota holds, scheduler policy and last queued model-notice fingerprints | Retained as host coordination/uncertainty evidence. They do not establish fresh source health, delivery or permission to lift the restore hold. New admission still respects the configured database-wide capacity and exact account hold. |
| Completed local rehearsal dataset metadata | The exact `rehearsal:multi-team:v1` checkpoint is retained as historical dataset identity. The launcher still validates its checksum, profile and existing incident/ticket identities. Reopening does not rerun setup or release the restore hold. Incomplete or absent rehearsal metadata prevents automatic seeding after any restore generation, including a released one. |
| Committed provider retry waits | Snapshot deadlines remain in sre_provider_retries. Later extensions and newly observed waits are lost with the missing interval and must not be inferred from the older snapshot. |

Start in rules mode for read-only investigation during reconciliation. Model work is held while the fence is active unless the runtime explicitly uses its rules-only recovery path. Deployment approvals/dispatch, Teams command processing, delivery and operational notices remain held. New read-only analysis notices are saved as held_restore; they will not be replayed when the hold ends. Signed no-change callbacks may reconcile a known workflow, but health verification cannot resolve an incident under the global hold. The console/operations API reports database_restore_hold. Restarting does not clear it.

The console now displays an explicit restore-hold notice. Saved replies, evidence, tracked history and Markdown downloads remain readable. Teams simulator controls, new plans, QA/change actions and manual retries are paused. Rules-only questions can still request a local review of restored evidence; model-mode questions explain that the investigator is held. Neither review establishes facts missing after the backup, current ownership, delivery or recovery. The console does not expose hold release.

Authenticated inbound Teams messages can still be saved while command processing is held. They retain their original sender, time and incident binding and may process after explicit release, with the existing authorization, nonce, expiry and current-evidence checks. Console receipts identify a request saved under the hold rather than suggesting normal processing has started. A new question/Teams receipt reads restore state within the same ingestion transaction; a failed state read rolls back that new request. These descriptions confer no authority and do not prove delivery or acknowledgement. An older in-flight response cannot clear a hold the browser has since observed; a new valid read must confirm release. Unsent drafts remain local to the open tab and are not submitted automatically.

The rehearsal launcher's `ready.json` and startup record explicitly report `recoveryHold` and the restore ID. Ready means that the console has opened its retained dataset. A hold still prevents outbound actions. Older restored copies whose dataset checkpoint was already deleted are not reconstructed automatically; use the generic rules-mode console with an explicit database/configuration for inspection, or recover reviewed matching dataset metadata from independent records. Do not reseed an existing restored history.

## Reconcile, then authorize release

Use independently retained provider/workflow, deployment, Teams, source-event and model records to identify the missing interval. Reimport missing facts where supported. Unknown requests still need the existing exact-request deployment/health or terminal no-change verification. A request whose original approval metadata was lost cannot pass the current signed workflow proof by guessing those fields; it remains blocked pending a reviewed reconstruction/reconciliation path.

Include provider retry obligations in that review before restarting affected reads. The outbound restore fence allows rules-mode source reads; it cannot reconstruct a missing quota hold. Keep affected readers disabled while reviewing the missing interval. A new response can extend an already observed deadline even while another request is in flight. The native drill captures a later extension and a new account bucket after backup, confirms both facts are missing from the restored snapshot, and now uses the actual administration CLI to import their independently retained synthetic records. An automatic/off-host provider journal and reconstruction of absent approval metadata remain unimplemented.

### Restore independently retained retry facts

With an explicit SRE_CONFIG, list the configured API/issuer buckets without opening a database or contacting providers:

~~~sh
pnpm sre:restore retry-scopes
~~~

The output gives serviceKey, connector, kind, scopeHash and enabled. It includes explicitly configured disabled sources so recovery can finish before they restart. It omits endpoint/account labels, client IDs and credentials. Confirm the original logical tenant, provider endpoint and account label against independent records. The hash binds the selected configuration; it does not authenticate a provider or prove credential ownership.

Prepare a reviewed JSON file using the original absolute provider deadline and observation time. Replace the timestamp strings below with actual integer epoch milliseconds and the other placeholders with reviewed values:

~~~json
{
  "restoreId": "CURRENT-RESTORE-ID",
  "requestId": "STABLE-PROVIDER-FACT-REQUEST",
  "reason": "Describe the independent records and scope review",
  "reviewedAt": "ACTUAL-REVIEW-EPOCH-MS",
  "evidenceUrls": ["https://YOUR-RECORD-SYSTEM/provider-evidence/ID"],
  "facts": [{
    "serviceKey": "CONFIGURED-SERVICE-KEY",
    "connector": "github",
    "kind": "api",
    "scopeHash": "EXACT-64-HEX-HASH-FROM-REVIEWED-MAPPING",
    "observedAt": "ORIGINAL-PROVIDER-OBSERVATION-EPOCH-MS",
    "until": "ORIGINAL-ABSOLUTE-RETRY-DEADLINE-EPOCH-MS",
    "status": 429
  }]
}
~~~

Select the restored database explicitly, then import:

~~~sh
pnpm sre:restore retry-facts --attestation /controlled/path/reviewed-provider-facts.json
~~~

The host account supplies the actor. The command requires the matching active restore, a review at/after preparation within ten minutes of database time, matching configured bucket hashes and HTTPS evidence links without URL user/password authentication. Keep secrets out of evidence links; they are retained for audit. API and OAuth issuer buckets are separate. Supply at most fifty unique buckets and ten links in a regular UTF-8 JSON file no larger than 256 KiB. Unknown fields, duplicate buckets and scope/time mismatches fail before changing waits. Consolidate evidence for a shared bucket using its longest confirmed obligation. Never turn an old duration into a new delay starting at recovery time.

Wait extensions and the recovery receipt commit in one transaction. A longer existing wait wins; expired facts remain audited without creating a fresh delay. If the original provider status was successful, a later deferred read still fails with logical status 429; the receipt retains the original status. Exact request retries return the original receipt, including after release, while the same restore generation/mapping remains selected. Changed content under that request ID is rejected. New facts after release require another explicit recovery procedure; the importer cannot lift the action hold, retry a workflow or resolve an incident. PostgreSQL release waits on the import-owned restore fence until both waits and receipt commit. A failed write rolls back the complete batch and receipt.

This is a local-operator attestation, with providerVerified false. Evidence URLs are recorded without being fetched or machine-verified. The command cannot discover facts missing from all independent records. Administration validates structural configuration using database/host authority and does not start HTTP, Teams or model services; their secrets are unnecessary here. Normal service startup/readiness continues to require its runtime credentials.

Release is available only through local administration, with the host-account identity recorded as a label. It is not exposed to the model, Teams, or a new HTTP endpoint. Prepare a reviewed JSON attestation with these fields:

~~~json
{
  "restoreId": "THE-CURRENT-RESTORE-ID",
  "requestId": "STABLE-RELEASE-REQUEST-ID",
  "reason": "Explain the external records reviewed and remaining uncertainty",
  "observedAt": 1792480000000,
  "evidenceUrls": ["https://YOUR-RECONCILIATION-SYSTEM/evidence/RESTORE-ID"]
}
~~~

The timestamp is illustrative; use an actual observation after preparation and within ten minutes. The CLI records the local account itself. It requires a matching restore ID, stable request, reason and HTTPS evidence links without embedded credentials. Link contents are not fetched or machine-verified.

~~~sh
pnpm sre:restore release --attestation /controlled/path/reviewed-release.json
~~~

This is a trusted operator's attestation authorizing the global hold to end. It is not provider evidence or application-health verification. Identical release retries are idempotent; a different release body is rejected. Release discards recovery-only held notices and leaves old unknown delivery/workflow rows unchanged. Those rows continue preventing blind retries. A new deployment requires a fresh eligible proposal and explicit authenticated approval. Newly delivered instructions received after preparation can run after release, subject to their normal scope and expiry checks.

Notification publication holds the recovery-fence row inside its transaction. Release waits for an in-flight held notice to commit and then discards it. A native blocked-transaction test reproduced the earlier race that left a held notice hidden after release and now checks this serialization explicitly.

## Casework and detection state

Restore preparation also quarantines proposed, approved and running QA requests as unknown, preserving their prior status and restore identity in the audit. Completed QA and its artifacts remain historical evidence. Old matching-log counters are cleared while the raw events/evidence stay intact. Directory snapshots need a fresh post-reconciliation import before they can recommend current owners. Change timelines explicitly retain the missing-history warning. These transitions are part of the same preparation transaction on SQLite and PostgreSQL.

An offline SQLite/PostgreSQL cutover uses this same hold and quarantine inside its import transaction. See [DATABASE-TRANSFER.md](DATABASE-TRANSFER.md) for commands, limits and actual native roundtrip evidence. An operator release does not resurrect an old QA approval or certify old ownership data.

## Reproduce the native drill

~~~sh
pnpm sre:backup-exercise --bin /absolute/path/to/postgresql/bin
pnpm test
~~~

The drill accepts a binary directory, never an existing database URL. It creates two owned clusters with separate ports, data directories and SCRAM credentials. Actual [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) produces a consistent single-database custom archive, and [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) loads it into the new cluster. It checks the archive digest, actual data loss after the snapshot, retained incident/agent/job identity, fresh investigation, persistent quarantine after agent restart, audited release, signed workflow reconciliation and a separately approved new request. All owned processes are stopped and evidence stays under .local/backup-runs/.

The seventh stage additionally verifies the saved provider wait, the missing later extension/new bucket, and the real retry-scopes/retry-facts CLI on a connected profile with disabled readers and absent HTTP/model secrets. The new bucket is learned from a successful GitHub HTTP 200 advertising exhausted quota; its original status/deadline survive import while subsequent reads defer with logical 429. A repeated import returns its durable receipt. Two restored agent processes each use the production HTTP client/store to honor both imported deadlines, making four blocked probes with zero provider transport calls. The independent fixture JSONL ledger, explicit profile and attestation are retained beside report.json. This proves the bounded administration path with synthetic facts; actual provider-record authenticity and production journal durability remain separate work.

Provider/Teams effects are independent local fixture logs; no real deployment, live message, tenant/model session or application recovery is established. This is a logical single-database backup test. Cluster roles/tablespaces, off-host storage, physical backup/WAL/PITR, RDS/TLS/IAM, retention and production restoration still require separate acceptance. The optional --unsafe-replay-probe is a counterfactual on freshly created fixture clusters and intentionally fails when it reproduces duplicate effects; it is not a recovery mode.


Relationship-correction controls are retained domain history, not a polling cache. Restore preparation preserves their SQL checkpoints and audit. A known withdrawal continues to suppress automatic rediscovery; restored positive operational associations remain historical until a fresh observation and explicit reaffirmation. Native cutover now separately verifies the same withdrawal reference survives both adapters. Missing post-backup corrections remain unknown and must be reconciled. See [CASEWORK.md](CASEWORK.md) for the participant/operator workflow.

Coordination attention coverage is retained alongside delivery audits during restore preparation. These checkpoints describe which delivery checks were already queued to each recipient, not acknowledgement or authority. Their parent messages remain retained; pending or sending parents become unknown under the existing restore policy. Releasing the hold does not resend those reminders. Exact original text and recipient bindings are checked before coverage is trusted.

Responder-chosen conversation aliases (`teams-room-label:`) survive restore preparation and offline adapter transfer. They describe the restored room identities and do not grant installation, incident sharing, acknowledgement or action authority. Current assessment labels are recomputed from the restored incident revision and matching audit body; historical replies keep their recorded times and content while restore reconciliation waits for a fresh review.

Operator question receipts (`operator-question-request:`) also survive preparation and adapter transfer. They bind the configured service, incident, client request ID, original time and immutable source/job records. Repeating a retained request confirms the original admission without refreshing evidence, creating work, reviving a failed job or releasing a hold. Missing or inconsistent retained receipt/source records fail closed. Receipts describe only facts present in the restored snapshot; requests accepted after that snapshot may be absent and require independent reconciliation. An admission receipt does not certify one reasoning invocation, a completed reply or any external action.

Recovery and terminal no-change verification now select deployment identities and conflict witnesses before replay-delivery caps, using the same ledger window as incident context inside the existing ingestion transaction. Missing versions, tied-current omissions and conflicting latest statuses remain uncertain; a retained SHA/artifact contradiction cannot be hidden by hundreds of later rereads. A proof rejected on that ledger leaves its inbox, action state and notification unchanged. Reopen and offline SQLite/PostgreSQL transfer retain the original deployment/source facts and restore hold. None of this reconciles a missing post-backup interval or releases the hold automatically; independent journals, exact request bindings and fresh authorization remain required.

Retained deployment metadata also preserves per-field conflict times. Reopen and SQLite/PostgreSQL transfer cannot turn same-time contradictory safety/configuration attestations into a selected safe value. A later status-only record does not resolve that conflict. Recovery and no-change proof rejection leaves event/action/notification changes rolled back together; restored source facts and the global hold remain separate from fresh operational reconciliation.

Reported log-scope labels are reconstructed from retained monitor identity/hash, incident binding and source observations after reopen or adapter transfer. They do not rewrite source events or create a new recovery checkpoint. A missing, invalid or omitted scope source stays unverified; different-scope errors remain dependency alternatives. Existing restore holds still pause outbound messages and actions while this history remains readable.


Local simulator Teams request receipts (`simulation-teams-request:*`) survive restore pruning alongside their source/command records. They preserve the original accepted, ignored or null-bound outcome; they do not authorize work or revive a discarded command. Held SQLite/PostgreSQL transfers and file reopen exercise that identity. Admissions missing from a backup still require independent reconciliation, and a browser reload loses its pending client request IDs.


The local console's saved-instruction status read remains available during a restore hold. It reports the original request and discarded-command reason alongside the current hold/binding; it cannot replay that command or release reconciliation. A missing request can mean an uncommitted admission or history absent from the backup, so a404 observation is not proof that an instruction never ran. The observer's in-tab pointer is lost on reload. The incident history reader can rediscover originally incident-bound retained commands by ID, including legacy commands, without reconstructing a raw retry body. Earlier unlinked/ignored messages remain excluded, and retained SQL records still require reconciliation against independent post-backup facts.
