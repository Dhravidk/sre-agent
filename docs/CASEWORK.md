# Contacts, fix tickets, QA and alert threads

Claude stays off in the current local rehearsal. Open the port-3002 demo, create a recent bidding regression and use **Owners and fix plan**. The demo includes Bidding, Platform and a fictional worker desk, with six selectable synthetic identities. Only Local operator may approve local QA.

## Persistent multi-team rehearsal

Run `pnpm sre:rehearsal` for a separate persisted console on port 3004. Optional `--directory /absolute/private/folder --port 3005` selects another dedicated directory and loopback port. It does not load account credentials or inherit a remote database URL. Its SQLite database and local QA workspaces live together under that directory; fixture inbox JSONL is a delivery record, while incident, room, plan, QA and approval state live in the database.

Use the two incident buttons near the top. EU Bidding, EU Platform and the worker desk share the accepted-bid regression. US Provider operations and US Provider engineering follow an independent dependency problem. The EU case opens from three matching log errors before the scripted human messages. Another 180 successful health probes remain grouped as a separate sample. Separate fictional metric corroboration supplies the narrow rules recognizer; the rules engine does not infer arbitrary causes from free-form logs. Actual generated before/after code supplies the known version-guard defect. Pipeline 201's scripted success, pipeline 202's scripted failure and the MR risk review are distinct from runtime recovery.

1. Inspect the EU coordination warnings: an unverified recovery report conflicts with ongoing investigation, the groups propose different theories, and both claim the same replay work. Sam's unmentioned worker update stays in context. Robin's drawing is metadata only; its text description is a responder claim.
2. Open the US case. Its logs keep their own region and release, and no EU rollback target or code finding is inherited. Incident selection starts on the appropriate channel thread and keeps each case's unsent drafts separately.
3. In the EU case, review **Owners and fix plan**, draft a current Markdown ticket if new evidence made the old one historical, then choose **Request local QA**. As the requesting Local operator in that thread, send the exact approval or `yes` while it is the only pending action. Another responder cannot approve it. A successful run creates a local branch and retains failing-original/passing-fixed business checks and the exact patch; it does not publish an MR.
4. Add an update from another responder or ask for `sync`, `signals`, `contacts` or `changes`. Stop and restart the launcher with the same directory to keep the case and its approval/QA history. An interrupted initial seed resumes with stable delivery IDs. A ready checkpoint is not replayed; a foreign nonempty database, changed mapping or corrupted checkpoint is rejected.

The mock reader can correlate a ticket to `log-monitor:<configured-monitor-id>:<64-character-lowercase-scope-hash>` only when `servicenow.correlateLogMonitors` is explicitly true and its CI matches the service. The default is off. Each ticket's own native ID and lifecycle remain independent; closing a ticket cannot close an observed log source. This is an exact identity contract, not fuzzy incident merging. Real Ally correlation fields and source ownership require validation before enabling it there.

The launcher is an offline rehearsal, not Microsoft transport or general code/model acceptance. The port-3002 demo and native Teams trial retain their separate histories. Native background messages, drawing contents, real monitoring, generic isolated QA and remote MR publication remain separate integration work. Distributed dispatch remains [a design for review](DISPATCH-DESIGN.md).

## Database records

The existing SQLite/PostgreSQL adapters store all case tracking. New tables retain versioned directory snapshots, immutable Markdown plans, QA requests and transition events, provider change observations, incident-to-change links and original alert-thread bindings. A local file export is a copy; the database remains authoritative. No Jira or ServiceNow ticket is created.

`POST /api/services/<service-key>/directory` imports a JSON snapshot through the existing operator API authorization. It requires `source`, `observedAt`, `expiresAt` and bounded `entries` with `id`, `name`, `team`, `contact`, `role` and repository-relative `paths`. Roles are `service-owner`, `component-owner`, `on-call`, `escalation`; on-call entries require `startsAt` and `endsAt`. Expired/conflicting directories do not select a current owner. The demo seeds fictional example.invalid contacts once; it is not Ally's org chart.

