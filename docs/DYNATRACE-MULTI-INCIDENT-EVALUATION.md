# Messy logs across concurrent incidents

This evaluation runs the actual restricted Claude CLI through `IncidentWorker`, SQL ingestion, the single-investigator lease, progress checkpoints, assessment publication and restart. Vendor evidence readers are authored fixtures. It does not query a live Dynatrace tenant or GitLab server, send messages, execute repository code or dispatch a deployment. The distinction matters: model reasoning is real; the incident populations and provider contracts are controlled inputs.

## Run it

Use the existing approved/authenticated Claude installation:

```sh
pnpm sre:dynatrace:multi:eval --live
```

The default seed is 73421 with a ceiling of 30,000 records per service population. Five incidents in four service scopes are ingested before the first inference, including two overlapping identity incidents reading the same population. The actual default population has 119,443 records, reused for scoped reads; repeated collection is not additional independent source evidence. Most records are high-cardinality routine logs or expected validation failures. Useful observations are a small minority.

The workload includes:

- INFO business failures among noisy ERROR/WARN stack traces from instrumentation files.
- Reused trace/request IDs across regions, out-of-order records, canonical duplicates, missing timestamps, malformed JSON inside log content and long messages.
- Older-release counterevidence and multiple affected operations in one service population.
- Archived Confluence notes contradicting the current Jira/Confluence contract.
- Embedded instruction text in untrusted evidence, which grants no authority.
- A relevant legacy source file absent from the complete deployment diff.
- Partial query coverage and a case with no sufficient immutable source evidence.

Case identifiers are opaque in model input. The expected file/line/recovery verdicts live in the fixture's separate `expected` objects and are used by the scorer, not sent as labels to Claude. These are authored examples, not a blind production accuracy benchmark. Human review is still needed for free-form claims and specifications.

## Decisions being tested

| Case | Supplied observations | Expected planning judgment |
| --- | --- | --- |
| `case-01` | A new bid-write amount defect; prior healthy artifact with matching compatibility | Identify the changed bid-state file/line and propose a read-only rollback candidate; discuss persisted-data repair separately |
| `case-02` | A session-lifetime defect introduced by the current source; schema/data rollback incompatible | Identify the session-window file/line and propose a forward fix |
| `case-03` | A tenant cache-key defect on both releases in an unchanged legacy file | Identify the legacy cache-key file/line; propose a forward fix without blaming the new deployment |
| `case-04` | Upstream credit failures on both releases; no implicated application defect | Propose dependency mitigation, with no candidate file or deployment |
| `case-05` | Incomplete catalog observations, symbolic release labels and insufficient source | Request discriminating evidence, with no invented file or rollback target |

Rollback targets in these inputs are fictional artifact/health/compatibility assertions. A correct planning choice is not operational approval or independent production verification. All service writers remain disabled. Model remediation, host execution eligibility, and incident resolution remain separate.

## Concurrent intake, fairness and restart

While the first Claude invocation is pending and has emitted progress, the harness ingests eight distinct questions for a different incident and replays each delivery once. The SQL inbox must retain eight questions, reject the eight duplicate deliveries and later process one bounded eight-question batch. A second independent store connection tries to claim work while the active lease is held and must be refused. The first pass must serve each incident before revisiting the question backlog.

After two successful worker turns the harness closes the worker/database, reopens the same SQLite file and checks exact incident analysis/revision and job identities/statuses before continuing. This is a controlled restart between turns, not proof of host crash or enterprise failover. Existing regression tests cover stale publication, lease expiry, cancellation and PostgreSQL SQL separately.

The queue remains durable and model concurrency stays one. Several incidents are active together; this does not promise parallel Claude execution or arbitrary low latency under sustained arrivals. Provider deadlines, usage limits, retries, source omissions and failed attempts remain visible.

## Collection changes exercised by the workload

