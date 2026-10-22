# Dynatrace investigation latency follow-up

This continues [PR #2](https://github.com/Dhravidk/sre-agent/pull/2) after the [consolidation baseline](DYNATRACE-CONSOLIDATION.md). The development priority remains noisy Dynatrace evidence, immutable GitLab findings and supported recovery/specification proposals. Jira connector design and organizational permissions still require discussion before further implementation.

## Changes

- Share byte-identical question text once on model stdin while retaining every job, destination and request position. Apply the original count, character and serialized-byte checks before compression. Preserve SQL batches and retries exactly.
- Ask both reasoners for concise structured prose without truncating source quotes or omitting distinct counterevidence, unknowns or verification checks.
- Give the explicit Codex evaluation child the shared SRE instructions through the documented private instruction-file override and request low response verbosity. Retain `gpt-6.1-sol`, medium reasoning effort, the pinned CLI, disabled tools and all host validation. Pin the actual instructions hash and verbosity in each fresh evaluation directory.
- Allow an explicit database-wide capacity of up to eight leased investigators. Existing defaults remain one, or four in the development profile. Upper-slot leases participate in the same admission, expiry, quota and capacity-change fencing. Stop investigators before changing capacity. Higher concurrency increases simultaneous model/resource use and requires validation on the approved route.
- Extend the maximum settling window for a new stale request turn from one to two minutes, retaining five seconds of quiet intake. This avoids restarting a long model call too early during a continuing burst. Existing gate deadlines, ordinary retry eligibility, one-time fairness recovery, quiet-incident admission, quota/restore holds and current-revision/lease fences remain intact. The limit bounds another attempt; it cannot guarantee publication under endless input.
- Correct the reviewed numbered-source projection: a persisted restore fence with `active:false` no longer marks subsequent source reads historical. An active hold still does. Location verification remains separate from causality, current deployment and permission to act.

## Measurement contract

The comparison uses the existing surge profile: seed 91573, 30 authored incidents in 24 service scopes, 90 groups, explicitly selected SQL-coordinated investigator slots, 1,078,854 authored log entries, 72 fixed-cadence bursts with 96 hot-room updates per burst, and the unchanged source/remediation oracle. Each incident remains exclusive. Metrics distinguish busy rooms from other rooms and native inference from question-to-assessment/outbox latency. They do not measure external delivery.

All five authored decision classes retain exact file/SHA/line, candidate attribution, rollback target, citations, issue-specification and open-incident checks. Independent capacity exclusion, fair first admission, quiet publication during the flood, restart, bounded requests, durable draining and every-room replies remain required.

These are sequential development runs, not randomized performance trials. Provider load, model variation and source-relative timestamps can affect timings. The same finite classes repeat across namespaces; this does not establish accuracy for arbitrary incidents. The separate source-location check puts the useful 1% of 10,000 records at the tail and checks exact numbered source and raw-log provenance.

No live Dynatrace/GitLab acceptance, Teams transport, deployment execution or enterprise production capacity is established. Claude remains the normal runtime; the capped-account alternative is an explicit Codex development evaluation.

## Observed results

Seconds from question intake to its matching scoped outbox reply; no sender ran. Every row passed all 18 gates and queued all 90 replies.

| Run | Model turns | Overall median (s) | Busy p95 (s) | Other p95 (s) |
| --- | ---: | ---: | ---: | ---: |
| Consolidation baseline (4 slots, 60 s cap) | 45 | 266.24 | 360.68 | 299.11 |
| Shared question text (4 slots, 60 s cap) | 36 | 120.68 | 399.94 | 299.36 |
| Focused Codex instructions (4 slots, 60 s cap) | 43 | 276.05 | 375.07 | 323.48 |
| Eight slots, 60 s cap | 59 | 93.35 | 378.67 | 139.21 |
| Final: eight slots, 120 s cap | 55 | 87.64 | 371.45 | 106.47 |

The final run reduced the overall median from **266.24 to 87.64 seconds** (67%) and other-group p95 from **299.11 to 106.47 seconds** (64%). Busy p95 was **371.45 seconds**, about 3% slower than the consolidation baseline; overall p95 likewise remained worse (**367.00 versus 350.56 seconds**). This is a substantial quieter-group/median improvement, not a busy-tail or overall-p95 improvement claim.

The gain uses an explicit increase from four to eight slots. Final native inference median was **44.99 seconds**, versus **43.65 seconds** originally. Total model turns increased from **45 to 55**, and reported input tokens increased from **1,561,133 to 1,699,845**. Peak and total usage are material tradeoffs. The longer settling window avoided one premature busy-room turn relative to the eight-slot/60-second run; its total fell from 59 to 55 turns. Other timing differences remain observational.

Repeated question text shrank the observed 32-room request transport from **11,841 to 4,937 bytes**, retaining all exact requests. This did not establish a latency benefit by itself. Focused Codex instructions lowered mean input tokens per turn, but neither prompt tuning nor the low-verbosity setting established faster inference.

The final workload retained **7,091 messages**, deduplicated **162 replays**, drained **7,121 jobs**, and queued **90 scoped replies**. All **55/55 actual-model judgments** passed exact source location, attribution, recovery strategy/target, citation and issue-specification checks; all 30 final incident assessments passed. Quieter publication during the flood, peer capacity exclusion, fair first admission and controlled restart passed. No incident was resolved or deployment executed by the model.

Busy-tail latency remains open: continuing input invalidates drafts, and the deliberate quiescent restart waits for admitted calls before reopening the pool. The final hot-room inference itself took 54.69 seconds. Source/lease/revision checks were preserved; no stale draft was published to lower the metric.

## Source-location checks and reproducibility

A separate actual-Codex check found `fixture/ledger` / `src/ledger/amounts.py:12`, the exact immutable revision and quote, and retained raw-log provenance with the useful 1% at the tail of 10,000 records. Both follow-up source checks passed all 14 gates. The earlier invocation proposed a contract-aligned forward fix; the focused-instruction invocation selected `collect-evidence` because producer/parser responsibility and monetary conversion semantics were unresolved, while drafting contract tests and rejecting unsupported rollback. This fixture validates source mapping and conservative unknowns; the 30-incident surge separately requires the exact supported recovery class.

Reopening the completed final surge added **zero native calls** and preserved its cases and metrics. Per-attempt native inputs, output, timing and failed/unsuccessful latency controls remain in private evaluation directories. The [compact receipt](evidence/2026-10-22-dynatrace-latency.json) records source/report hashes, inference settings, all gates, usage and final full-suite verification.

Reproduce in a fresh directory with Node.js 24+ and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
pnpm test --test-concurrency=8
pnpm sre:groups:eval --live --provider codex --surge --concurrency 8 --directory .local/group-latency-fresh
```

The explicit live flag consumes model usage. The normal Claude route still needs a fresh completed test after its cap clears, and live Dynatrace/GitLab and external-delivery acceptance remain outstanding.

## Full verification

The final frozen-source suite passed **2545 / 2545 tests**, with zero failures, skips or cancellations, in 250.45 seconds. Node.js 24.19.0 / pnpm 11.25.0; frozen-lockfile install and no follow-up dependency/lockfile change. All **344 runtime/configuration/fixture/script/test hashes** matched after native evaluation, completed-run resume and full tests. The source commit is `7c66e1e05a8a89da88d8829f8e3e6ed945b34dcf`; the compact receipt includes its aggregate hash and individual report/log hashes.

Focused regressions cover lossless repeated/Unicode questions, original request limits before native startup, host-only instruction-file contents/permissions/cleanup, changed inference settings, upper-slot exclusion/expiry/capacity changes on SQLite and PGlite, a 96-second flood with a progressing quiet incident, the two-minute maximum, and released-versus-active restore source metadata. An initial new eight-slot test fixture assumed the single-question claim order; its two failures were retained and the fixture was corrected to use the intended 32-question fairness profile before the passing run.
