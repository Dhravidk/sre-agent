# Multi-file Dynatrace → GitLab diagnosis

This continues the [larger-repository slice](DYNATRACE-LARGE-REPOSITORIES.md): follow evidence through a caller, an adapter and an imported helper, distinguish multiple interacting defects from healthy contextual code, and choose a supported recovery proposal. Teams and further ticket connectors remain deferred. The model cannot execute a rollback, publish a change or create an external ticket.

## Runtime changes

An opt-in model-backed investigation now permits three follow-up rounds and six proposals, at most two per round. This allows a targeted outcome query plus a caller read, old/new adapter reads, then old/new helper reads. The host continues to choose scope, validate selectors and persist the resulting evidence under existing job/lease/revision/restore fences. There are at most four reasoner invocations, sharing the existing model-timeout-plus-60-second investigation deadline. Normally that deadline is 240 seconds; adding a round does not extend it.

With GitLab source inspection and model follow-ups enabled, initial collection reserves four source attempts and 48,000 accepted bytes within the unchanged eight-attempt, 64,000-byte total and 16,000-byte per-file budget. It keeps one safe comparison frame ahead of untrusted stack-path priorities. That frame is a navigation opportunity, not evidence of relevance or causation. Directed reads still have to discover the actual implementation.

A temporary reservation cannot permanently poison the immutable-file cache. Reads defer before HTTP when the free capacity cannot fit one maximum allowed file. A parallel response rejected solely because another read consumed the unreserved bytes is evicted from the cache, without returning its content or refunding its attempted read. Denial, wrong immutable identity and absolute size failures remain cached as unavailable. Focused regressions cover those distinctions and cancellation.

SQL receipt admission and recovery use the same round-limit constant. Stop older investigators before upgrading: their receipt reader does not recognize round-three terminal-limit observations. Existing receipts remain valid. [Follow-up limits](EVIDENCE-FOLLOWUP.md) describe the full boundary. No dependency, database schema, credential scope or deployment-write permission changes.

## Authored workload

```sh
pnpm sre:diagnosis:eval --live --provider codex --suite multifile --partition calibration
pnpm sre:diagnosis:eval --live --provider codex --suite multifile --partition validation
```

Each case builds real Git history with 4,000 text modules, 80 similarly named decoy components and 78–79 changed files. Comparison paths sort lexically, placing application files after decoys. Caller, adapter and helper responses are approximately 2.8 KB, 9 KB and 11 KB respectively, so the accepted-byte budget matters as well as read count. Functions are small and padding is inert comments; this does not reproduce enterprise monorepo semantic complexity or language/build diversity.

Each initial batch has 60,000 records with 1% request-review witnesses at its tail. Those witnesses expose only the outer caller, without detailed outcomes. Noise includes malformed scalar records, expected collector ERROR/WARN events, future timestamps, another environment, reused trace IDs, non-SHA release labels, misleading paths and untrusted scope/rollback instructions. A targeted scoped query is needed for detailed old/new input/output observations. One control denies the current helper and marks query results sampled; that evidence must remain incomplete.

Two calibration mechanisms cover boundary conversion and coupled unit/sign faults. Five different validation mechanisms cover:

| Mechanism | Required distinction |
| --- | --- |
| Tuple keys collide after delimiter concatenation | Find the helper defect; keep the correct adapter as context; compatible rollback candidate |
| Signed adapter normalization and reversed helper arithmetic | Identify both culpable files; either one-file correction still fails controls; forward fix because schema/data rollback is unsafe |
| Helper sorts a caller-owned array in place on both releases | Find the mutation defect; propose a forward fix without blaming its introduction on the current deployment |
| Independent upstream audience rejection on both releases | Dependency mitigation; application code propagating the response is context rather than a candidate defect |
| Unknown identifier-canonicalization contract, denied current helper and sampled logs | Collect evidence; no invented case/whitespace fix, current-source quote or deployment attribution |

The author-only oracle verifies exact generated Git bytes before executing a fixed first-party harness. It deep-clones probe inputs to isolate mutation tests. For the interacting-defect cases, separate counterfactual combinations prove that neither single-file correction satisfies the declared contract. No oracle labels, source definitions, counterfactual results or expected culprit list enter model input. Retrieved provider bytes and model output cannot select an executor. Vendor HTTP, deployment health/compatibility assertions and independent dependency probes are fictional.

