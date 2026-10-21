# Local process soak

`pnpm sre:soak <minutes> <crash-every-cycles>` runs the actual HTTP service, SQLite database, scheduler, and separate OS child processes against synthetic provider methods. It uses the existing credit-timeout Git fixture and measured auction traffic. Rollback execution and external delivery stay disabled. No vendor credentials or model calls are used.

```sh
pnpm sre:soak 1 1     # at least one minute, crash during every cycle
pnpm sre:soak 360 6   # at least six hours, crash in the first and every sixth following cycle
```

The run finishes the current cycle after the requested duration. Ctrl-C asks the supervisor to stop its owned child and retain an interrupted report. Do not start a replacement merely because a terminal read times out; inspect the existing process and its report first.

## What a cycle proves

1. Actual auction calls fail under the known credit-timeout policy. The first synthetic issue is an hour old, exercising startup active inventory rather than only the recent-change window.
2. The investigator correlates synthetic Dynatrace/ServiceNow evidence and the fixture deployment diff. Its rollback result remains ineligible because execution is disabled.
3. On designated cycles, a question is persisted and observed running before the supervisor sends SIGKILL to that child. The supervisor confirms exit, starts a new process on the same database, and waits for that exact job to complete with the same local incident/session identity.
4. A synthetic Dynatrace authorization error becomes visible in Agent health while independent ServiceNow polling continues.
5. The harness restores the healthy auction policy, measures successful calls and business invariants, publishes signed synthetic release metadata, and explicitly closes both source records. A separately signed exact-deployment health proof must resolve the issue. The agent must return to healthy operational status with no rollback records.

Cycles use real wall-clock scheduler waits. The fixture shortens worker leases to five seconds, polls to ten seconds, and active reconciliation to thirty seconds. It retains a twenty-record synthetic deployment window. The session check concerns durable local identity and work reclamation; it does not validate live Eve persistence or reasoning quality.

## Evidence and source isolation

Each run writes `report.json`, child output, private fixture state, SQLite state, and a `runtime/` source snapshot under `.local/soak-runs/<timestamp>-<run>/`. Source fingerprints identify the frozen runtime. Installed dependencies remain shared at the recorded lockfile versions; the harness does not create a separate dependency installation. Later source edits do not alter the running child snapshot. Reports identify that source version, so a running soak cannot establish correctness of later edits.

The supervisor samples child RSS/heap every ten seconds and fails if sampled RSS exceeds one GiB. Sampling is evidence of observed memory use under this bounded workload, not proof of leak freedom or a production memory budget. Reports preserve process IDs, actual exits, job/session identity, cycle durations, measurements, failures, and last observation time. `status: running` is incomplete evidence; verify the retained process handle or owned PID as well. Only an exited successful run with `status: passed` counts as a completed soak.

Smoke runs passed on October 19–20, 2026 (America/Detroit):

| Local run | Elapsed | Recovery cycles | Deliberate crashes | Sampled maximum child RSS |
| --- | --- | --- | --- | --- |
| `2026-10-20T03-52-07.552Z-f151435f` | 65 seconds | 2 | 2 | 157.3 MiB |
| `2026-10-20T03-54-52.778Z-96ef6f2d` | 65 seconds | 2 | 2 | 151.3 MiB |
| `2026-10-20T04-09-23.349Z-60e0e653` | 65 seconds | 2 | 2 | 151.2 MiB |
| `2026-10-20T05-28-25.191Z-82f6d3cc` | 65 seconds | 2 | 2 | 157.9 MiB |
| `2026-10-20T05-45-28.883Z-1e43fc31` | 65 seconds | 2 | 2 | 158.8 MiB |
| `2026-10-20T06-19-49.272Z-925e4efb` | 66 seconds | 2 | 2 | 141.0 MiB |

The second smoke used frozen source fingerprint `6245f03567c4dbf7498b2a5b6caa1f3cde1490e8e13946c4a0a2d779c14b181e`. Its six-hour run `2026-10-20T03-57-35.500Z-836ecbfb` completed successfully after 21612 seconds, 536 recovery cycles and 90 deliberate SIGKILLs. Supervisor exit was zero; all 91 recorded children exited, and no owned frozen-runtime process remained. Peak sampled child RSS was 208814080 bytes. Frequent restarts do not establish six-hour memory stability of one process, and this earlier source excludes subsequent changes.

The third smoke covers the later per-ticket ServiceNow state changes, frozen fingerprint `1559aef75fa02d84f1fe1b5df38c1568f51519133003b6f3d03be74a323164ab`. Its supervisor and final child both exited successfully. It does not replace the earlier version's multi-hour test.

