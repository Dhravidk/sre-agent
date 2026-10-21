# Organization-wide incident collaboration

The optional `teams.admission: "tenant"` profile accepts members of one configured Microsoft tenant in team channels and group chats without editing a room allowlist. Two actual Microsoft accounts have passed the live collaboration acceptance below. The app is published to the trial tenant as **Built for your org**. A non-admin account found and installed it in a new test team; the earlier installation in a two-person chat also passed. The dated checkpoints retain their original scope; the latest MR-tracking acceptance is recorded at the end. These results establish this trial tenant's tested paths, not Ally permissions or production readiness.

## October 20 live checkpoint

- **SRE Agent Trial 1.1.1** is published with availability **Everyone (org-wide default)**. Global custom-app upload settings were not changed.
- The previous temporary tunnel had expired. Its replacement callback and public app links use the same Cloudflare-to-loopback architecture. Version 1.1.1 changes only the app version and those links; identity, capabilities and permissions are unchanged.
- The approved org window began at **7:02:17 PM America/Detroit on October 20, 2026**, and expires at **9:02:17 PM that evening**. New incoming webhook traffic and new outbound delivery attempts stop when its grant closes or expires. Already queued briefings remain durable without consuming delivery attempts. A request already in flight may finish.
- One actual org-mode mention from the original user passed native Microsoft authentication, member lookup, command processing, persistence and a bot reply with a Microsoft message ID. The live process restarted with the same incident and agent identity. Claude and deployments remain off.
- **SRE Trial Responder** was created as a non-admin using an existing trial seat, with Teams as its only selectable service, plus organization-assigned defaults. No licenses were purchased. The human completed the initial password change. The profile email and authenticated native messages from its distinct Entra identity are verified. The active password supplied by the user is saved in the private mode-600 credentials file; it is excluded from evidence and source snapshots.
- The first catalog Add attempt returned **This app cannot be found**. A later retry through Microsoft's documented org-catalog deep link succeeded with **Added successfully! Choose a place to use the app**. The original failure's cause is unknown. The original user then used **View and add participants → Add agents → SRE Agent Trial** in the dedicated chat with the trial account. Teams confirmed the bot was added there. No third human account was needed.
- This actual installation exposed an ID-format bug: a bot added between two people receives authenticated `groupChat` activities with the existing `@unq.gbl.spaces` ID. The router now accepts that format while retaining exact tenant membership, explicit mentions and rejection of personal bot scope. After the fix, real `incidents` and `join` commands completed with Microsoft reply IDs, and briefing #28 was delivered to all three joined conversations.
- Live testing also exposed a false delivery-delay reminder when a fresh briefing replaced an old unread round. The fix retains the unread reminder against the latest delivered round; a new queued round does not create a second false delay alert. A genuinely delayed queue still raises a delivery issue. The join confirmation is shorter and keeps the next commands visible.

Evidence for that earlier checkpoint is retained in `.local/acceptance/organization-teams-2026-10-20/`. Do not copy credentials or the private incident database into an app package or repository commit.

## Two actual users: completed acceptance

The original **dhravid kumar** account and non-admin **SRE Trial Responder** sent actual resolved @mentions through Teams. Their different Entra object IDs passed native authentication and member lookup; commands completed with Microsoft reply IDs. The responder created the private **SRE Agent Test - Org Member** team, added the original account as a member, found version 1.1.1 in the org store and installed it. This proves non-admin discovery and installation where that user owns the team; other members still follow their team's installation policies.

A fresh fictional incident, `inc_0170b15897a63c7218ab`, links its Bidding thread and the new Org Member thread. Both received the same numbered briefing. Live checks covered:

- Deployment and network theories disagreed; duplicate `eu-canary` work raised reconciliation warnings and a request for a shared thread/lead.
- A real five-minute wait with one team silent produced the missed-acknowledgement reminder. Acknowledging an old briefing explicitly warned that a newer one remained unread.
- Releasing duplicate work and explicitly accepting the handoff left one active owner. Ruling out the deployment-only theory removed its competing-theory warning.
- One team claimed recovery while the other still reported impact. The agent flagged the disagreement and retained the open incident. Correcting that claim removed the disagreement; neither claims nor acknowledgements verified recovery.
- `leave` cleared that room's incident binding. A later owner update produced no new outbox records for the departed room. Rejoining restored the same incident and earlier context.
- Two service restarts retained agent identities, bindings and work. The later restart also retained both readable room names. An actual second-user update then continued the same work.
- A wrong-incident rollback request was rejected in the live Bidding thread, and a wrong-incident investigation request was rejected from the responder's thread. The other incident's evidence, work and rollback records were unchanged. A fixture regression independently proves the rollback proposal service is never invoked for that wrong target.
- A correctly targeted rollback request was refused because execution was disabled and deployment-regression evidence was absent. No live rollback record or deployment was created.

