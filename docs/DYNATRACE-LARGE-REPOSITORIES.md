# Noisy Dynatrace evidence in larger GitLab inventories

This follow-up to [the first diagnosis milestone](DYNATRACE-GITLAB-DIAGNOSIS.md) tests multi-file localization and new diagnostic mechanisms. Teams, additional ticket/document connectors and deployment writes remain deferred.

## Retrieval change

Initial collection previously could consume all eight immutable source attempts on early comparison files. A relevant helper outside those files then remained unread even when its import was visible. The regression fixture reproduced zero remaining reads after initial collection.

For model-backed investigations with follow-ups enabled, initial collection now leaves two attempts and 32,000 accepted bytes for subsequent directed reads. The overall limits remain eight attempts, 64,000 accepted bytes and 16,000 bytes per file. Failed reads consume attempts. Cache hits reuse their original result, and reads deferred by the reservation are not cached as permanent failures. Optional history also reserves capacity for pending primary requests.

The host releases the initial reservation after all collection tasks drain, including cancellation/fence failures; it never replenishes consumed attempts or bytes. Follow-up policy reports remaining attempts and bytes alongside immutable scope. With follow-ups disabled, ordinary collection retains the full budget. This changes evidence allocation, not the recovery classifier, connector permissions or source execution policy.

The first live calibration also exposed a protocol mismatch: an explicit `project` equal to the host-fixed project was treated as an additional-project proposal and refused. The host now canonicalizes that exact spelling to the fixed-project selector before scope validation, deduplication and persistence. Both forms use the fixed reader and the same cache/history identity. Other projects and revisions still require their separately delivered allowlist; this does not grant discovery access.

## Authored calibration and validation

```sh
# Actual official Codex CLI calls; each run requires a fresh directory.
pnpm sre:diagnosis:eval --live --provider codex --suite large --partition calibration --files 1200 --records 30000 --directory .local/MY-CALIBRATION
pnpm sre:diagnosis:eval --live --provider codex --suite large --partition validation --files 1200 --records 30000 --directory .local/MY-VALIDATION
# To require an unchanged runtime/prompt/corpus from a prior freeze:
# append --frozen-inputs .local/MY-CALIBRATION/frozen-inputs.json
```

Two calibration cases cover seconds-to-milliseconds conversion and preservation of an explicit zero quota. Five separate validation mechanisms cover cursor advancement, numeric sequence ordering, a pre-existing fixed-offset date defect, an independent dependency failure and an unresolved amount-format contract. Validation model responses must not be used to tune the runtime/prompt reported by that validation run. Both partitions are authored here; this separation is not an externally independent production benchmark.

Each case creates actual Git history with 1,200 text modules, a caller importing a separate helper, similarly named decoys across 40 components and 37–38 changed files. The helper is outside the initial comparison selection and is unchanged in the pre-existing/control cases. The files and defects are deliberately small: file-count pressure does not reproduce the semantic complexity, build system or languages of an enterprise monorepo.

Each initial batch contains 30,000 records with 1% rare INFO request-review witnesses. ERROR/WARN instrumentation, health traffic, shared trace IDs, regional differences, non-SHA release labels, misleading file paths and untrusted deployment instructions compete with the useful observations. Detailed input/output and contract observations require a scoped follow-up; they are absent from the initial snapshot. Some unknown contracts intentionally stay unknown.

The code oracle executes only exact first-party authored bytes and a fixed probe harness, after checking those bytes against each generated Git revision. Provider responses, source/log text and model output cannot select an executor. The oracle and expected finding/recovery labels never enter model input. Deployment health/compatibility assertions and dependency probes are fictional, and all vendor HTTP is mocked.

All incidents are queued together, but the diagnostic worker visits them sequentially once each. This is a diagnosis workload, not a group-message throughput or production concurrency test. The shared two-round/four-proposal/two-log-query ceiling remains in force.

Before inference the runner records hashes for runtime, instructions/adapter, evaluator and corpus files. It retains every attempted response and failure in the private run directory and refuses to overwrite a used run. A validation result must name its freeze; later changes require a new validation run. Location checks require the exact helper and revision, and reject additional unrelated candidate files even if one correct finding is also present. Recovery, target, attribution, follow-up citations and developer-spec presence are checked separately. Free-form causal explanations and acceptance tests still require review.

## Remaining acceptance

Read-only tenant acceptance still requires actual Dynatrace field/DQL/auth/sampling/completeness and cost checks, GitLab permissions and runtime-to-project/commit/artifact bindings, and representative sanitized historical incidents with independent outcomes. These authored results cannot certify those contracts. The approved local Codex route is used while Claude is capped; Claude performance and correctness need their own run when available. Jira/API-versus-MCP design discussion precedes further Jira implementation.
