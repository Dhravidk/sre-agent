# Shared time for agent coordination

A two-process PostgreSQL test reproduced a peer with its application clock two minutes fast reclaiming a still-live investigator lease. The lease owner and result fences prevented the old owner from committing afterward, but they did not prevent premature duplicate investigation/model work.

PostgreSQL-backed runtimes now read coordination time from the server:

~~~sql
SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now
~~~

PostgreSQL documents that [clock_timestamp advances during a transaction](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT), while CURRENT_TIMESTAMP/now represent its start. Deadline checks therefore read the live clock again after row/table waits and before result commits. They use the same checked-out transaction connection where one is already held. Invalid or unavailable database time fails closed; there is no fallback to a peer's wall clock. SQLite retains the local runtime clock, including explicit virtual clocks used by its tests.

## Paths covered

| Path | Shared-clock behavior |
| --- | --- |
| Investigator | Claim/reclaim, heartbeat, result publication, failure recording and remote-session checkpoints check database deadlines. Expired attempts cannot renew or publish. |
| Queues | Inbox job/command times, retry schedules, assessment notifications and delivery retry times use database time. A fast producer cannot postpone a slow peer's due work. |
| Rollback | Proposal/approval timestamps, expiry, execution leases and interrupted-action recovery use database time. Default production connectors await that clock before authentication and again before deployment submission. |
| Commands | Completion/discard checks bind the current command lease. An expired acknowledgment transaction rolls back. An old callback cannot complete a replacement attempt or publish its response. Stable command/action IDs retain idempotency for already performed work. |
| Delivery | A fast peer cannot prematurely quarantine a live delivery; an expired delivery remains uncertain and is never automatically resent. |
| Evidence | Ingress time checks, proof freshness, timestamped webhook authentication, polling windows/cursors and collected-evidence timestamps use database time. Provider observation/deployment timestamps remain their original supplied values. |
| Operations | Queue age and expired-lease checks use database time. A clock_skew condition reports an application clock differing by more than 30 seconds. Comparing against the interval bracketing the database read avoids treating read latency alone as clock drift. |

The clock condition uses a fixed notice fingerprint, so continuing drift does not generate a notice every poll. Per-process loop timing and external SDK/model authentication still depend on a correctly synchronized host clock. Shared lease time is not permission to ignore that condition.

## Upgrade behavior

Coordination policy version 1 participates in rollback-policy and polling-scope hashes. Pending/approved proposals created without it require a fresh proposal and approval. Existing submitted/unknown actions retain their reconciliation requirements. An old future cursor/health claim is discarded and a new active-issue inventory runs; scope reset does not close an incident or erase its history.

Upgrade/drain every agent instance before relying on these guarantees. An older binary still using its own time can violate them. Existing unexpired leases are preserved rather than forcibly cleared on startup. This exercise does not establish a safe mixed-version deployment protocol.

## Evidence and limits

~~~sh
pnpm test
pnpm sre:postgres-exercise --bin /absolute/path/to/postgresql/bin
pnpm sre:process-exercise
~~~

The native PostgreSQL exercise runs separate Node processes with injected application-clock offsets of minus/plus two minutes; its supervisor and PostgreSQL keep real clocks. It checks early-reclaim rejection, due work across peers, expired heartbeat/checkpoint/result/failure rejection, command/delivery/rollback recovery, cross-peer approval timestamps and visible clock drift. Other cases retain actual lock waits, connection loss, immediate server shutdown/WAL replay and agent SIGKILL recovery.

Unit checks additionally exercise a live database clock advancing inside one transaction, malformed clock results, asynchronous connector-clock failure before submission, command expiry during acknowledgment, and stale command callbacks. Expiry-injection unit fixtures explicitly use virtual coordination clocks; they do not substitute for the native tests.

These are same-host fault injections, not tests on machines with independently skewed OS clocks. Database-clock jumps, mixed-version fleets, replica promotion, RDS/TLS/IAM, backup restore and live vendor/model behavior remain separate acceptance work. The two earlier long SQLite runs use frozen source and do not cover these changes. The protected deployment workflow still needs its own serialization, exact-current-artifact guard, idempotency and approval-expiry check before replacement.
