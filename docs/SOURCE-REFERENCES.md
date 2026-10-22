# GitLab source references

The host can collect selected source files from an explicitly configured GitLab project at the exact revisions of a complete comparison. This extends evidence collection beyond the five known auction-policy changes. It does not discover a service's repository, establish a failure mechanism, or add a general patch executor. The existing rules reasoner stays inconclusive for unfamiliar code.

## Configuration and reads

Set `gitlab.sourceInspection` to `{"enabled":true}` on a reviewed service mapping. Omitting it, or setting `enabled:false`, keeps generic source collection off. The object accepts this boolean and an optional reviewed `logLocations` mapping described in [log source locations](LOG-SOURCE-LOCATIONS.md). The project must be a numeric ID or namespace/project path. Follow the existing configuration rule: use a new service key for an actual tenant, environment, provider-host or repository scope change.

The collector uses the existing read-only GitLab connector. Each comparison selects at most four safe text-source paths; additions and deletions retain the provider's absence claim, and renames use the old path at the base and new path at the head. A collection turn shares eight unique file reads and 64,000 accepted source bytes, with 16,000 UTF-8 bytes per accepted file. Its temporary cache includes service, tenant, environment, provider base, project, path and revision. Unsupported paths, incomplete comparisons, denied reads and exhausted budgets remain unavailable or omitted.

When `logLocations` is configured, selected error locations can read unchanged files before comparison collection. They use that same budget/cache and retain their original log provenance. Numbered source verifies the retrieved location; a logged revision does not create an observed deployment. The default comparison-only behavior is unchanged.

These are accepted-content limits, not a total network-byte budget. The lower-level file reader independently limits each response. Redaction runs before persistence; original and displayed content have separate hashes. Recognized private-key blocks and redaction that changes physical line layout withhold the numbered source. This is not comprehensive secret detection.

GitLab's [repository files API](https://docs.gitlab.com/api/repository_files/) accepts a project, encoded file path and ref, and returns content and revision metadata. This implementation requests immutable refs and verifies the response identity. GitLab can convert non-UTF-8 text; the current strict size/UTF-8 checks can reject such files. Retained responses and hashes are not independent cryptographic proof of membership in a Git tree.

## Numbered evidence and findings

The normal evidence projection omits generic file bodies. A separate `sourceCode` window delivers whole numbered lines: at most eight file versions, 20,000 JSON bytes overall, 5,000 per file, 80 lines per file and 2,000 bytes per line. Changed-hunk windows guide selection. Coverage shows omitted lines/files, unavailable sides, conflicting identities and the existing evidence-window limit. The normal total model transport limit still applies, and source frames whose parent evidence is dropped are removed.

Optional `sourceFindings` output must name the supporting evidence ID, GitLab project, full SHA, path, line range, exact quote and a conditional explanation. The host validates against both retained source and the exact lines delivered to the reasoner. Different recorded original bytes for one project/ref/path make that identity conflicting, even when redaction makes the displayed text identical. A finding cannot cite a clipped or omitted line, another project, a mutable ref or an unsupported evidence ID. The worker revalidates before publication.

A validated location remains a hypothesis about cause. It does not supply an observed deployment, approval, recovery proof or action authority. `candidateSha` retains its separate deployment-evidence checks. Generic findings do not expand the literal-policy catalog or its local QA capabilities.

## Shared investigation and ticket

Joined incident conversations receive compact conditional locations and material explanation changes. Exact repeats stay quiet; withdrawing a location produces an explicit update without rewriting old artifacts. An imported directory can identify owners of validated paths, with its source and expiry retained. It never pages an owner or grants permission.

The console shows numbered excerpts, quotes and a local link opening the matching source panel. Open readers, their scroll positions and a separate draft survive ordinary refreshes and a backend restart while the page stays open. A Markdown fix ticket revalidates the current references and preserves the source hypothesis, owner evidence and attributed team reports. Generic evidence alone produces no automatic patch. After database restoration the active assessment is cleared, retained sources are labelled historical, and existing reconciliation holds govern sending and new plans.

## Retained immutable identity checks

A displayed source version now checks retained SQL history for the same incident, approved project, immutable revision and path. This check is independent of the log parents and source packets that fit in the current evidence window. Repeated equivalent log receipts must not hide previously disagreeing bytes and make a location look verified again.

The reader selects at most eight current file identities and two distinct original-byte-hash witnesses per identity before hydrating their packets. It rechecks the host artifact identity, current scope, file shape, displayed-content hash, line layout and original-byte hash contract. Comparison files, mapped log sources, requested source, discovery candidates and supported candidate-history versions participate. A missing, malformed or oversized witness stays unverified; a storage error makes the read unavailable. A failed/denied file response does not erase an earlier accepted immutable version.

Witness packets are limited to 262,144 UTF-8 bytes each. These are returned-row and hydration bounds, not a bound on SQL scanning, JSON parsing, total retained data or enterprise latency. The query examines retained source metadata for the selected incident; production retention, indexing and capacity still need measurement. No new schema, source read, credentials or provider authority is introduced. Two verified disagreeing original hashes suffice to withhold a citation; additional versions remain explicitly outside the witness display.

History witnesses establish disagreement only. They do not create a delivered log parent or let a finding cite a line outside its actual source window. Affected source findings and source-derived component-owner recommendations are withheld; service-owner and roster evidence remain independent. Both joined groups receive the material uncertainty/withdrawal through the normal host briefing, while repeat receipts remain quiet. The console labels an old saved quote historical when its current source verification is conflicting, unverified or omitted. Earlier assessments and Markdown tickets remain immutable. A consistent saved-byte history does not prove the running revision, current provider permission, cause or recovery.

## Verification boundary

The source-reference unit and flow tests cover collection budgets, in-flight reuse, scope and identity conflicts, redaction, omitted lines, bounded transport, reference validation, worker rejection, owner lookup, peer deduplication/withdrawal, immutable tickets, file reopen and held transfers between the SQL adapters. `fixtures/sre-source-references.mjs` generates an actual local Python ledger repository with a removed optimistic-version predicate. Provider responses, incidents, directory and people are fictional. `fixtures/source-output-double.mjs` scripts model-shaped output to exercise validation; it does not demonstrate model diagnosis.

The private native PostgreSQL and browser receipts are under `.local/acceptance/gitlab-source-references-2026-10-21/`. They exercise real SQL, generated Git bytes, actual connector/worker/UI code and simulated peer sends. Read their final reports and source fingerprints for results. They do not renew native Microsoft transport acceptance or establish Ally mapping, actual Claude reasoning, continuous log transport, remote merge-request publication, AWS capacity or production readiness. Claude, live readers, remote writes and deployment execution remain off during this rehearsal. The dispatch design remains a proposal.
