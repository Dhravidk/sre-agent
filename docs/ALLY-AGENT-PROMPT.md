# Implementation brief for an Ally coding agent

Give this repository to Claude Code or another coding agent in an approved Ally development environment. The agent needs the checkout plus authorized access to the relevant engineering standards, service owners, secret references, non-production resources and sanitized API/MCP contracts. The checkout alone cannot provide enterprise access or settle missing service policies.

Copy this prompt, adding the actual service/environment and approved sources of configuration:

```text
Implement this SRE agent for our approved Ally service and non-production environment.

Read AGENTS.md and CLAUDE.md, then docs/ALLY-HANDOFF.md,
docs/ALLY-INTEGRATION-CHECKLIST.md and docs/ARCHITECTURE.md.
Inspect the code and tests rather than relying on historical checkpoint claims.

Start by installing from the frozen lockfile and running the offline suite.
Inventory the actual service, environment, source repository, ServiceNow CI/MCP,
Dynatrace entity/log mappings, Teams audience, model route and hosting/database
against our available authorized configuration and standards. Mark unknown items
and identify the owner/input needed; do not invent endpoints, scopes or schemas.

Implement a scoped read-only pilot first. Use ServiceNow MCP only after comparing
the real tools/list definitions and sanitized responses with the enforced allowlist
and bindings. The mock MCP contract is not our enterprise contract. Confirm whether
GitLab, GitHub, Jira and each telemetry source are actually part of this service.
Keep secrets in the approved system and private runtime configuration; commit only
placeholders and environment-variable references.

Preserve incident/tenant/environment isolation, evidence provenance/completeness,
transactional inbox/jobs/outbox, fencing, retry deadlines and restore holds. Keep
model inference and Teams delivery separate from provider read checks. The host
collects evidence; the restricted Claude subprocess receives a bounded snapshot.

Configure and validate the real readers one at a time, then actual Teams identity,
installation and incident sharing, the approved Claude service runtime, and a fresh
ownership/on-call importer. Add focused connector regressions for real contracts
and record sanitized live acceptance separately from fixture results. Run the
required full suite after behavior changes. Continue useful independent work while
missing enterprise details are resolved.

Leave rollback execution disabled during this pilot. Report separately the work
needed for the protected recovery pipeline, signed release metadata, independent
technical/business health proof, generic isolated QA, external ticket writes and
remote MR publication. Do not enable those capabilities unless our task explicitly
authorizes them and their owners' contracts have been implemented and tested.

Deliver code, reviewed configuration templates, updated integration status,
reproducible checks, an operator setup/restore procedure, and a clear record of
what works in our environment, what was only fixture-tested, and what is blocked.
```

## Expected implementation outputs

1. A scoped integration inventory with real contract decisions, approved secret references and unresolved owner questions; no embedded credentials.
2. Code/configuration for the selected sources, mapped against observed schemas and resource identities, plus meaningful regressions.
3. A deployment/run procedure for the chosen host, database, Teams callback, private operator access and Claude runtime.
4. Acceptance evidence for each enabled capability, with environment, command, observation date, result and limits. Local tests, external reads, Teams transport, model quality and execution have separate results.
5. Updated human and agent documentation that another Ally developer can use without the original chat, developer machine, private trial files or expired tunnel.

Read-only adoption can finish with explicit execution follow-up work. A working read-only incident flow must never be described as a validated production recovery system.
