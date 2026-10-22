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

## Observed validation, October 22, 2026

Runtime commit `8a41db1` passed **5/5 new authored validation cases on their first run**, with the runtime/prompt/corpus frozen before inference and unchanged throughout. This follows the two calibration mechanisms; validation responses were not used to tune that version. The [sanitized receipts](evidence/2026-10-22-large-repo-diagnosis.json) retain the completed and failed development runs separately.

Frozen-lockfile installation and the initial full baseline passed 2,557 tests. The final full check, `pnpm test --test-concurrency=3`, passed **2,562 tests**, zero failures/skips/cancellations, on Node 24.19.0 / pnpm 11.25.0. All **211 runtime/configuration/script/corpus/dependency-manifest hashes** matched after verification. No dependency or lockfile changed.

The actual official Codex CLI requested `gpt-6.1-sol`, medium effort, using verified CLI `0.163.0-alpha.10.2`. Fourteen validated model responses investigated **150,000 initial records across five separate 1,200-file repositories**, with 1% initial request-review witnesses, six targeted log queries and 39 source-file reads total. All ten authored code-stage checks matched their declared behavior. Median invocation was **32.44 seconds**, maximum **41.11 seconds**; model time summed to 64.50–106.06 seconds per case, excluding initial collection and queue wait. This is neither a production latency promise nor a paired speed comparison.

| New authored mechanism | Observed diagnosis and recovery |
| --- | --- |
| Cursor advances beyond consumed items | `packages/archive/rules/cursor.mjs`:L2 at the exact current SHA; compatible historical rollback candidate, separate permanent correction and data-repair review |
| Decimal sequence IDs sorted lexicographically | `packages/reconciliation/rules/sequence.mjs`:L2; forward fix because schema/data rollback is explicitly unsafe |
| Fixed-offset date computation ignores the offset on both releases | `packages/settlement/rules/business-day.mjs`:L1–L3; forward fix, no claim that the latest deployment introduced the pre-existing defect |
| Independent dependency 503s on both releases | Dependency mitigation, no candidate application findings or rollback target |
| Amount representation without a known producer/consumer contract | Collect evidence, unknown deployment attribution, no candidate defect; no invented unit/format correction |

Each case passed separate provider, follow-up, exact-location, recovery/target, attribution, citation, specification and false-candidate-file checks. Review of the final structured outputs confirmed the concrete mechanisms, negative/control tests and falsifying checks in their developer specs. That review is by the implementing agent, not independent acceptance. Reopening SQL preserved assessments and immutable Markdown plans without another model call. No Teams intake/delivery, fix execution or rollback occurred.

The first calibration run contained refused fixed-project requests and a cancelled second assessment. After the selector fix, another run completed the first calibration case but was interrupted on the second; the second then passed in a fresh single-case run. These partial runs are not combined into a single claimed 2/2 run. Long pauses and cancellations coincided with recorded host sleep. The first full suite also had three timing failures during that period. Those failures remain in the receipts; elapsed time across sleep is not treated as ordinary model latency. Subsequent live evaluation and full verification ran separately with idle sleep inhibited only for the process lifetime. No test deadline, test assertion or recovery policy was weakened.

## Remaining acceptance

Read-only tenant acceptance still requires actual Dynatrace field/DQL/auth/sampling/completeness and cost checks, GitLab permissions and runtime-to-project/commit/artifact bindings, and representative sanitized historical incidents with independent outcomes. These authored results cannot certify those contracts. The approved local Codex route is used while Claude is capped; Claude performance and correctness need their own run when available. Jira/API-versus-MCP design discussion precedes further Jira implementation.
