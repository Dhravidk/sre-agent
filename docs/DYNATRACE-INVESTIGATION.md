# Noisy Dynatrace evidence and Claude source investigation

The Claude worker prioritizes Dynatrace evidence and exact GitLab source over routine collaboration updates. Host code reduces data and validates provenance; the actual Claude model proposes a diagnosis and recovery plan. There is no application-defect catalog or rules fallback in this path. All deployment execution remains behind the existing independent host policy and approval boundary.

## Read from Grail within an explicit budget

`DynatraceConnector.investigationLogs` uses the configured Grail endpoint and read identity. The worker supplies its service environment and a finite interval from 15 minutes before incident start through database coordination time. Every query filters the configured service field/value, explicit environment field/value, and half-open timestamp window. Returned samples must match that scope, including the service/environment fields in aggregate samples. A wrong or missing service/environment fails collection.

The host issues three query kinds, followed by bounded priority-window splits:

1. **Structured strata:** Grail `summarize` counts observations and first/last timestamps by severity, log source, source path, error/exception, HTTP status/route, exact service version, environment and region. `takeAny(record(...))` retains one actual representative per stratum. The 200-result limit applies after aggregation; rare strata sort first. This can summarize many source records without transferring every noise line. An arbitrary sample cannot describe all messages in a stratum, and grouping can hide semantically different messages with identical attributes.
2. **Priority observations:** error/warning severities, explicit error/exception attributes or HTTP failures. INFO business failures with an error attribute are eligible. This is a retrieval heuristic, not a classification of noise or cause. A capped window is bisected while budgets permit.
3. **Broad baseline:** newest records without a severity filter, retaining ordinary traffic and counterevidence. A full 200-record result remains incomplete.

Defaults under `dynatraceLogs.logInvestigation` (or the Grail `dynatrace` reader) are:

| Setting | Default | Bound |
| --- | --- | --- |
| `maxQueries` | 8 | 3–8 total requests, including initial queries and slices |
| `scanLimitGbytes` | 0.125 | Per query; at most 1 GB across eight default queries, including overlapping scans |
| `timeoutMs` | 30000 | 100–60000 ms host deadline |
| `minWindowMs` | 1000 | Positive integer; no smaller split |
| `levelField` | `loglevel` | Validated DQL field identifier |
| `environmentField` | `deployment.environment` | Validated DQL field identifier; must map the service's actual environment |

Each query explicitly requests `samplingRatio:1` and `defaultSamplingRatio:1`, 200 result rows, a 500,000-byte soft result limit and a 10-second provider fetch timeout. Query polling is bounded. The parent abort signal/deadline cancels host requests; remote Grail query cancellation is not implemented. An initial unauthorized/unavailable/schema-invalid query stops the plan and produces incomplete evidence rather than unbounded retries in the plan. Existing HTTP credential/retry gates remain in effect.

The Claude worker has a default 240-second overall budget, including collection, the separately bounded 180-second CLI invocation and persistence. The CLI timeout is configurable from 100 to 300,000 ms; the worker adds 60 seconds for collection/persistence. This accommodates the 30-second default Grail collection deadline. Claude uses explicit medium effort by default, configurable through `claude.effort`/`SRE_CLAUDE_EFFORT`, and the prompt asks for a concise complete response. A timeout remains an explicit failure, not a fabricated diagnosis or a rules fallback. Lease heartbeats, shutdown cancellation, one-investigator concurrency and fair durable job scheduling continue to apply; a queued question has no arbitrary low-latency guarantee.

Receipts retain each window, returned row count, explicit sampling metadata, notifications, scan counters when supplied, and completeness. Missing metadata, non-INFO notifications, sampling, invalid/missing timestamps, unfinished windows and deadlines remain unknown. The batch is complete only if the broad baseline, priority leaves and aggregate inventory all complete. Successful targeted slices cannot make a capped baseline complete. A query cap is not an ingestion checkpoint or evidence of absence.

The existing `logs()` reader and threshold-trigger poller retain their separate newest-200 contract. The expanded path is used for Claude investigations, not as an automatic change to monitor thresholds or source-closure rules. No live tenant DQL acceptance is implied by fixture HTTP tests.

## Preserve evidence, select samples, inspect code

`log-triage.mjs` scans up to 100,000 supplied records, retaining at most 4,096 signatures and selecting up to 20 groups with two source samples each. It deduplicates exact canonical timestamped records. Explicit request/trace IDs are normalized only for grouping; amounts, error codes, exact releases, regions and other message values remain significant. Severity, stack references and explicit error attributes prioritize inspection, then rarity and release/severity/environment/region/operation/status strata preserve useful minority evidence and counterevidence. At capacity, a newly seen stratum can displace a member of an overrepresented stratum so unique routine noise cannot take every slot before an unlabelled INFO operation arrives. These heuristics cannot guarantee recall for arbitrary logs; omitted groups and capacity loss are counted.

The generic evidence redactor limits arrays to 500 elements. Larger log batches therefore persist in idempotent `log_page` rows of 500 records, followed by a manifest containing page IDs and retained/omitted counts. The first 100,000 records can be retained; records beyond that bound remain explicitly omitted. Standard secret redaction and per-record field/string/depth limits still apply. Pages are excluded from bounded model snapshots. Interrupted writes cannot publish the final manifest; a retry reuses existing content-addressed pages. Raw retention is not byte-for-byte archival or a tenant-wide export.