Contact recommendations carry their directory source, observation time and a validity window ending at the next shift transition or directory expiry. Overlapping active shifts and multiple owners of an implicated path keep all candidates visible and ask for a confirmed lead. A roster with no active shift reports the coverage gap even when a service owner remains available. Component ownership based on an older assessment is identified as awaiting the current review.

Saved assessment replies and Markdown tickets retain their original contact snapshots. The API and console flag these snapshots when directory evidence or a shift window changes, independently of the incident revision. Contact changes do not invalidate the code findings or grant QA authority. Drafting a new ticket requires a current audited assessment and rechecks the contact version before saving; repeated drafts within an unchanged window reuse the same ticket. Restart recalculates freshness without rewriting old tickets.

The existing command loop checks one active incident at a time for contact updates, independently of a slow investigation. Each currently authorized joined conversation gets one initial contact notice and another when applicable owners, shifts, directory availability or coverage uncertainty changes. A shorter validity window also gets an update; an equivalent fresh directory observation or review-in-progress wording stays quiet. Per-conversation publication receipts and outbox messages commit together in the database. Older pending contact notices are retained as discarded when superseded. No unjoined alert-channel fallback receives these proactive updates. Resolved incidents stop proactive notices, including a notice still waiting to send. An uncertain send remains uncertain and is not automatically replayed; a discarded notice can get a fresh copy after its conversation rejoins.

New managed assessment replies, `contacts` responses and proactive contact notices carry host-generated contact-section provenance. Before sending, the outbox checks its lease and current conversation access, refreshes that generated section from the directory, and saves the prepared body, directory view and observation time. The original queued body and saved assessment/ticket remain unchanged. The console displays the prepared body with its check time and retains the original queued reply separately. Preparation is not a delivery receipt, a read receipt, acceptance of a handoff, or an atomic guarantee against an import immediately after the check. Older messages without this provenance keep their original body. A clipped Teams message can omit later details; the full source and prepared body stay in SQL.

Restore retains contact-message provenance and prepared send bodies as historical evidence. It resets positive publication receipts and holds all delivery/publication. After reconciliation, a new directory observation is required to select current owners. Fresh notices use the restore generation and cannot silently replay a pre-restore uncertain message.

Teams delivery runs independently from command intake and investigation. The current transport defaults are a 15-second send deadline and four reserved calls per runtime. A timed-out adapter that ignores cancellation keeps its slot until it actually settles; saturation is visible as an instance condition. The SDK receives an abort signal and a bounded HTTP timeout. Notifications to a conversation are serialized through a database lease, and an earlier rate-limited message keeps later messages in that conversation behind its retry deadline. Other conversations can progress. This transport concurrency does not add incident dispatchers or parallel model investigators.

A timeout, interrupted send or expired claim remains `unknown` and is not replayed. A later receipt or failure is retained separately and cannot overwrite that state or disable a conversation using an expired authorization result. The console surfaces older uncertain/failed messages ahead of routine recent messages and shows retained late evidence. It does not provide a new delivery-retry or reconciliation approval action. A lease is finite: a remote operation can still finish after it expires or after a process dies, so this is not an exactly-once or absolute ordering guarantee across failures. Inspect the actual conversation before deciding what to do next.

Prepared logical bodies, normal outcomes and late transport observations live in SQL and survive backup/adapter transfer as historical evidence. Preparation is not proof of a network post or human receipt. Known HTTP 429 rejections honor Retry-After when provided and stop after four claimed attempts; an uncertain transport failure does not retry automatically. Shutdown aborts active sends and retains uncertainty before closing storage. Old agents must still be stopped for offline database recovery.

