# Integration setup and contracts

Copy `config/sre.connected.example.json` to `.local/sre.connected.json` and set SRE_CONFIG. Vendor readers start disabled. Configure exact repository/project, environment, Dynatrace service entity, ServiceNow CI, Jira project allowlist, Teams tenant/conversations, and Entra approver object IDs. Separate service keys isolate environments and tenants. Each Teams conversation maps to exactly one service.

Connected mode requires SRE_API_TOKEN and a stable SRE_CAPABILITY_SECRET of at least 32 characters. The Ally profile uses SRE_AGENT_MODE=claude and the noninteractive Claude Code CLI (`claude -p`), with your approved Claude login or enterprise provider configuration. It requires no OpenAI key or Eve service. See [Claude runtime setup](CLAUDE-RUNTIME.md). Start with SRE_AGENT_MODE=rules for transport-only checks. Legacy explicit Eve mode still requires EVE_URL and EVE_TOKEN. Secrets are environment variables named in config. API URLs require HTTPS; redirects are refused. Reads, pagination, query consumption, and investigation duration are bounded.

Run `pnpm sre:ready --json` before configuring live access; add `--strict` for an exit-status gate. It inventories missing fields and credential variable names without network calls or printing secret values. Readers and the separate rollback writer report credentialMode using runtime's static-token/OAuth selection; Jira basic additionally requires its email/token pair. Reader OAuth cannot satisfy missing writer credentials. The report applies loadConfig's shared load-time validator and normalized defaults to a copy of the input. core.runtimeConfigurationValid records that validation; strict mode rejects missing core or enabled-source/writer setup, invalid services, nonboolean rollback flags, missing model settings and explicit unfinished quota labels. Disabled rollback can remain incomplete while testing reads. configurationReady checks presence and selected local structure. The report always leaves liveValidated:false; database connectivity, actual branch protection, permissions and workflow behavior require separate checks. After each reader is enabled, run the operation-specific read probes below on dedicated test resources; those probes still construct no rollback client.

## Operation-specific read checks

Run `pnpm sre:check --live` to opt into provider reads and bounded queries. For a pure JSON file, invoke the script directly:

```sh
node --env-file-if-exists=.env scripts/sre-check.mjs --live --json > .local/read-access-report.json
```

The command forces rules mode, excludes the rollback client even when execution is configured, and creates no store, model session or Teams sender. Every operation has a sixty-second deadline and aborts its remaining local requests when it finishes, including a sibling request left by a failed parallel PR read. The command has a five-minute cancellation signal. CLI freshness checks use the host clock, reported as clockSource:host; synchronize it before interpreting timestamp failures. Provider query/response/page budgets still apply. Reports contain operation status/counts and safe HTTP/retry metadata; provider bodies, source text, credential values and arbitrary exception messages are omitted.

| Reader | Operations checked |
| --- | --- |
| GitHub | Scoped repository metadata, bounded environment deployment history and observed status reads, PR metadata/files with rechecked refs, checks/combined status bound to the PR head, commit-linked PRs, immutable source and comparison |
| GitLab | Scoped project metadata, bounded environment deployments, MR metadata/diffs with exact refs, head-pipeline metadata, commit-linked MRs, immutable source and comparison |
| Dynatrace | Recent problems, active inventory, Classic problem details, every configured metric monitor using the runtime sample-window validator; Grail fallback logs when no separate log reader is enabled |
| ServiceNow | Recent incidents, active inventory and scoped incident details, using the runtime normalizer |
| Dynatrace logs | Configured bounded log query with a complete reader result |
| Jira | Configured allowlisted test issue and matching returned issue key |

Set these optional probe fields in the existing reader configuration:

| Field | Test resource |
| --- | --- |
| github.smokePull / gitlab.smokeMergeRequest | A small real PR number / project-local MR IID with readable diff and CI metadata |
| github.smokePath / gitlab.smokePath | A small existing source file; the auction pilot uses src/auction/rules.mjs |
| smokeSha / smokeBaseSha on either repository reader | Optional full immutable commit IDs for source/comparison probes; otherwise the configured review supplies refs, with an observed deployment as an additional source-head fallback |
| dynatrace.smokeProblemId | Optional Classic problem ID; a recent/active scoped record can supply it |
| servicenow.smokeIncident | Optional incident sys_id; a recent/active scoped record can supply it |
| jira.smokeIssue | An allowlisted project issue key |

