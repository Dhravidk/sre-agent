# Coordinating an incident across Teams groups

The agent can follow one incident in multiple configured Teams group chats or channel threads. The incident has one persistent investigation identity; each conversation keeps its own provenance, reported state and delivery records. It does not create extra model agents, invite itself into chats, or import earlier chat history.

The local demo currently defaults to **offline rules and mock connectors**, as requested. No Claude inference is needed for the coordination flow described here. Start it with `pnpm sre:trial:demo` and open http://127.0.0.1:3002. For the later real-model trial, explicitly select `SRE_TRIAL_DEMO_AGENT_MODE=claude pnpm sre:trial:demo`.

The separate [October 20 real Teams trial](LIVE-TEAMS-TRIAL.md) passed actual authenticated mentions/replies in two private teams' standard channels, including conflicting theories, duplicate work, missed updates, handoffs, restart and bot removal/reinstall. That checkpoint passed 588 tests. That trial keeps Claude and deployments off and does not establish live group-chat, multi-user approval or Ally tenant readiness.

## Bring two groups into the same incident

1. Simulate a recent bidding regression, or select the existing incident. In the Teams simulator choose **Bidding responders**, then **Link selected incident**. Wait for its acknowledgement.
2. Choose **Platform responders** and link the same incident. The shared view now contains two conversations. A newly joined group receives an attributed briefing about reports already delivered to the agent in the other group.
3. Send progress using **Responder conversation**, or use **Mention the agent** with `update <owner, action, result and next check>`. The latter works without background message access.
4. Use **Report team state** to report `investigating`, `mitigating`, `monitoring`, `recovered` or `blocked`. These are human reports. `recovered` does not close the incident or prove health.
5. Click **Sync both groups** for an immediate shared briefing. Changed background updates also produce briefings, coalesced over 15 seconds by default. Unchanged state stays quiet.
6. Use **Track a theory** and **Track work** for information that should stay visible through routine chatter. Give the same task and scope the same work key in both groups. The selected sender is the reported owner. Changing a work state records what the responder says; it does not run a mitigation.
7. After reading a briefing, use **Acknowledge latest briefing** in that group, or `ack <number>`. Each group acknowledges its own addressed copy. Acknowledgement records one responder's receipt, rather than agreement or approval.

In real Teams, commands in a group/channel require an @mention:

```text
@SRE join inc_...
@SRE update Alex restarted the bidder once; accepted bids still regress. Next check: exact deployed revision.
@SRE report mitigating Sam owns dependency traces; next update after the current trace sample.
@SRE theory bid-order supported New revision reproduces the accepted-bid error for affected auction IDs.
@SRE theory credit-pool ruled-out Matched traces show no credit errors in that same window.
@SRE work auction-prod-traces active Comparing the affected auction IDs; next check is the accepted winner.
@SRE sync
@SRE ack 3
@SRE brief
@SRE status
```

A group chat follows one incident at a time. Use `leave` before switching it to a different incident; its earlier history remains in the old incident. Channel conversations can use a separate thread for each incident. Eight conversations can follow one incident; beyond that, the agent asks teams to use a common incident thread. These bounded views are not unlimited model memory.

## Briefs and direct questions

Use `brief` for a quick saved incident snapshot without creating an investigation job or calling a model. It includes the assessment revision, observed failure samples, scoped code identities, important coordination warnings, missing evidence, next checks, rollback limits and directory-backed contacts. A stale or restored assessment is labelled historical/awaiting review and cannot present its old rollback eligibility as current. A snapshot can age after it is queued; action paths still require their own fresh checks.

New material assessments go to joined peer conversations as structured briefs rather than a copy of the entire analysis. Rare/severe log groups retain their priority, release/region, quoted sample and coverage limits. Handoff gaps take priority over routine coordination warnings. Every limited section states its shown/available counts; the normal rendering is bounded to 11,000 UTF-8 bytes, including up to three compact contact candidates. Use `signals`, `contacts`, `changes`, `sync` or the console for detail. Briefs and omitted counts describe bounded observations, not total error rates, a complete source scan, cause, task completion or recovery.

An ordinary question gets its detailed assessment reply in the asking conversation. The full question and assessment remain in SQL and the console. A console question has no implicit Teams reply destination. If the judgment is unchanged, it does not broadcast another assessment to all groups. Proposed next checks and reordered equivalent hypotheses/unknowns do not by themselves create peer notifications. Changed conclusions, risk assumptions/alternatives, rollback policy, provider/CI visibility or ownership evidence still can. Work, theories, state disagreements and delivery reminders continue through the separate coordinator. A newly joined alert thread retains its own required reply even when the judgment is unchanged.

