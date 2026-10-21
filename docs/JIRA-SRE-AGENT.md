# Jira ticket: Production SRE investigation and collaboration agent

## Summary

Deliver a production SRE investigation and collaboration agent on an AWS virtual machine. Integrate Dynatrace, ServiceNow, Microsoft Teams, GitLab, Atlassian Jira, and Atlassian Confluence for context. Run the Claude Code harness through `claude -p`, stream its progress/output to its own console, and let the agent selectively request Teams messages. Storage technology is **TBD**.

## Description

As an on-call responder, I want the agent to bring together operational evidence, tickets, source changes, documentation, and responder updates so that I can investigate failures with traceable evidence and a shared incident context.

Investigations must be triggered by both provider events and Teams requests. Source integrations supply context in the initial production release. Creating or updating source-system records belongs to a future extension; selective Teams messaging is part of the initial release.

Use the existing repository as the implementation baseline. It contains a prototype, synthetic auction scenarios, connector fixtures, and operational documentation. Production deployment and enterprise acceptance are deliverables to establish, not existing verified capabilities.

## Scope and interpretation

The numbered requirements define the requested product scope. Linked documents describe implementation boundaries, setup, and validation; earlier pilot defaults or optional Jira choices do not change the requirements below. Preserve the repository's host-owned credentials, scope checks, durable coordination, and approval boundaries. Ask for clarification before turning an unresolved item into an additional requirement.

## Confirmed requirements

| ID | Requirement |
| --- | --- |
| R-01 | Target production deployment on an AWS virtual machine. |
| R-02 | Integrate all six required products: Dynatrace, ServiceNow, Microsoft Teams, GitLab, Jira, and Confluence. |
| R-03 | Start investigations from both Dynatrace/ServiceNow provider events and Teams requests. Exact event types, delivery transports, and Teams request syntax remain to be mapped. |
| R-04 | Use source integrations for context only in this release. Do not create/update Jira or ServiceNow records, publish Confluence content, or publish GitLab changes/MRs. Teams message actions are explicitly in scope under R-07. |
| R-05 | Invoke the Claude Code harness through `claude -p` on the service host. Preserve host-managed evidence collection and credentials. |
| R-06 | Stream the harness's progress/events and user-facing output to its own output surface, such as a web console. The exact presentation remains an implementation decision. |
| R-07 | Let the agent select when to request a Teams message as an explicit action during an investigation. The host validates the request, enforces incident/audience scope, and sends through the durable delivery path. Do not automatically mirror the full console stream into Teams. |
| R-08 | Provide a storage layer. Technology, location, data/retention policy, and capacity requirements are **TBD**. Preserve existing durable incident, evidence, conversation, job, and outbound-intent behavior when selecting it. |
| R-09 | Document the future create/update extension described below without enabling its write capabilities in this release. |

## Required integration context

| Product | Context and interaction boundary |
| --- | --- |
| Dynatrace | Operational evidence and provider events; exact signals, entities, queries, and event mappings require the approved contract. |
| ServiceNow | Incident/service context and provider events; exact records and correlation mappings require the approved contract. |
| Microsoft Teams | Responder/request context plus selective agent-requested messages in authorized incident conversations. |
| GitLab | Source/change/CI context for approved projects and immutable refs; exact operations require the approved contract. |
| Jira | Issue context for approved projects; no issue creation or updates in this release. |
| Confluence | Documentation context for approved spaces/pages; no content publication or updates in this release. |

## Expected investigation flow

1. Receive an authorized provider event or Teams request and identify its service, environment, incident, and audience scope.
2. Collect the permitted context, retaining source provenance and evidence limits. Missing, denied, stale, or incomplete context remains unknown.
3. Invoke `claude -p` with bounded context and stream progress/output to the agent's own console.
4. When the agent selects a Teams message action, validate and deliver that message through the host. A turn may complete without selecting a Teams message.
5. Retain the assessment and delivery outcomes. Distinguish findings, hypotheses, reported actions, and independently verified results.