Missing probe resources remain unverified. An empty GitHub deployment list does not certify status access. Partial pages, incomplete diffs/queries, malformed or mismatched CI data, wrong scopes and unusable metric windows do not pass. A complete small repository/issue response proves only that listed operation on that configured resource. Empty inventories cannot establish full tenant visibility, ACL coverage or historical retention. A valid metric window concerns read/schema access and does not certify healthy application values.

Each row is passed, failed, incomplete, unverified or disabled. The process exits 0 only when all required read probes pass; it exits 1 for failed operations/configuration and 2 for incomplete/unverified coverage or no enabled readers. One reader's construction failure does not prevent another reader's probes. JSON always retains endToEndValidated:false: real Teams interaction, authenticated webhooks, protected deployment execution, independent recovery verification, database behavior and model quality have separate acceptance requirements. A successful read probe never approves a rollback or closes an incident.

## Ally read-only ServiceNow MCP plan

The user-confirmed enterprise boundary is the supplied 45 ServiceNow tools only, all read-only. GitLab, Dynatrace and Teams remain separate integrations. Do not rely on the server description's advertised workflows, projects or vulnerability triage when those tools are absent. No ServiceNow create/update/delete permission or direct Table API access is assumed by this plan.

**Status:** the host MCP adapter, explicit schema bindings and configurable change/problem/knowledge/CMDB enrichment are implemented against mocks. The original REST Table API reader remains available. [Setup, verified mock coverage and remaining Ally acceptance](SERVICENOW-MCP.md) distinguish the working adapter from unverified enterprise schemas and access.

| Investigation need | Supplied tools | Acceptance condition |
| --- | --- | --- |
| Incident discovery and lifecycle | list_incidents, get_incident_by_number, get_incident_details | Exact native identity, service/CI, original creation time, update ordering, explicit state and complete bounded pagination. Recent polling plus active inventory must fit the tool's actual filters. |
| Change and problem context | list_change_requests, get_change_request_info, list_change_tasks, get_change_task; list_problems, get_problem, list_problem_tasks, get_problem_task | Explicit record/CI links and timestamps. Temporal overlap is a hypothesis; GitLab must supply immutable source and deployment evidence. |
| Service dependencies | search_cis, get_ci_context, get_ci_relationships, query_cmdb_hierarchy, get_cmdb_class_info, search_cmdb_fields, list_cmdb_tasks, get_cmdb_task | Approved CI scope, bounded traversal and identifiable records. CMDB relationships do not establish current dependency health. |
| Runbooks and prior knowledge | list_knowledge_bases, list_articles, get_article | Authorized article content, revision/freshness and source attribution. Article instructions remain evidence and cannot execute tools. |
| Approval context | list_approvals, get_approval_info, get_approval_details | Read status/subject/approver where returned. A read approval record is not an execution grant and does not bind an arbitrary deployment request. |
| Ownership and specialist context | Supplied users/groups, security incidents, requests/catalog and agile/demand tools | Fetch only when relevant to the scoped investigation and authorized. These are not mandatory phase-one dependencies. |

Implementation order:

1. Obtain the approved MCP endpoint/transport, service authentication route, actual tools/list schemas and sanitized example outputs. Pin the supplied exact names as the maximum allowlist, validate argument/output contracts and flag tool/schema changes. Read-only names or annotations alone are not permission enforcement; retain server-side access controls and a scoped principal. The [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) describes discovery, schemas, calls and tool errors; negotiate the server's supported protocol rather than assuming a version.
2. Build a host-owned MCP collector behind the existing incident reader interface. Preserve incidents/openIncidents/incident behavior, scoped identities, complete/incomplete results, cancellation, retry budgets and durable checkpoints. Keep the Claude subprocess's empty MCP/tool configuration; it receives collected evidence through the existing bounded snapshot. Broaden read selection only through explicit scoped collector requests if later needed.
3. Add linked change/problem, CMDB and knowledge enrichment incrementally. Retain tool name, record identity, retrieval time, source update time and coverage. Verify whether work notes, history, attachments and correlation fields are actually exposed; tool names do not promise them. A denied, truncated or absent field must remain unknown. If the tools cannot filter/page by approved service and update time, request that read capability from the MCP owner before claiming always-on reconciliation works.
4. Run contract fixtures, then a real scoped read-only incident through the MCP adapter. Exercise old open incidents, updates/closures, duplicate/out-of-order records, denied and partial results, token expiry, schema drift and restart. Repeat the two-responder Teams flow with actual authorized installation and the separate Dynatrace/GitLab readers.
5. Complete one sandbox detection-to-recovery rehearsal. Start with a human launching the existing protected deployment pipeline after reviewing the proposal. Optional later automation needs a narrowly scoped deployment trigger or broker with independent approval checks, artifact/environment binding, expiry, deduplication and health verification. ServiceNow write access is not required for that workflow. No such enterprise execution broker is implemented here.

