# GitLab history and two-team acceptance

The private [test-project](https://gitlab.com/test-group7105743/test-project) contains a runnable fictional auction service, business-invariant tests, structured observation probes and a two-team runbook. Publication and acceptance took place on October 20–21, 2026. All history was created for this drill; ticket labels are fictional. There is no Ally code or customer data.

The published repository has **20 reachable commits and eight branches**. Main contains an earlier concurrency defect, its fix and a healthy release. Each drill branch retains one deliberate behavior or a control. A later CI scaffold repair is preserved in every branch rather than rewriting history.

| Branch | Published SHA prefix | Observed local behavior | Limited agent assessment |
| --- | --- | --- | --- |
| `main` | `3b94b33deda1` | Healthy business checks pass | Healthy baseline; separate dependency injection is unlikely to be deployment-related |
| `codex/drill-bid-race` | `633a2c8995a8` | Lower concurrent bid replaces the accepted winner | Likely; version-guard finding |
| `codex/drill-credit-timeout` | `dcab2b3ed44a` | Normal 25 ms credit response exceeds the 1 ms policy | Likely; timeout finding |
| `codex/drill-catalog-latency` | `a24a37457a97` | Catalog responses exceed the local threshold | Likely; delay finding |
| `codex/drill-late-bid` | `05516a456133` | Bid accepted after auction close | Likely; close-time finding |
| `codex/drill-schema-v2` | `bb27209e790f` | Binary expects a different schema | Unknown overall; conditional schema finding and an additional migration path |
| `codex/drill-healthy-release` | `418931fc3ef5` | Release label changes; business checks pass | Unknown; no new code finding |
| `codex/drill-unknown-service-change` | `a386bc2cb4b9` | Bid amount is incorrectly multiplied by 100 | Unknown; implementation is outside the five-pattern catalog |

The eighth agent case injects credit-provider unavailability into healthy main. It returns `CREDIT_PROVIDER_UNAVAILABLE`, with no deployment candidate. The unfamiliar implementation has a failing business check even though the existing built-in telemetry emits no recognized failure code. The exercise records that limit rather than treating silent telemetry as correctness.

## What was verified

The existing Reporter token read real GitLab project metadata, branch identities, main history, comparisons, immutable file contents, deployment listings and commit-to-MR lookup. A fresh reader-authenticated clone executed the actual published revisions. All 89 branch/file combinations were checked against the prepared source: exact bytes where unchanged, parsed JSON/JavaScript equivalence for editor formatting, and the reviewed CI repair. No source from an unrelated repository was executed.

The agent's normal `IncidentWorker` collector, relational evidence store and rules reasoner passed eight isolated cases using those real reads. Release timing and error events were explicitly simulated replays of local executions. These are not Dynatrace detections or hosted deployment attestations. No GitLab deployments or merge requests exist for this exercise; those live paths remain unverified.

Two real Microsoft identities joined incident `inc_8eb2423dc22c423705a3` in **Fictional GitLab history — Bidding** and **Fictional GitLab history — Platform**. Native authenticated commands and Microsoft reply IDs establish the actual transport. Both rooms received:

- The known version-guard finding and the exact GitLab base/head pair, including the SA-301 code change and subsequent SA-308 CI commit.
- Conflicting recovery claims, a CI-versus-code theory and overlapping recovery work, with a recommendation to use one incident bridge and one owner.
- An explicit release/acceptance handoff: SRE Trial Responder owns the investigation; dhravid coordinates.
- A revised assessment after a separately reproduced dependency failure on the healthy SHA. The agent retained the conditional bidding finding, changed overall attribution from likely to unknown, removed the deployment candidate and informed both rooms.
- Rollback refusal, with no native rollback records or deployment execution.

Briefing acknowledgements prove receipt only, not agreement, completion or recovery. Raw observations and reports remain in the private database. Earlier root-post automation submitted a plain `@SRE` starter; the verified joins were real bot mentions in those threads' replies. Receipt evidence distinguishes attempted UI submission from delivery.

## Fixes found during this drill

The signal display cap initially withheld an otherwise supported bidding hypothesis when it omitted only low-severity, error-free 2xx `/health` responses. The digest now counts these display-only omissions separately. It retains all raw groups and request numbers, does not use health success to establish business recovery, and still withholds attribution for omitted errors, unknown groups, other operations, partial reads or unscanned records. The model transport carries the same coverage distinction.

A ruled-out theory or released task becoming old also generated a new unread briefing despite no operational change. Automatic publication now ignores only those inactive age flags in its change hash. Historical timestamps and age labels remain visible; active work, active theories and service-state expiry continue to trigger fresh coordination.

## Publication and CI boundaries

GitLab rejected the approved second project token with **Access token limit reached**. No writer was created and the reader was unchanged. The signed-in Web IDE published the code and subsequent corrections. No force push or history rewrite was used.

The first disabled CI scaffold lacked a visible job and produced 19 invalid pipeline records. A valid job definition, gated by both `workflow:rules: when: never` and job rules, was then added on all eight branches. GitLab subsequently reports a separate account identity-verification gate. The 27 recorded pipelines have **zero jobs**. Identity verification, hosted CI execution and real deployments were not attempted. Failed CI records are not evidence that the auction business checks ran.

## Repeat the read-only exercise

Keep Claude and deployment execution disabled. With the private reader configuration present:

```sh
SRE_GITLAB_PUBLISHED_MANIFEST=.local/gitlab-published-manifest.json \
  node --env-file=.local/sre.trials.env scripts/sre-gitlab-history-exercise.mjs --live
```

This performs real read-only GitLab requests, creates an isolated local evidence database and runs the rules reasoner. It creates no vendor records or Teams messages. The published clone/manifest are authoritative for these SHAs; the original prepared bundle is retained separately. `seed-gitlab-sandbox.mjs` prepares new local history only and refuses to overwrite an existing checkout, moved refs or local edits.

The real Teams process keeps continuous provider polling disabled. This incident used one controlled GitLab collection through the existing collector; later `status` commands reason over that collected context. Dynatrace, Ally ServiceNow MCP schemas, general Claude reasoning and protected production rollback require separate acceptance. The approved forwarding window runs until **1:40:40 AM America/Detroit on October 21, 2026**. Both incoming and outgoing attempts are gated by that deadline.

The retained evidence is under `.local/acceptance/gitlab-history-2026-10-20/`, including the matrix, native delivery IDs, failed reproductions, source snapshot, screenshots and final test log. Credentials and private databases are excluded from the source snapshot.
