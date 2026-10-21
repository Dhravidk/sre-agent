# Ally developer handoff

This repository is a transferable implementation starting point for an SRE investigation and incident-collaboration service. It includes the current application source, dependency lockfile, test fixtures, test suite, and operational documentation. The auction application and its business data are fictional. This is an independent prototype for the Smart Auction use case; it does not reproduce Ally's proprietary systems.

The initial integration route described by this project is **ServiceNow read-only MCP + GitLab source/change history + Dynatrace telemetry + Microsoft Teams + an approved Claude runtime + a persistent database/host**. Confirm that route with Ally's owners. GitHub is the distribution location for this checkout; it does not determine where Ally application source or deployment pipelines live.

## Read in order

| Reader | Start here | Next |
| --- | --- | --- |
| Developer or technical lead | This handoff and [architecture](ARCHITECTURE.md) | [Integration checklist](ALLY-INTEGRATION-CHECKLIST.md), then the relevant operational guide |
| Claude Code or another coding agent | Root [AGENTS.md](../AGENTS.md); Claude Code also has [CLAUDE.md](../CLAUDE.md) | [Implementation brief](ALLY-AGENT-PROMPT.md) and source/tests |
| Platform, identity, or service owner | [Integration checklist](ALLY-INTEGRATION-CHECKLIST.md) | Return approved endpoints, service identities, scopes, schemas, and acceptance resources |
| Operator | [Agent operations](AGENT-OPERATIONS.md) | [Backup/restore](BACKUP-RESTORE.md), [database transfer](DATABASE-TRANSFER.md), [deployment approvals](WORKFLOW-APPROVAL.md) |

## What is implemented and what still needs integration

The Node service persists incident evidence, investigations, responder reports, ownership snapshots, Markdown fix plans, tracked PR/MR observations, approvals, jobs, and outbound Teams intents. It supports SQLite and PostgreSQL, bounded provider readers, authenticated webhook ingress, a Teams SDK bridge, and host-controlled Claude subprocess investigations. It can dispatch a configured GitHub/GitLab recovery workflow after its policy and approval checks.

These interfaces still need Ally-specific identities, service mappings, network routes, contracts, and acceptance. The ServiceNow MCP adapter is implemented, but its committed bindings describe a mock, not Ally's actual schemas. The protected recovery workflow, independent release/health publishers, enterprise ownership synchronization, generic isolated QA worker, external ticket writer, and remote MR publisher are not supplied as working Ally integrations. See the checklist for the precise boundary of each.

The offline reasoner recognizes a small set of known auction defects. It is a test mechanism, not a general code analyst. General investigations use the separately configured Claude runtime and require representative evaluation.

Current development prioritizes [noisy Dynatrace-to-GitLab investigation](DYNATRACE-INVESTIGATION.md): explicit service/environment/time query scopes, Grail aggregates and priority/baseline windows, durable redacted log pages, rare-sample provenance, immutable source locations and actual-Claude recovery/specification drafts. Local high-volume inputs and sandbox source reads do not establish live Dynatrace acceptance; the read identity and tenant contract remain unverified.

## Clone and run an offline baseline

Use an authorized GitHub identity that can read this private repository. Repository access is separate from Ally service access.

Requirements: Node.js 24+, Git, and pnpm 11.25.0 (the version used by the provided Dockerfile). Install them through the developer workstation's approved tooling.

```sh
git clone https://github.com/Dhravidk/sre-agent.git
cd sre-agent
pnpm install --frozen-lockfile
pnpm test
pnpm sre:lab
```

Open `http://127.0.0.1:3001`. In a second terminal in the checkout:

```sh
pnpm sre:seed recent-regression
pnpm sre:status
pnpm sre:teams "incidents"
```

The default profile is offline rules with synthetic identities and simulated dispatch. No model inference or vendor access is required. Package installation needs registry access. Before configuring enterprise credentials, run the reproducible offline suite in a clean development environment.

For a multi-team case, run `pnpm sre:rehearsal` and open `http://127.0.0.1:3004`. Its persisted directory is reported at startup; reuse it to check restart behavior. [Casework](CASEWORK.md) explains its fictional teams, ownership, fix-ticket export, and local QA. The original auction website is a separate `pnpm dev` process on port 3000. The port-3002 `pnpm sre:trial:demo` also defaults to rules and mock evidence.

## Prepare an Ally read-only profile

1. Choose one non-production service/environment and an approved operational audience. Obtain the values in the [checklist](ALLY-INTEGRATION-CHECKLIST.md); do not infer CMDB IDs, repositories, Dynatrace entities, or approvers from display names.
2. Keep configuration private:

   ```sh
   mkdir -p .local
   cp .env.example .env
   cp config/sre.connected.example.json .local/sre.ally.json
   ```

   Set `SRE_CONFIG=.local/sre.ally.json` in `.env`. Leave readers disabled until mapped and keep `rollback.enabled:false`. Set `SRE_AGENT_MODE=rules` and `SRE_TEAMS_MODE=off` for the first transport checks. The example's default rollback provider is GitHub; change it to the actual provider only if recovery execution is later in scope.
