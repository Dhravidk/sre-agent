# Bounded follow-up evidence

The host can now refresh an investigation with additional evidence proposed by the reasoner. This is explicitly disabled unless a service sets:

```json
"investigation": {"followUp": {"enabled": true}}
```

The connected template leaves it false. Existing demo profiles do not gain autonomous query planning. Ordinary rules can surface reviewed log locations but do not plan arbitrary follow-up investigations. The development planner is a deterministic test double; actual Claude remains a separate acceptance task.

## Read boundary

The reasoner may return an optional `evidenceRequests` array of at most two exact proposals:

```json
{"kind":"gitlab_file","sha":"<full delivered SHA>","path":"src/ledger/retry.py","startLine":1,"endLine":20,"reason":"Compare the predicate with the observed exception."}
```

```json
{"kind":"dynatrace_logs","from":1792641600000,"to":1792641660000,"reason":"Inspect the earlier error window."}
```

An optional `filters:[{"field":"http.route","value":"/api/requests"}]` can narrow a diagnostic read when the host supplies `evidenceAcquisition.logs.filters`. Only its delivered exact field/value pairs are eligible; up to three matches are ANDed within the fixed service/environment. Filtered old/new selections keep distinct retained histories. A custom window-only reader cannot accept them. [Diagnosis milestone](DYNATRACE-GITLAB-DIAGNOSIS.md) describes validation, coverage and evaluation limits.

Examples are illustrative, not Ally mappings or valid permissions. Syntax is strict: no endpoint, raw query, service, environment, command, credential or action field is allowed. An explicit project may name the configured fixed project; it normalizes to the same scope and deduplication identity as an omitted project. Other projects require the separately delivered candidate allowlist described below. The host fixes the service and independently validates each selector. A changed configuration requires ordinary reviewed setup; source or responder text cannot enable a reader.

GitLab requests require enabled [source inspection](SOURCE-REFERENCES.md), a safe text path and a full immutable SHA actually delivered from scoped GitLab source, comparison or deployment evidence. Another provider's deployment cannot supply that authority. Each requested range is at most 80 lines, with integer endpoints from 1 to 1,000,000. It uses the same initial-collection cache and budget: eight file reads, 64,000 accepted bytes in total and 16,000 bytes per file. A follow-up does not replenish that budget. Full retained bytes remain subject to the existing source identity, redaction and excerpt validation.

Log requests use only the configured Grail log reader and fixed service filter. Each window is at most 15 minutes, starting no earlier than incident start minus 15 minutes and ending no later than the host time supplied in the snapshot. The operation is a read-only query; the existing Grail protocol uses POST to execute a query and GET to poll. No DQL is supplied by the reasoner. A response accepts at most 200 records and 128,000 JSON bytes; this is an accepted-response budget, not a claim about total network bytes. Oversized responses are unavailable. A response that reaches the record limit remains partial even if its provider claims completion. Missing, contradictory or out-of-window timestamps, sampling and uncertain completion also remain partial. Original accepted records and the provider's completion claim remain retained separately.

There are three follow-up rounds, up to six budgeted proposals and two actual log queries per job attempt. This supports a bounded caller → adapter → helper investigation, including old/new comparisons. Refusals and duplicate selectors consume proposal slots; changing only the reason does not retry a selector. The host makes at most four reasoner invocations, including the initial invocation. Further requests are recorded as limited and force an inconclusive final assessment with an unknown candidate and low confidence. All rounds share the existing investigation deadline: the configured model timeout plus 60 seconds for model-backed workers (normally 240 seconds), or 120 seconds for non-model workers. More rounds do not extend that deadline. CLI cost controls still apply per child invocation, not as a new aggregate currency limit. A reclaimed attempt may repeat a safe read; this is not exactly-once network execution.

For model-backed investigations with follow-ups enabled, initial collection reserves four file attempts and 48,000 accepted bytes within the unchanged eight-attempt/64,000-byte budget. One comparison frame precedes untrusted log-path priorities; neither its selection nor a stack reference proves relevance. A read deferred solely by a temporary reservation is not cached as a permanent provider failure. An attempted read rejected under concurrent reservation pressure still consumes its attempt. Denial, mismatched identity and absolute byte-limit failures retain their cached unavailable result.

## Persistence and publication