`GET /api/incidents/<id>` includes casework. `POST /api/incidents/<id>/plans` creates an idempotent snapshot ticket. `GET /api/incidents/<id>/plans/<plan-id>.md` downloads Markdown. `contacts` and `changes` also have GET subroutes. Connected API requests require the operator token; local mutation stays loopback/same-origin.

## Teams commands

Join an incident, then @mention the agent:

```text
contacts
changes
track-change gitlab 72
plan
fix <plan-id>
approve-fix <request-id> <nonce>
```

`ticket` aliases `plan`. A developer can reply `yes` only when exactly one unexpired local QA proposal exists in that joined conversation, it belongs to that developer, and there is no pending or uncertain rollback action for the same incident. Other developers' proposals in the same chat count toward ambiguity. Otherwise the exact approval command is required. Passive messages, another room, another person, stale evidence and expired authorization cannot approve QA. Plans, request status and results survive restart.

The QA adapter is injected **only by the local demo** and accepts exact locally generated pilot trees. It reproduces the known business defect, changes one parsed literal policy field, runs four trusted business checks and commits a branch containing the fix, Markdown ticket, MR draft and test evidence. The database also retains the patch, ticket text, MR draft, branch/commit identity and test output; local paths are not the only tracking record. It uses no repository credentials and does not install dependencies, push, create an MR, merge or deploy. Unknown implementations, multiple code findings, schema changes and unsupported production repositories have no automatic patch. An interrupted filesystem action becomes unknown after its lease expires; it is never silently replayed.

The real Teams profile has no QA executor configured. `plan`, `contacts` and `changes` are read/plan operations there. A production QA runner, repository write scope, isolated execution and MR lifecycle acceptance remain separate work.

## Signed alert workflow intake

The current Teams bot ignores other bots' messages. An alert workflow can mirror structured data to `POST /webhooks/alerts/<service-key>` in connected mode. Configure `alerts.enabled`, an explicit `alerts.providers` array (`datadog`/`dynatrace`) and a separate `webhookSecretEnv`. Sign the raw body with the existing timestamped HMAC contract (`x-sre-timestamp`, `x-sre-signature`) and provide a stable `x-sre-event-id`.

The JSON body identifies `provider`, `alertId`, `groupKey`, `title`, `service`, `environment`, `status`, `startedAt`, `observedAt`, optional `metrics`, and optional `thread: {tenantId, channelId, messageId}`. Thread channels must be explicitly configured and have an existing installed bot reference whose saved conversation type is `channel` and whose saved conversation ID belongs to that channel. A group-chat, personal or untyped reference cannot establish a channel installation. The reference's stored service URL is used; an incoming alert cannot supply another URL. Intake, incident association and original-thread binding commit together. Duplicate events cannot repeat work. Different monitor IDs retain independent lifecycle states even when grouped into one incident.

The worker's assessment is queued to that original alert thread and other authorized conversations that join the incident. It does not fetch earlier messages or claim a vendor-specific card integration. Live Datadog/Workflows ingress is unverified; use the local signed HTTP exercise before enabling a real workflow.

Workflow metrics retain native provider/monitor identity as well as the incident grouping key. A correction replaces that monitor's earlier snapshot; it cannot remove a different monitor's failure. Closed monitor snapshots remain in the audit and no longer supply current failure signatures. Distinct metric versions at the same source time are retained as a conflict until a strictly newer observation arrives. If the bounded source window cannot cover the active workflow monitors, the rules withhold a conclusive deployment attribution and request the missing snapshots.

Equivalent deliveries of the same monitor, source timestamp, status and normalized content retain separate inbox audit rows without another incident revision or investigation. Metric field order and the order of equivalent code/violation sets do not create new facts. A later source timestamp, changed content or a different monitor still requires reassessment and makes an older fix plan stale. The observation fingerprint is stored with its native lifecycle state; existing older states acquire it on their first fresh admitted observation. Original event normalization and delivery IDs remain unchanged, so a replay across the software update remains idempotent.