The scorer requires every declared culprit at the exact current SHA and line, rejects extra healthy or old-release candidate files, and checks that required current adapter/helper context was actually delivered. Strategy, target, deployment attribution, follow-up citations and developer-spec presence remain separate checks. Free-form causal explanations and proposed tests require review. The implementing agent authored and reviewed this workload; validation responses are withheld from tuning the frozen version, but this is not an independent external benchmark.

All incidents are open together, with one sequential diagnosis attempt each. This is not a group-message throughput test. Every model attempt and failure is retained privately; a used run directory cannot be overwritten. Runtime/configuration/prompt/evaluator/corpus hashes freeze before inference. The normal connected runtime still uses restricted Claude; the official Codex development route is used while Claude is capped.

## Observed validation, October 23, 2026

Runtime commit `3a147eb` passed **5/5 new authored validation cases on the first run**, with **54/54 separate checks** and **20 validated Codex responses**, four per incident. The runtime, instructions, evaluator and corpus were frozen before validation; validation responses did not tune this version. The [sanitized receipts](evidence/2026-10-23-multifile-diagnosis.json) separate these results from calibration.

On Node 24.19.0 / pnpm 11.25.0, frozen-lockfile installation and the initial full baseline passed **2,562 tests**. The final `pnpm test --test-concurrency=3` passed **2,571 tests**, with zero failures, skips or cancellations, in 411,940 ms. Live evaluation and full verification ran separately, with idle sleep inhibited only for their process lifetime. All **212 frozen runtime/configuration/script/corpus/dependency-manifest hashes** matched after verification. No dependency or lockfile changed. Focused checks also cover reservation/cache failures, the deep source graph and round-three limit receipts across SQL reopening.

The official CLI was `0.163.0-alpha.10.2`, requesting `gpt-6.1-sol` at medium effort. The workload contained **300,000 initial records across five 4,000-file Git histories**. All ten declared old/new code-stage checks and both single-file counterfactual checks matched their authored expectations. Five scoped diagnostic queries and 29 source-file HTTP requests were made. Six reader attempts were charged per incident, including a denied/held source path in the unknown-contract case; reader attempts and HTTP requests are distinct. Accepted source bytes at the final invocation ranged from 31,862 to 54,049 per incident, within the unchanged 64,000-byte cap.

The model located the tuple-encoding helper and selected a compatible historical rollback candidate; it located both the signed-normalization adapter and subtraction helper and selected a schema-compatible forward fix. It found the pre-existing mutation helper without blaming the latest deployment. Cross-release upstream denial produced dependency mitigation, while denied source plus an unknown identifier contract and sampled logs produced an inconclusive evidence request. Neither control produced a candidate application finding. Required current adapter/helper context was actually delivered in the four cases where it was required.

Median invocation time was **39.70 seconds**, maximum **46.18 seconds**. Summed model time was **144.35–172.58 seconds per incident**, excluding collection and queue wait. More reasoning rounds trade time for deeper evidence; these measurements do not establish a latency improvement or production response-time promise. SQL reopening preserved assessments and immutable Markdown plans without another inference. No Teams intake/delivery, fix execution or rollback occurred.

Draft review confirmed concrete mechanisms, negative/control checks, the distinction between a defect's presence and introduction, and separate data-repair questions. Specification presence is scored, but prose is not automatically certified. The dependency draft contains an ambiguous configuration-change condition. Before using that draft, clarify it as: “Change configuration only when an approved entitlement contract establishes that these denied requests should be allowed; preserve denials for unauthorized callers.” The original response remains retained unchanged. This review and clarification are by the implementing agent, not an independent reviewer or deployment owner.

The earlier calibration before lexical ordering/root-only hints passed both authored cases with seven responses. The first harder lexical calibration ended with a cancelled final call at approximately the unchanged 240-second job budget; its timing is consistent with deadline expiry. The same frozen runtime/prompt/corpus then passed both calibration cases in a fresh run with eight responses. The cancelled run remains a failure in the receipts. No source cap, deadline, assertion or execution policy was relaxed to obtain a pass.

## Remaining acceptance

Live read-only acceptance still requires the organization's actual Dynatrace DQL/auth/field/timestamp/sampling/completeness/cost contracts, GitLab permission and runtime-to-project/commit/artifact bindings, and representative historical incidents with independently established outcomes. Claude needs a separate quality and timing run when available. Missing source or contract evidence remains unknown. Real deployment execution, ticket writes, Teams and further Jira/ServiceNow/Confluence work remain deferred.