Live testing also improved paragraph formatting and added `name <room name>`. Labels persist independently of incoming native references. Messages escape formatting characters so literal incident IDs and command placeholders remain visible. The current native formatter uses Microsoft's [recommended extended Markdown](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/format-your-bot-messages); a bounded plain-text fallback preserves oversized content. Both the test suite and actual Teams clients were checked.

Evidence, failed reproductions, screenshots, native delivery IDs and the final 606-test log are retained in `.local/acceptance/two-user-teams-2026-10-20/`. Provider incident evidence is fictional. No actual Claude inference, live Ally MCP access, production telemetry detection or deployment execution is established by this acceptance.

## Complex incident and signal-digest checkpoint

The later approved renewal runs from **9:29:23 PM to 11:29:23 PM America/Detroit on October 20**. It uses the same tenant, bot, callback, mention-only scope and incoming/outgoing expiry gates. Claude, live provider readers and deployment execution remain disabled. The earlier 7:02–9:02 window above is historical.

Both actual accounts joined new threads titled **Fictional complex incident - Bidding** and **Fictional complex incident - Platform**, following `inc_aba96ddfe41a6ace3874`. Fictional provider evidence contains 262 log observations, including 90 overlapping observations, a rare critical bidding error and credit timeouts on both exact releases. Both users received the `signals` response through native Teams with Microsoft message IDs. It retains the rare error, separate health-probe traffic, older-release counterevidence, immutable comparison and commit history, and the sampled-query warning.

The users submitted competing recovery plans under the same shared work key, deployment/dependency theories and conflicting recovery claims. Shared briefings reached both rooms with overlap, theory and reported-state warnings. An explicit release/acceptance handoff left one owner, and Bidding withdrew the health-probe-only recovery claim. The incident remained open.

A separate five-minute wall-clock check retained an unread briefing through **SIGKILL** and restart. One team had acknowledged briefing 30; the other had not. The reminder reached both rooms after 300,512 ms. Subsequent graceful restart checks retained the original reminder IDs and remote receipts without replay. New-incident activity did not acknowledge the older incident's unread briefing.

New regressions reproduced two ways noise hid code evidence: the database window and the model byte budget. Source-aware selection now preserves provider/type diversity and reserves a separate code-history budget. Structured logs can withhold the limited rules' deployment claim when they contain unexplained failure classes, matching failures on an older exact release, or incomplete coverage. Log groups alone cannot establish a new positive code attribution. The code check parses only the five known auction-policy patterns; general code reasoning still awaits a Claude test. The trial now explicitly selects `repositoryProvider: "gitlab"` for analysis, with execution still disabled.

The local UI also created an eligible mock proposal, accepted an authorized approval after contrary logs arrived, then **blocked dispatch at the final fresh policy check**. No rollback simulation ran for that request. This distinguishes authorization from deployment eligibility and execution.

Both real identities acknowledged shared briefing 24 at the final receipt checkpoint; subsequent age-based briefings remain separate. The final browser check also verified the local signal card's displayed-versus-available group count and source paths from immutable legacy comparison fixtures. Raw evidence remains stored when a display group is omitted.

A separate real read-only GitLab request succeeded for `test-group7105743/test-project` (project 87869540), whose API reports an empty repository. It cannot yet validate real commit/diff/source history. The code history used in the Teams incident is generated fixture data, not a claim of live GitLab history or Dynatrace detection. No repository mutation or real provider data was sent into the Teams trial.

Evidence, native receipts, failed reproductions, bounded-load checks and the final test log are in `.local/acceptance/complex-teams-noise-2026-10-20/`. The bounded load check examined 240 evidence batches containing 48,000 records; it retained the rare critical batch, scanned 2,000 records and explicitly reported omitted groups. This is one local bounded workload, not a production throughput or uptime claim.

## October 20–21 GitLab checkpoint