## Acceptance criteria

- [ ] **AC-01 / R-02, R-04:** Demonstrate scoped context retrieval from every required product with sanitized evidence. Test denied access, wrong scope, and incomplete results without presenting unavailable evidence as complete.
- [ ] **AC-02 / R-03:** Demonstrate investigation intake from Dynatrace events, ServiceNow events, and Teams requests using the agreed mappings. Duplicate deliveries do not create duplicate intake effects; unrelated incidents remain separate.
- [ ] **AC-03 / R-05, R-06:** Demonstrate an actual approved `claude -p` invocation whose user-facing progress/output is visible before completion. Verify completion, failure, timeout, and cancellation handling without exposing credentials.
- [ ] **AC-04 / R-07:** A turn selecting no Teams action sends no model-selected message. Demonstrate an authorized agent-selected message during an investigation, delivered through the host; an unauthorized destination is rejected. Console streaming alone does not initiate Teams delivery.
- [ ] **AC-05 / R-07, R-08:** Retain assessment and outbound-action history across restart. Preserve failed/unknown delivery outcomes and restore holds; uncertain external effects are not blindly replayed. Complete storage-specific checks after the TBD storage contract is resolved.
- [ ] **AC-06 / R-01, R-08:** Document and verify deployment on the selected AWS VM, unattended Claude authentication, selected storage, network access, secret handling, service supervision, backup/restore, and monitoring. Record unresolved operational requirements before production acceptance.
- [ ] **AC-07 / R-04, R-09:** Verify the current context integrations do not perform source-system writes. Include a future create/update extension note with the exact future actions and authorization contracts still to be defined.
- [ ] **AC-08 / R-01–R-09:** Deliver code/configuration, setup/run/restore instructions, and an acceptance record separating offline fixtures, real scoped integration results, and production sign-off. Record tested scope, date, result, evidence reference, and remaining limits. Local tests alone do not establish production acceptance.

## Future extension: create/update capabilities

The later implementation phase must support creating/updating records or content in the integrated systems where applicable. Candidate areas discussed are Jira/ServiceNow tickets, Confluence content, and GitLab changes/MRs. Exact actions, object types, permissions, approval rules, audit requirements, and retry/reconciliation contracts require a separate specification before implementation.

This ticket includes the extension note and current context integrations. It does not enable future source-system writers, merges, deployment execution, or rollback. Teams messaging follows R-07.

## Open implementation inputs

- **Storage: TBD.** Do not choose a database or retention policy by implication from the prototype's existing SQLite/PostgreSQL adapters.
- **Integration contracts:** Approved endpoints, identities, transports, resource scopes, event mappings, query budgets, and Confluence spaces/pages are not supplied by this ticket.
- **Teams routing:** Exact tenant/conversations, request syntax, and policy for message selection/frequency need environment-specific definition.
- **Production operations:** AWS VM configuration, Claude authentication/provider route, operating owner, retention/recovery objectives, and service/usage limits remain to be agreed.

Record these as explicit inputs or decisions. Ask the requester or responsible owner before adding uncertain product behavior or granting additional privileges.

## Implementation context

The existing Claude wrapper requests a completed JSON result and tells the model not to send messages. Live console streaming and an explicit model-selected Teams-message contract therefore require implementation; existing host-generated replies do not establish those requirements. Keep Teams credentials and execution in the host while adding the model's message selection capability.

No Confluence connector was found in the inspected SRE source/configuration. Its integration must be accounted for explicitly. Existing storage adapters, fixture results, and historical trials do not establish the selected production configuration or acceptance.

## References

- [Developer handoff](ALLY-HANDOFF.md)
- [Integration checklist and acceptance record](ALLY-INTEGRATION-CHECKLIST.md)
- [Runtime architecture](ARCHITECTURE.md)
- [Current Claude runtime](CLAUDE-RUNTIME.md)
- [Ally implementation brief](ALLY-AGENT-PROMPT.md)
