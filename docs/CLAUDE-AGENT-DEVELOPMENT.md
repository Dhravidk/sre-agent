# Claude agent development

The normal development command runs the actual Claude CLI. It does not select an auction rule catalog, seed an incident automatically, or fall back to rules when Claude fails. Connector provisioning is outside this development slice.

Use Node.js 24+, pnpm 11.25.0, and an installed/authenticated approved Claude CLI:

```sh
pnpm install --frozen-lockfile
pnpm test
claude --version
pnpm sre:dev
```

The default console is `http://127.0.0.1:3010`, with its own `.local/sre-agent.sqlite`. It starts without incidents. The normal development screen hides auction seeding and simulated Teams controls; the legacy auction-seed endpoint is rejected in this profile. `config/sre.agent.json` uses Claude with supplied development evidence and no vendor readers, deployment writer or external Teams sender. Set `SRE_CONFIG` to an approved connected profile to use its existing scoped readers; the connected default port remains 3001. Rules are available explicitly through `pnpm sre:lab` for offline regression fixtures. The older rehearsal commands are separate test machinery.

For an explicit fictional input with real model reasoning:

```sh
pnpm sre:dev --case session-expiry
```

The case supplies an unfamiliar identity-service file, Dynatrace-shaped logs, a Jira requirement and a versioned Confluence document. It imports the supplied evaluation deployment metadata with unknown health, rather than treating a comparison head as a deployment. Reopening the same case retains its existing identity/history. It creates no hosted issue, repository record, deployment or Microsoft message. `dependency-outage` and `missing-source` are contrasting inputs.

## Investigation behavior

The host still owns source collection, credentials, identity, jobs, progress checkpoints and delivery. The child has no filesystem/connector/MCP tools or action authority. It receives a bounded snapshot and returns:

- A diagnosis that distinguishes observations, source intent, competing explanations and missing evidence.
- `codeFindings`: candidate provider/path/SHA/line locations with source and corroborating evidence IDs. The host rejects locations absent from the delivered immutable excerpt and rejects unseen citations. These remain model hypotheses, not proven causes.
- `issueSpec`: problem, impact, proposed change, acceptance criteria, evidence and open questions. The console assessment and saved Markdown plan include it. Drafting a spec does not create a Jira/ServiceNow record or enable QA.
- `remediation`: a planning-only rollback candidate, forward fix, dependency mitigation or request for evidence, with verification steps and blocking unknowns. The host validates a supplied rollback target against immutable artifacts, scope, health and compatibility; actual execution still requires the independent action policy and approval.
- `teamsMessages`: up to four explicit requests for currently joined incident rooms, or an empty array. The host rechecks each destination inside the assessment transaction and queues through the existing durable outbox. No selected messages means no model-selected delivery. Progress text stays in the console.

The prompt compares Dynatrace trace/time/release scope with Jira requirements, versioned Confluence context and GitLab source/diffs. Source content remains untrusted. A log release or repository SHA cannot substitute for a deployment record. Missing documents, sampled logs, incomplete source and old/conflicting reports remain unknown.

For Claude, the existing immutable repository reader collects up to four ordinary files, with 1,500-byte line-bounded excerpts near a changed hunk or a supplied log stack location, and bounded diff context. A structured problem operation prioritizes matching references. Up to two slots can read safe referenced files outside a complete comparison, marked `changed:false`; they do not become changed-file diff entries. This replaces the auction-policy-only collection path for model investigations. Additional files, large lines, failed reads and omitted code remain explicit coverage limits; a bounded review cannot promise to find every defect. Jira and Confluence receive a separate fair reference budget so telemetry cannot consume their entire transport window.

The [noisy Dynatrace investigation path](DYNATRACE-INVESTIGATION.md) adds Grail aggregation, priority and broad-baseline reads within explicit service/environment/time and scan budgets. Host reduction scans up to 100,000 supplied logs, preserves large batches in durable redacted pages and exposes rare samples with provenance. It does not replace model reasoning with a defect catalog. Provider aggregation and local reduction are evaluated separately from actual-model diagnosis; absent live Dynatrace credentials remain an explicit acceptance gap.

