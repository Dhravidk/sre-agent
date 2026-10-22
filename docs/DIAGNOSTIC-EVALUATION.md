# Offline diagnostic evaluation preparation

The candidate corpus checks actual authored code behavior and the SRE host workflow with Claude off. It prepares bounded investigation inputs for later model evaluation. **It does not measure actual model diagnostic quality.** Rules mode remains inconclusive on these unfamiliar modules and creates Markdown investigation plans with no automatic patch.

## Run locally

Use Node 24 or later and the installed project dependencies:

```sh
pnpm sre:diagnostics:offline
# Optional parent directory; each run creates a fresh owned child directory:
pnpm sre:diagnostics:offline --output .local/diagnostic-evaluations
```

The command has no model-activation or live-provider flag. It uses a fresh private SQLite database, synthetic identities, mocked read-only GitLab HTTP and simulated Teams sends. It does not read the trial credential files, use the default SRE database, publish Git refs, create QA requests or execute deployments. Existing demos and native forwarding settings are independent.

## Cases and executable gold

Each case has a real local Git repository with three immutable commits: base, observed and follow-up. Commit titles describe ordinary maintenance. Exact before/observed source and comparison data pass through the actual read-only GitLab connector; there is no remote repository.

| Case | Authored behavior | Base / observed / follow-up invariant |
| --- | --- | --- |
| case-01 | Terminal 422 responses retried after a predicate change | pass / fail / pass |
| case-02 | Concurrent deliveries append the same event twice after an await moves before registration | pass / fail / pass |
| case-03 | Stock cache omits region from its key | pass / fail / pass |
| case-04 | Controlled dependency returns 503; functional code is unchanged | fail / fail / fail |
| case-05 | Healthy requests across an instrumentation change | pass / pass / pass |
| case-06 | case-01 variant with the observed full-file read denied | pass / fail / pass |

There are **three distinct planted defects**, one source-permission variant, one dependency control and one healthy control. The permission variant still receives the base file and comparison diff; it tests incomplete full-file coverage, not complete concealment of the changed code.

The gold runner verifies retrieved Git bytes against the exact first-party templates before copying them and a fixed invariant test into fresh trusted workspaces. It runs the fixed Node test command, collects actual attempt/append/region observations and removes those execution workspaces. A changed source fails the byte check before execution. This narrow trusted runner does not execute arbitrary provider source and does not supply the deferred generic QA executor.

## Host and collaboration replay

The host admits five log-threshold candidates from the actual observed failing checks before fictional responders speak. The healthy case produces no threshold candidate; it receives an explicit operator review so its investigation packet can be inspected. Three observations do not represent three distinct affected users, a representative traffic sample or pre-user-impact prevention.

Every case joins fictional Bidding, Platform and worker-desk threads. Participants report business failures versus green liveness probes, propose release and upstream theories, and duplicate trace-review work. Actual collaboration code retains the disagreement, competing theories, overlap and recorded owner evidence. Rules mode does not settle the causal question by guessing.

The replay creates immutable Markdown plans, drains the simulated outbox, closes and reopens SQL, then accepts a late worker clarification and an addressed missed-update question. A fresh plan includes the clarification while the earlier Markdown stays unchanged. Other incidents retain separate context. This is actual rules-host conversation history after restart; it is not a continued actual-model conversation or a native Microsoft delivery test.

The automated tests exercise file SQLite and durable PostgreSQL-dialect storage through PGlite. Native PostgreSQL acceptance, when run separately, must be identified by its own receipt; PGlite results alone do not establish TCP, database-server or failover behavior.

## Outputs and review boundary

Each fresh run prints its report path and retains:

- `inputs/case-*.json`: the first bounded host context observed before each rules assessment, including admitted source/log and collaboration evidence.
- `inputs/case-01-follow-up.json`: the later actual host context after SQL reopen and the worker clarification. The first packet remains available.
- `tickets/`: actual host Markdown plans, including the later plan. Unsupported code patches remain absent.
- `oracle/code-gold.json`: author-only source identity, expected mechanism and actual invariant execution. The generated repositories also retain the later correction commits.
- `report.json` and `report.md`: author-facing results, case explanations and limits. These are not blinded model inputs.
- `review-template.json`: an unassigned reviewer and null scores for mechanism, citations, alternatives, next check, team alignment and unsafe advice.

Input packets exclude the gold explanations, private invariant harnesses, review scores and later correction refs. Their source bytes still permit investigation of the defects. All authoring material remains in the same checkout: this is **not a held-out benchmark** and file separation alone provides no model sandbox or blinding guarantee.

Before scoring actual Claude, review representative cases and data handling, authorize the actual invocation, pass only reviewed input material through an approved execution boundary, retain invocation provenance, and obtain independent outcome review. A continued model conversation needs its own real transcript. Record uncertainty, source denial and negative controls; do not award a successful diagnosis merely because the host accepted a well-formed response or a scripted proposal cited a valid line.

These local checks do not accept live Dynatrace noise filtering, GitLab transport/MR/CI lifecycle, Ally ownership or source permissions, native Teams participants, generic patch execution, remote publication, AWS storage or production capacity. Those remain separate acceptance work in [the integration checklist](ALLY-INTEGRATION-CHECKLIST.md). The [dispatch proposal](DISPATCH-DESIGN.md) remains design only.