An authenticated delayed or equivalent alert can still link a new authorized original thread to the existing incident. Its older metrics do not become current, reopen a source or change the incident revision. The new thread receives an explanation and a required reply using the current incident context. That reply survives an evidence change during investigation. An unchanged assessment is sent to the new destination only; changed conclusions continue to reach the other joined conversations. Sharing, installation, thread ownership and the eight-conversation limit still apply in the same transaction. A duplicate delivery cannot restore a conversation that left the incident.

When several threads join before the worker catches up, one investigation can answer all of them. Claiming that work transfers their waiting reply destinations into the retained job in the same transaction that supersedes redundant work. The destinations survive an expired lease, runtime replacement and reassessment after new evidence. Explicit human questions retain separate jobs. An unchanged conclusion reaches each waiting authorized thread once without another broadcast to older recipients; a changed conclusion uses the normal shared broadcast. Destination membership and sharing scope are checked again before publication and delivery, so a departed, moved or revoked thread cannot receive the old incident's answer. All assessment and reply intents commit together.

## Message and content limits

Context selection now balances rooms and sender identities. A noisy person cannot consume every slot in a quiet person's group. Shared briefings include the latest report per participant, up to six per room, and flag omissions; large-message/model transport limits can further shorten a briefing. The database retains full admitted text; model and briefing windows remain bounded. Work/theory keys and explicit team reports stay separate from quoted discussion. This is not unrestricted access to all chat history.

The current organization trial still receives explicit mentions only. Background discussion needs scoped Teams RSC installation/consent. Attachment names/types are retained as explicitly unread metadata, with no URL retrieval. Drawings, attachment contents and voice are not interpreted in rules mode; their proposed pipeline and the multi-dispatcher design are in [DISPATCH-DESIGN.md](DISPATCH-DESIGN.md). The distributed dispatch system has not been implemented.

## Proactive log thresholds

A service can configure `logMonitors`, for example:

```json
[{"id":"winning-bid","codes":["WINNING_BID_REGRESSED"],"minCount":3,"windowSeconds":60}]
```

The detector accepts bounded pages of up to 500 records from the normal Dynatrace log reader or signed log ingress. It counts only fresh ERROR/FATAL records with an explicit matching environment and code. Environment, region and version form separate scopes. Observation identities and matching records persist in SQL, overlapping reads are deduplicated, and a changed monitor configuration does not inherit the old configuration's counts. A threshold opens an incident even when no vendor problem or human report exists. It remains an observed log threshold, not a proven cause or error rate. Missing logs never close it.

Matching samples and a later investigation read can describe the same observation. Their source provenance is retained and Dynatrace aliases are grouped without counting those copies as new failures. Partial coverage is still flagged and keeps limited attribution conservative. Current bounds are 20 monitors per service and 100 active scopes per monitor; this local implementation is not the proposed ten-million-record production ingestion system.

The simulator also binds each send to the UI's selected incident. A group already following another incident is rejected before enqueue, so switching the incident selector cannot silently put an update in the wrong case. Use a separate channel thread/chat or explicitly leave the old incident.

## Initial casework checkpoint — October 21, 2026

The full suite passes **665 tests**. It includes 23 new casework tests: SQLite and PostgreSQL/PGlite contracts, 12 concurrent incident threads with four responders each, a quiet participant under message floods, directory freshness, MR/CI/deployment lineage, signed HTTP alert-thread intake, log thresholds/restart/deduplication, QA approval/expiry/late-result fencing, unread drawings and the selected-incident routing guard. The UI was operated across three groups and five fictional responder identities. Two explicit local QA runs reproduced the defect, passed four corrected business checks and retained separate branches and audit records.

Both actual Microsoft accounts also passed `plan` and `contacts` through native Teams after restart. The same plan was reused idempotently, a missing directory was reported as unknown and an unsupported automatic patch was withheld. Live testing exposed the ordinary Teams inline-HTML body being mistaken for an attachment; that false warning was fixed and retested. The native profile has no QA executor.