Before a read, the host stores a versioned `system/evidence_read` start receipt. A successful artifact and its terminal receipt commit together. Checkpoints lock the existing worker lease, job and incident; they require the same owner/attempt, live lease, incident revision and no restore hold. A report received during the request prevents the stale response from being accepted. Final publication still uses the existing revision fence and ordinary requeue behavior.

Requested source is stored as `gitlab/source_requested`; requested logs use `dynatrace/logs` with follow-up provenance. If reviewed [log location mapping](LOG-SOURCE-LOCATIONS.md) is enabled, accepted logs can supply further exact source locations within the same file budget. The next invocation receives a refreshed bounded snapshot with numbered source. The model child continues to receive stdin only, with tools, MCP, hooks and application credentials disabled; the host retains connector and action authority.

The console shows retained read proposals and outcomes. A start with no retained outcome is unknown: a bounded snapshot or restart cannot prove whether a remote read happened. Reopen preserves receipts and immutable tickets; a reclaimed attempt gets its own identity. Database restore retains historical artifacts, clears current analysis and holds follow-up reads until reconciliation. No schema change is required. Stop older investigators before upgrading: the prior receipt reader rejects round-three terminal-limit observations, while the new reader validates them using the shared round limit. Existing receipts remain valid.

Material read outcomes accompany conditional source findings, contact evidence and the Markdown ticket. They survive a later turn that needs no extra reads. Receipt IDs and timestamps alone do not repeat peer briefings. A collected read does not prove causation, health, a deployment, approval or complete history. Generic source findings still produce no automatic patch; existing QA and rollback controls are unchanged. This adds no dispatcher, concurrency, source executor, remote publisher or external ticket writer.

## Verification boundary

Focused regressions exercise strict proposals, unavailable/oversized responses, shared budgets, duplicates, cancellation, lease loss, revision races, atomic persistence failure, SQLite reopen, PGlite transfers and restore holds. Flow tests use actual generated Git bytes and GitLab reader code with fictional responses, scripted proposal output and simulated peers. The controlled fake CLI executable verifies the real wrapper across successive invocations; it does not invoke Claude or evaluate model reasoning.

The private acceptance directory `.local/acceptance/evidence-followup-2026-10-22/` retains the preceding source, negative receipts, final source/full-suite manifest, native PostgreSQL and browser reports. Inspect each report's final status and source hashes before treating a checkpoint as passed. Native PostgreSQL tests actual locking and an immediate database stop/reopen while an expired unfinished job is retained. The worker interruption is simulated through that expired lease; it is not a killed worker process during a live vendor request. Browser tests use the real forms/API/SQL with scripted proposals. Fresh Microsoft delivery, actual Claude investigation quality, Ally's mappings/access and production acceptance remain unverified.

## Recovery before assessment publication

A read artifact and its terminal receipt can commit before the worker publishes the final assessment. Recovery now reconstructs the assessment's read observations from SQL rather than depending on a previous assessment or the interrupted process's memory. It does not submit another read just to reconstruct the history. Ordinary collection and an explicit new proposal can still make read-only requests; this is not an exactly-once network guarantee.

The history query selects at most 64 terminal candidates with a fair lane per read resource and retains at most eight resource observations. It joins the scoped job, start and artifact and checks their incident/service identity, recorded hashes, selector and parent relationships. Unsupported, mismatched or missing provenance is unverified; it cannot become a collected observation. Existing source-quote checks remain independent. This is a bounded display/projection over saved evidence, not a source of read or action permission.

Within one job, fenced attempt/round/index metadata supplies order when host times tie. Contradictory receipts without that proven order remain conflicting. A lone start remains unknown. Limited windows and unverified receipts produce a warning in the assessment, peer brief and Markdown; changing receipt counts alone does not repeat material notifications. A restored observation remains historical and cannot clear the restore hold.

The `.local/acceptance/evidence-read-recovery-2026-10-22/` checkpoint retains negative reproductions, scoped SQL-adapter tests, final source/full-suite evidence and process/database restart drills. Inspect final report status and source hashes. Fixture providers, scripted proposals and simulated sends do not establish real Claude diagnosis or Microsoft delivery.

With optional [candidate discovery](SOURCE-DISCOVERY.md), `gitlab_file` accepts an explicit `project` only from delivered `source.additionalProjects`, paired with a SHA actually delivered for that project. Missing project still requires the configured fixed project. The host does not choose a candidate implicitly or borrow another project's revision. Requested candidate bytes remain conditionally mapped; read-history resource keys include project, and source budgets/caches are shared with initial discovery.