Long direct answers can still be shortened by the transport with a console pointer; their original text remains stored. Compact assessment/contact sections carry their rendering format through deferred routing. Immediately before sending, the host refreshes only the generated contact section, retaining the original body and prepared delivery audit. Earlier full-format contact provenance remains readable. A brief does not acknowledge a coordination briefing or approve QA/rollback.

The October 21 checkpoint passes **1,105 tests**. An owned native PostgreSQL exercise verifies question routing, peer briefs and immediate server restart with a queued contact refresh. Both actual trial users independently requested `brief` and `status`; unchanged status answers went only to their origins. A fictional rare ledger-reconciliation error then produced compact notices in both native threads, with Microsoft delivery IDs and no recovery/action claim. These are real Teams transport checks with fictional provider evidence and Claude off. Evidence is under `.local/acceptance/assessment-briefings-2026-10-21/`.

### Sharing a fix ticket

After `plan`, peer groups already following the incident receive a bounded ticket-ID/revision notice. They can ask `ticket <plan-id>` for the saved Markdown preview. Reading does not create another draft or announce it again. The creator gets the preview directly; operator-console drafts notify all joined rooms. These notices contain no approval nonce or copied model/source summary. Historical reads are labeled, recipient access is rechecked on delivery, and leaving discards a pending copy. See [saved ticket review](CASEWORK.md#sharing-and-reading-saved-tickets).

The real trial sender uses the same tested notice wrapper as the SDK loopback regression. That wrapper forwards the original cancellation options, so an outbox timeout can close the underlying request while another conversation continues. An interrupted send remains unknown and is not replayed automatically. A controlled loopback cancellation does not establish that a particular Microsoft request was interrupted.

### Waiting for a conversation

A proactive notice can be retained before any Teams conversation follows its incident. It stays pending and backs off from fifteen seconds to at most five minutes. A valid incident join, or availability of the configured alert conversation, wakes that routing wait. Activity in an alert conversation already following a different incident does not wake unrelated waits. These operations preserve a provider's actual `Retry-After` deadline.

Delivery selection gives messages with an installed destination priority over unjoined incidents, while preserving order within each conversation. This availability check chooses what to try first; tenant, sharing scope, installation and incident binding are still rechecked before transport. It adds no investigator or distributed dispatcher.

The stored attempt number identifies a delivery claim and remains monotonic through routing and conversation-lock deferrals. It is not a count of Microsoft posts. The rate-limit budget instead uses the immutable saved 429 outcomes: four explicit rejections exhaust automatic retries. Prepared, outcome and late-receipt records keep their original claim numbers. Corrupt quota evidence prevents another send. Unknown deliveries still require inspection and are never automatically replayed.

The routing checkpoint passes **1,122 tests**. Seventeen added cases cover SQLite/PostgreSQL behavior, 96 unjoined incidents, wake-up, provider retry deadlines, quota-audit corruption, similar message IDs and file reopen. An owned native PostgreSQL 17.11 restart exercise preserves the claim and quota history across two independent delivery owners; it does not run additional SRE investigators. Private evidence is under `.local/acceptance/teams-route-waits-2026-10-21/`.

Native acceptance also uses an existing two-person chat and a separate team thread with both actual trial users. A fictional provider incident waits without a destination, then its saved assessment is delivered after the chat joins, before the deferred check was due. Both users contribute in the common chat; conflicting states/theories, duplicate work, unread updates and a handoff are shared with the team thread. A bot restart retains the missing receiver and saved receipts. A fresh explicit acceptance clears the handoff gap, and corrected reports clear the corresponding disagreements while the incident stays open. Both rooms explicitly acknowledge briefing #14; later freshness changes can still produce a new unread briefing. The native plan is a Markdown proposal with no supported automatic patch. These checks use actual Microsoft transport and fictional provider observations. They do not enable Claude, live provider reads, QA, Git publication or deployment execution.

## Disagreements and disconnected work

The offline coordinator compares explicit reported states. If one group reports recovery while another remains investigating, mitigating or blocked, it quotes both groups, asks them to confirm service scope/time window/impact, and recommends one incident thread or bridge with a named coordination lead. It separately states whether recovery is independently verified.

A correction such as `report mitigating Correction: recovery was premature...` replaces that participant's earlier state claim in the conversation. The room badge shows its latest delivered state claim; it is not team consensus. Other participants' latest claims remain attributed, so one person's recovery claim cannot erase a colleague's blocked report. Reports at the same source millisecond use durable receipt order as the tie-breaker. A later delivery carrying an older source timestamp does not override newer source observations.

If groups follow different incident IDs, `sync` can point out the different bindings within their configured sharing group and ask whether they mean the same issue. It does not merge incidents or copy the other incident's reports. A silent team is shown as having no delivered report, rather than agreeing with the other team.

**Arbitrary natural-language disagreement detection remains a later Claude evaluation.** The coordinator does not infer service truth, causal agreement, work completion or rollback permission from free text. The Claude prompt now receives room provenance and coordination context and asks for specific contradictions, missing evidence and a common communication plan, but that new behavior has not yet been evaluated with the real model.

### Durable theories, ownership and handoffs

Explicit `theory <key> <proposed|supported|ruled-out> <details>` reports stay in the shared ledger. Different active keys across groups produce a request for a discriminating check. The same theory being `supported` in one group and `ruled-out` in another produces a scope/evidence reconciliation warning. These are reported positions, not a determination of the cause.

Use `work <shared-key> <planned|active|blocked|done|cancelled|released> <scope and next check>` to track work. Keys contain lowercase letters, digits and hyphens, up to 40 characters. Include the environment or affected scope in the key where it matters; use different keys for legitimately separate tasks. More than one group claiming the same active task produces a possible duplicate-work warning and asks for one owner or an explicit scope split. `done` in one group while another remains assigned also needs reconciliation.

For a shift handoff, the old owner reports `work auction-prod-traces released <handoff details>`. A current ownership report must follow that release in source time, with durable receipt order breaking equal timestamps. Older assignments, a delayed old update, an old completed check, acknowledgement of a briefing, routine chatter and a restart do not accept a newer handoff. The receiver uses `work auction-prod-traces active <scope and next check>`; an explicit post-release planned or blocked assignment also records that participant as the reported owner. If the receiver later cancels their assignment, the gap reopens until another current post-release owner or completion report exists. Cancelling a participant assignment does not erase the retained release request. The agent recommends a common thread or bridge and a named lead when ownership or understanding diverges; it does not create the bridge or assign people without their input.

The **Work handoffs** panel derives the latest release and current post-release owner/completion reports from retained authorized work records before applying the per-room eight-item display window. It shows report IDs, source times, participants, origins, older assignment counts and explicit conflicts. Up to 32 handoffs are returned with missing-owner cases prioritized and omission counts for the remainder. Briefings and Markdown fix tickets retain these handoff facts even when newer active tasks fill a room summary. Ownership and completion remain reports; neither independently proves execution or recovery.

Work and theory positions are retained per participant and key within each conversation. Two people in one chat can disagree about a theory or claim the same task without overwriting each other. If the same native participant updates that key in another currently authorized conversation for the incident, their newer position becomes current; the older room claim remains visible as historical. One person mirroring an assignment in two places counts as one owner. Display-name changes do not create another person, and identical display names do not combine distinct identities. Another responder's `done` or `cancelled` claim cannot cancel a peer's assignment. Separate incidents and revoked or unlinked conversations cannot supply a hidden superseding position.

Source observation time selects positions, with durable receipt order breaking equal-time ties. Delayed older updates cannot replace a newer correction. Passive messages resembling commands remain quotations. Each room has up to eight work positions, eight theories and eight participant state claims. Active positions receive priority with a fair first pass across participants; omitted counts remain explicit. Conflict checks can publish a briefing to a single multi-person chat, and a later correction clears that conflict without creating an acknowledgement feedback loop. A rejoined group receives a fresh briefing when its old copy was discarded.

Outbound and model summaries shorten excerpts and position windows fairly so later rooms, warnings and receipt instructions survive size limits. The compact model fallback retains structured room/position records and marks omitted source citations; it does not substitute a serialized prefix that hides later rooms. Full source records remain in the incident database. These projections use the existing append-only report/participant ledger, so no new table or data rewrite is required. New Markdown fix tickets retain the individual state claims and distinguish historical assignments.

### Missed updates and receipt checks

Briefings have durable version numbers and separate delivery/acknowledgement records for each group. Acknowledging an older version does not acknowledge a newer update. New briefings retain the oldest outstanding acknowledgement deadline, so continuous chatter cannot hide a silent peer. By default, after five minutes the agent asks reachable groups to check the silent team's current briefing and keep the lead informed. Repeated unchanged checks are deduplicated across restarts.

Failed or uncertain delivery is shown separately from an unacknowledged successful send. A freshly queued replacement retains the unread reminder for the latest delivered round rather than immediately declaring the new round delayed. Its existing deadline is preserved, and a genuinely delayed queue still raises a delivery issue. An uncertain send is not replayed automatically; someone who actually read it can explicitly acknowledge it while the transport audit remains uncertain. The coordinator also flags old reported service states and active work without a fresh update after five minutes. Fresh chatter does not refresh an old service-state claim or work assignment. Configure `coordinationAckSeconds` and `coordinationStaleSeconds` between 60 and 3600 seconds when a different cadence is appropriate.

In the local launcher, mock deliveries are persisted to a mode-600 fictional inbox beside the database (`<database>.teams.jsonl`) and marked **simulated** in the UI. These are local test receipts; no Teams service is contacted. Other runtimes with Teams disabled and no sender still retain their outgoing queue. Each incident permits one successful rollback simulation; a second queued approval is blocked and replaying the exercise requires a new synthetic incident. Connected execution retains its existing unresolved-dispatch guard.

## Signals and code context

In a joined conversation, mention the bot with `signals` to see grouped Dynatrace log observations and bounded GitLab/GitHub comparison history. `help` returns the command guide without starting an investigation. Use `status` for an assessment. The local console shows the same digest under **Signals and change history**.

Error families retain environment, entity, region, endpoint, severity, HTTP status and release distinctions. Overlapping reads count as repeated observations only for identical timestamped raw record signatures; counts are samples, not request totals or rates. Explicit correlation IDs can be normalized in a message family, while arbitrary numbers and HTTP codes remain significant. Rare critical patterns and unknown schemas stay visible. Missing timestamps, sampled/partial queries and omitted records remain uncertain. Raw records are retained in the incident database.

The digest helps both groups compare the same error class and immutable commit pair. It does not infer arbitrary action conflicts from prose while Claude is off: groups should use the same work key for the same target and explicitly report ownership, scope and sequence. A parsed code finding is conditional; a recent release, matching SHA, successful probe or acknowledgement cannot establish the incident cause or recovery. See [connector coverage](CONNECTOR-TESTS.md) and [the actual two-user checkpoint](TEAMS-ORGANIZATION.md).

## Explicit sharing boundaries

Each conversation must already be allowed for the service and tenant. Cross-room incident context requires a configured collaboration group:

```json
{
  "teams": {
    "tenantId": "YOUR-TENANT-ID",
    "conversations": ["BIDDING-CHAT-ID", "PLATFORM-CHAT-ID"],
    "alertConversationId": "BIDDING-CHAT-ID",
    "approvers": ["AUTHORIZED-ENTRA-OBJECT-ID"],
    "captureResponderUpdates": false,
    "coordinationIntervalSeconds": 15,
    "collaborationGroups": [{
      "key": "auction-response",
      "name": "Auction incident response",
      "conversations": [
        { "id": "BIDDING-CHAT-ID", "name": "Bidding responders" },
        { "id": "PLATFORM-CHAT-ID", "name": "Platform responders" }
      ]
    }]
  }
}
```

Rooms must be distinct, allowlisted root IDs and may belong to only one sharing group. Each incident's audience is pinned when it is first linked or routed. A different sharing scope cannot join that incident or request its reports. Unlinked rooms do not receive its briefings. When there are multiple configured conversations, unsolicited initial alerts need an explicit `alertConversationId`; they are not sent to an arbitrary recently active chat.

The durable report window fairly selects across rooms before filling its 40-record budget. The model transport also reserves a fair per-room order and caps report entries. Original reports remain in the database. The coordinator cycles through active incidents in batches, so incidents beyond the first 100 are still checked. Truncated or omitted material is identified; coordination metadata does not supply citation IDs for source reports outside the evidence window.

Shared assessments, coordination briefings and recovery-action status get separate durable outbox records per recipient. Delivery rechecks current tenant, conversation, incident binding and sharing scope. Leaving an incident discards its pending messages for that room. A removed installation cannot reactivate itself through a delayed message. Passive reports queued before a sharing-membership revocation are discarded. A delivery failure in one room leaves other recipients independent; an uncertain send is not automatically replayed.

A later authenticated installation restores its exact root and existing incident threads atomically. Stale lifecycle events cannot undo newer state; removal wins a timestamp tie. SDK regressions cover literal underscores in channel IDs and the eight-conversation boundary. If other rooms filled a removed thread's old incident slot, that thread becomes reachable again but must explicitly join an incident with available capacity.

Rollback proposal approval commands stay in their original conversation. Another group cannot approve that proposal, even when the sender is an allowlisted approver. Shared briefings contain action IDs/status, not another room's approval nonce. Reports, passive messages and model text do not grant execution permission. A simulated dispatch leaves the incident open without independent recovery verification.

## Real Teams access still needed

The bot must be installed in each intended group/team and its authenticated endpoint and tenant/conversation mappings must be configured. Background capture requires the applicable resource-specific consent: `ChatMessage.Read.Chat` for a group chat or `ChannelMessage.Read.Group` for team channels. Without it, coordinate using mentioned `update`/`report` messages. Microsoft documents that these permissions cover messages in resources where the app is installed, rather than arbitrary conversations: [receiving all messages](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/enable-receive-all-chat-messages) and [resource-specific consent](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent).

The local tests do not validate Ally tenant policies or live model quality. The earlier real Teams checkpoint validates its named test tenant and two standard channels. The later [organization admission trial](TEAMS-ORGANIZATION.md) passed actual contributions from two distinct Microsoft accounts, non-admin app discovery/installation in a new test team, cross-team theories/work/state reconciliation, missed acknowledgements, leave/rejoin and restart. An earlier fresh installation in a chat between two people also passed. Private/shared channels remain unverified live. Earlier chat history, attachments, edits and deletions are not synchronized. The optional organization profile implements enrollment with an exact tenant, verified sender membership, explicit incident joins and separate approval permissions. Use `name <room name>` to persist a readable label for the current conversation without changing its sharing scope. Claude and deployments stay off.

## Verification retained on October 20

Repeat the offline coordination checks with `node --test tests/sre-collaboration.test.mjs`. The fixtures force rules mode, use local databases and group-chat endpoints, and do not start Claude.

The earlier checkpoint passed 565 tests, including 25 coordination tests. The expanded checkpoint adds durable theories/work, missed-update receipts and stronger restart scenarios. Its final counts and source fingerprint are retained in `.local/acceptance/two-team-incidents-2026-10-20/report.json`.

The actual installed Microsoft Teams SDK also delivered coordination messages to two local HTTP group-chat fixtures. Identity, vendor data, model reasoning and destination Teams services remained synthetic. Browser operation independently verified the two groups, disagreement, correction, wrong-group rejection, approved simulated rollback and both action-status copies. No actual Claude inference was used for this checkpoint.

Evidence, failed first test runs, screenshots and the original two reproduced defects are retained in `.local/acceptance/teams-coordination-2026-10-20/`. These bounded tests do not establish production uptime, model accuracy or live enterprise permissions.

The expanded evidence directory retains reproductions for vanished work/theories, missing receipts, an unread deadline hidden by new publications, oversized multilingual briefings, declined handoffs and duplicate simulated rollback. The SIGKILL drill kills an isolated agent process after a synthetic recipient logs its message but before the outbox saves the receipt. Reopening the same SQLite database preserves the agent identity, both rooms, theories, work and a queued acknowledgement; the expired send becomes uncertain and is not replayed. Its lease clock is advanced in the fixture rather than waiting 90 seconds. PostgreSQL syntax, ledger writes, acknowledgements and restore locks are exercised through PGlite; this is not a native multi-host database claim.

Rooms joining after a ticket was saved discover it in the join reply and can use `tickets` for a bounded metadata list. The list includes prior local QA status and exact commit identity, marks stale evidence, expired proposals and interrupted runs, and declines to pick a latest result among equally timed QA requests. It neither repeats peer announcements nor transfers approval authority. Incident sharing and current room binding are checked before reading the list.

The console projects the prepared recipient from the retained Teams delivery audit, including messages originally queued without a linked room. It preserves the original nullable routing intent. Prepared targets, queued targets, route waits and missing historical recipient metadata have distinct labels; preparation never changes an unknown outcome into a successful delivery. Invalid or conflicting recipient metadata fails closed, while older audit records that omit it remain readable.

Delivery-attention checks are combined per recipient: one reminder lists the newly reported unread, delayed, failed, discarded or uncertain briefing checks in that pass. Each line keeps its conversation label, relevant briefing and original outstanding generation. This reduces a late joiner's four separate reminders to one without changing anyone's acknowledgement. Later reminders contain newly reportable checks; use the current shared briefing or console for the full state. A reminder never supplies a stale global acknowledgement command.

Coverage is recorded transactionally with the combined outbox message in `coordination-attention-covered:` checkpoints. It means queued, not received or read. Coverage binds each original per-issue identity, recipient, batch members, outbox identity and original text hash. Historical per-issue outbox rows also count as covered, including uncertain deliveries. Unchanged checks remain quiet through new briefings, restarts and adapter transfer. Invalid coverage or a conflicting retained message fails closed. Leaving discards an undelivered recipient's copy; neither leaving nor restore reconciliation silently replays it.
