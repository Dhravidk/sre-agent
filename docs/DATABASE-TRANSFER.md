# Offline database cutover

The application can run on SQLite or PostgreSQL through the same query/transaction contract. The transfer utility moves the current version's application tables between those adapters, retaining incident/session identities, people and conversation links, evidence, change history, Markdown tickets, completed QA artifacts, request audit and provider retry obligations.

It is a **bounded offline cutover**, not a live migration, schema upgrader or distributed dispatcher. It supports up to 200,000 application rows and 64 MiB per snapshot. Large production datasets need a separately tested bulk/streaming migration. PostgreSQL uses the default public schema. Unrelated application/public tables and non-empty destinations are refused. AWS/RDS, TLS/IAM, online change capture, production throughput and failover remain unverified.

## Procedure

1. Stop all source writers and delivery workers. Resolve any existing database restore hold. Keep independent external workflow/message records and preserve the source database. A source export is consistent within its database transaction; it cannot stop another old process from restarting after export.
2. Select the exact service/tenant/provider configuration and exactly one source database. Export into a new private regular file. Existing output files are never overwritten.
3. Initialize a dedicated empty destination and import the reviewed snapshot/digest. Import and recovery quarantine commit as one transaction. The destination starts **held**, with no old action automatically resumed.
4. Review independent provider, repository and Teams records. Old pending/running commands, approvals and delivery intents may have effects outside the snapshot. Follow [BACKUP-RESTORE.md](BACKUP-RESTORE.md) to release the hold with a local operator attestation. This is separate from application-health verification.
5. Import a fresh ownership/roster observation, collect fresh provider evidence and review fresh plans/approvals before continuing work. Start only the destination agents. Retain the source and export until the cutover is accepted.

The utility checks schema version, service/tenant/provider mappings, table/column sets, exact digest, row shapes and safe integer representations. Source data stays intact. The digest detects changes relative to the separately recorded export; it is not a signature or proof that an arbitrary file is trustworthy. Snapshots contain private incident history and approval/delivery records and must remain private.

## Commands

Set `SRE_CONFIG` explicitly and **exactly one** of `SRE_SQLITE_PATH` or `DATABASE_URL`. Do not leave an unrelated database selection in the environment. No default database is selected. Runtime HTTP, Teams and model credentials are unnecessary; this command starts none of those services.

For a stopped SQLite source:

```sh
SRE_CONFIG=/controlled/path/sre.json \
SRE_SQLITE_PATH=/controlled/path/source.sqlite \
  pnpm sre:database:transfer export --offline --file /controlled/private/sre-cutover.json
```

The receipt reports the SHA256, row count and table count without printing record contents. Use that digest independently when importing. Select the empty target `DATABASE_URL` through your private environment or secret store, unset `SRE_SQLITE_PATH`, then:

```sh
pnpm sre:database:transfer import --offline \
  --file /controlled/private/sre-cutover.json \
  --sha256 REVIEWED_64_HEX_DIGEST \
  --restore-id reviewed-cutover-1 \
  --reason "Reviewed offline database cutover"
```

Do not put database passwords in command arguments or this document. The same configuration/mappings must be selected on both sides. A changed mapping is a separate migration/access review, not an incidental database swap. Exact import retries return the existing receipt without copying rows again. A changed reason/content under an already used restore ID is rejected. A different non-empty target is preserved.

If a connection is lost around commit, inspect `pnpm sre:restore status` on the explicit destination and match its restore ID and digest. Do not clear the hold or overwrite the target to make a retry pass.

## Recovery behavior

- Completed QA, its patch, Markdown ticket, MR draft, branch/commit identity and test output remain historical evidence in SQL. The working directory is an optional artifact, not the only tracking record.
- Proposed, approved and running QA requests become `unknown` immediately, with a restore-linked audit event. A queued request cannot resume through an old nonce or an old "yes". Expired/late worker results cannot replace the quarantined state.
- Matching-log samples are a derived cache and are cleared. Raw source events and incident evidence remain. A new threshold requires fresh observations; silence never closes an old incident.
- Restored directory snapshots cannot select current owners. A new import must identify the current restore generation and contain observations at/after preparation. Reimporting old observations does not establish current ownership.
- Managed contact-message provenance and prepared send bodies remain historical SQL evidence. Contact-publication receipts reset, and no pre-restore uncertain delivery is replayed automatically.
- Delivery inspection history transfers intact but pre-restore handled reports cannot suppress current attention. Fresh inspection waits for restore reconciliation release.
- Teams prepared logical bodies, transport outcomes and late receipts/failures remain historical SQL evidence. Delivery leases reset with other runtime locks; neither transfer nor a late receipt authorizes replay or proves a human read a message.
- Change timelines identify the restored history gap. Old MR, CI or deployment rows do not establish current state, even after the operator releases the global hold.
- Provider retry deadlines remain absolute obligations. Follow the existing retry-facts recovery procedure for obligations missing from independent records.

## Verified scope

SQLite ↔ PostgreSQL/PGlite tests cover the full tracking graph, import rollback, digest/mapping rejection, non-empty/unrelated database preservation, idempotent retry and private CLI export. Restore tests exercise QA, directories and log counters on both SQL adapters.

The native exercise also uses a real local PostgreSQL 17.11 server with SCRAM-authenticated loopback TCP and separate administration processes:

```sh
pnpm sre:database:exercise --bin /absolute/path/to/postgresql/bin
```

It accepts a binary directory, never an existing database URL, and creates only owned databases. It executes trusted auction code, reproduces the original bug, verifies the four corrected business checks and then transfers the resulting tracking graph SQLite → PostgreSQL → SQLite. Incident/agent identities, three group links, the exact Markdown ticket, patch, MR draft and completed QA JSON survive. Old approved QA remains unknown, provider waits survive, and the owned PostgreSQL server stops at completion. Reports and private snapshots stay under `.local/database-transfer-runs/`.

Provider, Teams and MR inputs in that exercise are fictional. It creates no real ticket, repository request, deployment, model session or AWS resource. The cached local PostgreSQL build has no TLS support; the loopback result does not establish an RDS deployment.


Relationship-correction controls are retained domain history, not a polling cache. Restore preparation preserves their SQL checkpoints and audit. A known withdrawal continues to suppress automatic rediscovery; restored positive operational associations remain historical until a fresh observation and explicit reaffirmation. Native cutover now separately verifies the same withdrawal reference survives both adapters. Missing post-backup corrections remain unknown and must be reconciled. See [CASEWORK.md](CASEWORK.md) for the participant/operator workflow.