With candidate history enabled, an approved project-scoped source follow-up can also retrieve its provider-reported last-modifying and parent versions within the same metadata/file budgets. The existing terminal source/read checkpoint retains those facts atomically. Historical source frames stay separate from log-reported locations; see [SOURCE-HISTORY.md](SOURCE-HISTORY.md).

Directory navigation is now available as a bounded `gitlab_tree` proposal at an already-delivered approved project/revision. [SOURCE-INVENTORY.md](SOURCE-INVENTORY.md) covers the non-recursive tree→file path, shared metadata/request budgets, retained SQL provenance, partial listings and the explicitly scripted offline rehearsal. Optional history reserves pending primary file allocations within the same shared file budget.

## Initial collection ownership

Ordinary initial connector reads now retain job-attempt observations separately from the model's optional follow-up proposals. Before a read starts, the host records its job, attempt, incident/service, source, kind, ordinal, incident revision and restore epoch in `initial-read-start:` checkpoints. Successful admission records an `initial-read-end:` checkpoint naming the immutable artifact and accepted revision. The checksum and matching artifact are checked on replay. These records describe host collection; `collected` means a packet was retained, not that every requested source was available or the incident recovered. A lone start has no proven accepted outcome.

The claimed investigator slot lease, exact running job attempt, incident service and restore epoch must permit admission. Cancellation is checked around database waits and before commit. A late response from an expired/replaced attempt cannot append its source body, connector error, deployment observations or automatic MR/PR association. The host checks ownership again before each reasoner invocation. Already-running model transport keeps its existing cancellation and publication checks; a signal cannot prove that an external process or provider stopped.

Initial collection deliberately refreshes the same incident when teammates or independent telemetry add context during a read. Its receipts distinguish the starting and accepted revisions, and the reasoner receives the refreshed snapshot. It does not reject ordinary chat merely because the revision advanced. Hypothesis-specific follow-up reads and candidate-discovery publication retain their stricter existing revision fences.

A job-owned deployment packet and its existing inbox observations commit together. An automatic review relationship and its supporting packet also share the acceptance transaction. They keep the existing provider identity/deduplication and association-withdrawal rules. Native PostgreSQL uses a shared transaction-only service admission lock for these completions and source inbox writes, with consistent incident row order; question intake and change-read bundles acquire it before their row locks. SQLite already serializes transaction writers. Initial ownership checks acquire the investigator lease/job before the restore control and incident, so a stale reader cannot hold that control while waiting for a replacement investigator's lease. No network call runs while the admission lock is held. These protect the current host's data mutations; they are not the proposed distributed dispatcher or a capacity result. Independent polling remains a separate source of scoped provider facts.

Provider failures admitted while ownership is valid remain explicit `connector_error` observations with an unavailable outcome. Persistence failures are job/storage failures and do not manufacture a provider error. All started parallel reads drain before an investigation or shutdown finishes, including when another lane fails or a provider ignores cancellation. A committed observation remains history if cancellation follows its commit; there is no claim of exactly-once HTTP delivery or undoing an already committed transaction.

Read-only rules reconciliation may begin a fresh read during an active restore hold, as before. Its receipt pins that active epoch. A read cannot carry its response across a new restore or release of the hold. Both accepted and unfinished initial-read receipts survive offline restore/SQL transfer as descriptive history; they do not revive an old job, certify current provider state or release delivery/action holds. Earlier artifacts lacking these receipts retain their original history and are not retroactively certified by the new admission guard.

The production `runOnce` path supplies its claimed job. Trusted direct store/import/test helpers remain separate from that worker contract. No model connector tool, credential, external writer, schema or dependency is added. The local tests cover takeover, cancellation, storage faults, atomic rollback, ordinary three-person/two-group context refresh and held transfer. Native database/process and browser receipts must be inspected separately from SQLite/PGlite and model-quality evidence.

After consolidation with concurrent model workers, initial collection and follow-up receipts bind the claimed slot as well as its job/attempt. Large initial Dynatrace batches retain raw pages, a bounded manifest and triage samples in the same fenced completion transaction. Raw pages stay outside the model window; direct source excerpts and opt-in numbered source inspection share immutable reads and the source budget. These are local development contracts, not live Dynatrace or GitLab acceptance.