The fourth smoke covers the bounded evidence projection, immutable source readers and parsed policy attribution, fingerprint `e71bc8b426867c9b8f7b628ce1dce35b763c770705915df8930311d354d59e63`. Two running questions survived deliberate SIGKILL/restarts in the same stored sessions, both incident cycles recovered only after exact independent proof, and the final child/supervisor exited successfully. Provider source bytes in this version come from the allowlisted local Git revisions. This short run does not establish multi-hour uptime for the new revision.

A separate six-hour run of the fourth smoke's revision, `2026-10-20T05-30-27.494Z-77259b89`, has now passed after 21610 seconds, 536 recovery cycles and 90 deliberate SIGKILLs. Its source fingerprint is `e71bc8b426867c9b8f7b628ce1dce35b763c770705915df8930311d354d59e63`. Supervisor exit was zero, all 91 children have terminal exits and no owned frozen-runtime process remains. Peak sampled child RSS was 207454208 bytes. This earlier parsed-policy source excludes the later PostgreSQL/fencing/dispatch and recovery changes; frequent restarts do not prove six-hour memory stability of one process. Keep at most two long runs active unless a new test need justifies another.

Provider identities, authorization failures, deployment execution, and verification signatures in this harness are fixtures. Successful cycles do not establish live GitHub/Dynatrace/ServiceNow/Teams access, a real deployment rollback, multi-process PostgreSQL behavior, model accuracy, or production recovery.

The fifth smoke covers the later investigator lease/session fencing and connection-adapter source revision, fingerprint `5c0c0999d786bd36ba091417ad8f9854cdf715b99b30f59ce27fdd6167628205`. It passed two recovery cycles and two running-job SIGKILL/restarts, with the final child and supervisor exiting successfully. This harness uses SQLite; the separate [fifteen-case native PostgreSQL exercise](POSTGRES-EXERCISE.md) supplies the actual PostgreSQL/network evidence. Both existing long runs use earlier frozen source and remain separate from these changes.

The sixth smoke covers dispatch contract version 3 and no-change verification routing, fingerprint `a6b72591326c42202b863f4f1d7af8fb4563be66afc636db1dc870c89d83cfb8`. Two recovery cycles and two running-job SIGKILL/restarts passed; the final child and supervisor exited cleanly. Rollback execution remains disabled in this soak. The separate ten-case process exercise tests real local expiry/reapproval and artifact replacement. Both earlier long runs exclude these later changes.

A later access-check revision run `2026-10-20T09-59-13.983Z-08fefadb` failed after 41 seconds with no completed cycle. The supervisor still awaited shared `poll_error`, while the runtime now immediately reports an own-instance `instance_poll_error` and preserves a peer's fresh shared data. Private SQLite inspection retained the actual HTTP 401 and independently progressing ServiceNow cursor. The supervisor now requires that instance condition plus the same poller's 401 timestamp; it retains the independent progress and signed recovery checks. The corrected one-minute smoke `2026-10-20T10-02-43.356Z-031afcef` passed two cycles and two running-job SIGKILL/recoveries in 65 seconds. The failed report remains retained; runtime behavior was not weakened to satisfy the old predicate.

The later durable-retry run `2026-10-20T10-15-54.977Z-5a0ea04d` ended with failure after 7919 wall-clock seconds, 162 complete recovery cycles and 28 deliberate crashes. Cycle 163 timed out waiting for its exact reclaimed question after restart. The report records the final child's clean exit. There are substantial timestamp gaps around that attempt; their cause is not established, and the run does not count as a six-hour pass. The report/source remain preserved. No replacement was launched while that failure awaited investigation and the requested Claude CLI migration took priority.

The October 20 follow-up established the missing cause for that specific interval: macOS power logs record Maintenance Sleep from 08:11:50 to 08:27:52 America/Detroit, approximately 962 seconds. Read-only inspection of the retained SQLite file shows the exact question completed at 12:27:54.537 UTC, on attempt two, with its original agent identity. The supervisor's 30-second deadline expired while observation was suspended. This is not evidence of a lost job, nor does it establish availability while the host was asleep. The original failed report remains unchanged.

The supervisor now records long observation gaps both between probes and during an in-flight probe, gives resumed recovery one bounded observation window, and classifies the run as interrupted after verifying its current cycle. Repeated interruptions and genuinely stuck work still fail. Production worker leases, approval expiry and health-proof deadlines are unchanged. `pnpm sre:restart:exercise` deliberately SIGKILLs a worker, restarts it, then SIGSTOPs both the replacement and observer for 32 seconds. The retained corrected exercise `2026-10-20T16-24-25.766Z-3dc2c4f8` passed: the exact question completed on attempt two with the same identity, and the underlying soak was correctly interrupted. An earlier controlled reproduction `2026-10-20T16-23-17.396Z-0a772a65` exposed the additional in-flight-probe gap and remains retained. A host that can sleep cannot serve as an always-on deployment; an awake host and separate uninterrupted soak are still required.
