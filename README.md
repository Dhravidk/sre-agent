# SRE Agent

An SRE investigation and incident-collaboration prototype with a persistent Node.js service, Teams bridge, scoped provider connectors, host-controlled Claude reasoning, and a synthetic Smart Auction lab.

**For an Ally developer:** start with the [developer handoff](docs/ALLY-HANDOFF.md), [connector and service checklist](docs/ALLY-INTEGRATION-CHECKLIST.md), and [architecture](docs/ARCHITECTURE.md). They describe what is implemented, what Ally must reconnect or build, and how to validate a read-only pilot.

**For a coding agent:** read [AGENTS.md](AGENTS.md). Claude Code also has [CLAUDE.md](CLAUDE.md). Use the [implementation brief](docs/ALLY-AGENT-PROMPT.md) to adapt the project in an approved Ally environment.

Requires Node.js 24+, Git, and pnpm 11.25.0. Start the persistent integration console with:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm sre:dev
```

Open **http://127.0.0.1:3001**. This defaults to offline rules and synthetic evidence. Ally credentials, internal mappings, verified enterprise MCP schemas, deployment workflows, and production acceptance are not included. Private/generated `.local/` trial evidence and credentials are excluded. Dated checkpoint counts below describe historical runs; rerun the suite for this checkout.

## Smart Auction lab

A local development repository for testing an SRE agent against a synthetic vehicle auction. It includes a working auction website, an executable auction API, deliberately faulty Git releases, an incident engine, connector contract tests, and a Teams SDK bridge.

This is an independent demo for exploring the Smart Auction use case. It contains fictional vehicles, dealers, tickets, telemetry, and deployments. It does not connect to Ally systems or reproduce Ally's proprietary implementation.

## Run it

Requires Node.js 24+ and Git. No Docker or AWS account is required.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:3000**. Place a bid, choose **Concurrent bid regression**, and click **Deploy & send traffic**. The SRE console shows the resulting business invariant violation, the actual Git diff, linked synthetic Jira key, and recovery considerations. Its chat uses the same question handler as the Teams bridge.

The default launcher uses deterministic rules. It makes no model calls or calls to AWS, Dynatrace, GitLab, Jira, or Teams. Dependency installation needs network access; after installation, the following direct commands work without a package manager contacting its registry:

```sh
node src/server.mjs
node --test tests/*.test.mjs
```

Use a Node.js 24+ installation from your development environment; no developer-specific executable path is required.

## Simulate changes and requests

Keep the server running in one terminal. In another:

```sh
node scripts/cli.mjs scenario bid-race
node scripts/cli.mjs ask "Investigate auction-api and explain recovery options"
node scripts/cli.mjs traffic
node scripts/cli.mjs reset
node scripts/cli.mjs scenario dependency-outage
```

| Scenario | Executed behavior | Expected SRE outcome |
| --- | --- | --- |
| `healthy-release` | Changes release label; catalog stays healthy | No configured incident |
| `bid-race` | Removes optimistic version check; concurrent bids overwrite the winner | Detect a winning-bid regression; identify a candidate prior artifact |
| `credit-timeout` | Reduces timeout below the fixture provider's response time | Detect credit timeouts; correlate with the deployed change |
| `schema-break` | New application expects schema v2 against a v1 store | Detect incompatibility; withhold rollback guidance that assumes compatibility |
| `catalog-latency` | Introduces a 350 ms catalog delay | Detect latency above the demo threshold |
| `late-bid` | Removes close-time validation; advances a test clock | Detect an accepted bid after auction close |
| `dependency-outage` | Makes the simulated credit provider unavailable | Identify dependency failure; do not blame a deployment or recommend rollback |

The scenarios execute changed code and measure requests. The schema test uses an in-memory schema version and a migration fixture; it does not run a real database migration. The credit provider is simulated. The deployment artifacts are fixture hashes, not built container images.

Each scenario resets auction data and traffic samples. Incident history remains until **Reset local lab**. The auction itself is in memory; incidents, reviews, and pending notification intents persist in SQLite across restarts.

## The custom pilot repository

First startup or `pnpm pilot:seed` creates **`.local/auction-pilot`**, an independent Git repository with a healthy `main` commit and seven `scenarios/*` branches. Every scenario has a real commit and a synthetic `SA-10x` ticket association. The website loads only these generated, trusted policy revisions.

```sh
git -C .local/auction-pilot branch --list
git -C .local/auction-pilot diff main scenarios/bid-race
```

The generated repository is the auction API under test. The surrounding repository supplies the website and SRE test harness. The pilot remains local until published to a dedicated sandbox. `pnpm sre:sandbox:package` produces a checked Git bundle with the healthy baseline and seven exact scenario branches, excluding the parent workspace and unrelated history. It verifies a bare clone before reporting success. [GitHub publication and acceptance](docs/GITHUB-SANDBOX.md) covers the access steps and real fault/rollback tests. For GitLab, publish to a dedicated test project and create an MR from a scenario branch. Do not use the fixture loader to execute arbitrary submitted code; production review needs an isolated runner with no service credentials.

## Database-backed SRE integrations

Run the integration service in a second terminal:

```sh
pnpm sre:dev
```

Open **http://127.0.0.1:3001**. The console provides four full-flow fixtures: recent bidding regression, six-month-old feature, incompatible schema change, and dependency outage. The separate auction website remains on port 3000.

To test collaboration, select an incident and click **Link selected incident** in the Teams simulator. After its confirmation appears, choose **Alex** or **Sam** and **Responder conversation** to report progress. Switch to **Mention the agent** and send `status`. The responder timeline and reply show the retained context; each selected incident uses its own simulated thread. Offline rules display reports without interpreting arbitrary instructions.

```sh
pnpm sre:seed recent-regression
pnpm sre:status
pnpm sre:teams "incidents"
pnpm sre:teams "join <incident-id>"
pnpm sre:teams "update Restarted the bidder; timeouts persisted"
pnpm sre:teams "status"
pnpm sre:teams "rollback <incident-id>"
# Copy the exact approve command from the proposal into the Teams simulator.
pnpm sre:ask <incident-id> "What evidence would change your assessment?"
```

Local mode uses synthetic identities and only simulates rollback dispatch. It rejects live connectors and public binding. Outbound Teams messages remain in the database when the Teams sender is off. Use `SRE_TEAMS_MODE=playground pnpm sre:dev` to exercise the current database-backed bridge on port 3978, without live Teams credentials. The older `teams:playground` script belongs to the original port-3000 lab and should not be run on the same port concurrently.

For an interactive trial, run `pnpm sre:trial:demo` and open **http://127.0.0.1:3002**. The launcher currently defaults to **offline rules with fictional provider evidence**, simulated Teams identities and simulated rollback dispatch. Two configured groups can join the same incident, exchange attributed briefings, report differing team states, and review the shared coordination view. No Claude inference runs by default. For the later actual-model trial, explicitly use `SRE_TRIAL_DEMO_AGENT_MODE=claude pnpm sre:trial:demo`. The ServiceNow fixture exposes the 45 permitted read tools over loopback MCP; live readers and Teams delivery remain disabled. Questions, responder reports, per-room deliveries and approval records persist in SQLite. See [multi-group coordination](docs/TEAMS-COORDINATION.md), [trial acceptance](docs/TRIAL-ACCEPTANCE.md), and [the unverified Ally MCP contract](docs/SERVICENOW-MCP.md).

A separate [real Teams transport trial](docs/LIVE-TEAMS-TRIAL.md) passed authenticated mentions/replies in two actual team channels, conflicting theories, duplicate work, missed updates, handoffs, restart and removal/reinstall. Its incident evidence is fictional, Claude is off and deployments are disabled. That checkpoint passed **588 tests**; the trial record gives its temporary access window and remaining live checks.

The optional [organization-wide Teams profile](docs/TEAMS-ORGANIZATION.md) supports team channels and group chats in one tenant, verifies sender membership through Bot Connector, and shares context only between conversations joining the same incident. The current suite passes **761 tests**. Two actual Microsoft accounts passed live mentions, attribution, shared briefings, conflicting theories, duplicate work, missed acknowledgements, handoff, leave/rejoin and restart. The second account also found and installed the published app in a newly created test team without tenant admin rights. Live testing improved message formatting and durable room names; a regression test exposed and fixed a rollback-proposal request targeting a different incident than its joined thread. A source-aware evidence window and reserved model budget retain GitLab history during Dynatrace log storms. The new `signals` command groups repeated observations, preserves rare errors and release/region distinctions, and marks partial coverage. Contrary log-only evidence keeps deterministic attribution unknown; parsed code findings remain conditional. Claude and deployment execution stay off, and the approved trial deadline gates both incoming messages and outbound delivery. Ally tenant policies, actual Claude reasoning and production rollback remain separate acceptance steps.

The [GitLab sandbox acceptance](docs/GITLAB-SANDBOX.md) now uses a private repository with 20 commits and eight branches. The read-only collector fetched actual source and comparisons, and eight agent cases covered known faults, a benign release, an unfamiliar implementation and a dependency failure. Both real Teams users received the code findings, conflict warnings, ownership handoff and revised assessment after contrary evidence. Display-only health-success omissions no longer suppress a separately supported code finding; inactive age flags no longer create unread coordination rounds. Claude and deployment execution remain disabled.

The current [casework iteration](docs/CASEWORK.md) adds a fictional worker desk, sender-fair discussion context, evidence-backed contact recommendations, downloadable Markdown fix tickets and a reviewed local QA branch workflow. Explicit error-code log monitors can open incidents without a prior human report; their counts and overlapping-read identities persist in the database. Signed workflow alerts can bind the agent reply to an installed alert thread. MR heads, CI updates and deployment observations remain distinct in the change timeline. These new provider/workflow paths use local protocol fixtures; the real organization trial remains mention-only with Claude, QA execution and deployments disabled. The [distributed dispatch design](docs/DISPATCH-DESIGN.md) is a proposal for review and has not been implemented.

For a populated, persistent rehearsal, run `pnpm sre:rehearsal` and open **http://127.0.0.1:3004**. It uses its own database under `.local/sre-rehearsal`, leaving the existing port-3002 demo intact. Start with **Open EU bidding incident**: three joined conversations contain conflicting theories, duplicate work, a quiet worker and explicitly unread drawing metadata. **Open separate US provider incident** follows a different region/release in two other conversations. A separate MR risk review is retained. Scripted log thresholds open the EU incident before human messages; a mock ServiceNow reader joins its explicitly correlated ticket. Provider records, people and CI results are fictional; source bytes and approval-gated local QA branches/tests are real. Claude, native Teams, remote Git publication and live deployments stay off. Reopening the same directory retains incident identities, discussions, plans and QA history. See [the rehearsal walkthrough](docs/CASEWORK.md#persistent-multi-team-rehearsal).

A tested [offline database cutover](docs/DATABASE-TRANSFER.md) transfers tracking between SQLite and PostgreSQL without losing incident identities, tickets, conversation links or completed QA artifacts. Import and restore quarantine commit together; old approvals, counters and directory snapshots cannot silently become current. A native PostgreSQL roundtrip is retained separately from the SQL contract tests. Linked MR updates refresh their operational incident, CI stays tied to observed change SHAs, and completed QA is marked historical when its approved evidence moves. Results from an in-flight review become superseded if the incident or authorization changes. Participants can use `track-change gitlab 72` or the console form to associate an observed forward-fix MR; attribution stays in the database and Markdown plan. A link is context, not cause or action approval. Mistaken links can be withdrawn with a reason and explicitly reconsidered against the reviewed audit reference. Withdrawal survives restart, restore and database cutover; repository rediscovery cannot silently recreate it. The console isolates incident selections during delayed reads: old responses cannot display under a different incident, actions retain their reviewed incident, and drafts stay separate for each incident within the current browser tab. Those unsent drafts are not database records. [Tracked MR/PR readers](docs/CHANGE-READS.md) reconcile missed updates, retain separate provider/read times and collect associated forward-fix code at the observed head. GitLab head-pipeline visibility is recorded separately; unknown CI and merge state do not establish deployment or recovery. MR metadata, optional CI evidence and its read receipt now commit together; a failed pipeline write preserves the prior accepted result. Earlier CI receipts without verified source references remain unknown until refreshed. Current CI views reconcile delayed and conflicting reports with saved source facts. Lost/restored CI visibility queues durable reassessment even when MR metadata stays unchanged; changed understanding reaches joined teams while repeated status stays quiet. Change history now groups repeated CI deliveries with status/time references, distinguishes active links from retained/shared-commit context, and reserves linked MR facts against a noisy source window. The console, Teams history command and new Markdown tickets use the same projection; raw facts stay retained. The native drill also found and fixed a QA patch export missing its final newline; new patches are checked by applying them to a clean trusted checkout.

### Implemented integration path

- Authenticated webhooks and bounded reconciliation reads for Dynatrace, GitHub, GitLab, Jira, and ServiceNow; signed custom release, log, and health-verification events.
- Dynatrace Classic problems/metrics, bounded Grail log queries, and configurable sustained metric thresholds. ServiceNow incidents are explicitly scoped by CMDB CI. Jira provides read-only ticket context; it never creates or updates tickets.
- A relational SQLite/Postgres inbox, per-issue session identity, jobs, evidence, release ledger, assessments, Teams conversations/outbox, and rollback audit records. Events are committed before acknowledgement and processing. One leased investigator runs at a time; each issue retains its own session.
- GitHub PR, merge queue, check/workflow, deployment events; GitLab MR, pipeline, and deployment events. Commit-to-PR/MR lookup and Jira key extraction provide change intent. Reviews are advisory; they do not block merges or post repository comments.
- Teams SDK authenticated input, tenant/conversation allowlists, persisted commands, proactive delivery, incident binding, and explicit approval by allowlisted Entra object IDs. The app package supports personal/team/group chat; optional RSC consent enables background responder updates in linked incident threads. Author/timestamp/context survive restarts and reach the same issue's model session. Use mentions to give instructions; passive discussion cannot approve actions. See the Teams setup and local simulation flow in [INTEGRATIONS.md](docs/INTEGRATIONS.md#teams-setup-and-commands).
- GitHub Actions and GitLab pipeline rollback dispatch after a fresh policy check and explicit approval. A deployment-specific protected rollback workflow must be installed separately. Dispatch is never reported as recovery. Ambiguous writes are not automatically retried.
- An Ally connected worker using **Claude Code `claude -p`**, bounded incident context, validated structured output and no shell/deployment tools. Incident conversations remain in the application database across restarts. OpenAI credentials and an Eve service are unnecessary for this profile. [Claude setup and validation limits](docs/CLAUDE-RUNTIME.md) cover authentication and deployment. Explicit legacy Eve mode remains available; the offline worker uses deterministic fixture rules.

The console now includes **Agent health** for stale polling, failed/exhausted work, loop progress, and uncertain notifications/actions. Exhausted read-only investigations can be resumed through an audited console, API/CLI, or direct Teams retry; the original failure remains intact. The same report is available through authenticated `/api/operations` and `pnpm sre:health`. Connected Teams can post scoped condition-change and recovery notices. See [agent operational checks](docs/AGENT-OPERATIONS.md). Uncertain/failed messages also support an [audited operator inspection](docs/DELIVERY-INSPECTIONS.md) for manual follow-up; it preserves transport state and reopens review when new evidence arrives.

### ICD 203 analytic skill

`agent/skills/icd203-sre/SKILL.md` adapts the supplied ODNI directive for change risk and outage assessment. The required output separates likelihood from confidence, includes evidence-quality limitations, assumptions, alternatives, contrary evidence, monitoring indicators, and changes from the previous judgment. Assessments retain the review stage, exact reviewed/merged SHA where available, environment, and forecast horizon.

Before/at merge, the forecast is conditional on deployment. At runtime it concerns further degradation; observed failures remain facts. Fixture mode returns `unknown` for real-world outage likelihood. Model forecasts are uncalibrated until evaluated against representative outcomes. This adaptation is not a certification or an outage prediction algorithm supplied by ODNI. See [the source directive](https://www.intelligence.gov/assets/documents/intelligence-community-directives/ICD_203.pdf).

### Rollback policy

Prefer rollback only for an implicated recent deployment (24-hour default) with a recent independently healthy immutable target. Require matching schema, dependency, configuration, and feature-flag fingerprints plus affirmative compatibility and data-safety attestations from trusted release metadata. Old features, incompatible migrations, unrelated dependency failures, incomplete identity, revoked approvers, and stale proposals fail closed. Configuration can tighten these limits. Reverting an old feature's Git history is never the rollback mechanism.

### Verification and remaining boundaries

Earlier local verification: **565 tests pass**, including 25 multi-group coordination cases. Browser operation verified two groups following one incident, contradictory reported states, a correction, wrong-group approval rejection, an authorized simulated rollback and shared action status. These checks used offline rules and mocks. Actual Teams SDK transport was exercised against two loopback group-chat destinations; live Teams installation/consent and arbitrary natural-language coordination through Claude remain unverified. [The development record](docs/DEVELOPMENT.md) preserves scope and evidence.

```sh
pnpm sre:drill bid-race
pnpm sre:drill late-bid
pnpm sre:exercise 21
pnpm sre:process-exercise # actual local server replacement and retained bid/receipt checks
pnpm sre:soak 1 1 # real-clock process/crash smoke test with synthetic providers
pnpm sre:ready --json
pnpm sre:health # reads the running service
```

Each drill writes its database and report under `.local/recovery-drills/`. The bid-race drill demonstrates that redeployment leaves corrupted winning-bid state behind, then performs an explicit synthetic operator reconciliation while preserving bid history. The late-bid drill withholds resolution because its accepted late transactions still require a separate recovery procedure. Healthy releases, dependency failures, and incompatible schemas exercise the alternative decisions. See [development evidence and next steps](docs/DEVELOPMENT.md).

The [local process deployment tests](docs/PROCESS-ROLLOUT.md) pass all seven auction scenarios plus lost-receipt, same-SHA redeployment, queued-approval expiry and write-credential recovery cases. They replace real auction server processes, retain accepted bids/request receipts in SQLite, and independently check the stored business invariants. GitHub workflow transport and Teams identities in those deployment exercises remain fixtures.

The [networked PostgreSQL exercise](docs/POSTGRES-EXERCISE.md) passes fifteen cases with two real Node processes and a local PostgreSQL 17.11 server. It found and fixed simultaneous schema-startup collisions, stale result publication after lock waits, and agent crashes on dropped database connections. Interrupted inbox writes roll back, redelivery remains idempotent, and running work survives agent SIGKILL or an immediate PostgreSQL shutdown followed by WAL recovery. Provider/model transports remain synthetic.

Rollback approvals now retain their expiry across workflow queues. A signed independent no-change result can reconcile a rejected request while keeping the incident open; a new action still needs a new explicit approval. Completed receipt replays cannot repeat deployment. See [the version-3 workflow contract](docs/WORKFLOW-APPROVAL.md).

Rules diagnosis now requires a matching observed symptom and a complete comparison of the exact deployed source pair. Its five policy checks parse source without executing it; negative cases cover coincidental releases, comments, pre-existing faults, moving review heads, missing evidence and competing dependency failures. Optional model evidence is bounded across metadata and source content while preserving the local audit. See [the attribution and transport limits](docs/ATTRIBUTION.md).

Startup reconciliation discovers older open Dynatrace/ServiceNow issues, and polling health is bound to the current service/source configuration. Correlated ServiceNow tickets retain independent lifecycle states. Storage failures return a retryable HTTP 503 after an uncommitted ingress attempt. Process-soak results concern their own frozen sources, including the retained later timeout. See [the soak procedure and evidence limits](docs/PROCESS-SOAK.md).

Earlier browser checks confirmed explicit simulated approval and rejection of the six-month-old rollback. Teams collaboration tests cover multi-responder context, thread isolation, restart, passive command rejection, bounded context during telemetry floods, and channel reply routing through the actual SDK. The placeholder demo app ZIP remains for schema checks; the separate real Teams trial uses its reviewed app/bot identities and installed mention-only package.

The test suite covers auction defects, SQLite restart/idempotency, worker fencing, graceful shutdown, Postgres SQL execution through PGlite, vendor HTTP contracts, signed ingress, metric polling, actual Teams SDK local transport and live-auth rejection, ICD 203 validation and review transitions, approval authorization, stale rollback checks, concurrent/reclaimed rollback workers, deployment identity changes, and uncertain dispatch handling. Recovery proofs must be fresh, identify the exact artifact/deployment, follow closure of all incident sources, and attest technical health and business invariants. `pnpm agent:build` checks the optional Eve package without a model call.

Ally vendor credentials, target-tenant Teams installation/consent, the actual deployment workflow, real model-quality evaluation, and AWS infrastructure validation are still required. The later real Teams checkpoints establish standard test channels and a two-person group chat using two Microsoft accounts in the trial tenant. Docker is unavailable on the current machine: the container/Compose recipes have not been executed. The native PostgreSQL tests establish bounded local concurrency, reconnection and logical backup/restore behavior; RDS, production networking/TLS, replica failover and production backup/restoration remain unverified. No AWS resources or live deployment recovery actions have been performed. Claude trial calls use the host’s existing CLI authentication; no Ally model identity has been validated.

The original `src/core/` and SQS-shaped adapter remain an isolated auction teaching fixture. The new `src/sre/` service owns the integration workflow and relational database. Use that path for connected development and AWS packaging. Neither local simulation nor mocked connector success establishes real tenant access.

## Setup and operations

- [Integration configuration, webhook contracts, Teams, and rollback workflows](docs/INTEGRATIONS.md)
- [Local testing and promotion to AWS](docs/LOCAL-TO-AWS.md)
- [Original architecture review](docs/PLAN-REVIEW.md)

Requires Node.js 24+, Git, and pnpm. `.env.example` lists configuration names; secrets stay in ignored local files or the deployment secret store. Source-level redaction removes common credential patterns but is not a comprehensive PII scrubber. Set service-specific retention and upstream log filtering before using real business data.
