# Trial acceptance

Current checkpoint: **642 tests pass**. The local demo uses offline rules, shared context and simulated actions. The [GitLab sandbox checkpoint](GITLAB-SANDBOX.md) adds 20 published commits/eight branches, actual read-only source/history collection and eight agent cases. Two real Microsoft identities received code findings, conflict warnings, an ownership handoff and a revised assessment after separately reproduced dependency evidence. Health-success display omissions and inactive age-only briefing noise were fixed from these drills. GitLab source identity and Teams transport are real; error events and release timing are explicit local replays. Claude and deployment execution remain off. The earlier [real Teams](LIVE-TEAMS-TRIAL.md) and [organization](TEAMS-ORGANIZATION.md) records retain the previous restart, missed-update, installation and simulated-approval evidence. See the [coordination guide](TEAMS-COORDINATION.md) for commands. Earlier Claude checkpoints below are historical.

Use a dedicated GitLab project, Dynatrace environment, ServiceNow developer instance and Teams app. All incident data in this rehearsal is fictional. A signed-in browser, a created token or a working local mock does not establish that the connected agent can complete the incident flow.

The connected investigation runtime is Claude Code `claude -p`. Provider reads enter the application through its REST connectors or the [host-owned ServiceNow MCP adapter](SERVICENOW-MCP.md). The Claude subprocess receives bounded evidence and has no deployment tools or configured MCP servers. No OpenAI account is required. ServiceNow MCP has been built and tested against fictional schemas/data; Ally access remains unverified. See [the actual integration contracts](INTEGRATIONS.md) and [Claude setup](CLAUDE-RUNTIME.md).

Earlier October 20 mock checkpoint: **ready for an offline local user trial**. The then-current suite passed 535 tests, and eleven MCP-backed local process scenarios passed with real auction process replacement/verification where eligible. A controlled 32-second observer/worker suspension retained the exact question and agent identity. A separate 314-second frozen-runtime soak passed eight crash/restart/recovery cycles; it is not a six-hour or enterprise uptime claim. A real Claude invocation with MCP-collected fictional evidence completed in 51 seconds and retained its assessment and two responder reports after database reopen. Browser checks verified the Mock MCP card, question-to-evidence flow, preserved history and expandable evidence across refresh. The detailed report and screenshot are under `.local/acceptance/mcp-recovery-2026-10-20/`. All forty observed owned drill processes were absent after completion; the local demo is intentionally left running.

## 1. Rehearse locally

```sh
pnpm sre:trial:demo
```

Open http://127.0.0.1:3002. The command now defaults to **offline rules, fictional provider evidence and simulated rollback dispatch**. It forces loopback, disables live provider readers and Teams delivery, and ignores an inherited remote database URL. Its authenticated loopback ServiceNow MCP fixture exposes the supplied 45 read tools. The two-group simulator adds explicit reported states and shared briefings without model calls. The default database is `.local/sre-trial-demo.sqlite`; `SRE_TRIAL_DEMO_PORT` and `SRE_TRIAL_DEMO_DATABASE` select another local port/database. It does not load `.env`. For the later real-model trial, explicitly run `SRE_TRIAL_DEMO_AGENT_MODE=claude pnpm sre:trial:demo`; this uses the host's CLI authentication, supports `SRE_CLAUDE_BIN`/`SRE_CLAUDE_MODEL` and has no rules fallback.

The earlier Claude UI checkpoint passed **540 tests**, including trial isolation, conversation persistence, quota errors and authorized simulated approval. It keeps the same local database/history when switching from rules to Claude. The console shows saved questions and model-labeled replies, current work/errors, and exact rollback approval commands. Commands are acknowledged while a model turn runs; dispatch still follows investigation and deterministic revalidation. On October 20 the installed real CLI returned `usage_limit_reached` (HTTP 429), reporting a reset at 4:10 PM America/Detroit. At that checkpoint, fresh real-model UI acceptance was blocked by that account limit. The current coordination checkpoint deliberately leaves Claude disabled. The separate browser workflow exercise uses an explicitly labeled test CLI, and does not count as a real Claude response. Evidence is retained under `.local/acceptance/claude-ui-2026-10-20/`.

To exercise the interactive flow after Claude access is available:

1. Explicitly select Claude mode for this later test. Choose **Recent bidding regression** and **Simulate incident**. Wait for Claude’s assessment; a turn may take up to two minutes.
2. Ask a follow-up in **Ask about this incident**. The conversation preserves your question and the reply. Expand a reply for the detailed evidence limitations.
3. Click **Link selected incident** for the Teams simulator. Send ordinary questions using **Mention the agent**, or responder reports using **Responder conversation**.
4. When eligible, click **Request rollback proposal**. Review the current deployment, target artifact and expiry in the outbox. The model cannot approve it.
5. Click **Use approval command**. Choose **Alex** and **Send message** to test authorization rejection; the proposal stays pending. Choose **Local operator**, use the command again, and **Send message** to approve.
6. Verify the action says **simulated** and the incident stays open. A simulated dispatch supplies no independent recovery proof. Try the schema-change or old-feature scenario to inspect blocked rollback explanations.
7. If the CLI cannot respond, inspect the visible error. For an exhausted job, use **Retry investigation** with a reason after restoring Claude availability. This retries analysis, not deployment execution.

