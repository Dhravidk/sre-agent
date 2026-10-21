# Real model investigation under sustained group bursts

Run this explicitly with the approved/authenticated Claude installation:

```sh
pnpm sre:groups:eval --live
```

This consumes actual Claude usage through the restricted CLI, `IncidentWorker`, the single-investigator lease and durable SQLite jobs. Inputs use authored Dynatrace, GitLab, Jira/Confluence and deployment contracts. Group events enter the admitted-room/store boundary directly. There is no Teams network/authentication exercise, HTTP capacity measurement, live vendor query, outbound sender or deployment writer in this workload.

## Explicit local Codex alternative

When Claude's account is capped, the developer can explicitly select the official Codex CLI using its existing ChatGPT login:

```sh
pnpm sre:groups:eval --live --provider codex
```

`SRE_CODEX_BIN` can identify the installed executable. This is a local development evaluation, not a production subscription-backed inference service. OpenAI documents [non-interactive CLI use with saved authentication](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation). No OAuth credentials are extracted, copied or sent through an unofficial API. The adapter rejects API-key logins rather than silently using API billing. Subscription availability and account limits still apply; this does not promise an enforcement outcome.

The evaluation-only adapter requires the verified CLI `0.163.0-alpha.10.2` and requests `gpt-6.1-sol` with medium effort. The requested model and CLI version are retained; they are not a separate attestation of server-side model identity. It ignores user/project execution rules and user configuration, disables hooks, apps, plugins, browser/search, shell and agent delegation, forces Code Mode and disables its execution host. On this build the remaining `exec`/`wait` wrappers fail closed. The adapter requires the native disabled-host diagnostic before accepting a result, rejects unexpected tool events, bounds stdout/stderr/time, and kills its owned process group on cancellation. Unsupported CLI versions fail before inference. This version-specific boundary must be reverified before upgrading it; read-only sandboxing alone is insufficient.

The same bounded stdin snapshot, evidence/source validation and publication fences apply. Production configuration continues to select Claude. There is no automatic provider fallback. Reports label actual Codex, actual Claude and test-double reasoning separately. A Codex result does not complete a pending Claude acceptance check.

## Workload