The [GitLab sandbox acceptance](GITLAB-SANDBOX.md) populated the private test repository and verified actual read-only source/history collection. Both real users joined a fresh shared incident, reconciled code-versus-CI theories and a false recovery claim, handed off ownership, and received a revised assessment when a dependency failure appeared on the healthy revision. Claude and deployment execution remain off. The renewal expires at 1:40:40 AM America/Detroit on October 21. The record distinguishes real source/Teams transport from locally generated telemetry and simulated release timing.

## User flow

1. Find **SRE Agent Trial** in the organization's Teams apps and add it to the intended team or group chat. In a chat between two people, use **View and add participants → Add agents**. The bot appears in that picker; a third human is not required. Teams installation and membership policies still apply.
2. Select the actual bot from the @mention picker. Send `incidents` to find the fictional incident.
3. In each participating incident thread or group chat, send `join <incident-id>`. Joining shares that incident's submitted context with other joined conversations in this tenant. People in those conversations can read the posted briefings. Use a separate thread/chat for each incident.
4. Optionally send `name <room name>` to make that incident thread's label readable in shared briefings. It changes the display label, not Teams membership or sharing permissions.
5. Use `signals` to read grouped logs and code history, or `help` for the command guide. Send mentioned `update`, `report`, `theory` and `work` commands. Use `sync` for a shared briefing and `ack <number>` after reading it. `leave` stops future incident briefings in that conversation.

Ordinary unmentioned conversation, previous history, attachments, edits and deletions are not synchronized. Reports are attributed claims, not independent confirmation of recovery. There is one persistent incident agent identity across the joined rooms and restarts. At most eight conversations can follow an incident; further teams should use a common incident thread/bridge.

## Configuration and boundaries

```json
{
  "tenantId": "<exact Microsoft tenant GUID>",
  "admission": "tenant",
  "tenantSharing": {
    "key": "organization-incidents",
    "name": "Organization incident response"
  },
  "conversations": [],
  "approvers": [],
  "captureResponderUpdates": false
}
```

An org-wide tenant maps to exactly one service, avoiding ambiguous routing. The native SDK validates Microsoft's inbound JWT; Bot Connector's member lookup must match the sender's Entra ID and configured tenant with a recognized `user` or `owner` role. Guest, foreign-tenant, unknown-role and missing-member responses fail closed before message storage. The bot must actually be installed for Microsoft to deliver a mention. This is sender validation; it does not independently certify that every participant in a joined conversation is an employee.

The tenant-sharing key is saved as the incident audience. Changing it does not silently migrate old incidents to a new audience. Existing explicit collaboration groups can retain their key when the operator intentionally expands their audience. Incident context is posted only to enabled conversations that join that incident. Installed but unbound conversations get setup help, not another thread's context. An explicit `incidents` request lists this service's incident IDs/titles.

Tenant-wide reporter access does not authorize rollback approval. Approval still requires both an explicitly configured approver and an explicitly allowlisted room, plus all existing proposal/nonce, evidence, deployment and execution checks. The org trial forces rules mode, a nonexistent Claude executable, no approvers, disabled rollback execution and disabled live provider readers.

Team identity is retained with each received channel reference. A team uninstall disables all known channel threads in that team and blocks late mentions in previously unseen channels. A later authenticated install can restore existing incident bindings within the eight-room limit. Duplicate or older lifecycle activities cannot undo newer removal/reinstallation state. Group chats keep their own lifecycle. Team and room state is locked while accepting new references to avoid racing an uninstall.

## Trial activation