## Busy conversations

Claude runtime jobs batch up to 32 eligible pending questions from the same incident within a separate 32 KiB serialized UTF-8 request budget. Each question retains its existing 4,000-character bound. Questions that do not fit stay pending in full; every original event/job and its question/conversation identity remains in SQL. Parent batches and child-to-parent links persist across failure/retry and process restart. SQL ranks candidates within each room before returning at most 128 siblings; durable incident/room last-served checkpoints help quieter groups enter the bounded batch despite an older hot-group flood. Deferred retry jobs remain ineligible. Different incidents retain their durable last-served scheduling, so one question backlog does not have to drain before another incident runs. Within that order, an explicit question takes precedence over an update-only turn and absorbs eligible non-question work, retaining its scoped reply obligations and evidence. Previously persisted eight-question batches keep their exact retry payload under their legacy bounds; new batches record version 2. Stop older investigator binaries before upgrading. See the [sustained actual-Claude group evaluation](SUSTAINED-GROUP-EVALUATION.md) for the workload and limits.

`investigationConcurrency` allows one to four leased investigators across the database, with one active job per incident. The development profile selects four; omitted configuration retains one. SQL enforces capacity across processes, and idle slots refill without waiting for another incident's model. Capacity changes require idle/stopped investigators; older differently configured processes fail admission. This bounds model concurrency and usage; it does not guarantee low latency under arbitrary arrival rates. Commands and delivery run independently of inference. New evidence still fences stale assessment publication. Shutdown aborts all owned Claude processes before closing storage. Existing deduplication, retries, unknown-delivery handling and restore holds remain in force.

The model classifies a supported recovery strategy separately from execution readiness. A dependency/access-path strategy can retain unknown probe topology, an unverified mitigation target and approval as blockers; these do not alone require relabeling it as evidence collection. Missing causal support still requires `collect-evidence`, and rollback retains its strict artifact/compatibility checks. The host does not rewrite the model's classification into an expected fixture answer.

The same distinction applies to historical baseline health: an independent pre-incident health record can support a planning candidate while current health, exact current deployment and approval still need revalidation before execution. For a supported new-release defect with a verified compatible historical baseline, immediate containment can be a rollback candidate while the issue specification drafts the permanent fix and data reconciliation. A baseline showing the same fault or unsafe/missing compatibility blocks that candidate.

`teams.maxIncidentConversations` optionally raises the per-incident join limit from eight to at most 32. The development profile selects 32; existing profiles retain eight unless configured otherwise. This changes capacity, not admission, tenant membership, installation or sharing permissions. Large summaries preserve every room identity and mark omitted report detail.

## Reproducible evaluation

```sh
pnpm sre:agent:eval --live
# Or one case:
pnpm sre:agent:eval --live --case missing-source
# Noisy telemetry and rollback/dependency controls:
pnpm sre:dynatrace:eval --live
pnpm sre:dynatrace:multi:eval --live
```

This explicitly consumes actual model usage. It checks source localization, cross-source references, a usable spec, visible progress before completion, dependency counterevidence and withholding unsupported source findings. Results/specs are private under `.local/claude-development/evaluation/`; override with `SRE_AGENT_EVALUATION_DIRECTORY`.

`tests/sre-agent-development.test.mjs` separately checks forged paths/SHAs/lines/citations, foreign destinations, bounded source reads, noisy context, SQLite/PostgreSQL SQL batching and fairness, retries, shutdown, and a 32-group/256-question process-restart workload. Its load CLI is synthetic, so its throughput does not measure Claude capacity or Microsoft delivery.

Actual Claude evaluations use fictional evidence. Enterprise model authentication, connected evidence quality, live Teams load and production operating capacity require their own acceptance. The integration checklist remains authoritative for those boundaries.
