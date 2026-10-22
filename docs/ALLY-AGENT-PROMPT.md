# Implementation brief for an Ally coding agent

Give this repository to Claude Code or another coding agent in an approved Ally development environment. [JIRA-TICKETS.md](JIRA-TICKETS.md) contains both complete drafts, the review/open decisions, and instructions for deciding what belongs in Jira. [Ticket 01](JIRA-TICKETS.md#ticket-01-dynatrace-logs-and-gitlab-code-findings) requires continuous Dynatrace log ingestion, active diagnostic queries, bounded service/repository/revision discovery, GitLab code findings, and configured outbound Teams webhook delivery. Production AWS VM hosting, `claude -p` console streaming, and storage TBD remain required. [Ticket 02](JIRA-TICKETS.md#ticket-02-future-integrations-and-actions) preserves broader connectors, native Teams conversations, and source-system writes for later.

Copy this prompt with the approved discovery boundary and available configuration when known. The actual service/project/revision mapping remains an agent discovery task:

```text
Implement Ticket 01 in docs/JIRA-TICKETS.md. Read its Instructions for Claude
and Review and open decisions before decomposing work. Production on an AWS VM
remains the delivery target. Local fixtures and historical trials do not
establish production acceptance.

Read AGENTS.md and CLAUDE.md, then docs/JIRA-TICKETS.md,
docs/ALLY-HANDOFF.md, docs/ALLY-INTEGRATION-CHECKLIST.md and docs/ARCHITECTURE.md.
Inspect the code and tests rather than relying on historical checkpoint claims.

Start by installing from the frozen lockfile and running the offline suite.
Inventory the allowed Dynatrace/GitLab discovery boundary, log feed/query
contracts, Teams hook provisioning/contract, Claude route and AWS VM/storage
inputs. The actual service/project/revision mapping is initially unknown and
the agent must investigate it inside the approved boundary. Mark unknown inputs
and identify the owner/input needed; do not invent endpoints, scopes or schemas.

Implement both continuous log ingestion and active, repeated diagnostic queries.
Logs are the primary evidence; polling supports issue discovery/reconciliation.
Support both alert/event intake and configured periodic log-based detection.
Retain durable progress, coverage and overlap identity; do not invent a feed API,
query schema or threshold. Validate the actual approved contracts first.

Discover candidate service/project/revision relationships within the allowed
scope, then collect relevant immutable GitLab source beyond the known auction
fixture. Define/validate finding records against retrieved project/ref/path/line
evidence. Missing runtime/source binding stays unknown; do not substitute latest
branch HEAD for deployed code. Explain the likely failure mechanism and flag
supported files/functions/lines with log and source citations.
Return qualified or inconclusive findings when evidence is insufficient, and
consider dependency/configuration explanations when code attribution is unsupported.
Do not invent log records, code locations, permissions or causal certainty.

Source connectors are Dynatrace and read-only GitLab. Configure the requested
outbound Teams webhook/workflow and implement its approved sender contract;
it does not exist yet. The agent selects useful messages, and the host sends to
the fixed configured destination with durable intent/outcome records. Do not
mirror the whole console stream or infer human acknowledgement from a receipt.
ServiceNow, Jira, Confluence, native Teams requests/history/collaboration and
source-system writes remain Ticket 02 goals. They do not gate this release.
Storage remains TBD until selected.
Keep secrets in the approved system and private runtime configuration; commit only
placeholders and environment-variable references.

Preserve incident/tenant/environment isolation, evidence provenance/completeness,
transactional inbox/jobs/outbox, fencing, retry deadlines and restore holds. Keep
model inference separate from provider read checks. The host
collects evidence; the restricted Claude subprocess receives a bounded snapshot.
Stream user-facing progress/output from claude -p to its own console. Implement
host-controlled follow-up reads and refreshed bounded context, with connector
tools/MCP disabled in the child. Produce code flags as report/console findings
and selected Teams-hook notifications, not GitLab comments or published changes.
Keep connector credentials and execution in the host. The development runtime already streams bounded provisional progress and validates
final structured findings and message requests; the approved route still needs live verification.

Configure and validate the Dynatrace log and GitLab source readers, then evaluate
the approved Claude log-to-code investigations, console streaming and Teams-hook
delivery. Test non-fixture source collection, discovery boundaries, fabricated
locations, known defects, insufficient evidence and non-code cases. Agree the
diagnostic reviewer/cases/pass criteria; a Teams post is not correctness sign-off.
Code attribution must cite verified source. Add focused regressions for real contracts
and record sanitized live acceptance separately from fixture results. Run the
required full suite after behavior changes. Continue useful independent work while
missing enterprise details are resolved.

Leave source-system writers and rollback execution disabled in this release.
Preserve Ticket 02 and its unresolved action/permission contracts.
Additional source/native Teams features, ticket/content writes, remote MR publication,
merges, generic isolated QA and protected deployment recovery need their own
authorized implementation and acceptance.

Deliver code, reviewed configuration templates, updated integration status,
reproducible checks, an operator setup/restore procedure, and a clear record of
what works in our environment, what was only fixture-tested, and what is blocked.
```

## Expected implementation outputs

1. A scoped integration inventory with real contract decisions, approved secret references and unresolved owner questions; no embedded credentials.
2. Code/configuration for continuous/actively queried Dynatrace logs, bounded mapping discovery, immutable application-source reads, validated findings, console streaming and configured Teams webhook delivery, plus meaningful regressions.
3. A production deployment/run procedure for the AWS VM, explicitly selected storage, private console, Claude runtime and Teams hook. Keep storage labeled TBD until selected.
4. Acceptance evidence for the focused flow, with environment, command, observation date, result and limits. Local fixtures, real source reads, real-model quality, webhook delivery and production acceptance have separate results.
5. Updated human and agent documentation that another Ally developer can use without the original chat, developer machine, private trial files or expired tunnel.

Acceptance must address Ticket 01's numbered requirements. Keep Ticket 02 goals deferred. Use the packet's rules to distinguish issues from implementation tasks/questions; old ticket filenames are navigation entry points only. An identified candidate code location or delivered message is not proof of deployed causality or verified recovery.