The package is `.local/live-teams-org-trial/app/sre-teams.zip`, version **1.1.2**, using the existing app and bot identities. Version 1.1.2 refreshes the retired trial notice URLs; the October 20 checkpoint used 1.1.1. It supports `team` and `groupChat` scopes and requests no Graph or RSC message-history permissions. This one app is published; users do not need permission to upload arbitrary custom apps. Microsoft documents [org app management](https://learn.microsoft.com/en-us/microsoftteams/manage-apps), [app availability](https://learn.microsoft.com/en-us/microsoftteams/app-centric-management) and [org-catalog installation links](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-application). Those links use the catalog ID, which differs from the manifest ID. The original lookup failure's cause remains unconfirmed; the later successful installation is independently recorded.

The prepared private settings are `.local/live-teams-org-trial/settings.json`. They reuse the existing fictional incident database and ports. Stop the earlier native trial before starting this profile:

```sh
SRE_TEAMS_TRIAL_SETTINGS=.local/live-teams-org-trial/settings.json \
  node --env-file=.local/sre.trials.env --env-file=.local/sre.teams-trial.env \
  scripts/sre-teams-trial.mjs
```

Its separate grant activates both incoming webhook forwarding and outbound delivery. It requires the exact tenant/bot, `admission: "tenant"`, an empty `channelIds` array and an explicit expiry within eight hours. An old two-channel grant cannot enable org scope, and an org grant cannot enable the old profile. Missing, malformed, closed and expired grants pause delivery before a queued message is leased. Only the authenticated Teams webhook and static trial notices cross the temporary tunnel; operator APIs and the console stay private. Temporary callback and computer hosting remain availability limits.

## Verification

`node --test tests/sre-teams-organization.test.mjs` exercises two distinct fixture identities across new team channels and group chats, including `@unq.gbl.spaces` chats, shared conflict/duplicate-work briefings, other-incident isolation, leave, database restart, the real native SDK member-lookup wire path against a mock Connector, guest/foreign/missing identities, approval separation, team-wide removal/reinstall and forwarding-grant scope separation. The collaboration suite covers fresh queued rounds, genuine delays and reminder deduplication. No Claude process is started.

Actual Microsoft Bot Connector lookup and native Teams transport passed for both real accounts, including the responder's uniquely attributed group-chat update and its fresh team installation. This is separate from the synthetic identities used by the automated suite. Private/shared channels, Ally tenant installation policies, background history capture, actual model reasoning and production recovery still need their own acceptance. Claude and deployments remain off.

## October 21 renewed MR-tracking acceptance

The old Cloudflare quick tunnel returned `Tunnel not found` and its hostname no longer resolved. After explicit approval of the replacement callback, the same org trial was activated from **2026-10-21 12:59:08.817 UTC to 14:59:08.817 UTC** (8:59–10:59 AM America/Detroit), using `https://rug-jpeg-myspace-join.trycloudflare.com/api/messages`. The bot endpoint persisted across a Developer Portal reload. The public gateway serves trial notices, requires a Microsoft token for the enabled webhook, and does not expose the operator API. Incoming and new outgoing attempts remain bounded by the saved expiry. Tenant permissions were unchanged.

Both **dhravid kumar** and **SRE Trial Responder** sent actual resolved mentions from their existing Bidding and Platform incident threads. Native authentication/member lookup admitted their distinct Entra identities; both command acknowledgements have Microsoft message IDs. `track-change gitlab 900731` created one operational association, and the second user's request returned the same association without changing attribution. A literal, unresolved `@SRE Agent Trial` text message was not admitted as a command.

MR 900731 and its pipeline facts are fictional local provider observations. The newer head names an already tested local fixture QA commit; no GitLab MR, CI run, merge or deployment exists for this exercise. Both native threads' `changes` replies distinguish the earlier head's successful CI observation from the newer head's failed observation. Neither is treated as deployment or recovery. Live provider readers, remote Git writes, the QA executor, Claude and deployments stay off.

Duplicate active review reports produced a shared ownership warning in both threads. The native bot restarted without changing persisted agent identities, associations, work or already sent receipts. A later explicit handoff remained awaiting acceptance even though the other participant had reported active work before that release. That older report does not establish a receiver for the new handoff. A real five-minute silence produced a Platform missed-update notice after **300,550 ms**, with a Microsoft delivery ID. Platform acknowledged the briefing, then separately reported acceptance of the new handoff; only that later work report cleared its ownership gap. Both users acknowledged the reconciled briefing. After another restart on the 1,094-test source, both accounts successfully requested the retained change ledger again.

The admin upload displayed **Published version 1.1.2**, **Everyone (org-wide default)** and the replacement top-level privacy/terms links. Its package changes only the version and three notice URLs. A subsequent full admin-page reload returned `INVALID_PRIVILEGE`; that fresh admin session remains unverified and needs account reauthentication. No role or permission was changed to bypass it. The separately verified native bot traffic continued for both users. The pre-reload publication view and later access error are both retained.

Evidence and the original source/runtime boundaries are retained in `.local/acceptance/native-track-change-2026-10-21/`. Temporary callback availability and the fixed expiry remain limits. This acceptance does not establish Ally permissions, unmentioned/history/drawing capture, real telemetry detection, general code reasoning, production QA, remote publication, AWS failover or a distributed incident dispatcher.
