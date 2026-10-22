# Dynatrace to GitLab diagnosis: first milestone

This milestone prioritizes diagnostic evidence and rollback-versus-fix accuracy. Teams throughput, notification delivery, Jira/ServiceNow connectors and deployment execution are deferred. Existing communication and execution guards remain in place.

## Investigation behavior

The existing host-owned follow-up loop can now narrow Dynatrace reads using exact values already present in the delivered log evidence:

```json
{"kind":"dynatrace_logs","from":1792660000000,"to":1792660060000,"filters":[{"field":"http.route","value":"/api/requests"}],"reason":"Compare detailed old/new request behavior before attributing the failure."}
```

The timestamps and route above are illustrative, not an enterprise mapping. `evidenceAcquisition.logs.filters` lists the values actually available for that invocation. Up to three ANDed matches may select `operation`, `http.route`, `service.version`, `trace.id` or `error.code`. The model cannot supply DQL, endpoints, credentials, another service/environment or an arbitrary filter field/value. A custom window-only reader does not implicitly gain selector support.

The host constructs a query with its configured service and environment, a half-open time window, explicit sampling ratio 1 and the existing scan/result budgets. It checks returned service/environment/filter values and timestamps. Foreign records make the read unavailable; missing timestamps, missing sampling metadata, notifications, sampling and capped results cannot become complete evidence. A complete filtered response covers only that selection. Empty results do not establish health, absence of a defect or a healthy rollback target.

The existing two-round/four-proposal/two-log-query ceiling, shared immutable file budget, deadline, request deduplication, revision/lease/restore fences and atomic artifact/outcome persistence remain. Filter ordering is canonicalized for duplicate detection. Filtered operation/release/time selections retain separate resource histories, so a healthy control cannot overwrite the failing-release observation in the bounded read summary. Legacy unfiltered windows retain their earlier history grouping. Restart reconstructs retained observations without a new provider read.

The shared model instructions ask for a discriminating comparison and a counterexample before attributing causation. Candidate finding arrays are reserved for implicated code mechanisms; healthy/control code and expected propagation of an independent failure belong in ordinary citations and counterevidence. A pre-existing defect may still qualify when its mechanism is supported. Source navigation and file inspection remain bounded host reads at delivered immutable project/revision pairs. Exact file/line/quote verification establishes a location; the causal explanation remains a hypothesis supported or contradicted by telemetry. No deterministic defect classifier or model fallback is added.

## Recovery judgment

A planning-only rollback candidate requires a supported deployment hypothesis and distinct immutable current/target artifacts, a historically independently healthy target, and known matching schema/dependency/configuration/flag metadata with verified backward/data safety. Null, empty or wrong-typed compatibility values cannot prove compatibility merely because both releases contain them.

The planning validator now uses reconciled deployment history, considers the latest instance of the candidate SHA, and rejects unsuccessful or contradictory current/target identities, incomplete history, conflicting attestations and later ambiguous deployments. This closes a gap between draft recommendations and the existing stricter execution policy. It does not make a planning candidate executable or establish present health. Historical health can support a containment proposal while fresh target/current checks, approval and verification remain outstanding.

A supported code defect may justify a forward fix when rollback is unsafe or its compatibility is unknown. Cross-release dependency observations may justify dependency mitigation. Missing causal evidence requires further investigation. These remain model judgments; the host does not replace a rejected candidate with a predetermined alternative.

The immutable Markdown plan retains the model's issue specification: mechanism, impact, proposed change, acceptance/control tests, evidence and open questions. It does not create a Jira ticket, publish a GitLab MR, execute code or repair persisted data.

## Actual-model evaluation

```sh
pnpm sre:diagnosis:eval --live --provider codex
# Use a fresh directory for every run:
pnpm sre:diagnosis:eval --live --provider codex --case case-01 --directory .local/MY-FRESH-RUN
# Optional window-only reader ablation; keep failures as well as passes:
pnpm sre:diagnosis:eval --live --provider codex --case case-01 --window-only
```

The explicit Codex development adapter uses the version-verified official CLI and its existing login with tools disabled. Normal connected runtime remains Claude. `--provider claude` runs the same cases when that approved route is available; Codex results are not Claude acceptance.

The workload uses six authored cases from the diagnostic corpus, actual generated Git history and trusted first-party code checks. Those checks establish the controlled behavior of retry predicates, concurrent event append and regional cache keys; retrieved provider source is never selected as an executable. Additional cases cover a shared dependency outage, healthy requests and a denied observed-source read. The cache case deliberately supplies matching null compatibility values, and the append case supplies an incompatible schema/data transition. Neither supports rollback.

Each initial 10,000-record input has 1% request-review witnesses among noisy ERROR/WARN instrumentation logs, with embedded untrusted deployment instructions. Detailed outcomes are absent from the initial snapshot. The real model must request additional records, compare exact releases, cite retrieved source where available, choose a supported recovery strategy and draft a developer specification. Author-only gold mechanisms, correction revisions and expected answers are excluded from model stdin.

Dynatrace query execution and GitLab HTTP are mocked. Dependency probes and deployment/compatibility/health assertions are fictional. This is an authored development evaluation, not a held-out production benchmark, a live tenant trial or independent acceptance. Each code case uses one authored application module within its scoped project, with noisy instrumentation path hints; larger-repository localization remains a live evaluation task. Automatic checks cover locations, recovery class/target, attribution, follow-up citations, specification presence and persistence; free-form causal claims and test quality still need review.

Private run directories retain exact inputs, validated responses, native timings/usage, provider selectors, SQL state, source/code-gold receipts and Markdown plans. A used directory is refused rather than silently replacing earlier failures. Reopening completed SQL is checked separately from actual inference.

## Remaining live checks

Validate approved Dynatrace service/environment/operation/release/trace field contracts, DQL and sampling/completeness metadata in a read-only tenant; measure query volume, cost and limits on representative logs. Confirm GitLab reader permissions and actual runtime-to-project/commit/artifact bindings, including ambiguous candidates and denied files. Obtain sanitized historical incidents with matching source history and independent recovery outcomes for a reviewed evaluation set. Missing inputs remain unknown; no enterprise endpoint or owner is invented here.

The implementation uses documented [DQL filters](https://docs.dynatrace.com/docs/platform/grail/dynatrace-query-language/commands/filtering-commands), [fetch sampling](https://docs.dynatrace.com/docs/platform/grail/dynatrace-query-language/commands/data-source-commands) and immutable [GitLab file reads](https://docs.gitlab.com/api/repository_files/). Documentation and mocks do not validate the organization's tenant/server contracts.
