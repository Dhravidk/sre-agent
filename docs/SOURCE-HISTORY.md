# Candidate file history

Supported source-history versions also participate in the [retained immutable identity checks](SOURCE-REFERENCES.md#retained-immutable-identity-checks). Earlier conflicting or unverified bytes cannot become a verified historical quotation merely because their original packet leaves the current display window. This does not establish deployment or causality.

Set `gitlab.discovery.history:true` alongside an explicitly approved [source discovery](SOURCE-DISCOVERY.md) boundary to inspect the provider-reported last-modifying commit of a candidate file. History is off by default. It stays inside the same read-only host boundary, metadata cache, file budget and claimed-job checkpoint; it gives no code or deployment authority.

The reported application revision can contain an unrelated recent commit. The history collector uses the pinned file response's `last_commit_id` as a clue, checks the exact commit and its parent list, verifies ancestry when it differs from the reported revision, and retrieves the file at that commit. Its raw source hash must agree with the candidate version. For each selected parent it reads a direct immutable comparison and actual parent source. These checks test consistency of provider evidence; they do not independently prove deployment, causation, the complete file history or that the provider's last-modifying claim is exhaustive.

A rename can select the comparison's safe old path at its exact parent. A merge retains up to two distinct parent alternatives. Root commits and provider-reported additions have no invented empty parent source. Missing metadata, unsafe paths, denied/partial comparisons, changed file responses, omitted parents and exhausted budgets stay unknown. Conflicting immutable bytes or last-modifying metadata withhold historical quotations. Commit titles are untrusted metadata; authors are not inferred as owners.

The host computes a bounded changed span from retained before/after text; it does not execute code, trust provider hunk text as a verified quote, or generate a patch. Visible text changes, unchanged bytes, line-ending-only changes and redacted differences are distinguished. Numbered excerpts contain whole retained lines and disclose omissions. Separated changes inside a span may be outside the excerpt. A parent source location is historical comparison evidence, never a log-reported runtime point.

## Bounds and retention

Initial discovery and explicit project-scoped file follow-ups share the existing sixteen logical metadata operations and eight source attempts, with 16,000 bytes per file and 64,000 accepted bytes per job attempt. The existing provider retry/cooldown policy remains in force. At most four unique candidate files attempt history, with at most two parents each; these limits do not guarantee all selected history can fit the shared budgets. Logical operations are not a total HTTP-call, SQL-scan or production capacity bound.

The same atomic source artifact/checkpoint retains candidate and history evidence, fenced by job attempt, lease, incident revision and restore state. A terminal file follow-up retains its history in its existing source/read receipt. No new table, dispatcher or execution boundary is added. Read observations can repeat after a new attempt; this is not exactly-once provider behavior.

A bounded host view reserves retained histories across approved projects. After a new denied read it can show an earlier immutable observation, explicitly labelled prior/historical. Changed receipt IDs/times alone do not repeat an identical unsolicited briefing. Before/after sources, imported project-qualified contacts and the same history facts flow to the console, shared incident brief and immutable Markdown plan. Model context strips full history bodies from ordinary metadata; citations require the separately delivered numbered source. Old plans are not rewritten when evidence changes.

The console exposes host source/history observations while an assessment is pending and preserves open history readers/positions across polling. Restore holds label retained history historical and keep reads, delivery and action work held. Retention windows are bounded: missing history does not establish unchanged code, absence of defects or recovery.

## Offline rehearsal

```sh
pnpm sre:history:demo
# http://127.0.0.1:3008
```

This selects `scripts/sre-source-discovery-demo.mjs --history true`, a separate `.local/sre-source-history/agent.sqlite` and real generated local Git history. Each fictional candidate contains an older retry change, a later reported tracing revision, and an unreported branch tip. The existing demo remains on port 3007 with its original database and settings. Optional explicit `--directory` and `--port` choose another dedicated profile.

Provider HTTP, Teams sends, people and directory are fictional. Rules mode can surface exact versions and conditional code locations; generic code diagnosis, Claude quality, a generic patch executor and remote MR publication remain unverified or unimplemented. Claude, native Teams, remote Git writes and deployment execution stay off. The independent [dispatch design](DISPATCH-DESIGN.md) remains design-only.

## Provider contracts

The reader uses GitLab's [repository file metadata](https://docs.gitlab.com/api/repository_files/), [single-commit endpoint](https://docs.gitlab.com/api/commits/#get-a-single-commit), [merge-base endpoint](https://docs.gitlab.com/api/repositories/#get-merge-base), and [direct comparisons](https://docs.gitlab.com/api/repositories/#compare-branches-tags-or-commits). Only full immutable SHAs are sent for history reads; a mutable branch is never the fallback. Text/byte checks retain the existing UTF-8 limitations. Actual Ally permissions, server contracts, approved scope and runtime identity still need separate live acceptance.
