# Real Teams transport trial

October 20, 2026 checkpoint: **passed the scoped real Teams trial; ready for manual fictional-data use**. The suite passes **588 tests**. At the handover checkpoint, the native live-authenticated SDK had accepted **31 actual Teams messages** and retained Microsoft message receipts for **89 bot posts**. One signed-in human operated both test teams using fictional responder roles. Claude, real provider readers and deployment execution remain off.

The approved callback expires automatically at **5:20 PM America/Detroit on October 20, 2026**. This is a temporary workstation/tunnel trial. Do not extend or reactivate it without another authorized window.

## What has actually passed

- Created the private **SRE Agent Test - Bidding** and **SRE Agent Test - Platform** teams, each with a standard **Incident rehearsal** channel. No colleagues were invited.
- Validated the dedicated bot's saved credential against Microsoft's token endpoint (HTTP 200). The returned access token was not retained in the test artifacts.
- Linked the existing bot to the unpublished **SRE Agent Trial** Teams app draft and supplied the required developer information and descriptions. The app ID is distinct from the bot's client ID.
- Installed the mention-only app in both real test teams. Their original incident threads share `inc_f7446f61f3e095f37d4d` and persistent agent `agent_1122c8b4-94e2-40d7-a8f2-d182cf786f7c`. Messages were sent through the Teams UI and processed by the authenticated native SDK; these are not simulated Teams receipts.
- The localhost trial uses the native Microsoft Teams SDK in live authentication mode. Unsigned/malformed requests are rejected before incident data changes. The operator API requires its separate local token.
- Restarted the actual trial host with both real conversations joined. Fresh real mentions and replies passed after restart with the same incident, agent identity, references, thirteen responder reports, work, theories and receipt state.
- Verified competing theories, duplicate ownership, incompatible recovery claims, a five-minute missed-update warning, a correction, late/current acknowledgements, an unaccepted handoff and explicit acceptance in real Teams. The agent asked the teams to use one incident thread or bridge and name a lead. The final briefing was #22, acknowledged separately in both rooms, with no outstanding coordination issues at that checkpoint. The incident remains open.
- Verified that an unmentioned sentinel did not enter events or evidence. A resolved bot mention in an unrelated thread received setup help without incident context.
- Removed the app from Platform and confirmed only that channel root and its existing incident thread were disabled. After fixing a discovered reinstall defect, a fresh real installation restored that original thread, its incident and the same agent, and delivered a new shared briefing to both teams.
- The HTTPS gateway serves only public fictional-trial notices and the exact bot callback. Public checks returned 200 for notices, 404 for `/api/status`, 503 before activation, and 401 for missing/invalid Microsoft tokens after activation. The console/operator APIs are never proxied.

## Installation and access

Teams initially blocked installation because custom-app uploads were disabled. With the user's explicit approval, **SRE Agent Trial - Operator Only** was created and assigned only to the trial account. After installation/testing, that direct assignment was removed; admin center again shows **Global (Org-wide default)** with default assignment. The global policy and org-wide app settings were not changed, the app was not published to the org catalog, and no colleagues were invited. Policy changes can take time to reach clients. Fresh bot messages passed after the default assignment was restored. Microsoft documents these separate controls in [Manage custom apps](https://learn.microsoft.com/en-us/microsoftteams/teams-custom-app-policies-and-settings).

The bot's Microsoft Teams channel is enabled, and its endpoint is the approved temporary HTTPS callback. Its exact two-channel local forwarding grant expires at the time above. The cached Teams app entry returned `AppDefinitionDoesntExist` during reinstall; refreshing the unchanged original Developer Portal package recovered installation. This trial preview is not an enterprise app-distribution acceptance test.

The Portal initially generated manifest 1.30 without `supportsChannelFeatures`, which failed Teams validation. The reviewed package uses the existing generator's manifest 1.21 and requests only `team` and `groupChat` scopes with no resource-specific background reading. The Portal still warns that publication requires `supportsChannelFeatures=tier1`. Do not declare private/shared-channel readiness based on this preview: the selected trial uses standard channels inside private teams. Group chats, private channels, shared channels and cross-tenant use remain unverified.