## 2. Prove each reader against an actual resource

Populate a private connected profile and environment file; keep credentials out of this document and Git. Enable a source only after its scope, credential and test resource are configured.

```sh
node --env-file=.local/sre.trials.env scripts/sre-readiness.mjs --json --strict
node --env-file=.local/sre.trials.env scripts/sre-check.mjs --live --json
```

| Integration | Required evidence before proceeding |
| --- | --- |
| GitLab | Project metadata; immutable baseline and faulty revisions; an MR with a complete diff, linked changes and CI results; deployment metadata tied to the deployed artifact. An empty project only proves limited project reads. |
| Dynatrace | A reader scoped to the trial environment; a bounded service log query; an observed entity or verified service query; actual metrics/problem lifecycle. Empty query results do not prove telemetry ingestion or fault detection. |
| ServiceNow | A dedicated read identity; exact CMDB CI and fictional incident `sys_id`; recent and active reads; creation/update/closed-state handling; explicit Dynatrace correlation. The agent does not currently create or update ServiceNow tickets. |
| Claude | A real CLI invocation with structured output and relevant evidence references. Evaluate reported attempts, corrections, missing evidence and alternatives. One successful sample does not establish general diagnosis accuracy. |
| Teams | Installed bot with actual tenant, conversation and approver IDs; authenticated incoming mention, reply delivery, join/update/status and removal behavior. An app draft or personal Codex connector is not this bot installation. |

Prefer mention-only Teams access initially. Use explicit `update` messages for progress. Request background message-reading consent separately before testing passive capture. Check that unrelated threads, passive approvals, removed installations and wrong tenants are rejected.

Latest Dynatrace uses [platform tokens](https://docs.dynatrace.com/docs/manage/identity-access-management/access-tokens-and-oauth-clients/platform-tokens) with Bearer authentication for its platform services. Do not configure a Classic token/header solely because an older example uses one. Verify the actual environment and API contracts.

For ServiceNow, the [read-only role](https://www.servicenow.com/docs/r/platform-administration/user-administration/c_ReadOnlyRole.html) restricts access already granted by other roles and has documented exempt tables. Validate actual API permissions with the dedicated identity. [Client credentials](https://www.servicenow.com/docs/r/platform-security/authentication/client-credentials.html) require instance configuration; do not substitute an administrator bearer token for the intended read identity.

GitLab trials currently limit [project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/) to one. Keep the reader's rights unchanged while selecting and validating a separate deployment credential mechanism. A token that can read a repository cannot be assumed to create or dispatch a pipeline.

## 3. Exercise one connected incident

1. Publish the reviewed fictional pilot to the dedicated test project. Install CI, retain an immutable healthy artifact and prove its health before fault injection.
2. Deploy the faulty artifact only in the trial service. Send synthetic traffic and observe a real configured Dynatrace signal. Distinguish manually inserted plumbing records from native failure detection.
3. Create a fictional ServiceNow incident for that exact CI. Verify the agent correlates it to the same service and problem.
4. In a dedicated Teams test conversation, ask for impact, evidence, attempted actions and the next safe check. Add two responder updates, including a correction. Restart the agent and ask a follow-up.
5. Review the exact rollback proposal. A real dispatch requires the separate writer, protected pipeline and explicit operator approval. Verify the pipeline rechecks deployment identity, artifact provenance, compatibility and approval expiry at execution time.
6. Verify the resulting deployment independently and repeat health plus auction invariants. Workflow completion alone must not resolve the incident. Reconcile affected transactions separately.

Required failure cases include missing/revoked credentials, incomplete telemetry, stale health, wrong tenant, disallowed approver, expired approval, changed deployment identity and a lost dispatch response. An ambiguous write must not be automatically replayed. See [workflow approval](WORKFLOW-APPROVAL.md).

## 4. Assess usability and reliability

Ask a reviewer to identify impact, the latest attempted mitigation, the remaining uncertainty and the next action without expanding diagnostic details. Check that queued analysis receives an acknowledgement, long responses remain readable and the full approval is visible. Measure actual timing and record misunderstandings; do not invent usability scores or response-time guarantees.

Repeat the connected conversation through a controlled restart, then a short continuous run before a longer soak. Retain failures as evidence. The existing process and PostgreSQL drills exercise specific local boundaries; they do not certify SaaS credentials, tenant permissions, production model quality or the enterprise hosting image. Consult the known limits in [process soaks](PROCESS-SOAK.md) and [Claude runtime](CLAUDE-RUNTIME.md) before declaring readiness.