Private evidence, the frozen source manifest, source snapshot, sample ticket, patch, MR draft, native delivery IDs and screenshots are retained under `.local/acceptance/casework-2026-10-21/`. The source snapshot excludes credentials, private databases and QA workspaces. Existing historical acceptance reports remain intact.


Database restoration and offline SQLite/PostgreSQL cutover now include the casework records and derived log counters. [DATABASE-TRANSFER.md](DATABASE-TRANSFER.md) describes the verified path and its limits. Old QA authorization is quarantined, restored ownership is historical until refreshed, and the missing change-history interval stays explicit.


## Recovery checkpoint — October 21, 2026

The recovery checkpoint passed **684 tests**. Additional restore tests exercise QA quarantine, directory generation freshness, rebuilt log thresholds and atomic rollback in both database adapters. Three multi-person approval cases reject ambiguous “yes” messages while leaving unrelated incidents independent. The restored-database UI keeps historical Markdown readable, disables new plan/QA actions during its hold and does not seed fresh owners automatically.

Seven offline-transfer tests and a separate native PostgreSQL roundtrip verify retained identities, group links, tickets, completed QA artifacts and provider wait deadlines. Imported pending QA stays unknown; the transfer and outbound hold commit together. Scope, operator procedure and remaining AWS/bulk-migration work are in [DATABASE-TRANSFER.md](DATABASE-TRANSFER.md). Private logs, UI evidence and source snapshots are under `.local/acceptance/casework-restore-2026-10-21/`. The distributed dispatch design remains a proposal.


## Moving change and QA checkpoint — October 21, 2026

The moving-change checkpoint passed **699 tests**. A review remains its own investigation. The worker records evidence-backed MR/PR links when a configured connector discovers the change; later head/merge/close observations also refresh explicitly linked active operational incidents. They enter those cases as change evidence and do not change the original outage lifecycle or turn its risk assessment into a pre-merge forecast. Delayed MR observations stay in the immutable change ledger without replacing newer source state. A first link advances the incident revision and queues reassessment.

CI observations are retained for the service, but only refresh incidents explicitly linked to an observed change with that exact head or merge SHA. The same exact source revision can legitimately relate to several changes. Unlinked CI success does not wake every outage, create a deployment or establish recovery. A source change invalidates the previous plan and approval.

QA rechecks incident revision, approving-developer authority and original conversation access before saving its result. If those changed while tests ran, the request becomes `superseded`; the original reproduction, fixed checks, patch, ticket, MR draft, branch and commit remain saved. A completion notice goes only to currently authorized incident rooms. Removing the requesting room cannot roll back the result or block lease-expiry quarantine. A late worker cannot replace an unknown result. The UI also marks older completed results historical after later evidence changes. A new explicit, current passing review clears the superseded operational condition without deleting the old audit.

Fifteen additional regressions cover these behaviors in SQLite and the PostgreSQL dialect, including actual trusted-code execution. All fifteen fail against the independently reconstructed 684-test source; all 194 original file hashes match that earlier manifest. `pnpm sre:changes:exercise --bin /path/to/postgresql/bin` separately creates an owned native PostgreSQL cluster, runs a two-incident/five-room rehearsal, reproduces and fixes the bidding invariant, moves an MR head during QA, reviews the exact pinned fixture source again, and restarts without losing identities or artifacts. It stops its owned cluster. Optional `--preview-port 3004` exposes only a loopback inspection UI until interrupted. Reports stay under `.local/change-tracking-runs/`; all Teams/provider inputs are fictional, and no remote MR is modified or certified by the local correction.

The current actual Teams organization profile has no QA executor. Neither this iteration nor a successful local review grants GitLab publication, merge, deployment or production recovery permission.


## Participant change association checkpoint — October 21, 2026

