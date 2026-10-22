# Implementation brief for an Ally coding agent

Give this repository to Claude Code or another coding agent in an approved Ally development environment. The current requested scope is the [production Jira ticket](JIRA-SRE-AGENT.md): six context integrations, both provider-event and Teams-request triggers, `claude -p` console streaming, selective agent-requested Teams messages, an AWS VM, and storage TBD. The agent needs authorized standards, service-owner inputs, secret references, validation resources, and sanitized API/MCP contracts. The checkout alone cannot provide enterprise access or settle missing service policies.

Copy this prompt, adding the actual service/environment and approved sources of configuration:

```text
Implement the production SRE agent on an AWS VM according to
docs/JIRA-SRE-AGENT.md. Production is the delivery target; local fixtures and
historical trial results do not establish production acceptance.

Read AGENTS.md and CLAUDE.md, then docs/HUMAN-GUIDE.md,
docs/JIRA-SRE-AGENT.md, docs/ALLY-HANDOFF.md,
docs/ALLY-INTEGRATION-CHECKLIST.md and docs/ARCHITECTURE.md.
Inspect the code and tests rather than relying on historical checkpoint claims.

Start by installing from the frozen lockfile and running the offline suite.
Inventory the actual service/environment, GitLab projects, ServiceNow mappings,
Dynatrace entities/signals, Jira projects, Confluence spaces/pages, Teams audience,
Claude route and AWS VM/storage contracts
against our available authorized configuration and standards. Mark unknown items
and identify the owner/input needed; do not invent endpoints, scopes or schemas.

Implement all six required context integrations: Dynatrace, ServiceNow, Teams,
GitLab, Jira and Confluence. Support both provider-event and Teams-request triggers.
Source-system create/update operations belong to a future extension; selective
Teams messaging is in scope now. Storage remains TBD until explicitly selected.
If using ServiceNow MCP, compare the real tools/list definitions and sanitized
responses with the enforced allowlist and bindings. The mock contract is not our
enterprise contract. Do not add GitHub as a requirement because it hosts this code.
Keep secrets in the approved system and private runtime configuration; commit only
placeholders and environment-variable references.

Preserve incident/tenant/environment isolation, evidence provenance/completeness,
transactional inbox/jobs/outbox, fencing, retry deadlines and restore holds. Keep
model inference and Teams delivery separate from provider read checks. The host
collects evidence; the restricted Claude subprocess receives a bounded snapshot.
Stream user-facing progress/output from claude -p to its own console. Let the
agent select an explicit Teams-message action; the host validates scope and sends
through the durable outbox. Keep connector credentials and delivery execution in
the host. Do not automatically forward the full console stream into Teams.
The development runtime implements bounded progress streaming and validated
model-selected message requests. Validate these against the approved Claude
runtime and live Teams delivery; local fixtures do not establish acceptance.

Configure and validate the real readers one at a time, including the missing
Confluence integration, then actual Teams identity/installation, incident sharing,
the approved Claude runtime, console streaming and selective message actions.
Add focused connector regressions for real contracts
and record sanitized live acceptance separately from fixture results. Run the
required full suite after behavior changes. Continue useful independent work while
missing enterprise details are resolved.

Leave source-system writers and rollback execution disabled in this release.
Document the future create/update extension and unresolved action/permission
contracts. Protected recovery pipelines, independent release/health proof, generic
isolated QA, ticket/content writes, remote MR publication and merges need their
own authorized implementation and acceptance.

Deliver code, reviewed configuration templates, updated integration status,
reproducible checks, an operator setup/restore procedure, and a clear record of
what works in our environment, what was only fixture-tested, and what is blocked.
```

## Expected implementation outputs

1. A scoped integration inventory with real contract decisions, approved secret references and unresolved owner questions; no embedded credentials.
2. Code/configuration for all six context integrations, both trigger routes, console streaming and selective Teams-message actions, mapped against observed contracts, plus meaningful regressions.
3. A production deployment/run procedure for the AWS VM, explicitly selected storage, Teams callback, private operator access and Claude runtime. Keep storage labeled TBD until selected.
4. Acceptance evidence for each enabled capability, with environment, command, observation date, result and limits. Local tests, external reads, Teams transport, model quality and execution have separate results.
5. Updated human and agent documentation that another Ally developer can use without the original chat, developer machine, private trial files or expired tunnel.

Acceptance must address the numbered ticket requirements. Context-only source integrations and selective Teams messaging can be a production release; deployment recovery execution remains a separate capability and must not be implied by that release.