## Defects found and fixed

1. Teams' default markup rendering hid command placeholders such as `<incident-id>`. The SDK now sends explicit plain text; placeholders were verified in a subsequent real reply.
2. A newer briefing's warning repeated the prior round's acknowledgement command. Attention warnings now direct readers to the latest delivered briefing's command; the new briefing contains only its own explicit `reply ack` number. A regression test failed before the fix and passed afterward, followed by a real Teams check.
3. Reinstallation restored a channel root while leaving its existing incident thread disabled, silently ignoring a fresh mention. Installation changes now restore those threads atomically within the exact tenant/service/root. Literal underscores cannot match neighboring channels as SQL wildcards. SDK regressions also verify stale lifecycle replay rejection and the eight-conversation bound: if other rooms filled an old slot, the thread becomes reachable but must explicitly join again. The original two-room incident resumed in a second real removal/reinstall drill.

## Trial isolation and restart

The launcher is `scripts/sre-teams-trial.mjs`. It reads `.local/live-teams-trial/settings.json` and the separately supplied private credential environment. Start with:

```sh
node --env-file=.local/sre.trials.env --env-file=.local/sre.teams-trial.env scripts/sre-teams-trial.mjs
```

It forces rules mode, disables all real provider readers/webhooks and rollback execution, binds all listeners to loopback, and ignores inherited model, public-host and remote-database overrides. Every outgoing reply identifies the fictional trial, Claude-off mode and disabled deployments. Explicitly addressed messages from exactly the two configured channel roots can become incident evidence; unrelated channels cannot. A channel thread must explicitly join the same incident before it receives shared briefings. Earlier chat history, attachments, edits and deletions are not imported.

The private forwarding grant is `.local/live-teams-trial/forwarding.json`, closed when absent, invalid or expired. Its exact fields are `enabled`, `tenantId`, `botId`, `channelIds` and `expiresAt` (Unix milliseconds, at most eight hours ahead). This is an operator grant, not a public toggle. The gateway still relies on the native SDK to validate Microsoft's bearer token. Changing a tunnel URL requires reviewing the bot endpoint and the app's notice URLs. Do not store tokens in documentation or screenshots.

## Use the installed trial

Open **SRE Agent Test - Bidding** or **SRE Agent Test - Platform**, choose **Incident rehearsal**, and reply inside the existing **Fictional incident rehearsal** post. Select **SRE Agent Trial** from Teams' mention picker; typing plain `@SRE` without resolving the bot is not a mention. Try these commands after the resolved mention:

```text
sync
update My fictional trace check found the same error on both revisions.
theory network proposed Compare the same affected region and time window.
work canary active I own the common sample check; next update after comparison.
report investigating Recovery is not verified; the incident stays open.
ack <number from the latest delivered briefing>
status
```

Use the same work key only for the same task and scope. Reports are claims, not execution or verified recovery. The real trial refused a rollback request and created no recovery proposal or deployment. Live multi-user approval/rollback still needs a separate authorized test; the offline simulator's approval/dispatch checks do not establish it.

A single signed-in human exercising two team channels does not establish multi-user roles/approval permissions, live group-chat behavior, tenant-wide operation, production hosting reliability or Claude investigation quality. Rules mode compares explicit structured reports; arbitrary natural-language reasoning remains a later Claude evaluation. Real provider investigation and recovery remain separate acceptance work.

The authoritative checkpoint is `.local/acceptance/live-teams-2026-10-20/report.json`, with native message/receipt audit, live case snapshots, screenshots, expected pre-fix regression failures, the final 588-test log and a 148-file source snapshot. Its source fingerprint is `c7064461f6fb680dab1777f8265fef06a4b903c2128a9da9e068bc1a0379d118`. Earlier `checkpoint.json` and the two-team incident recordings retain their preflight/simulated status; they are not substituted for this live evidence.