The participant-association checkpoint passed **711 tests**. In a joined Teams conversation, any verified participant can explicitly send `track-change <github|gitlab> <number>`. The console provides the same operation under **Owners and fix plan → Tracked merge requests, CI and deployments**. Select a provider and enter the MR/PR number, then choose **Track change**. The main port-3002 demo has fictional GitLab MR **73** prepared from its already verified local QA commit; no remote MR exists. Its form is prefilled so the user can try the association. This adds evidence and queues reassessment; it does not grant QA authority, imply cause or verify recovery. Background discussion cannot execute the command.

A new forward-fix link requires an authenticated MR/PR observation already admitted for this service. A deployment comparison, copied number or URL does not establish that record. Existing connector-discovered code-review links can be acknowledged without a duplicate webhook; exact-head CI also follows those links. An absent or conflicting observation is rejected. After restore, historical observations cannot establish a fresh link. Production integration still needs the configured provider event intake; this rehearsal does not create a remote MR.

`POST /api/incidents/<id>/changes` accepts `{provider, number}` through the existing operator authentication and local same-origin boundary. Caller-supplied actor fields are ignored. Teams admission requires the verified originating tenant, conversation and incident audience. The link, evidence, attribution, incident revision and reassessment job commit together. Duplicate requests return the original link without another revision or new attribution. The API, Teams `changes` reply, console and newly drafted Markdown ticket retain the association's actor label and evidence ID. Operator-console attribution identifies the operator credential boundary, not an individual human login.

Twelve new cases cover GitLab and GitHub, participant and HTTP entry points, passive text, exact-head reader-only CI, conflicting records, sharing boundaries, unsafe identifiers, injected transaction failure, restoration, duplicate requests and database reopen. The native PostgreSQL rehearsal uses the operator entry point, and its optional preview includes a clearly fictional forward-fix MR for UI testing. Actual Teams acceptance of this new command is pending: the earlier two-user trial expired at **2026-10-21 05:40:40 UTC**, and its public gateway now refuses forwarding. Its approval was not extended. Claude, production QA, remote repository publication and deployments remain off.

The following correction checkpoint adds participant-facing withdrawal and reconsideration while retaining the original evidence.


## Relationship correction checkpoint — October 21, 2026

The change-correction checkpoint passed **723 tests**. In the console, each operational association offers **Withdraw**. Review the relationship, enter a reason and record the correction. A withdrawn association offers **Review reconsideration**; provide the reconciled scope/reason before linking it again. The buttons carry the reviewed reference. A delayed withdrawal cannot remove a newer link, and replaying an old tracking request cannot override a withdrawal. A change cannot be detached from its own provider-review incident; correct its relationship in the operational case.

Joined Teams participants use:

```text
changes
untrack-change gitlab 72 <current-link-reference> <reason>
retrack-change gitlab 72 <withdrawal-reference> <reconciled reason>
```

`changes` exposes current link references and retained withdrawal reasons. Correction notices go to currently authorized groups joined to that incident. These are context decisions; they do not delete an MR/PR, approve QA, prove that code is healthy or establish recovery. Original provider facts, previous associations, tickets and QA artifacts remain retained. New Markdown tickets cite current association reasons and the prior correction reference.

Operator APIs use separate `POST /api/incidents/<id>/changes/withdraw` and `/changes/reconsider` endpoints. Withdrawal requires `{provider, number, expectedEvidenceId, reason}`; reconsideration requires `{provider, number, reconsiderEvidenceId, reason}`. Authentication, audience checks and server-derived actor identity remain enforced. The ordinary `/changes` endpoint handles tracking only. Distinct routes prevent older servers from interpreting a correction as a new link. The UI advertises correction controls only when the backend declares support.

The current decision and immutable audit are SQL records. A transaction saves the audit, relationship projection, revision, reassessment job and group notices together. Automatic repository discovery and source-event routing recheck the decision while holding the incident row lock. Corrupt control state fails as unavailable rather than behaving as if no correction existed. Repeated identical requests reuse their receipt; changed or stale references require another review.

