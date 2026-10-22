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
- Provider schemas offer only finding formats supported by the delivered snapshot. Numbered findings are checked against delivered lines and full host provenance; invocation-local citation aliases remain mandatory.
- Repeated runtime ticks wake idle investigator capacity while an earlier incident is still running. Investigation/action ordering and protected-action fences remain covered by the combined suite.
- Reserved GitLab CI coverage requires matching provider, project and poll scope. A shared commit SHA cannot transfer those counts to GitHub or another GitLab project.
- Alert reply receipts remain atomic with publication. The regression fixture now observes the retained retry deadline instead of expecting a delayed retry to run immediately.
- Saved plan identity includes changed model source findings, recovery proposals and issue specifications, while retaining the previous fingerprint for legacy assessments without those fields.

## Verification record

Frozen-lockfile installs passed with Node 24.19.0 and pnpm 11.25.0. Fresh baselines passed 1,490 tests on merged main and 2,365 tests on the paused checkpoint. The first combined run passed 2,523/2,533; the ten failures exposed merge-boundary regressions and stale transport/retry fixtures. Those failures were retained and repaired. All 148 focused regression tests then passed.

The final combined suite passed **2,533/2,533**, with zero failures, cancellations or skips, in 239.71 seconds. All 344 frozen runtime/configuration/fixture/script/test hashes matched afterward; aggregate SHA-256: `21992709b058c62771912ff62be034be66ebeeb7c3684c8caf7074f5b569a700`. The lockfile was not changed.

Native-model results are added after testing the consolidated commit. Private raw inputs, model outputs and database artifacts remain outside Git. They contain authored incident data, not an Ally acceptance record.

## Remaining integration acceptance

Actual Claude/Codex inference against authored evidence tests the reasoning and host pipeline. It does not validate a live Dynatrace tenant, DQL compilation or scan semantics, enterprise GitLab permissions, native Teams traffic, or production capacity. SQLite/PGlite checks do not certify enterprise PostgreSQL.

Before adopting the log-to-code flow, verify the approved Dynatrace endpoint/authentication, service/environment/release fields, query and retention budgets, partial/sampled/denied responses and restart coverage. Verify the approved GitLab project or discovery allowlist, immutable source responses, deployment mapping and reader permissions against the same incident scope. Missing or incomplete evidence remains unknown. Rollback stays a proposal until the separately protected execution contract is accepted.

See [the integration checklist](ALLY-INTEGRATION-CHECKLIST.md), [Dynatrace investigation](DYNATRACE-INVESTIGATION.md), [source locations](LOG-SOURCE-LOCATIONS.md), [follow-up evidence](EVIDENCE-FOLLOWUP.md) and [the sustained group workload](SUSTAINED-GROUP-EVALUATION.md).
