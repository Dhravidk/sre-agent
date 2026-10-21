# Networked PostgreSQL exercise

This exercise starts a fresh, owned PostgreSQL cluster on an ephemeral IPv4 loopback port and two separate Node processes using the production HTTP/store/worker/rollback code. It accepts a PostgreSQL binary directory, never a database URL, so it cannot truncate an existing service database. SCRAM is required on TCP, Unix sockets are disabled, and the generated cluster/password stay under the ignored private run directory.

~~~sh
pnpm sre:postgres-exercise --bin /absolute/path/to/postgresql/bin
~~~

SRE_TEST_PG_BIN is the equivalent environment setting. The command needs initdb and postgres, a non-root user, and an existing Node dependency installation. It creates retained reports, source fingerprints, process logs and database files under .local/postgres-runs/. It stops its owned peers and PostgreSQL server after success or failure. No vendor credentials, model calls or cloud resources are used.

On this development machine, PostgreSQL 17.11 was built under /Users/dk/.cache/sre-agent-postgres/17.11/install from the [official release archive](https://www.postgresql.org/ftp/source/v17.11/). Its published SHA256 was verified before extraction:

~~~text
dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979
~~~

The build used two compiler jobs, a private install prefix, and --without-readline/--without-icu following the [PostgreSQL build procedure](https://www.postgresql.org/docs/17/install-make.html). No system installation or service was created. This local build has no TLS/OpenSSL support. Build metadata and configure/compile/install logs remain in .local/development/.

## Cases and corrected behavior

The current twenty-four-case exercise uses the isolated PostgreSQL 17.11 server:

| Case | Checked result |
| --- | --- |
| Simultaneous startup | Both Node processes initialize one empty database with every expected application table |
| TCP/authentication | Distinct peer backend connections exist; an incorrect password is rejected |
| Concurrent duplicate inbox | Twelve identical deliveries commit one event, incident, session and job; changed replay content is rejected |
| Correlated ticket updates | One ServiceNow closure cannot hide another open native ticket; the final closure enters verification |
| Peer notification ownership | A healthy peer cannot clear another runtime's loop fault; each local recovery matches its owner; concurrent observers emit one shared fault/recovery pair |
| Per-instance provider reads | A synthetic HTTP 401 stays visible on its instance while a peer succeeds; API badges agree, repeated failures preserve fresh shared data, own-read recovery is required, and concurrent successful cursors cannot regress |
| Fast application clock | A peer two minutes ahead cannot reclaim a real live investigator lease |
| Opposite application clocks | A slow peer claims a fast producer's due work; expired checkpoint/heartbeat/result/failure callbacks cannot revive it; another peer reclaims and publishes once |
| Other coordination deadlines | Clock offsets cannot prematurely recover a live command, delivery or rollback; actual expiry resumes the command and quarantines uncertain writes |
| Cross-peer approval | Oppositely skewed proposer/approver clocks cannot change the approval/dispatch deadlines recorded against database time |
| Lease competition | One investigator wins; expiry allows reclamation of the same job; the old result is rejected |
| Incident-row wait | Expiry while publication waits for a row lock rejects the result and notification |
| Remote checkpoint | A reclaimed job's former owner cannot replace the current model-session checkpoint |
| Late notification wait | Expiry during the last insert rolls back analysis, remote checkpoint, assessment, notification and job completion together |
| Operator retry race | Identical concurrent requests create one replacement and one recovery receipt |
| Rollback competition | Two approved-action executors submit one synthetic provider request |
| Concurrent no-change outcomes | Identical callbacks commit one result/notice, mark only the submitted request not_executed, preserve the open incident and make no second provider submission |
| Idle connection termination | The agent remains alive and reconnects on a health read |
| In-flight connection termination | An interrupted pre-commit inbox transaction leaves no partial writes, returns a retryable storage error and accepts identical redelivery once |
| Immediate server shutdown/restart | Both agents stay alive, HTTP health becomes retryable 503, WAL recovery preserves the committed incident/session, discards the open transaction, and allows unfinished work to be reclaimed |
| Agent SIGKILL | The second scheduled process reclaims running work, retains the local and synthetic remote session, and publishes one result |
| Shared provider retry | A synthetic 429 commits a ten-second hold; a peer with a two-minute fast application clock and a replacement process each invoke zero HTTP transports until the database deadline expires |
| Reviewed retry recovery/release | A table lock stalls the import after it owns the restore fence; concurrent release waits until deadline changes and receipt commit, then exact import replay remains idempotent |
| Successful GitHub quota | An accepted HTTP 200 with exhausted quota commits its reset; another peer and a replacement client make zero transport calls, defer with logical 429 while preserving provider status 200, and resume after the real database deadline despite application-clock skew |

The first real run exposed a PostgreSQL catalog collision despite CREATE IF NOT EXISTS. Schema creation now runs in one transaction under a database-local transaction advisory lock. A subsequent run proved stale publication after an incident-row lock wait, and a later notification-table wait exposed another expiry window. Publication now locks the investigator lease, checks the running job's lease, rechecks expiry after waits and before commit, and rolls back the complete result when invalid. Remote checkpoint callbacks receive the actual job identity; late failure reports cannot change expired jobs.

The database locking behavior follows PostgreSQL's [row and advisory lock contracts](https://www.postgresql.org/docs/17/explicit-locking.html). The real blocked transactions matter: the earlier embedded SQL tests did not exercise this multi-process behavior. A later clock fault reproduced premature reclamation by a fast peer; [shared coordination time](COORDINATION-TIME.md) explains its fix, upgrade behavior and remaining host-clock requirements.

Another failing run showed that terminating an idle backend crashed the Node agent through an unhandled pool error. The adapter now handles background disconnects with a generic credential-free log message. Checked-out transactions also handle connection loss, discard the broken client, and surface StorageError without replaying the transaction. A later query can reconnect. This follows the [node-postgres pool error contract](https://node-postgres.com/apis/pool#events); connection failures still reach the existing retryable HTTP storage path.

The immediate-shutdown case uses PostgreSQL's documented [SIGQUIT mode](https://www.postgresql.org/docs/17/server-shutdown.html), which stops without normal shutdown processing and requires WAL replay on restart. The exercise confirms fsync, synchronous_commit and full_page_writes are on, pauses an uncommitted inbox insert, and stops the owned server. Both Node PIDs remain alive. Health returns 503 with Retry-After: 5 during the outage, then 200 after a new postmaster starts on the same data directory. Its log must contain actual REDO start/completion records. The committed event and session checkpoint survive, the open transaction is absent, and the second peer completes the original running job on attempt two. The application incident remains open until its separate recovery requirements are satisfied. This tests database crash recovery on the same disk, not recovery from a backup or replica promotion.

Retained failed runs document each discovery. The latest successful report is recorded in .local/development/progress.json; earlier thirteen/fourteen/fifteen/seventeen-case reports are retained. Owned process lifecycles and intentional SIGKILL recovery remain in each report.

## Scope of this evidence

The [separate backup/restore exercise](BACKUP-RESTORE.md) uses actual pg_dump/pg_restore into another owned cluster and tests uncertain external effects. It is recorded independently from these twenty-four concurrency/crash cases. The retry cases use production client/store/administration code with synthetic provider records; they do not authenticate vendor evidence or allocate proactive quota. The import/release case observes real database waits through separate connections; its final receipt/deadline are committed before the hold can end.

The server, PostgreSQL transactions/locks, socket connections, password authentication, HTTP reads and Node process termination/recovery are real. Provider deployment reads/dispatch and approver identities are fixtures. Remote session IDs are synthetic state, not a live Eve session. The notification wait tests persistence, not live Teams delivery.

The scheduled crash case shortens worker leases to two seconds, and competition cases use one-second leases. Both processes share one host; several cases inject different application-clock values while the database/supervisor clocks remain unchanged. This is a bounded correctness exercise, not a multi-hour PostgreSQL soak, independently skewed OS-host test, production model evaluation, RDS/network/TLS/IAM validation, replica failover, power/storage-failure test or backup/restore proof. The SQLite long runs retain their own frozen source versions and do not cover these later changes.