Restore retains these relationship decisions while invalidating old positive tracking certainty. Withdrawals remain suppressive. Other restored operational relationships are marked historical and do not automatically follow later MR/CI updates until a fresh provider observation and explicit reaffirmation are admitted. Lost post-backup decisions still require reconciliation; the application cannot reconstruct missing history. Model input reserves a bounded decision section through log noise, treats reasons as participant reports and preserves independently relevant deployment evidence.

Twelve additional SQLite/PostgreSQL-contract cases cover scope, stale requests, repeated reconsideration, transaction failure, corruption, restoration, metadata budgets and retained facts. HTTP and file-reopen acceptance were extended, and both transfer directions preserve withdrawal controls. A native PostgreSQL rehearsal observes an MR writer waiting on the incident-row lock during withdrawal, then proves that it cannot recreate the old association. A separate native SQLite → PostgreSQL → SQLite cutover retains the same withdrawal audit. UI, logs and source snapshots are in `.local/acceptance/change-corrections-2026-10-21/`. Claude and live deployments stay off; new native Teams commands await the pending trial renewal.


### Selecting incidents in the console

Switching incidents hides the previous details and pauses incident actions until the selected context has loaded. Late responses from another selection cannot replace the current view. A submitted question, change operation or simulated Teams message keeps its original incident target. Separate unsent drafts are held per incident in memory for the current tab; reload clears them. Accepted events, tickets, QA results and relationship audits remain in the database. A failed detail read pauses actions while the console retries. The console concurrency checkpoint passes 739 tests, including 16 new controller/form regressions; evidence is retained under `.local/acceptance/ui-context-2026-10-21/`.


### Following an observed forward fix after a missed webhook

The repository poller follows active change associations using confirmed metadata reads and collects their exact observed source head. Provider update time and read time remain distinct in SQL, the console and newly drafted tickets. Unchanged reads do not invalidate a plan on each poll. GitLab head CI is recorded separately; missing CI visibility and other commit identities stay unknown. A restore needs a fresh read before explicit reaffirmation of historical context. See [tracked MR/PR readers and patch export limits](CHANGE-READS.md).

The fixture QA adapter now saves the exact Git diff bytes. A clean-checkout `git apply` regression verifies its patch. Older saved patch strings remain retained and are flagged if they lack a final newline; regenerate from their saved commit or request fresh local QA before applying them.

## Retained handoff evidence

New Markdown tickets retain the current bounded handoff projection alongside per-room positions: latest release report, any current receiver/completion ordered after it, source timestamps and report IDs, conflicting claims and omission counts. A release hidden from the room display remains visible here. Older tickets stay immutable when someone accepts or withdraws a task. These reports provide context and never grant QA, repository or deployment permission.

## Source-bound local QA approval — October 21, 2026

A bare `yes` now requires a resolved, admitted command from the requesting developer in the original incident conversation, received and timestamped after the exact QA proposal's normal delivery receipt. A message queued before the proposal, delayed older message, equal/uncertain timestamp, future timestamp, unsent proposal or late/unknown delivery cannot select a request. Use the proposal's exact `approve-fix` command when delivery ordering is unclear or a legacy proposal has no retained delivery provenance. A manual delivery inspection cannot substitute for approval. Passive text remains evidence only.

Approval checks and locks the durable command claim before changing QA state, then checks its lease again before commit. Reclaimed and expired handlers cannot approve after losing ownership. An `approval-receipt` in the existing `sre_fix_events` table binds the consumed source message to its exact request, actor, conversation and source hash. Retrying after an acknowledgement storage failure or database reopen returns that request's recorded outcome rather than consuming a newer proposal. The receipt and approval commit together; no new table or executor is introduced. Reusing a proposal request identity for another developer or conversation is rejected.