The agent can draft a ticket update or change request in Teams for a person to submit. Automatic work-note updates, incident creation/closure, assignment changes, approval decisions, knowledge publication and workflow execution are unavailable through this ServiceNow toolset. If one becomes a required product feature, request a specific reviewed action and scope from the platform owner; do not request broad administrator access.

The remaining access requirements are separate: GitLab source/MR/CI/deployment/artifact reads; Dynatrace scoped problem/metric/log/entity reads; Teams installation, reply delivery and any explicitly consented incident-thread reading; approved Claude service authentication; and a continuously running host/database/network route. The live trial setup does not establish Ally access to any of these.

## OAuth reader configuration

Repository, ServiceNow, Jira bearer and Dynatrace connectors share a client-credentials token helper. Configure the issuer's HTTPS token URL, environment-variable names for client ID/secret, and its verified scope/resource. The helper sends form-encoded client_credentials, client_id and client_secret and refuses redirects. Select this method only when the actual issuer supports credentials in the form. The Teams SDK manages its own authentication separately.

```json
{
  "oauth": {
    "tokenUrl": "https://YOUR-IDENTITY-ENDPOINT/token",
    "clientIdEnv": "ISSUER_CLIENT_ID",
    "clientSecretEnv": "ISSUER_CLIENT_SECRET",
    "scope": "VERIFIED_SCOPE"
  }
}
```

A configured nonempty tokenEnv value takes precedence. Otherwise OAuth uses the current credential values. One connector shares each pending acquisition across concurrent reads; Jira retains that provider between requests. Changing client ID, secret, endpoint, scope or resource invalidates the cached grant and aborts the old acquisition. A late old response cannot replace the new token. Removing required credentials prevents reuse of an older cached token. This observes changes to the running configuration/environment object; editing a file alone does not reload the process.

Token responses require JSON with strict UTF-8, a nonempty printable ASCII access token up to 16384 characters, and case-insensitive Bearer token_type. The complete response is limited to 65536 bytes and acquisition has a ten-second transport timeout. These are application budgets to validate against the issuer. Tokens remain opaque; the helper does not decode JWT claims. The [OAuth response contract](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1) defines token_type and the recommended expires_in. Microsoft's [client-credentials response](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow#successful-response) includes both fields.

When supplied, expires_in must be a positive integer number or decimal integer string. Caching is capped at 24 hours, subtracts measured acquisition time and refreshes with a ten-percent margin capped at one minute. A response without expiry is usable by the waiting callers and is not cached for another call; no lifetime is invented. Failed acquisition does not leave a stuck pending promise. A protected API's HTTP 401 invalidates only the matching cached token. The original read/write request is not replayed; a later independent read can acquire a new token. A late 401 for an older token cannot clear a newer grant.