Ten incidents are open before inference, spanning eight source/service scopes and 32 distinct admitted group conversations. Two independently namespaced copies of the [five incident decision classes](DYNATRACE-MULTI-INCIDENT-EVALUATION.md#decisions-being-tested) have different source paths, projects and immutable SHAs. This tests concurrent load and source isolation; it adds no novel defect classes. Two operations share each identity service population but retain separate incident audiences.

Workload version 2 supplies an explicitly authored independent provider-health probe alongside the dependency case's caller logs. The probe is regenerated as synthetic data at collection time; it is not a live measurement. The incomplete catalog case has no such supporting probe. The earlier workload lacked independent provider health: a model's decision to collect that missing evidence instead of selecting dependency mitigation is a conservative taxonomy mismatch with its original strict oracle, not evidence that a binary rollback is appropriate. Earlier inputs, outputs and mismatches are retained separately; the expected verdicts are not silently broadened.

Version 3 additionally pins the provider and actual-model/test-double classification in `fixture.json`, so a resumed directory cannot silently switch providers or turn synthetic results into claimed model results. Its incident evidence is the version-2 contract.

At the default 30,000-record service ceiling, the eight service populations supply 238,886 record entries. Old-release counterevidence, INFO business failures, benign severe stacks, malformed content, duplicated/out-of-order logs, incomplete windows and conflicting archived documents remain present. Expected file/line/remediation labels stay outside model inputs.

The first twelve model invocations each receive three bursts at approximately one, ten and twenty seconds after model start. Each burst adds 64 repeated updates from one hot group and one rotating quieter-group update. One question per group is spread over the bursts. Defaults produce:

- 36 bursts over multiple actual model turns, rather than one preloaded intake.
- 2,304 hot-group updates, 36 quieter-group updates and 32 scoped questions: 2,372 accepted messages.
- 68 replayed deliveries that must be deduplicated.
- A competing database connection attempting a claim during every burst; the active investigator lease must exclude it.

The producer is paced by actual model turns, not a fixed network arrival rate. Record ingestion latency and the actual producer duration from `report.json`; these do not establish sustained HTTP/Teams throughput. A question being processed into a published assessment also does not establish that a human received a message.

## Fairness and persistence checks

Incident scheduling retains the existing durable last-served order. For questions within an incident, SQL now ranks eligible jobs within each conversation before returning at most 128 sibling candidates. Durable incident/room service checkpoints put previously unserved groups ahead of recently served groups when filling the eight-request model batch. Original events/jobs and child-to-parent batch links remain in SQL. The parent request consumes a slot; a busy group can still appear in a batch without hiding all quieter groups.

After the incident last-served priority, explicit eligible questions take precedence over update-only work. A model question turn also absorbs eligible non-question jobs from its incident, retaining their original evidence and scoped reply obligations. This avoids a separate routine-update inference ahead of an already waiting question. Deferred jobs retain their deadlines; the revision and lease fences still govern publication. Rule-mode question scheduling retains its separate behavior.

The batching query respects each job's retry deadline and excludes already batched parents. A failed/reclaimed parent retains its exact original request batch. Checkpoints are scheduling metadata; they grant no room, incident, source or action authority. SQLite and PostgreSQL SQL regressions exercise 160 older hot-group questions ahead of 31 quiet groups, continued hot arrivals and deferred retry jobs. SQL may scan more rows than its returned candidate limit; production query cost is a separate acceptance check.

During the actual-model workload the scorer verifies:

- A first pass across all ten incidents before a repeated hot-incident turn.
- A quieter incident publishing an assessment while the burst producer is still active.
- A diverse first hot-incident question batch and exact request-to-audience scope.
- All 32 original questions covered by published assessment jobs, not only marked as superseded children.
- Expected immutable file/line, deployment attribution, remediation and delivered-citation checks for each validated model response; final assessments must also be current.
- A controlled restart after a question batch has been claimed, preserving incident revisions/analyses, job payloads/statuses and room scheduling checkpoints exactly.
- A drained final queue, no deployment records and no external delivery. Locally queued model message requests remain pending; they are neither sent nor counted as successful delivery.

Incoming reports can legitimately invalidate an in-flight assessment. The revision fence must suppress publication and retain necessary questions for a fresh turn. The workload records this behavior instead of treating a stale draft as current or disabling the fence to improve latency.

Query manifests have a separate bounded 8 KB reservation inside the unchanged 160 KB total snapshot limit. Raw-page identifiers are omitted from their model projection, with explicit omitted-ID counts; the original manifest and pages remain in SQL. This keeps query coverage and supplied auxiliary observations available when grouped samples fill their telemetry budget. A projection is not a new independent measurement, and incomplete query/retention flags remain intact. The 30,000-record dependency regression reproduced a missing manifest that the earlier 6,000-record check did not expose. Any remaining omitted metadata is counted in snapshot coverage.

## Artifacts and resume

Private timestamped directories under `.local/group-burst-development/` contain pinned `fixture.json`, `state.sqlite`, every bounded `attempts/*-input.json`, each validated result, model/burst/restart `events.jsonl`, per-case Markdown issue/recovery drafts and `report.json`. Failed attempts remain visible. The report includes per-group question coverage, per-attempt judgments, local intake latency and actual burst duration.

```sh
pnpm sre:groups:eval --live --seed 91574
pnpm sre:groups:eval --live --records 10000
pnpm sre:groups:eval --live --directory .local/YOUR-EXISTING-GROUP-EVALUATION
```

An existing version-3 directory reuses its pinned parameters and durable jobs; supply the same `--provider` when resuming. Earlier workload directories are rejected instead of silently changing their evidence contract; preserve them and use a fresh directory. A completed run should reopen without another model call. Tests in `sre-group-burst.test.mjs` use a labelled test double for harness/queue checks; they do not measure model accuracy. An explicit live command is required for actual-model results.

Use a fresh directory after changing investigation or context-projection code when comparing quality. Earlier failed judgments remain part of a resumed report; a later correct answer does not erase them. Source hashes alongside development runs identify the tested runtime.

## Provider quota holds

A native account usage-cap response now creates a durable hold for the configured investigator account across all incidents in that database. The failed invocation's exact question batch remains pending, without consuming its ordinary failure budget. New messages still enter transactional ingestion and deduplication. Subsequent claims, including after restart, make no model call while the hold is active. A stale worker cannot install a hold after losing its lease. This is backpressure on an exhausted provider, not evidence of incident recovery.

The console shows the pause and a **Resume investigations** form. After checking the account, an authenticated local/API operator supplies a reason and resumes the exact displayed hold. A newer hold requires a new review; retries of an identical resume are idempotent. Teams responder text cannot resume the account queue. The same operator boundary protects `GET /api/agent/quota` and `POST /api/agent/quota/resume` (body: `holdId`, `reason`). Status snapshots expose the current hold.

Claude reset labels such as `7pm (America/Detroit)` are retained as operator guidance. They contain no date and do not establish an absolute retry deadline. Unknown deadlines require operator resume; a future provider contract supplying an exact absolute deadline can release its hold at that deadline. No arbitrary sleep or blind replay is substituted for an unknown reset.

This workload is controlled development evidence. Live Grail semantics and permissions, GitLab access, general diagnosis quality, fixed-rate capacity, provider usage limits, host failover and production recovery remain in [the integration checklist](ALLY-INTEGRATION-CHECKLIST.md).

## Observed development checks — October 21, 2026

After the fairness, provider-hold, explicit Codex-evaluation and large-log metadata changes, `pnpm test` passed **1,411 tests**, with no failures or skips. Source hashes for the 227 runtime, console, script, fixture, test and package files were unchanged between the captured verification checkpoint and completion. These are local regressions, including PGlite SQL; they do not establish enterprise PostgreSQL or vendor acceptance.

The quota fix was also exercised against the actual authenticated Claude CLI: one native invocation received the account usage cap and retained the provider's `7pm America/Detroit` label. Repeated claims across three queued incidents, followed by database reopen and worker replacement, made no additional model call. All jobs remained pending with their ordinary failure budgets intact. Operator resume and its console/API race and authorization checks were verified locally; the capped account was not automatically resumed.

The earlier actual-Claude sustained run admitted all 2,372 messages and 68 replayed deliveries, but did **not** finish question processing. It recorded one CLI output-byte-budget failure, a conservative dependency taxonomy mismatch under missing independent provider health, and repeated account usage rejections. That incomplete run is retained; the newer evidence contract, queue changes and Codex alternative do not turn it into a Claude pass. A separate real Codex smoke investigation correctly bound the supplied source location and supported rollback candidate before the larger workload was started.

An initial Codex burst run then exposed the large-log manifest omission described above: its dependency answer correctly requested the independent health evidence that the host had omitted. That run was stopped and retained. After the metadata reservation fix, a fresh real Codex dependency investigation delivered the probe, selected dependency mitigation and returned no causal code finding or rollback target. The correction preserves the strict expected labels rather than treating absent evidence as established health.

The fresh sustained Codex run completed **22 actual investigation turns** over 238,886 authored record entries, ten incidents, eight source/service scopes and 32 admitted groups. All 36 bursts completed: 2,372 messages retained, 68 replayed deliveries deduplicated and all 32 questions covered by published assessments. All 2,382 jobs ended done/superseded. First-pass incident fairness, bounded diverse question batches, peer exclusion, controlled database restart and drained-run resume passed. Resume made zero new model calls and preserved the checked incident, job and room-scheduling state.

Every validated turn passed exact source path/SHA/line, deployment candidate, rollback target, delivered citation and snapshot-bound checks. The **strict quality result remains incomplete**: one dependency follow-up selected `collect-evidence` rather than the expected `dependency-mitigation`. It still identified the dependency as the recovery focus, cited the delivered probe and supplied no causal application finding or rollback target, while requesting probe topology and a healthy mitigation target. The mismatch is retained; earlier and other dependency turns selected dependency mitigation. This is a remaining consistency/semantic acceptance question, not a silently widened oracle or permission to invent a mitigation.

Local authorization/store ingestion p95 was **0.56 ms**, maximum **6.43 ms**, during a **13.31-minute** burst producer. Question-to-assessment publication p95 and maximum were **24.92 minutes**. Model investigations remain serial; durable intake and fair scheduling do not establish fast replies or capacity under an indefinite flood. The outbox retained 25 pending messages across 17 groups. Question assessment coverage is separate from selected messaging, external delivery and human receipt. No sender or deployment writer was enabled.

The private checkpoint under `.local/group-burst-development/` contains `RESULTS.md`, `acceptance.json`, the source/test manifests and original incomplete runs. The completed run's directory contains the full report, per-case issue/recovery drafts, capacity summary and zero-call resume receipt. These are actual Codex results with authored vendor inputs, not a replacement for the pending real-Claude quality rerun or enterprise integration acceptance.
