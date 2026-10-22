# Dynatrace consolidation — October 22, 2026

This change preserves the paused investigation work and integrates it with the merged real-model runtime. The immediate development priority is scoped Dynatrace logs → immutable GitLab source → a supported recovery proposal and draft issue specification. Further Jira reader work waits for a discussion of API/MCP access and organization permissions. ServiceNow access and communication improvements follow separately.

## Preserved source

- Main: `e29389a961d97ca9cec9c928cf317bb871eb1c93`, containing merged PR #1.
- Paused work: `78a457069ffdac76b90abab6a1992b5fd49bab05`, checkpointed before consolidation. The original checkout was left clean; its private configuration, databases and running services were preserved.
- All 35 textual merge conflicts were reviewed. The result combines the real Claude runtime, bounded request batches and SQL-coordinated investigator slots with the paused log/source provenance, bounded follow-up reads and operational visibility.

The paused work also contains previously developed collaboration and local QA features. Preserving that work does not enable a new enterprise connector, sender, executor or deployment permission.

## Integration repairs

- Initial and follow-up reads use the claimed investigator slot and exact job ownership. A different or expired owner cannot retain a result for that incident.
- Large initial log pages, the manifest, derived triage and completion receipt commit together. A failed completion rolls them back. Replaying a completed receipt cannot silently repair a missing finalized artifact.
- Legacy model source excerpts and optional numbered source inspection share the same immutable GitLab read budget and cache.
- Provider schemas bind each finding format to its delivered evidence IDs, paths and revisions. Numbered findings are checked against delivered lines and full host provenance; invocation-local citation aliases remain mandatory.
- Rare error samples from large paged batches can supply reported locations only after the host checks their exact original raw page and record. The lookup verifies at most eight selected points, caches page reads and keeps raw pages out of model input. Missing, changed, shortened, denied or foreign-incident records cannot establish a location.
- The explicit Codex development adapter translates the disjoint request variants into the supported strict schema union and restores nullable optional project selection before host validation. Explicit project strings still reach the host allowlist. This follows [official OpenAI structured-output guidance](https://developers.openai.com/api/docs/guides/structured-outputs).
- Repeated runtime ticks wake idle investigator capacity while an earlier incident is still running. Investigation/action ordering and protected-action fences remain covered by the combined suite.
- Reserved GitLab CI coverage requires matching provider, project and poll scope. A shared commit SHA cannot transfer those counts to GitHub or another GitLab project.
- Alert reply receipts remain atomic with publication. The regression fixture now observes the retained retry deadline instead of expecting a delayed retry to run immediately.
- Saved plan identity includes changed model source findings, recovery proposals and issue specifications, while retaining the previous fingerprint for legacy assessments without those fields.

## Verification record

Frozen-lockfile installs passed with Node 24.19.0 and pnpm 11.25.0. Fresh baselines passed 1,490 tests on merged main and 2,365 tests on the paused checkpoint. The first combined run passed 2,523/2,533; the ten failures exposed merge-boundary regressions and stale transport/retry fixtures. Those failures were retained and repaired. All 148 focused regression tests then passed.

After the native preflights exposed the paged-source and provider-schema gaps described below, the next combined run passed 2,536/2,537. The remaining test expected host-only sample origins in model input. Its correction preserves exact sample/coverage comparisons and explicitly asserts that origin bookkeeping stays hidden.

The final combined suite passed **2,537/2,537**, with zero failures, cancellations or skips, in 249.76 seconds. All 344 frozen runtime/configuration/fixture/script/test hashes matched afterward; aggregate SHA-256: `52e3eae55cabb86853e2c6c02bdee279b31486dcadc2ec6a28f5ad358e4fef18`. The lockfile was not changed.

The final runtime is commit `0e0e90926eafba31e579a0c90aa59ed2984f73bc`. The [compact verification receipt](evidence/2026-10-22-dynatrace-consolidation.json) contains source/input/report hashes, every final workload gate and the observed metrics. Private raw inputs, model outputs and database artifacts remain outside Git.

### Actual model results

The earlier real-Claude surge stopped at an account cap: **38 validated turns and two quota failures**, with all validated judgments passing. Its overall result remains **incomplete**. The native reset label was “2pm America/Detroit,” without a date; the host retained the hold with no fabricated retry timestamp. This run used the earlier merged commit and is not final-Claude acceptance.

Codex preflights then exposed a strict-schema incompatibility, missing source locations after large-log paging, and confusion between legacy and numbered finding formats. The initial unknown parser result was appropriate for the source then delivered; the invalid finding was rejected. These failed attempts were retained, the host/protocol gaps were repaired, and a fresh native source check passed.

That source check supplied **10,000 authored log records with the useful 1% at the tail**. Actual Codex found the unchanged `src/ledger/amounts.py` at line 12, with the exact SHA and quote `    return int(raw.strip())`. It retained the log provenance, left deployment attribution unknown and `candidateSha:null`, proposed a contract-aligned forward fix, and drafted verification/data-reconciliation criteria. It took 47.79 seconds and performed no external action. Separate SQLite/PGlite regressions place the only useful error at record 9,999 and reject changed, missing, denied or foreign-incident raw provenance.

The final fresh surge used the official, version-verified Codex CLI `0.163.0-alpha.10.2`, its existing ChatGPT login, requested model `gpt-6.1-sol` and medium effort. Execution/tools were disabled and credentials stayed outside the model. It passed **45/45 native judgments and all 18 workload gates** on the final frozen runtime.

| Observed development workload | Result |
| --- | --- |
| Incidents / service scopes / admitted groups | 30 / 24 / 90 |
| Authored Dynatrace-shaped record entries | 1,078,854 |
| Decision diversity | Five authored decision classes repeated across six cohorts |
| Sustained bursts / retained messages / deduplicated replays | 72 / 7,091 / 162 |
| Current correct incident assessments / questions with queued full replies | 30 / 90 |
| Drained jobs | 7,121; all done or superseded |
| Simultaneous investigators / peer capacity exclusion | Four / passed |
| File/SHA/line, attribution, recovery target, citations and issue-spec gates | All passed |
| Fair first pass / quiet progress during flood / controlled restart | All passed |
| Maximum bounded incident snapshot / request count | 95,558 bytes / 32 |
| Completed-run resume | Passed; zero additional native calls |
| External message delivery / rollback execution | Zero / zero |

Latency remains a development limitation:

| Measured queue-to-reply latency | p95 |
| --- | --- |
| Busy cohort, 32 questions | 360.68 seconds (6.01 minutes) |
| Other groups, 58 questions | 299.11 seconds (4.99 minutes) |
| All 90 questions | 350.56 seconds (5.84 minutes) |

Native inference median/p95 was 43.65/50.39 seconds; local intake p95 was 0.43 ms. These observations are not production SLAs or a causal performance comparison with prior model runs. Quiet groups progressed during the flood, but several-minute queueing remains under this workload. The 90 replies were retained in the local outbox; none was delivered to Teams. Authored populations, repeated decision classes and one source-location scenario do not establish general diagnosis accuracy or live integration acceptance.

## Remaining integration acceptance

Actual Claude/Codex inference against authored evidence tests the reasoning and host pipeline. It does not validate a live Dynatrace tenant, DQL compilation or scan semantics, enterprise GitLab permissions, native Teams traffic, or production capacity. SQLite/PGlite checks do not certify enterprise PostgreSQL.

Before adopting the log-to-code flow, verify the approved Dynatrace endpoint/authentication, service/environment/release fields, query and retention budgets, partial/sampled/denied responses and restart coverage. Verify the approved GitLab project or discovery allowlist, immutable source responses, deployment mapping and reader permissions against the same incident scope. Missing or incomplete evidence remains unknown. Rollback stays a proposal until the separately protected execution contract is accepted.

See [the integration checklist](ALLY-INTEGRATION-CHECKLIST.md), [Dynatrace investigation](DYNATRACE-INVESTIGATION.md), [source locations](LOG-SOURCE-LOCATIONS.md), [follow-up evidence](EVIDENCE-FOLLOWUP.md) and [the sustained group workload](SUSTAINED-GROUP-EVALUATION.md).
