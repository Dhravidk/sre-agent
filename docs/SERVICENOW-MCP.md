# Read-only ServiceNow MCP adapter

The host service now has a ServiceNow MCP adapter in `src/sre/servicenow-mcp.mjs`. It enforces the exact 45 names supplied for Ally. An advertised tool outside that list cannot be called, even if its annotation says it is read-only. No create, update, delete, workflow, resource-read, prompt, sampling, elicitation or arbitrary RPC interface is exposed through this adapter. Server-side permissions and service-account scoping remain necessary.

## Try the mock

```sh
pnpm sre:trial:demo
```

Open http://127.0.0.1:3002. The ServiceNow card says **Mock MCP**. Simulate a recent regression, select the incident and ask a question. The worker fetches incident details plus configured CI context, relationships, change/problem records and knowledge matches through a real loopback MCP server. The server exposes all 45 tool names with explicitly fictional schemas/data. The existing responder simulator and approval flow remain available; rollback dispatch there is simulated and cannot establish recovery.

The demo binds to loopback, generates its MCP bearer credential in memory, uses its local SQLite file and loads no vendor environment file. Its MCP fixture echoes the local synthetic ServiceNow event records; this does not test external ServiceNow detection or ingress. The default model is labelled **rules** and makes no model call. Connected investigations continue to use `claude -p`; a separate actual-Claude acceptance sample exercises the MCP-collected evidence.

## Implemented boundary

- Actual MCP initialization, paginated tool discovery and calls use pinned `@modelcontextprotocol/sdk` 1.32.1. Streamable HTTP supports JSON and SSE responses. This SDK negotiates its supported 2025-and-earlier protocol revisions. Legacy SSE-only and stdio transports, a 2026-only server, and Ally's selected protocol/authentication remain unverified; unsupported negotiation fails.
- The adapter uses explicit bearer or existing configured client-credentials authentication. It never opens an interactive login or discovers a different authorization endpoint on its own. Requests stay on the exact configured endpoint, reject redirects, carry bounded timeouts and enforce a 2 MiB response budget. A 429/503 delay is retained through the configured retry gate; calls are not automatically replayed by application code.
- Actual discovered input/output schemas validate each call. The adapter ignores server instructions, checks contradictory read-only annotations, supports reviewed schema pins, detects changes across rediscovery/reconnect and refreshes discovery at least on the next read after one minute. Missing tools and unsupported schemas fail closed. Pin hashes across process restarts for enterprise use.
- Core incident methods match the poller's existing incidents/openIncidents/incident interface. Original creation time, update time, state, native identity and the configured CI are mandatory. Recent and active reads validate their windows/state, reject duplicate identities and require explicit pagination/completeness metadata. Missing, partial or failed inventories cannot advance a successful polling checkpoint.
- Configured enrichment is collected as untrusted evidence with tool name, schema hash, retrieval time and coverage limits. No ticket/article text can select a new tool, change arguments or approve execution. The other tool families are available to reviewed host collectors through the guarded readTool interface; dedicated domain workflows for every family are not implied by 45-call transport coverage.
- Runtime shutdown drains active work and closes MCP transports. Access-probe commands also close their clients. The Claude child still receives a bounded evidence snapshot with an empty MCP/tool configuration; repository writers and approvals remain outside model control.

## Configure the real server after access arrives

`config/servicenow.mcp.mock-contract.json` is a **mock contract**, not an assertion about Ally's tool parameters. Keep the live reader disabled until these items are verified:

1. Obtain the approved MCP endpoint, supported transport/protocol and unattended service authentication. Scope the identity to the permitted service/CI and relevant records. Direct Table API access is not required by the MCP path.
2. Compare the server's tools/list definitions and actual sanitized outputs with the bindings. Map argument templates, list/detail result paths and canonical incident fields. Export reviewed schema hashes from inventory() into mcp.schemaPins. Test missing and revoked scopes separately from schema discovery.
3. Verify filters, update-time ordering, active-incident semantics, page limits and completeness indicators. The current result contract requires an explicit boolean complete and nullable next cursor. A different server contract needs a reviewed normalization change; a short or empty page must not silently become complete. Confirm original timestamps, actual closed states and CMDB/Dynatrace correlation fields.
4. Configure optional enrichment templates only for relevant authorized reads. Verify whether journals, work notes, history, attachments, knowledge revisions and related-change links are exposed. Their presence is not promised by a tool name. Missing coverage remains unknown.
5. Run strict readiness, operation-specific read checks, one real scoped incident, restart and permission-revocation checks. Then perform the separate Teams/Dynatrace/GitLab sandbox rehearsal.

The argument template `{"$param":"ci"}` inserts the configured CI; core list bindings also support since, until, cursor and limit. Detail uses id; enrichment additionally receives the verified incident number. Templates are trusted local configuration, never tool-result instructions. Dotted result/field paths select already-returned JSON; they execute no expressions or network fetches.

For a connected service, select `servicenow.transport: "mcp"`, configure its mcp object and credentials, and leave rollback disabled during reader acceptance. The REST path remains available with transport rest or the existing default. Poll/checkpoint scope includes endpoint, bindings, fields and pins so a changed query contract cannot inherit an old success claim.

## Verified scope and remaining limits

Automated tests cover all 45 allowed calls over JSON and SSE, extra-tool denial, schema/pin drift, unavailable tools, malformed/partial results, old open incidents, state/time/CI checks, cancellation, credential rotation, output errors, worker enrichment, probe cleanup and the real demo launcher. These tests use fictional schemas and records. The expanded local process exercise routes ServiceNow reads through MCP while testing real auction process replacement and independent health/data checks; other provider behavior and Teams identities remain fixtures.

No Ally access, native enterprise tool semantics, live Teams delivery, real Dynatrace telemetry, cloud pipeline execution or production model accuracy is certified by these mocks. ServiceNow ticket mutation and approval decisions remain unavailable under the supplied access boundary.