Separate `log_triage` evidence rows contain selected source samples, counts, raw-manifest provenance and coverage. They are derived views, never independent corroboration. Provider stratum counts remain separate from observed sample counts; neither is automatically a count of failed requests. Aggregate counts and sample counts must not be added. The existing signal digest retains its own 2,000-record transport bound; the derived rows expose useful tail samples without widening model input unboundedly.

The worker collects logs before immutable source reads. Safe path/line references prioritize files within the four-file source budget, and excerpts focus near the referenced line. A structured source-problem operation prioritizes matching references. Up to two slots can inspect referenced files outside a complete changed-file inventory; those reads are marked `changed:false` and do not fabricate diff entries. GitLab readers still enforce their approved project and immutable SHA. Each source excerpt is at most 1,500 bytes; omitted files, unseen lines, failed reads and incomplete source stay unknown. Reference text cannot change the project, acquire privileges or execute source. Jira and Confluence context have a separate bounded transport budget.

Claude must explain a concrete mechanism and competing explanations, distinguish expected errors from business failures, and cite delivered source/log/document IDs. Host validation rejects invented files, moving refs, unseen lines or foreign citations. `remediation` proposes a rollback candidate, forward fix, dependency mitigation or further evidence. A rollback target requires supplied matching environment/provider/project/repository, immutable artifacts, prior verified health and schema/data/configuration/dependency compatibility. The proposal does not establish freshness, permission, causal proof or recovery; the actual action policy is stricter and independent. Data repair is a separate concern from replacing a binary.

The output schema restricts confidence to low/moderate when delivered evidence is synthetic, incomplete, truncated or includes a connector error. The prompt also prohibits high confidence with unknown likelihood, and existing host validation still rejects inconsistent results. This constrains the model before generation without promoting an unsupported conclusion or rewriting its judgment afterward.

Citation fields in the generation schema enumerate the delivered evidence IDs. Mentioned raw-page IDs and references inside source content do not become citable evidence. Source-quality limitations must be nonempty and bounded. The host independently revalidates citations and source locations after generation; an invalid result remains failed rather than being published as a diagnosis.

## Reproduce evaluation

```sh
pnpm test --test-concurrency=4
pnpm sre:dynatrace:eval --live
pnpm sre:dynatrace:eval --live --case regression-100k
pnpm sre:dynatrace:eval --live --case regression-unlabelled
pnpm sre:dynatrace:multi:eval --live
```

The model evaluator uses the actual installed/authenticated restricted Claude CLI, durable SQLite evidence and bounded snapshots. Its authored populations contain 10,000 logs with 1%, 5% or 10% useful evidence beyond the old 2,000-record window, including INFO business failures, old-release counterevidence and expected ERROR noise. Controls exercise incompatible rollback and a dependency outage affecting both releases. The 100,000-record case extends the same workload; the unlabelled case removes business error codes, source paths and stacks. These are controlled examples, not a general diagnosis accuracy benchmark or production throughput proof.

The [concurrent messy-incident workload](DYNATRACE-MULTI-INCIDENT-EVALUATION.md) adds five simultaneous incidents, shared-service populations, severe stack noise, unchanged-file defects, question bursts, fair scheduling, peer exclusion and durable restart through the actual worker. Its scorer's labels remain outside the delivered model snapshot. Native CLI results and synthetic-reasoner queue tests are recorded separately.

`--gitlab-source <private-json>` optionally supplies a previously retrieved immutable GitLab snapshot as `{source:{provider,baseSha,headSha,comparison,sourceFiles,...}}`; the dependency control uses authored corrected source. The evaluator records this distinction. Actual sandbox source does not make the authored logs, deployments, healthy artifacts or compatibility claims real.

Each run writes a private, timestamped directory under `.local/dynatrace-development/` with SQLite evidence, model output, recovery/specification Markdown and a check report. Override the root with `SRE_DYNATRACE_EVALUATION_DIRECTORY`. The evaluator checks useful-tail delivery, exact source localization, cross-source citations, supported remediation, bounded context, raw retention and zero deployment execution. `tests/sre-dynatrace-investigation.test.mjs` covers scope, query budgets, partial/sampled results, schema errors, cancellation/deadline, duplicates, 100,000-record reduction, capacity loss, durable restart, stack-based source priority and invalid rollback proposals. Fixture HTTP calls are not a live Grail test.

## Remaining live acceptance

The available development configuration has no nonempty Dynatrace read token. No live Grail query was accepted during this implementation. The observability/platform owner must supply an approved read identity, actual environment/log fields, retention policy and a bounded sandbox query window. Validate DQL compilation, OAuth/permissions, aggregation and scan metadata, warning/limit behavior, release attribution, redaction and cost against that tenant. Then compare model findings against independently confirmed incidents, including negative cases and varied low-signal populations. The deployment owner must supply actual release/artifact/health/compatibility evidence before any rollback proposal can be operationally supported.

The query design follows Dynatrace's [data-source commands](https://docs.dynatrace.com/docs/platform/grail/dynatrace-query-language/commands/data-source-commands), [aggregation functions](https://docs.dynatrace.com/docs/platform/grail/dynatrace-query-language/functions/aggregation-functions), [DQL language reference](https://docs.dynatrace.com/docs/platform/grail/dynatrace-query-language/dql-reference), and [Query SDK contract](https://developer.dynatrace.com/develop/sdks/client-query/). Tenant validation remains required.
