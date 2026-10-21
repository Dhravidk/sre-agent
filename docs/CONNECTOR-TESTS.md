> Historical port-3000 lab guide. For the current 642-test checkpoint, see [noise-aware investigation coverage](#noise-aware-investigation-coverage), [real GitLab source/history acceptance](GITLAB-SANDBOX.md), and [real organization Teams acceptance](TEAMS-ORGANIZATION.md#complex-incident-and-signal-digest-checkpoint). The database-backed service and connector setup are documented in [INTEGRATIONS.md](INTEGRATIONS.md) and [LOCAL-TO-AWS.md](LOCAL-TO-AWS.md).

# Connector test guide

Use three layers: offline contracts, connected local tests against dedicated vendor resources, and a final small AWS transport test. A green mock test proves our code's behavior against a contract; it does not prove the vendor still accepts that contract or the tenant grants the required permissions.

## Current evidence

| Integration | Implemented and tested locally | Still needs a real service |
| --- | --- | --- |
| GitLab | MR metadata/diff read, deployment read, token header, normalized deployment identity | Target version, token scopes, real pagination/large diffs, real MR/pipeline/deployment events, webhook authenticity and redelivery |
| Jira | Read one issue by key, selected fields, Cloud-style email/API-token authentication; no write client | Project permissions, actual ticket links, ADF descriptions, Cloud/DC authentication choice |
| Dynatrace | Classic problem read; Grail execute/poll contract; custom problem payload normalization | Entitlements, API/OAuth scopes, tenant-specific DQL, actual problem events, metric units/windows, token refresh |
| Teams | Actual Teams SDK receives local activities and replies through a local simulated transport; live mode rejects missing JWT | App registration, installation, real channel messages, consent/RSC, outbound proactive messages, throttling and permission revocation |
| AWS SQS | Partial batch failure, duplicate processing, same incident core | IAM, KMS, event-source configuration, visibility timeout, redrive, service limits and network |

No real vendor credentials were used during initial verification. No live Teams message was sent.

## 1. Offline connector tests

```sh
node --test tests/*.test.mjs
```

The suite starts local HTTP servers and temporary databases. It verifies method, path, token header, bounded retries, error sanitization, DQL polling, and the actual Teams SDK's transport. The SDK emits an expected warning when accepting local Playground requests without credentials.

The current GitLab reader intentionally reads bounded first pages: up to 100 diff entries and 20 successful deployments. It is a smoke-check client, not a complete production indexer. A small result does not guarantee GitLab returned every diff; server truncation and `collapsed`/`too_large` flags must be handled before trusting a general review.

## 2. Microsoft 365 Agents Playground

Microsoft's current local testing tool can chat with a bot, mock activities, and inspect HTTP exchanges. It sends unauthenticated local requests, so this repository has an explicit Playground mode. [Microsoft Playground guide](https://microsoft.github.io/teams-sdk/developer-tools/agents-playground/)

Start the lab and create an incident:

```sh
pnpm dev
# In another terminal:
node scripts/cli.mjs scenario bid-race
pnpm teams:playground
```

Install the Playground separately if needed, then open it:

```sh
pnpm add --global @microsoft/m365agentsplayground
agentsplayground -e http://127.0.0.1:3978/api/messages -c msteams
```

Send `Investigate auction-api`. Verify that the reply identifies the concurrent bid failure and links the synthetic ticket/commit evidence. Use the activity inspector to examine the request/reply. Test personal, group, and channel-shaped activities, mentions, and installation events. Only loopback callback URLs are accepted in Playground mode.

Keep `CLIENT_ID`, `CLIENT_SECRET`, and `TENANT_ID` unset or empty for Playground. The bridge refuses accidental credentialed Playground startup. It binds to `127.0.0.1`; do not expose this mode through a public tunnel.

The automated SDK transport test has passed. The separate interactive Playground application has not been installed or manually validated as part of this build.

## 3. Real Teams while the application stays local

AWS hosting is unnecessary for this test. You still need the Microsoft identity/bot registration, an appropriate test tenant, and permission to install the app. Hosting on AWS does not remove Microsoft registration and tenant consent requirements. Follow the current [Teams registration flow](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/get-started/quickstart-register).

1. Register a dedicated test app/bot. Choose the required personal/group/team scopes. Use a test team/channel and synthetic content.
2. Put its credentials in `.env` and set `TEAMS_ALLOWED_CONVERSATIONS` to the exact comma-separated conversation IDs authorized for the test. A channel ID or display name must not be guessed to be the SDK conversation ID; obtain the actual activity/reference through the registration/developer tooling.
3. Run `pnpm teams:live`. This mode requires the tenant ID, credentials, and allowlist. It leaves Teams JWT validation enabled and checks tenant plus conversation before invoking the lab.
4. Use an approved HTTPS tunnel for **port 3978 only**, and register its `/api/messages` endpoint. Do not tunnel the lab UI or event-injection API on port 3000. Microsoft documents persistent Dev Tunnels for this workflow. [Local tunnel guide](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/developer-tools/local-tunnels)
5. Install the app, mention it in the selected conversation, and confirm the synthetic incident reply appears in the intended place.
6. Verify rejection of an unauthenticated public request, a wrong tenant, and a conversation outside the allowlist. Remove the app and confirm sending no longer succeeds.
7. Stop the tunnel after the test.

The bridge stores conversation references in `.local/teams.sqlite`. A production proactive sender still needs to restore the full conversation/thread reference and correct service URL, deliver outbox items, retain remote message IDs, and recover after restart. Implement and test that sender before claiming automatic incident collaboration works. Current real-tenant mode supports request/reply only.

Proactive delivery requires a usable conversation and the app's installation/access. Reading channel messages without an explicit mention is a separate permission decision; resource-specific consent may be required. Start with mentions and the incident thread the bot participates in. [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages) · [Receiving messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/enable-receive-all-chat-messages)

Do not treat successful replies as proof of proactive delivery. The acceptance test must create an incident without a user message, deliver one notification to the mapped test conversation, restart the worker, and verify that subsequent updates remain in the right thread without uncontrolled duplicates. Repeat after access is revoked.

## 4. Credentialed read checks

Copy `.env.example` to `.env`, populate only the connectors you intend to test, and use dedicated read-only credentials:

```sh
pnpm connectors:check --live
```

The script reads one configured MR and recent deployments, one configured Jira issue, and one configured Dynatrace problem (or a bounded Grail query). It prints status and sanitized errors, not returned ticket bodies or tokens. Missing configuration is reported as **not configured**.

For Jira Cloud, use email plus an API token with read permissions to the chosen issue. Selecting REST version 2 does not turn this into a Jira Data Center authentication implementation; configure and test a separate DC authentication adapter if that is the team's platform.

For Dynatrace Classic, set the environment URL and an API token with problem-read scope. For Grail, set the platform URL and an appropriate OAuth bearer token; refresh/acquisition is not implemented here. Bounded queries can still consume tenant query allowance. Confirm actual field names, scopes, time windows, and edition before broader monitoring.

## 5. Exercise actual events without production changes

Use a dedicated GitLab project for the generated pilot repository. Create a healthy MR and a risky scenario MR, verify the read connector sees their exact SHAs/diffs, then run a test deployment that records an explicit environment and artifact digest. Exercise MR creation/update/merge, pipeline failure, deployment success/failure, and webhook redelivery. GitLab provides webhook testing and request inspection. [GitLab webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/)

The lab's `/api/events` accepts already-normalized trusted fixtures. It is **not** an authenticated GitLab or Dynatrace webhook endpoint. Build a separate ingress adapter with body limits, vendor authentication, project/tenant routing, payload validation, durable enqueue, and prompt acknowledgement before pointing vendor webhooks at it.

For Dynatrace, first use a dedicated monitored demo service or approved test entity. Generate known load and a short synthetic fault, verify the real problem notification, and compare timestamps/entity IDs with API reads. A fabricated HTTP payload alone does not test Dynatrace detection or ingestion. Feed only sanitized test payloads into replay fixtures.

For Jira, link an existing test ticket key in the pilot MR/commit; verify lookup and access-denied/missing-ticket behavior. Ticket text contributes context, never proof of deployment or rollback compatibility. The agent needs no Jira write permission.

## Completion record

For each real test, record date, vendor edition/version, resource scope, authentication method, request/event IDs, observed result, and remaining gaps. Mark mock-only, live-read, live-event, and end-to-end checks separately. Do not convert “not configured” into a passing integration result.

## Noise-aware investigation coverage

The incident context reads at most 240 non-human candidates with a fair window across source/type buckets, selects at most 80 representative telemetry/code rows, and reserves 40 responder/question rows across conversations. Repeated log-family snapshots and superseded native problem snapshots can be represented by their latest snapshot, while the complete raw audit stays in the database. Candidate limits and stored counts remain explicit. A composite evidence index supports these reads.

The model transport reserves 24 KB for code history, 60 KB for other telemetry and 40 KB for responder evidence, within its existing 160 KB total envelope. It drops lower-priority telemetry before code history and responder context. Digest citations are removed or marked omitted when their raw evidence does not survive the final transport. An oversized digest is omitted explicitly rather than replaced by a misleading serialized prefix.

The signal digest scans at most 2,000 log records, displays up to 12 families and 8 source comparisons, and retains separate environments, entities, regions, endpoints, severity, structured HTTP codes and release identities. Exact repeated timestamped records are counted as overlapping observations. Full source records remain available in the durable audit. Comparison coverage, commit titles/SHAs, source paths and deployment-time boundaries are retained; identity linkage is not causation. UI and Teams previews show fewer entries with coverage details available.

The Grail reader rejects a successful response without a records array or malformed sampling metadata. A sampled result, warning/error notification or full 200-row window is marked incomplete. This follows the provider's documented [query metadata](https://developer.dynatrace.com/develop/sdks/client-query/) and [Grail query response](https://developer.dynatrace.com/develop/platform-services/services/grail-service/). GitLab comparisons retain exact references and incomplete-diff flags described by the [Repositories API](https://docs.gitlab.com/api/repositories/).

The limited rules do not upgrade log groups into a positive deployment finding. Unexplained log-only failures, the same failure on a previous exact release, and sampled/omitted log coverage keep attribution unknown. The five supported auction-policy source patterns are parsed without executing source code. General application/code reasoning and production attribution require later model and connected acceptance.

The earlier October 20 expanded checkpoint passed 632 tests. SQLite and PostgreSQL syntax/transactions in PGlite cover noise-window preservation; record grouping, omissions, metadata handling, contradictory logs and model budgets have dedicated regressions. Real Teams transport used two actual Microsoft identities with fictional provider records. A standalone real GitLab reader request passed, but that trial project is empty, so actual commit/diff/source history remains unverified. Evidence is under `.local/acceptance/complex-teams-noise-2026-10-20/`.

The October 20–21 [GitLab checkpoint](GITLAB-SANDBOX.md) populates that repository with 20 commits/eight branches and verifies actual immutable source/history reads. The current suite passes 642 tests. Low-severity, error-free health HTTP successes omitted only for display are counted separately; all other omissions still withhold limited attribution. The Teams drill retains a conditional code finding while withdrawing the overall deployment candidate after independent dependency evidence.
