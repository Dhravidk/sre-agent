# Source locations reported by error logs

An error can point to a helper that did not change in the latest deployment comparison. With an explicit field mapping, the host can now read that file at the revision reported by the log. Ordinary offline rules can show the verified source line and its log references without a scripted model response. This is location retrieval, not diagnosis: the reported location may be a logging callsite, and the reported revision is not independent proof of the running deployment.

## Reviewed mapping

Keep the service/project scope explicit. For example, the local Python fixture uses:

```json
"sourceInspection": {
  "enabled": true,
  "logLocations": {
    "pathField": "code.file.path",
    "lineField": "code.line.number",
    "revisionField": "service.version",
    "pathPrefix": "/srv/ledger/"
  }
}
```

These are fictional fixture settings, not an Ally contract. OpenTelemetry documents [`code.file.path` and `code.line.number`](https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/); that does not establish which fields Ally exports or whether they name the throwing statement. `service.version` often contains a release label rather than a full Git SHA. A reviewed revision field must supply an exact immutable revision for this path to work. Repository/runtime discovery and release-label resolution remain separate work.

The three flat field names must be distinct; the prefix must be explicitly empty or a safe absolute directory ending in `/`. The host strips exactly that prefix. It does not parse arbitrary stacktrace text, follow a URL, search another project, guess a source root, coerce a string line number, or substitute current branch HEAD. Existing source scope, reader authentication and extension/path checks still apply. Omitting `logLocations` preserves comparison-only source collection.

## Selection and provenance

The host examines at most 2,000 records from the already bounded incident evidence window. It selects consistent ERROR, FATAL or CRITICAL records whose recognized environment matches the configured service, whose mapped revision is a full SHA, and whose mapped line is an integer from 1 to 1,000,000. Conflicting recognized aliases stay unverified. Other severities and unmapped/invalid fields do not request source. This is a narrow reviewed mapping, not a universal exporter or stacktrace parser.

At most two distinct revision/file identities and four reported lines per file are selected per collection turn. These reads lead configured comparison collection and share its existing eight-read/64,000 accepted-byte budget and per-turn scoped promise cache. They do not add a second budget. The 16,000 accepted-byte file limit and separate lower-level HTTP response limits remain. A duplicate file/ref across a log and comparison reuses its read. Counts describe retained packages and can overlap; they do not measure failed requests or complete log history.

The `gitlab/source_locations` evidence contains a versioned `logSource` package with its mapping, environment, source results, selection coverage and per-location original log evidence ID, record index and record hash. The host rederives each location from the retained log before exposing numbered source. Out-of-range lines cannot be cited. Source windows show whole lines around the reported point rather than an unrelated file prefix. Existing redaction, original/display hashes and conflicting-identity checks apply.

Bounded model context removes full file bodies from the ordinary evidence projection and supplies numbered excerpts separately. A reported frame requires both its source artifact and at least one original log parent in the delivered evidence. The host attaches derived `reportedLogLocations` to validated findings; model-provided copies cannot replace these references. Exact source locations still do not supply `candidateSha`, causal certainty, approval or recovery verification.

## Shared investigation

Offline rules can identify a reported point and suggest checking its input, upstream contract and runtime/source binding. General failure-mechanism analysis still needs the configured model or an operator. A location in an unchanged file does not demonstrate that a deployment caused the error. The normal competing-report, missed-update and coordination behavior remains in effect.

The same conditional source finding can select an imported path owner, appear in both joined groups and enter an immutable Markdown ticket. The ticket retains original log references alongside source quotes and attributed team reports. Generic source still produces no automatic patch. Material comparison ignores changing log receipt IDs, timestamps and counts; repeated observations at the same code point do not repeat an otherwise unchanged briefing. A conflicting immutable source response withdraws the location and informs peers while retaining the earlier ticket. [Retained identity checks](SOURCE-REFERENCES.md#retained-immutable-identity-checks) keep that disagreement visible even when equivalent-log deduplication omits an earlier parent, or repeated source packages evict the original packet from the display window. Those checks cannot supply missing citation parents.

SQL storage, reopening and database transfer preserve provenance. Restore clears the cached active assessment and labels retained source historical; existing sending/planning holds still apply. No schema, dependency, dispatcher, worker-concurrency, credential or approval boundary changes are introduced.

## Verification boundary

`tests/sre-log-source.test.mjs` covers configuration, scope, malformed fields, INFO pressure, duplicate/bounded locations, shared read budgets/cache, cancellation, denied/partial/oversized files, line bounds, tampered provenance, transport parents and stable material notices. `tests/sre-log-source-flow.test.mjs` uses both SQL adapters for actual generated unchanged Python/Git source, ordinary rules, owner/ticket/two-group reports, quiet worker speech, changing receipts, conflict withdrawal, reopen and held transfers.

The native PostgreSQL and browser evidence under `.local/acceptance/reported-log-source-2026-10-21/` uses fictional errors/providers/people and simulated sends around actual SQL, Git bytes, connector/worker/UI code. It uses neither actual Claude nor a scripted model-output double. Read the final source fingerprint and reports for outcomes. A preceding-worker/reasoner reproduction uses current configuration/SQL/fixture scaffolding and records the unchanged helper missing before this collection path; it is not a clean-clone full-system comparison. Ally field/mapping acceptance, real model diagnosis, live Microsoft delivery, continuous log transport, remote publication, AWS and production capacity remain unverified. Dispatch remains design-only.

## Paged model investigations

For large initial batches, raw pages remain outside the normal model evidence window. Retained triage samples carry host-only original record indices. When the reviewed source-location mapping is enabled, the host verifies at most eight selected points against the exact same-incident batch/page hashes and original record bytes before using their path, line or revision. It caches those page reads and prioritizes verified selected samples within the existing source-location limits. The model receives the ordinary triage sample and bounded numbered source, not raw pages or extra origin bookkeeping.

A missing or changed page, denied read, shortened sample or foreign incident cannot establish a reported location. Legacy triage without the original index remains unavailable for this path. Derived and raw views may overlap; they are not independent observations or evidence of complete coverage. A verified location remains a code hypothesis, not proof of cause, deployment identity, health or approval.
