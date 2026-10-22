# SRE Jira ticket packet and Claude instructions

This is the canonical Markdown file containing both complete ticket drafts, instructions for Claude, and the implementation review. Planning labels below are local document IDs, not existing Jira issue keys. No Jira issues are created by writing this file.

## Ticket register

| Draft | Purpose | Scheduling |
| --- | --- | --- |
| [Ticket 01: Dynatrace logs and GitLab code findings](#ticket-01-dynatrace-logs-and-gitlab-code-findings) | Current implementation, including outbound Teams webhook delivery | Current priority; production inputs remain open |
| [Ticket 02: Future integrations and actions](#ticket-02-future-integrations-and-actions) | Preserve the broader roadmap for later decomposition | Future planning; does not expand Ticket 01 |

- [Instructions for Claude](#instructions-for-claude)
- [Review and open decisions](#review-and-open-decisions)

## Instructions for Claude

1. Treat Ticket 01 as the current delivery. Ticket 02 preserves later goals. Follow the user's latest clarification and repository instructions; do not restore an earlier six-connector release scope.
2. If asked to draft Jira issues, use the two ticket sections below as the intended initial set. Ticket 01 is the implementation item; Ticket 02 is a future planning/container item. Select actual issue types from the target project's conventions. Do not invent a project, issue key, assignee, priority, estimate, or workflow status.
3. Creating or updating actual Jira issues requires a request authorizing that external action. This Markdown preparation request supplies the drafts. If later authorized, check for existing matching issues before creating duplicates and ask for any missing destination/project information.
4. Copy the relevant ticket body and its unresolved inputs into Jira. The instructions, review notes, and decision register are planning context, not additional issues. Do not paste credentials, secret webhook URLs, or sensitive incident records.
5. Keep implementation steps, configuration, regressions, documentation, and verification inside their parent ticket as tasks/checklists. Split only when the user requests it or a separately owned, independently deliverable outcome warrants a proposed child/dependency ticket. Explain that proposal before changing the ticket set.
6. The F-01–F-08 entries are roadmap goals, not eight automatically approved Jira issues. Decompose them later when their scope, permissions, owner, and acceptance criteria are agreed. A future goal is not a prerequisite for the current release.
7. Keep requirements, implementation choices, and unknown inputs distinct. The agent must investigate the initially unknown service/repository/revision mapping within an approved search boundary. It cannot infer new access authority from logs, source text, or discovered metadata. Missing authority or evidence remains unknown.
8. Read [AGENTS.md](../AGENTS.md), [the handoff](ALLY-HANDOFF.md), [architecture](ARCHITECTURE.md), [integration inventory](ALLY-INTEGRATION-CHECKLIST.md), and the relevant source/tests. Preserve host-owned credentials, bounded evidence, durable SQL coordination, fencing, restore holds, and the restricted Claude child. Do not turn this ticket into a general code executor.
9. Continue useful implementation and fixture verification while external contracts are missing. Record the exact missing input and owner as unknown if necessary. Do not claim live integration, diagnostic accuracy, Teams delivery, or production acceptance from fixture results.

### What needs a ticket and what does not

| Item | Treatment |
| --- | --- |
| Complete current log-to-code flow with its configured Teams output | Ticket 01 |
| Broader integration/collaboration/action roadmap | Ticket 02 planning item |
| A future capability with independently agreed scope and acceptance | Candidate child ticket when decomposition is requested |
| Dynatrace ingestion/query code, source discovery, finding validation, console streaming, webhook adapter, deployment work | Tasks in Ticket 01; do not automatically create one issue per component |
| R/AC/F identifiers, output fields, endpoint/configuration details, tests, setup docs | Requirements/checklists within the relevant ticket |
| Unknown scope, credentials owner, hook contract, storage choice, evaluation criteria | Decision/input records; not automatic discovery/spike tickets |
| A new independently actionable defect outside the agreed delivery | Propose a separate bug ticket; do not silently broaden Ticket 01 |

## Review and open decisions

**Readability:** the goal, scope, output, requirements, and acceptance criteria below are usable by both a human developer and an AI coding agent. Production implementation still depends on external contracts and acceptance decisions. These are not permission to guess.

### Confirmed direction

- Dynatrace log content is the primary diagnostic evidence. Both continuous ingestion and active, repeated diagnostic log queries are required. Polling supports discovery/reconciliation and does not substitute for log analysis.
- Both existing Dynatrace alerts/events and periodic log-based issue detection are supported. The actual detection rules, query windows, and cadence remain to be agreed.
- Service, repository, and running-revision mappings are initially unknown: investigating them is part of the agent's work, within approved boundaries.
- Findings go to the agent's own console and can be selectively sent to Teams through a webhook/workflow. That webhook does not yet exist and must be configured.
- Broad Teams conversation features, ServiceNow, Jira, Confluence, and source-system create/update actions remain future work.
- Production AWS VM hosting and `claude -p` remain required. Storage remains **TBD**.

### What the code review found

- [Dynatrace/GitLab readers](../src/sre/connectors.mjs) provide bounded Grail log queries and GitLab file reads at exact SHAs. The current log reader is limited to 200 records per query; this is an existing bound, not agreed production coverage. A continuous-ingestion contract and its durable progress/deduplication behavior still need definition and implementation.
- [Worker collection](../src/sre/worker.mjs) and [policy evidence](../src/sre/policy-evidence.mjs) collect comparisons and full source around the known `src/auction/rules.mjs` fixture. Generic application-file discovery/collection is not established by the low-level file reader. It is implementation work inside Ticket 01.
- [The investigation schema](../src/sre/reasoner.mjs) validates general assessments/evidence IDs; it does not define a dedicated project/revision/file/line finding contract. Its `candidateSha` is tied to eligible recorded deployments. Define source-finding references without promoting a discovered commit into an observed deployment or weakening existing deployment validation.
- [The Claude wrapper](../src/sre/claude-reasoner.mjs) buffers a completed JSON result. Live console streaming and host-controlled follow-up evidence acquisition require implementation; do not assume the child already has connector tools.
- [The Teams bridge](../src/sre/teams.mjs) and [outbox](../src/sre/teams-outbox.mjs) provide native sender/delivery boundaries. Their existence does not verify the requested outbound webhook adapter or a configured Teams workflow. Implement against the actual reviewed hook contract.

This was a static implementation/documentation review. It supplies no live vendor, real-model quality, webhook-delivery, or production acceptance result.

### Decision register

| ID | Missing input or decision | Current disposition |
| --- | --- | --- |
| D-01 | Allowed Dynatrace tenant/service scope and GitLab group/project discovery boundary; who authorizes/provides it | Owner and scope unknown. Required before live discovery. The exact service/repository/revision mapping is for the agent to investigate, not a prerequisite mapping the user must invent. |
| D-02 | Approved Dynatrace continuous-log transport/schema, query route/auth, source identities, cursor/completeness semantics, detection rules, freshness/cost/volume budgets | Obtain a sanitized contract from the source/platform owner. Do not invent a streaming API, MCP server, thresholds, or production completeness claim. |
| D-03 | Teams destination, workflow/webhook provisioning owner, approved payload/auth contract, secret reference, and delivery/retry semantics | Not configured yet. Configure and test it; keep the secret URL outside this file. Preserve the earlier agent-selected message behavior. |
| D-04 | Diagnostic correctness reviewer, representative known-issue/source cases, non-code/unknown cases, and agreed pass/fail criteria | Still open. A Teams message is delivery, not correctness sign-off or proof that the flagged code caused the incident. |
| D-05 | AWS VM configuration/access owner, approved Claude authentication/data-processing route, operator-console access, operating/monitoring owner, and recovery/usage objectives | Environment-specific production inputs. No values or owners have been supplied. |
| D-06 | Storage technology/location, retention/redaction policy, capacity, backup/restore requirements | Intentionally **TBD**. Preserve durable behavior while designing; resolve and verify before production sign-off. |

Useful work can proceed with explicit interfaces and fixtures. D-01–D-06 remain open inputs, not additional Jira issues. Ask for clarification before turning an unknown into a new product requirement. Do not repeatedly ask the user to name a service or commit they have already said the agent must discover.

---

## Ticket 01: Dynatrace logs and GitLab code findings

### Summary

Build a Dynatrace-log-led SRE investigation flow that continuously ingests logs, actively queries logs during diagnosis, discovers the related GitLab source/revision within approved scope, and flags code supported by the evidence. Run `claude -p` on a production AWS VM, stream user-facing output to its own console, and support selected findings sent through a newly configured Teams webhook. Storage is **TBD**.

### User outcome and scope

As an on-call responder, I want the agent to explain a logged failure, show the relevant code and evidence, and send useful findings to Teams so that I can assess the likely cause and next checks.

Current source connectors are Dynatrace and read-only GitLab. The current Teams capability is an outbound webhook/workflow delivery path. A native Teams bot, incoming Teams requests, responder-history capture, and broader collaboration are deferred to Ticket 02.

"Flag code" means an evidence-linked console/report finding with a GitLab project, immutable revision, file, and verified function/line location where supported. It does not create a GitLab comment or change code. The agent can return an inconclusive finding; it must not force every failure into a code-blame result.

### Requirements

| ID | Requirement |
| --- | --- |
| R-01 | Use Dynatrace logs as the primary diagnostic evidence through both continuous ingestion and active, repeated log queries. Support hypothesis-driven follow-up queries within configured scope and budgets. Retain timestamps, source identities, and coverage/freshness limits. |
| R-02 | Support both Dynatrace alert/event intake and periodic log-based issue detection. Polling is a supporting discovery/reconciliation mechanism. Define actual event mappings, detection rules, windows, and cadence from the approved contract; deduplicate overlapping deliveries and observations. |
| R-03 | Investigate the initially unknown service/environment-to-GitLab-project and running-revision mapping within explicitly authorized search boundaries. Retain candidate/mapping evidence and ambiguity; discovered text cannot enlarge the allowed scope. An unresolved mapping stays unverified. |
| R-04 | Select and retrieve relevant application source files and comparisons at immutable GitLab revisions. Support the actual application beyond the auction fixture. Keep retrieval host-controlled, bounded, and auditable; do not execute retrieved source or substitute latest branch HEAD for the runtime revision. |
| R-05 | Produce structured evidence-linked findings and a human-readable explanation. Verify project/revision/path/line citations against retrieved source. Explain the likely failure mechanism, competing explanations, missing evidence, and next checks; distinguish suspected cause from established facts. |
| R-06 | Invoke `claude -p` with bounded host-collected context and stream progress/events and user-facing output to its own console. Host orchestration may obtain additional authorized evidence and supply refreshed bounded context; connector tools/MCP and credentials remain outside the child. |
| R-07 | Configure the required Teams webhook/workflow and implement host-owned delivery to its fixed approved destination. Let the agent select useful messages as explicit actions; do not mirror the entire console stream. Pin the actual payload/auth contract and retain delivery outcomes without treating receipt as correctness or human acknowledgement. |
| R-08 | Target production deployment on an AWS VM with the approved unattended Claude route and private operator access. |
| R-09 | Provide storage, technology **TBD**, preserving durable log/source provenance, ingestion progress, investigation history, jobs, outbound intents, deduplication, fencing, and restore holds. Select data/retention and recovery policy before production sign-off. |
| R-10 | Keep Dynatrace and GitLab access read-only. The authorized external write in this slice is selected Teams webhook delivery. Source writes/comments, MR publication/merges, deployment/rollback, and arbitrary code execution remain outside scope. |
| R-11 | Deliver reproducible setup/run/restore instructions, meaningful regressions, representative diagnostic evaluation, and a scoped acceptance record. Clearly separate fixtures, live source reads, model quality, message delivery, and production acceptance. |

### Investigation flow and output

1. Continuously ingest scoped Dynatrace logs and retain durable source/progress evidence. An alert/event or configured log-based detection starts or updates a scoped investigation.
2. Analyze log content and issue focused follow-up queries. Query and ingestion overlap must not inflate counts; sampled, stale, truncated, missing, or denied evidence remains unknown.
3. Investigate service/project/revision clues within the allowed discovery scope. Retrieve relevant immutable GitLab source, expanding the bounded evidence set through the host when necessary.
4. Run/update Claude investigation turns with bounded evidence and stream user-facing progress to the console. Publish only findings valid for the current investigation revision/worker ownership.
5. Retain the findings. When the agent selects a message, the host sends the approved content through the configured Teams hook, respecting destination policy, delivery uncertainty, and restore holds.

Each retained finding/report must describe:

- Investigation identity/revision, affected service/environment, and log time window.
- Log observations and source references, with ingestion/query completeness and freshness limits.
- Discovered project/runtime-revision mapping evidence, including unresolved alternatives.
- A supported likely cause or an explicit inconclusive outcome.
- Each implicated project/revision/file/function/line location where verified, a navigable source reference, and the explanation linking logs to that code.
- Missing/contrary evidence, non-code explanations where relevant, and useful next checks.

Define the exact structured finding schema during implementation and render the same validated facts in the human-facing output. Do not invent file/line locations, commits, evidence IDs, metrics, or confidence percentages. A timestamp, SHA, or stack-frame match alone does not establish causality.

### Implementation tasks within this ticket

- Map approved Dynatrace ingestion/query contracts and detection rules; implement durable progress, overlap handling, completeness, and bounded follow-up queries.
- Implement bounded mapping discovery and generic application-source collection beyond `src/auction/rules.mjs`.
- Define finding/provenance validation against retrieved source and implement the console presentation.
- Implement Claude streaming/follow-up orchestration while preserving current revision, cancellation, credential, and worker boundaries.
- Configure the Teams workflow/hook, add its reviewed sender adapter, and preserve durable delivery/reconciliation behavior. A native bot installation is not implied by this webhook requirement.
- Complete focused regressions, representative model evaluation, deployment/storage decisions, operating documentation, and real scoped acceptance as inputs become available.

These are implementation tasks for Ticket 01, not automatically separate Jira issues.

### Acceptance criteria

- [ ] **AC-01 / R-01:** Demonstrate continuous Dynatrace log ingestion and active diagnostic/follow-up queries against the actual approved contract. Preserve progress and coverage; overlapping queries/feed records do not inflate observations. Polling status alone cannot pass this criterion.
- [ ] **AC-02 / R-02:** Demonstrate both alert/event-triggered and configured periodic log-based detection, with scope checks and duplicate-intake handling. Do not invent thresholds or advance complete progress over partial/denied results.
- [ ] **AC-03 / R-03:** Demonstrate discovery of a previously unconfigured service/project/revision relationship within the allowed scope, retaining evidence. Ambiguous mappings remain unverified; unauthorized candidates are not read or selected. A discovered commit does not fabricate a deployment record or establish cause.
- [ ] **AC-04 / R-04, R-05:** Retrieve relevant non-fixture application files at an immutable revision and verify finding citations against their actual contents/line bounds. Reject foreign-project, mismatched-revision, nonexistent-file, and fabricated-line references; a moving branch head cannot substitute different code.
- [ ] **AC-05 / R-05, R-11:** Evaluate representative known-code-defect, non-code-failure, and insufficient-evidence cases with real Claude output. Agree the case set, correctness reviewer, and pass/fail criteria before claiming diagnostic acceptance. Record controlled fixtures separately from that evaluation.
- [ ] **AC-06 / R-06:** Demonstrate user-facing output before Claude completion, including a host-controlled follow-up evidence path. Verify failure, timeout, cancellation, stale revision, and lease loss without credential exposure or stale publication.
- [ ] **AC-07 / R-07:** Configure and test the actual Teams hook with sanitized findings. Demonstrate selected-message delivery and no automatic full-stream mirroring; reject unapproved targets. Retain failed/unknown outcomes without blind replay, and do not equate a transport receipt with human acknowledgement or diagnostic correctness.
- [ ] **AC-08 / R-09:** Restart/restore preserves provenance, ingestion progress, investigation findings, jobs, and message intents; partial ingestion and uncertain sends cannot silently become complete/successful. Complete storage-specific persistence and recovery checks after selecting the TBD storage contract.
- [ ] **AC-09 / R-10:** Verify only authorized Dynatrace/GitLab reads and selected Teams-hook writes occur. ServiceNow/Jira/Confluence/native Teams features and source-system writers are not needed to complete the focused flow.
- [ ] **AC-10 / R-08, R-09:** Verify the AWS VM, unattended Claude authentication, selected storage, private console, network/secrets, supervision, backup/restore, and independent monitoring against the agreed production requirements.
- [ ] **AC-11 / R-01–R-11:** Deliver reproducible instructions and sanitized scoped evidence. Record unresolved source, discovery, hook, evaluation, and production inputs; missing live contracts or sign-off prevent claiming production acceptance. Local suite results alone do not establish it.

### Open inputs and dependencies

- Allowed Dynatrace/GitLab discovery scope and its authorizing/configuration owner are unknown. The agent will investigate the actual mapping inside that boundary.
- The continuous log-ingestion and active-query contracts, schemas, source IDs/cursors, detection rules, and budgets require verification.
- A Teams destination/workflow/webhook must be provisioned and its payload/auth/retry contract agreed; no secret URL belongs in this ticket.
- Diagnostic reviewer, representative cases/source revisions, and evaluation criteria remain unspecified. Notification delivery does not settle this input.
- Storage is **TBD**; AWS/Claude access, approved data handling, operating owner, retention/recovery, and usage limits need environment-specific decisions.

Continue independent code/fixture work while these inputs are obtained. Do not fabricate endpoints, search authority, owners, mappings, results, or acceptance.

### References

- [Developer handoff](ALLY-HANDOFF.md)
- [Architecture](ARCHITECTURE.md)
- [Integration inventory and acceptance record](ALLY-INTEGRATION-CHECKLIST.md)
- [Current Claude runtime](CLAUDE-RUNTIME.md)
- [Implementation brief](ALLY-AGENT-PROMPT.md)

---

## Ticket 02: Future integrations and actions

### Summary and status

Preserve the broader SRE integration, collaboration, and create/update goals for later decomposition. This is a planning/backlog container. Its goals are not additional release gates for Ticket 01 and are not claims of implementation, progress, or production acceptance.

Production AWS VM hosting, the `claude -p` harness, and storage **TBD** remain the shared direction. The current slice already includes configured outbound Teams webhook notifications; broader Teams capabilities remain here.

### Deferred goals

| ID | Future capability |
| --- | --- |
| F-01 | ServiceNow contextual reads and incident/service correlation, including investigation intake from approved ServiceNow events. |
| F-02 | Jira contextual reads from approved projects and association of relevant issues with investigations. |
| F-03 | Confluence contextual reads from approved spaces/pages to bring documentation/runbooks into investigations. |
| F-04 | Native Teams requests/mentions and responder context, authorized incident conversations, attributed updates, shared findings, differing theories, and handoffs. |
| F-05 | Broader Teams routing, native conversation delivery, acknowledgements, membership/install lifecycle, and collaboration beyond Ticket 01's outbound hook. Preserve selective agent-requested messages and host-owned delivery. |
| F-06 | Broader multi-source correlation and richer GitLab MR/CI/deployment tracking beyond the reads needed for the current log-to-code flow. Keep source changes, CI, deployments, and verified recovery distinct. |
| F-07 | Create/update capabilities where applicable, including discussed Jira/ServiceNow ticket, Confluence content, and GitLab change/MR extension areas. Exact actions, objects, permissions, approval, audit, and retry contracts remain to be specified. |
| F-08 | Time-bounded ownership/on-call context, contact recommendations, and reviewable fix-plan/collaboration workflows from the broader baseline. |

The broader trigger model retains provider events and native Teams requests. Ticket 01 supplies Dynatrace intake; later ServiceNow and Teams tickets must specify and verify their own contracts.

### Boundaries and later decomposition

- Schedule/decompose these goals only when requested, with their own owner, resource scope, permissions, dependencies, and testable acceptance. Do not create one Jira issue for every F row automatically.
- Start additional source connectors as contextual reads. Treat create/update capabilities as separately authorized action extensions; membership/contact evidence does not supply approval authority.
- Preserve scoped sharing, host-owned credentials, durable delivery, worker fencing, restore holds, and uncertain-result handling. Message delivery is not proof of recovery or agreement.
- Account for missing implementation explicitly. No Confluence connector was found in the inspected SRE source/configuration; Jira support does not establish Confluence support.
- Merges, arbitrary code execution, deployment/rollback, protected recovery pipelines, and independent recovery verification still need separately authorized scope and acceptance. They are not implied by a create/update goal.

### Planning acceptance criteria

- [ ] The deferred goals remain distinct from Ticket 01's requirements and acceptance.
- [ ] Each goal selected for implementation receives a focused specification and agreed owner/scope/permissions/acceptance before becoming a child implementation ticket.
- [ ] Source-system writers receive exact action, approval/audit, deduplication, and uncertain-result contracts before enablement.
- [ ] Fixture evidence, real scoped integration results, and production acceptance remain separately recorded for each later capability.

### References

- [Current runtime architecture](ARCHITECTURE.md)
- [Full integration inventory](ALLY-INTEGRATION-CHECKLIST.md)