3. Set a nonempty `SRE_API_TOKEN` and a separate stable `SRE_CAPABILITY_SECRET` of at least 32 characters through the approved secret mechanism. The operator token authorizes the service API across its configured services. Production human access needs Ally's approved identity/audit boundary; the current shared token does not identify an individual operator.
4. Replace logical tenant/service/environment labels and all enabled connector placeholders. Replace quota `retryScope` labels with reviewed nonsecret account labels. Use a new service key when changing the actual service, tenant, or environment. Default HTTP binding is loopback. The example includes release/log/health webhook secret references: remove those unused `webhookSecretEnv` entries until the corresponding publishers are configured, or supply distinct secrets if retaining them. Readiness treats configured release/verification references as enabled. Enabled REST-reader checks also require their configured webhook secrets even when initial intake uses polling; a configured secret does not require exposing an unused route.
5. Select the intended ServiceNow route explicitly. The connected example defaults to REST. For Ally MCP use `servicenow.transport:"mcp"` and reviewed `servicenow.mcp` endpoint, bindings, field paths, and schema pins. Do not copy the mock schemas to a live server without validation. [ServiceNow MCP](SERVICENOW-MCP.md) specifies required discovery, pagination, authentication, and mapping work.
6. Run local configuration inventory before starting a connected service:

   ```sh
   pnpm sre:ready --strict --json
   ```

   This checks local configuration only. It makes zero network calls and does not certify credentials, model login, database access, or workflow protections. With all readers disabled it cannot establish useful incident coverage.
7. Enable one approved reader at a time and configure small real probe resources (`smokeMergeRequest`, `smokePath`, `smokeIncident`, and other source-specific fields described in [integration contracts](INTEGRATIONS.md)). Explicitly run:

   ```sh
   pnpm sre:check --live --json
   ```

   This performs bounded reads/queries, forces rules mode, and creates no Teams sender or rollback client. Exit 0 means its required probes passed; 1 indicates failure and 2 incomplete/unverified coverage. Missing evidence is not a pass. Review query cost and tenant policies with the source owners.
8. Start `pnpm sre:dev` with that scoped profile. Verify recent updates and old active incidents, scope rejection, closures, pagination, stale/denied reads, source timestamps, retry behavior, and restart. Store sanitized evidence outside the repository.

## Add collaboration and reasoning

Provision a new Ally-approved Teams application/bot and HTTPS callback. Supply the Entra tenant/client identity, approved authentication, target conversation IDs, app policy URLs, and installation/consent. The SDK callback is `/api/messages` on port 3978; the main service/webhooks are on port 3001. Keep the operator API/UI private. Start with explicit rooms and mentions; background message capture requires separate consent and acceptance. Build a package with `pnpm sre:teams:package`. Do not reuse an expired trial app, tunnel, account, or credential. See [integration setup](INTEGRATIONS.md#teams-setup-and-commands) and [organization sharing](TEAMS-ORGANIZATION.md#configuration-and-boundaries).

Test two real responders in the actual tenant: join the same incident, exchange updates, receive proactive replies, track ownership and differing theories, leave/rejoin, uninstall/reinstall, and restart. Prove that a different incident or audience cannot receive the shared evidence. Teams transmission and passive-message permissions are separate from provider read access.

Install an approved Claude Code CLI on the service host and provide approved unattended model authentication. Then select `SRE_AGENT_MODE=claude` and the approved optional `SRE_CLAUDE_MODEL`. The host sends bounded evidence via stdin and validates structured output; the child receives no direct vendor tools/MCP or deployment authority. The supplied Node container does not install Claude. [Claude runtime](CLAUDE-RUNTIME.md) documents process, environment, timeout, and authentication boundaries. Local CLI fixtures and earlier personal-account samples do not validate Ally's provider/network route.

Import real, time-bounded ownership/on-call snapshots through the authenticated directory API. The repository has a snapshot contract and fictional fixture, not a connected enterprise directory. Choose an approved importer and source of truth. Roster membership is contact evidence; it does not authorize QA or deployments.

## Optional execution requires additional implementation

Keep the read-only investigation/collaboration pilot useful before introducing writes. If authorized later, the application/deployment owner must implement and test the protected recovery pipeline and trusted release/health callbacks described in [integration contracts](INTEGRATIONS.md#rollback-workflow-contract). Bind exact current and target deployments/artifacts, environment, request ID, approval time/expiry, provenance, and data/schema compatibility. Require independent technical and business checks. A dispatch receipt or green CI job is not recovery proof.

The repository's local QA adapter executes only its trusted fixture. Running arbitrary application source requires a separately designed isolated worker without production credentials. Creating external tickets, pushing fix branches/MRs, merging, or running a deployment are separate capabilities with separate authorization; Markdown plans and local fixture results do not supply them.

## Hosting and operational acceptance

Start with one continuously running service instance and durable storage. Select the approved Ally hosting platform; AWS material in this repo is deployment guidance, not provisioned infrastructure. Configure production database TLS/identity, migrations, secret rotation, clock synchronization, retention, backups/restore, ingress/egress, supervision, and independent alerts. `/health` is liveness plus a database query; use authenticated operations checks (`pnpm sre:health --strict`) to inspect application progress and delivery uncertainty.

Use [database transfer](DATABASE-TRANSFER.md) for a supported offline SQLite/PostgreSQL cutover and [backup/restore](BACKUP-RESTORE.md) for restore holds and lost-interval reconciliation. Do not point a restored database at live senders/writers before reconciliation. Validate native PostgreSQL and the chosen infrastructure separately from PGlite regression coverage.

## Evidence and access limits

See [handoff verification](HANDOFF-VALIDATION.md) for the clean-clone install, current full-suite result and offline checks performed for this publication.

Dated documents preserve development and sandbox checkpoint reports. `.local/` evidence, private trial configuration, databases, generated Git repositories, local QA artifacts, caches, and credentials are intentionally excluded from this checkout. Re-run the committed commands to create evidence in the receiving environment. A reference to a private screenshot/report in an older document is not a bundled artifact or current acceptance result.

No Ally credentials, production data, verified Ally MCP schemas, deployment rights, or system access are transferred with this code. The repository owner must grant developers access to this private repository before they can clone it.