At the 4,096-signature retention bound, severe routine logs cannot evict the last retained witness of a different operation/release stratum. Selection reserves operation diversity, then release/severity/region counterevidence, before filling the remaining 20-group budget by inspection priority. Counts and omissions still describe observed samples, not complete failures or rates. An adversarial or very diverse population can exceed these bounds.

When a source problem supplies a structured `operation` or `affectedOperation`, references for that operation receive priority over unrelated stacks. This is a collection hint, not a diagnosis or privilege. The existing service/project, safe-path, exact-SHA, denial, completeness and byte-budget checks still apply. A hint from a question or log instruction cannot grant new access.

Source collection retains its four-file/1,500-byte excerpt budget and can use up to two slots for safe stack-referenced files outside the complete changed-file inventory. The host reads those files through the same approved immutable reader. Successful reads are marked `changed:false`; they are not inserted into the changed-file diff. Failed or mismatched reads remain unknown. The model can identify an old defect without falsely calling it a new deployment regression.

## Artifacts and focused runs

Each timestamped private directory under `.local/multi-incident-development/` contains:

- `state.sqlite`: durable intake, evidence pages, jobs, checkpoints and assessments.
- `attempts/*-input.json`: the bounded evidence and requests actually delivered, without the scorer's expected labels.
- `attempts/*-result.json`: validated model output for each successful invocation.
- `events.jsonl`: intake, model timing, question-burst, peer-lease and restart events.
- `report.json`: per-incident file/line, deployment attribution, remediation, citation, scope, persistence and queue checks, plus every retained attempt.
- `case-*.md`: model recovery and issue-spec drafts.

For reproducibility or diagnosis:

```sh
pnpm sre:dynatrace:multi:eval --live --seed 73422
pnpm sre:dynatrace:multi:eval --live --records 10000
pnpm sre:dynatrace:multi:eval --live --case case-03
pnpm sre:dynatrace:multi:eval --live --directory .local/YOUR-EXISTING-EVALUATION
```

An existing directory preserves its pinned fixture parameters and database. A completed directory reopens without new model work. A focused single-case run does not satisfy the concurrent workload checks. `tests/sre-messy-incidents.test.mjs` checks collection, safe/denied reference reads, operation priority, shared-service evidence, queue fairness, duplicate handling, peer exclusion and restart with a clearly labelled synthetic reasoner. Only the explicit `--live` command measures actual Claude behavior.

Passing this workload does not complete the live acceptance in [the integration checklist](ALLY-INTEGRATION-CHECKLIST.md). Actual Grail schemas/queries, tenant credentials, GitLab permissions, source volume/cost, incident accuracy and production operating capacity remain separate checks. [The main investigation guide](DYNATRACE-INVESTIGATION.md) describes those boundaries.

## Observed development result, October 21, 2026

The default seed 73421 passed with the actual restricted Claude CLI: five initially open incidents, four service populations and 119,443 supplied record entries. Six model invocations produced the five expected file/attribution/remediation judgments and the subsequent eight-question batch. Eight replayed question deliveries were deduplicated, a competing store connection could not claim the active lease, and the first pass served all five incidents before the question backlog. A controlled restart retained five incidents and thirteen job identities/statuses. Reopening the completed directory required no further model invocation. No outbox delivery or rollback was created.

The full local suite passed 1,385 tests with no failures or skips. Additional collection-only checks retained the relevant logs and source for the three code-defect cases with seeds 73422, 80213 and 99731; these checks did not call Claude. Model snapshots in the real run ranged from 74,038 to 84,855 bytes. One model invocation ran at a time, taking about 53–122 seconds each; this is evidence for bounded intake and fair serial processing of this workload, not a sustained-throughput guarantee.

The assertions above concern controlled authored vendor evidence. They do not establish general diagnostic accuracy, live Dynatrace/GitLab acceptance, independent production recovery or approval of the generated issue specifications. Preserve and review each run's inputs, outputs and failures rather than treating this checkpoint as evidence for a later checkout.