Token endpoint Retry-After/quota deadlines are retained within that provider object, keyed by issuer URL and client ID, so changing the secret alone cannot bypass its hold. Endpoint response/transport text never enters diagnostics. Token caches are volatile per object. An explicit oauth.retryScope additionally persists committed issuer waits through the runtime database for process replacement and other instances; see [retry coordination](AGENT-OPERATIONS.md#local-evidence). Exact issuer permissions, TLS, consent and token sizes still need live acceptance. The offline inventory reports the selected credential mode without trying to authenticate; verify that mode before enabling live access.

### Cancellation around authentication and submission

An already-cancelled request starts neither token acquisition nor a provider request. Cancelling a reader waiting for shared authentication detaches that reader promptly; other waiting readers retain their acquisition. When the last reader cancels, the helper aborts the abandoned token request and discards any late response. A new reader can start a fresh acquisition without waiting for the abandoned transport. Custom authentication callbacks receive the caller's AbortSignal and must observe it to stop their own underlying work; late callback rejections are still observed safely.

The connector checks cancellation again after asynchronous final preflight, immediately before the submission boundary. A cancelled deployment at that point is not submitted. Cancellation that prevents a receipt after submission leaves an uncertain outcome for reconciliation and cannot trigger an automatic repeat. Received receipts retain their normal meaning. Diagnostic cancellation errors exclude the caller's private abort reason. These transport checks complement the existing approval-expiry and exact-request recovery requirements.

## Webhooks and read access

Ingress: `POST /webhooks/{source}/{service-key}`. Acknowledgement follows the database commit. Repeated source/service/delivery identities are deduplicated; reuse with changed content is rejected. Offline mode rejects vendor webhooks and provides an isolated simulator.

A database failure returns HTTP 503 with `Retry-After: 5` and a generic error. Retry the same delivery identity and body; an interrupted transaction must not acknowledge or retain only part of the event/job write. Application validation failures remain separate. A response can also be lost after a successful commit, so senders must retain the same event identity on retry.

| Source | Inbound authentication | Read behavior |
| --- | --- | --- |
| GitHub | Raw-body HMAC in X-Hub-Signature-256; X-GitHub-Delivery | PR metadata/files, SHA-bound checks/status, commit-associated PRs, comparisons, environment deployments/statuses. Fine-grained read access for contents, pull requests, checks, statuses, and deployments as applicable. Configure API version for GHES. |
| GitLab | X-Gitlab-Token; X-Gitlab-Event-UUID when available | Project-scoped MR metadata/diffs, commit-associated MRs, comparisons, deployments. Dedicated read API token. |
| Dynatrace | Workflow HTTP action Authorization: Bearer webhook secret | Classic problems and metrics with API token. Separate Grail OAuth connector for bounded logs. Select only required read/query scopes. |
| ServiceNow | Outbound flow HTTP action Authorization: Bearer webhook secret | Read-only Table API incidents, filtered and revalidated against configured cmdb_ci. OAuth bearer or instance-supported client credentials; ACLs apply. |
| Jira | Automation HTTP action Authorization: Bearer webhook secret | GET issue context for allowlisted project keys in evidence. Never creates/updates tickets. Native variants without custom auth need an authenticated relay. |
| releases / logs / verification | Timestamped HMAC, below | Trusted release publisher, log forwarder, independent health verifier; separate secrets. |

Enable GitHub pull_request, merge_group, check_suite/check_run or workflow_run, and deployment_status events. Enable GitLab merge request, pipeline, and deployment events. PR/MR events create review sessions; CI events refresh active investigations for that service. Merge and deployment remain separate facts. Reviews go to Teams; this version does not write repository checks/comments or enforce merge gates.

Known-policy reviews additionally read exact source files at immutable SHAs. GitHub collection rejects moving heads/bases and binds an explicit common-ancestor/head comparison; GitLab uses its native diff references, complete file count and truncation flags. Missing content permissions, partial coverage or unsupported source produce uncertainty. Runtime rules require a complete matching deployment source pair rather than relying on timing. The [attribution and model transport guide](ATTRIBUTION.md) describes source limits, supported patterns, abstention and the current 160000-byte evidence envelope.

Dynatrace workflow template:

```json
{"ProblemID":"P-123","State":"OPEN","Title":"Auction request errors","EntityIds":["SERVICE-REPLACE"],"StartedAt":1792411200000,"ObservedAt":1792411260000}
```

Map actual problem identity, explicit OPEN/CLOSED state, service IDs, and timestamps from the tenant schema. Missing state is rejected. Classic API payloads also work. Grail problem polling requires both a verified entity-scoped `problemQuery` for recent changes and an `openProblemQuery` for the active inventory. No tenant-specific DQL is assumed. The example uses Classic problems plus separate Grail logs.

ServiceNow sends sys_id, number, cmdb_ci, state, short_description, description, sys_created_on, and sys_updated_on. Configure the instance's closedStates explicitly. With correlateDynatrace enabled, `correlation_id: "dynatrace:P-123"` joins the same issue. Closing one source never suppresses another open source. Jira input contains issue.key and issue.fields including updated time.

ServiceNow state and original creation time are required. A recent update must not make an old incident appear to have started after a recent deployment. Verify state values and timestamp interpretation against the instance before using them for change attribution.

Correlated ServiceNow tickets retain independent state under their native `sys_id`, even when they share the same Dynatrace investigation. Every known ticket must close. Delayed updates are ordered per ticket; closing a newer ticket does not discard an older ticket's OPEN state. Older databases that stored one ServiceNow aggregate are upgraded at startup from the durable event audit, including formerly unlinked delayed events. A hidden open ticket reopens the investigation, restores its original age, clears the stale analysis, and queues a fresh review. Missing/unnamed audit records or an audit over the 10000-record startup budget stop startup for reviewed reconciliation; no source state is silently dropped. Retain the database and its audit when upgrading.

For HMAC sources, send X-SRE-Timestamp (epoch milliseconds), X-SRE-Event-ID (stable delivery ID), and X-SRE-Signature: `sha256=` plus the hex HMAC-SHA256 of `timestamp + "." + exactRawBody`. A five-minute timestamp window applies. Re-sign retries with a fresh timestamp and the same event ID/body. The secret comes from webhookSecretEnv.

## Startup and active-issue reconciliation

Recent polling alone misses an incident that opened before the initial lookback. Each enabled Dynatrace/ServiceNow instance therefore fetches an active inventory on its first successful read and every `activeReconcileIntervalMs` (300000 ms by default). A peer's complete inventory cannot establish this instance's permissions. Budget query volume for the number of instances. Classic Dynatrace uses the configured entity, `from=0`, and `status("open")`; the [problem-list API](https://docs.dynatrace.com/docs/dynatrace-api/environment-api/problems-v2/problems/get-problems-list) otherwise selects problems by start/end time in the requested range. ServiceNow uses the configured CI, an upper update time, and each `state!=<closed-state>` predicate, without a lower time bound. The [Table API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html) documents the encoded query operators. Tenant retention, access, timestamp behavior, and query cost still require live acceptance.

Grail active inventory uses `openProblemQuery` with the historical query window and the existing bounded record/byte/scan/time budgets. It must return explicit OPEN records scoped to the configured entity. An absent query, warnings, incomplete pagination, invalid record, or access failure leaves the checkpoint unadvanced and Agent health requiring attention. Recent events ingested before that failure remain durable. Inventory absence never closes an incident; explicit source closure and independent health proof are still required.

Checkpoint scope includes service key, logical tenant, environment, provider endpoint/entity/repository/CI, relevant queries/state mappings, and metric definition. A changed scope discards its saved cursor and success claim. Credential values are excluded so rotation does not change identity. Use a **new service key** for a different tenant, environment, or service: checkpoint invalidation does not migrate or erase incident history under a reused key. Test the new mapping with rollback disabled before enabling execution.

PostgreSQL instances share [database coordination time](COORDINATION-TIME.md) for polling, leases, approvals and proof freshness. Clock-policy version 1 invalidates older polling scopes and pending/approved proposal hashes. Drain and upgrade all instances together; mixed old/new timing behavior is unverified. Synchronize host clocks as well, and investigate the clock_skew health condition before live acceptance.

After restoring a database, follow [offline recovery preparation](BACKUP-RESTORE.md) before starting agents with write access. A snapshot may show a request as approved/pending even though it ran after the backup. The persistent restore hold prevents blind replay; its operator release does not reconcile unknown writes or establish health.

## Release and health attestations

A trusted pipeline sends metadata after actual deployment. Example values are illustrative:

```json
{
  "provider":"github", "deploymentId":"42", "environment":"staging", "status":"success",
  "sha":"1111111111111111111111111111111111111111",
  "artifact":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "at":1792411200000, "healthy":true, "healthVerifiedAt":1792411260000,
  "rollbackCompatible":true, "dataRollbackSafe":true,
  "schemaVersion":"2026-10-expand", "dependencyFingerprint":"deps-v3",
  "configurationFingerprint":"config-v8", "featureFlagsFingerprint":"flags-v2",
  "ticket":"SA-101"
}
```

Publish full actual SHA, immutable artifact digest, checked compatibility, and independent health results. Set deploymentId to the native GitHub/GitLab deployment identity so the release attestation and repository records describe the same deployment. Without a native identity, records are bound to their exact SHA/environment/deployment timestamp. The agent never carries health or compatibility attestations across redeployments merely because their SHAs match. Do not set attestations true merely to bypass a check. Missing metadata blocks rollback. The prior artifact must remain recent and healthy. Reverting old feature history is not the recovery mechanism; accepted auction transactions require separate reconciliation.

The verification webhook comes from a trusted health checker with its own signing secret. Its proof must follow closure of all correlated sources, identify the current successful deployment, and remain fresh (180 seconds by default, configured with verification.maxAgeSeconds). Future-dated proofs, unsettled/failed later deployments, wrong artifacts, missing business checks, and stale observations are rejected inside the inbox transaction. Identical accepted proofs remain idempotent on redelivery.

```json
{
  "id":"health-check-123", "incidentId":"inc_REPLACE", "environment":"staging",
  "healthy":true, "sha":"1111111111111111111111111111111111111111",
  "artifact":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "deploymentId":"42", "deploymentAt":1792411200000, "observedAt":1792411260000,
  "checks":{"technical":true,"businessInvariants":true},
  "evidenceUrl":"https://YOUR-VERIFIER/checks/123"
}
```

Use actual measured results and deployment times. deploymentId is required when the ledger has a native deployment identity; deploymentAt must match the successful deployment's ledger timestamp. For an executed rollback, include rollbackRequestId in both the trusted release metadata and the health proof. Only a proof matching the proposal's exact target and a dispatched/unknown request changes that rollback record to verified. An unrelated healthy deployment does not reconcile an uncertain dispatch. Workflow success alone is insufficient.

## Teams setup and commands

The host now supports approved groups sharing one incident, attributed coordination briefings, explicit team-state disagreement checks and separate durable recipient records. See [multi-group coordination](TEAMS-COORDINATION.md) for configuration and the offline test flow. Live tenant installation/consent and Claude interpretation remain separate acceptance checks.


Register a dedicated test bot/app, install it in the allowlisted conversation, and set CLIENT_ID, CLIENT_SECRET, TENANT_ID, and SRE_TEAMS_MODE=live. Tunnel only authenticated `/api/messages` on port 3978. The service can run locally; AWS is unnecessary for this test. Real tenant policies, consent, scopes, installation, and proactive messaging must be tested in that tenant. Local SDK tests do not establish those permissions.

Build the install ZIP with `pnpm sre:teams:package`. Configure CLIENT_ID, optional TEAMS_APP_ID, and actual HTTPS TEAMS_APP_WEBSITE_URL, TEAMS_APP_PRIVACY_URL, and TEAMS_APP_TERMS_URL first. Output is `.local/teams-app/sre-teams.zip`, containing the manifest and both required PNG icons. TEAMS_APP_SCOPES defaults to `personal,team,groupChat`; select only the scopes needed. `pnpm sre:teams:package --demo` produces a review-only package with placeholder IDs/URLs, clearly marked unsuitable for installation. The generated manifest uses Microsoft's v1.21 schema. Validate the real package in Teams Developer Portal before uploading it to a test team/chat under your tenant policy.

For incident collaboration:

1. In the intended channel thread or group chat, send `@SRE Agent join <incident-id>`. Wait for its confirmation. Each thread/chat follows one incident; channel replies stay in that thread. Direct personal chat does not require a mention.
2. Send `@SRE Agent update Restarted the bidder; timeouts persisted` to record progress. The database retains author, timestamp, text, and incident identity. `note` is an alias for `update`.
3. Ask `@SRE Agent Compare the database pool with the restart results; focus on connection limits`, or send `@SRE Agent status`. The Claude invocation receives the incident's bounded stored conversation, with a reserved window of responder reports alongside telemetry, logs, changes, and tickets. Reports remain available after application restart. The agent instructions require separating planned work, reported attempts, and verified results, and reconciling conflicting reports.
4. To follow messages without a mention, generate the package with `TEAMS_APP_MESSAGE_ACCESS=all`, set `teams.captureResponderUpdates:true` for the service, and install/upgrade it with consent. The package requests `ChannelMessage.Read.Group` for team scope and `ChatMessage.Read.Chat` for groupChat scope. Teams delivers these background messages only with the applicable RSC consent. The receiver discards unmentioned messages outside already-linked active incident threads/chats. It records accepted reports without acknowledging each one; investigation jobs coalesce and publish changed assessments. Passive text cannot invoke commands or approvals. Resolved incidents stop passive capture.

Default connected configuration is mention-only. Without RSC consent, use explicit `update` messages. The application does not import earlier Teams history or synchronize attachments, edited messages, or deletions. When adding it to an ongoing incident, provide an `update` summarizing earlier actions; send a new correction for an inaccurate report. Model context is bounded and reports the available/included evidence window. Stored conversation is not unlimited model memory. The offline rules reasoner records and displays updates, but arbitrary natural-language interpretation requires connected Claude mode and live model evaluation.

Other commands: `incidents`, `investigate <incident-id> <question>`, `rollback <incident-id>`, `approve <proposal-id> <nonce>`. In group chats/channels, @mention the bot for every command, even with RSC enabled. Commands are persisted first. Proactive channel notifications create an incident thread and save its reference. Install/removal updates access. Unknown delivery outcomes require reconciliation before retrying.

`retry <incident-id> <job-id> <reason>` resumes an exhausted read-only investigation with an audited replacement job. It requires a direct authenticated instruction in the incident's allowed service/tenant. Original attempts and errors remain available; retry receipts prevent duplicate enqueue after a response/storage interruption. This command does not retry delivery or deployment actions. See [operator recovery](AGENT-OPERATIONS.md#resume-an-exhausted-investigation) for the API/CLI, scope checks, and audit identity limits.

The offline `/api/dev/teams` endpoint accepts `text`, `userId`, `displayName`, `conversationType` (`personal`, `groupChat`, or `channel`), `conversationId`, `replyToId`, and `mentioned` (default true). For channel simulations, use the same root ID in `replyToId`; for group chat, use the same allowlisted conversationId. Send join, wait for its acknowledgement in the outbox, then simulate two responders with `mentioned:false`, followed by a mentioned status request. No external Teams message is sent in this profile. `node --test tests/sre-teams.test.mjs` runs this flow automatically, including restart, thread isolation, passive approval rejection, telemetry flooding, and the actual Teams SDK local transport.

Live acceptance: repeat the two-responder flow in a dedicated Teams chat/channel, verify an unmentioned message appears as `responder_update` evidence, restart the service and ask a follow-up, confirm no unrelated thread is stored, then uninstall and verify proactive delivery stops. Test both mention-only and consented message-read packages. Test real model responses separately; passing mocked session tests proves context wiring, not reasoning quality.

A rollback proposal identifies current/target commits, immutable target artifact, environment, and expiry. Approval must come from an allowlisted aadObjectId in the same tenant/conversation with the exact nonce. The model cannot approve. The executor rechecks policy, identity, expiry, and current deployment before dispatch.

The connectors also recheck expiry after authentication, immediately before the deployment request. Missing credentials or a failed OAuth exchange produce a locally blocked action with zero deployment submissions. Restoring credentials requires a fresh proposal and approval. Errors after the deployment request begins remain unresolved, including failed response reads and HTTP error responses; they are not automatically retried. See [submission and no-change handling](WORKFLOW-APPROVAL.md).

Approval also binds the repository/API base, environment, logical tenant, workflow, and protected ref. Configuration changes invalidate earlier proposals. A database lease serializes dispatch attempts for the repository/environment, and the dispatch transition fences the exact lease owner and incident revision after remote reads. An expired or reclaimed worker cannot dispatch or overwrite its replacement's receipt. An unresolved dispatched/unknown action blocks another dispatch for that scope until reconciled. Proposals created by older policy versions must be requested again.

## Rollback workflow contract

Enable rollback only after installing and testing a protected deployment-specific recovery workflow, with a separate write token. Dispatch contract version 3 sends these string values:

| Meaning | GitHub workflow input | GitLab variable |
| --- | --- | --- |
| Exact target SHA | `target_sha` | `TARGET_SHA` |
| Retained target artifact | `artifact_digest` | `ARTIFACT_DIGEST` |
| Environment | `environment` | `DEPLOY_ENVIRONMENT` |
| Idempotent request identity | `request_id` | `SRE_REQUEST_ID` |
| Approved current SHA | `expected_current_sha` | `EXPECTED_CURRENT_SHA` |
| Approved current artifact | `expected_current_artifact` | `EXPECTED_CURRENT_ARTIFACT` |
| Approved native deployment ID | `expected_current_deployment_id` | `EXPECTED_CURRENT_DEPLOYMENT_ID` |
| Approved deployment time, epoch milliseconds | `expected_current_deployment_at` | `EXPECTED_CURRENT_DEPLOYMENT_AT` |
| Authenticated approval time, epoch milliseconds | `approved_at` | `APPROVED_AT` |
| Approval expiry, epoch milliseconds | `approval_expires_at` | `APPROVAL_EXPIRES_AT` |

GitLab additionally sends `SRE_ACTION=rollback`. GitHub uses the configured workflow/ref; GitLab uses the configured protected ref. Define/require these inputs in the deployment-specific workflow before enabling execution. A missing native ID is represented by an empty string only for a trusted release attestation that has no native identity; the exact SHA/artifact/time binding remains mandatory. Current artifact/time validation happens before the connector sends a write. Proposal policy hashes include the dispatch contract version; request fresh proposals after upgrading.

That pipeline must serialize actions per environment, deduplicate request IDs, compare the actual current SHA/artifact/deployment ID/time with the approved values, validate target artifact provenance/retention, recheck schema/data compatibility, and redeploy that exact artifact. A newer deployment of the same SHA still invalidates the request. It must not rebuild an old branch or revert arbitrary history. Enforce environment authorization in CI. Report deployment outcome and independently check service health plus auction invariants. This repository implements dispatch clients and [actual local process tests](PROCESS-ROLLOUT.md); the real service's deployment command must be configured and verified by its owner.

The workflow must reject an expired approval after queueing and recheck it immediately before deployment begins. An exact completed receipt can be retrieved after expiry without repeating its action. Changing the window under the same request ID is rejected.

A signed independent `rollback_no_change` verification can reconcile a terminal job blocked before deployment as `not_executed`. It binds the original inputs, native run and actual current deployment; it leaves the incident open and requires a fresh eligible proposal/approval for another action. Failure text alone cannot establish no change. See [proof fields, hashing and tests](WORKFLOW-APPROVAL.md).

Workflow completion is not automatically queried in this version. Deployment callbacks/polling and health verification update evidence/state. Retain request_id in CI logs. A dispatch timeout becomes unknown, never an automatic second write.

The current [GitHub dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) documents a 200 response containing a workflow run ID and URLs. The connector retains those fields in its durable dispatch receipt and accepts empty 204 responses. The [versioned API reference](https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event) documents `return_run_details` behavior; confirm the selected cloud/GHES endpoint in live acceptance. A receipt is workflow submission evidence. GitHub [custom inputs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch) and GitLab [pipeline variables](https://docs.gitlab.com/api/pipelines/#create-a-new-pipeline) carry this contract; deployment-specific safety checks belong in this application's workflow.

## Metric monitors and model forecasts

Optional monitor configuration: `{ "id":"latency", "name":"Auction latency", "selector":"<verified aggregate selector>", "operator":"gt", "threshold":250, "unit":"<actual unit>", "consecutive":3, "maxSampleAgeSeconds":180, "maxSampleGapSeconds":180 }`. Validate selector and units against the entity; the number is illustrative. Exactly one aggregated series is required. Samples must be paired numeric values/timestamps, strictly increasing, within the query window, and neither future-dated nor separated by an excessive gap. Consecutive violations open the issue; healthy samples enter verifying. Missing/stale/invalid data records a polling error and never means healthy. The last successful checkpoint remains available during failure. Model-generated indicators are advice until explicitly configured. See [agent operational checks](AGENT-OPERATIONS.md) for polling concurrency, health APIs, and scoped Teams notices.

The ICD 203 skill produces separate likelihood/confidence rationales, assumptions, source-quality limitations, contrary evidence, alternatives, and monitoring indicators. Forecast scope records stage, reviewed/merged SHA, environment, and horizon. Offline rules abstain from production probabilities. Estimates from the model remain uncalibrated pending held-out evaluation.

## References

- [ICD 203, pages 2–4](https://www.intelligence.gov/assets/documents/intelligence-community-directives/ICD_203.pdf)
- [GitHub webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) and [workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [GitHub deployment status states, status-level environments, and auto-inactivation](https://docs.github.com/en/rest/deployments/statuses) and [GitLab deployment states](https://docs.gitlab.com/api/deployments/)
- [GitLab pipelines](https://docs.gitlab.com/api/pipelines/#create-a-new-pipeline) and [commit-associated MRs](https://docs.gitlab.com/api/commits/#list-merge-requests-associated-with-a-commit)
- [Dynatrace query client](https://developer.dynatrace.com/develop/sdks/client-query/)
- [ServiceNow Table API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html)
- [Teams Playground](https://microsoft.github.io/teams-sdk/developer-tools/agents-playground/) and [tunnels](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/developer-tools/local-tunnels)
- [Teams receiving unmentioned messages and RSC consent](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/enable-receive-all-chat-messages) and [v1.21 app manifest schema](https://developer.microsoft.com/json-schemas/teams/v1.21/MicrosoftTeams.schema.json)