Sixteen regressions include source ordering, missing/late delivery, manual inspection, malformed command provenance, lost claims, failure during commit, request identity reuse, file-backed reopen, portable PostgreSQL SQL and an actual trusted fixture branch/commit whose reproduction fails and corrected business checks pass. That approval checkpoint passed **1,094 tests**. An owned native PostgreSQL 17.11 exercise separately verifies independent command handlers, lease reclaim and immediate server restart. The browser's ticket → local QA request → delivered proposal → `yes` flow also creates a real fixture commit and passes all four business checks. These are local QA checks. The real organization Teams profile still has no QA executor, approvers or deployment execution.

The renewed two-account native Teams check also accepts `track-change gitlab 900731` from both actual users. Its MR/head/CI observations are explicitly fictional and stored locally; neither a remote MR nor hosted CI is created. Both threads retain the same association, distinguish old-head success from failed CI on the newer head, and preserve their agent identities, work and sent receipts across the native bot restart. See [TEAMS-ORGANIZATION.md](TEAMS-ORGANIZATION.md) for the trial window and acceptance limits.

The subsequent [briefing checkpoint](TEAMS-COORDINATION.md#briefs-and-direct-questions) passes **1,105 tests**. `brief` reads the saved assessment without another investigation. Material updates notify peer groups compactly; unchanged questions do not repeat the full assessment everywhere. Full source/assessment history, immutable tickets and both contact-rendering formats remain retained. The local UI's brief preserves the unaccepted handoff and creates no QA, rollback or new investigation job.

## Sharing and reading saved tickets

`plan` drafts a ticket and sends its Markdown preview to the requesting Teams conversation. Other currently joined conversations receive a short **Fix ticket saved** notice with its ID and evidence revision. A console/operator draft notifies all joined conversations. The peer notice contains fixed review metadata, with no approval nonce, contact details, logs or copied model text. It does not approve QA, publish code or establish recovery.

Use `ticket <plan-id>` in any conversation following that incident to read the saved preview without creating another ticket or announcing it again. Full Markdown remains available through the console. A historical or unaudited snapshot is labeled before the preview; review current evidence, draft a fresh plan before QA and recheck current contacts. A ticket ID from another incident is rejected. `ticket` alone retains its earlier draft behavior.

The ticket and its peer outbox entries commit together. Repeated requests reuse immutable ticket/recipient identities; independent PostgreSQL writers cannot create duplicate notices. Sending rechecks current audience and binding, and leaving discards an undelivered copy. Existing tickets are not rewritten or automatically announced on upgrade. Native QA proposals and approval secrets remain in their original authorized conversation.

## Reviewing a ticket during incoming updates

An open **Read fix ticket** stays open through console polling. Its Markdown reading position and keyboard focus stay in place. If another participant's update advances the incident revision, the old ticket remains available with a revision warning and **Request local QA** disabled. A fresh ticket can arrive without closing the one being read. The Markdown snapshot stays immutable; an old `fix` command is also rejected by the backend.

These reading positions and unsent drafts live in the current tab. They survive a server restart while that tab stays open; a page reload still clears them. A successful status read clears an earlier polling error only if no newer action has replaced that notice. SQL retains the evidence, tickets, QA outcomes and transport receipts independently of the tab. Browser acceptance uses a private copy of the fictional rehearsal database; it does not inject new activity into the main or native Teams cases.

A newly joined conversation receives a bounded index of existing tickets. `tickets` reads the same index later: up to three tickets, with matching incident revisions reserved ahead of historical snapshots, plus the latest local QA request and valid commit identity when recorded. If QA requests have the same latest timestamp, the index reports ambiguity instead of selecting a result by ID. Expired proposals and interrupted runs stay visible without being resumed. The list reads metadata, leaves ticket Markdown immutable, copies no approval nonce and creates no investigation, plan, QA run or peer announcement. Use `ticket <plan-id>` for the saved preview; check contacts and exact source again before acting.
