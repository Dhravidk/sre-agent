# Bounded candidate source discovery

The host can investigate a log-reported ref and filename before the runtime repository, source root or exact file is known. An operator supplies an explicit **read boundary** of one to four approved GitLab projects and a reviewed log-field mapping. That boundary is not the runtime mapping. The feature is disabled by default.

A full reported SHA is checked exactly. With `allowTags:true`, a reported tag is read, its returned commit is checked by full SHA, and the tag is checked again. The host reads a bounded tree at that immutable SHA, keeps the strongest filename-suffix matches, and retrieves actual text files. Multiple projects or filenames remain candidates. A unique match, tag lookup or source quote does not establish the running repository, deployment, cause or rollback target. Branch HEAD is never a fallback.

```json
{
  "gitlab": {
    "enabled": false,
    "base": "https://REPLACE-GITLAB-HOST",
    "tokenEnv": "GITLAB_READER_TOKEN",
    "sourceInspection": { "enabled": false },
    "discovery": {
      "enabled": true,
      "projects": ["REPLACE-GROUP/REPLACE-PROJECT"],
      "allowTags": false,
      "hints": {
        "serviceField": "service.name",
        "serviceValue": "REPLACE-EXPECTED-LOG-SERVICE",
        "revisionField": "service.version",
        "pathField": "code.file.path",
        "lineField": "code.line.number"
      }
    }
  },
  "rollback": { "enabled": false }
}
```

This is an illustrative configuration fragment, not an Ally mapping. `enabled:false` on the reader prevents live connector creation; the offline demo injects fictional HTTP transport. Connected adoption requires the approved actual projects, reader credentials, service/environment log contract and separate live checks. This implementation does not enumerate a GitLab group, search arbitrary repositories or infer permission from a log, filename, source file, model output or directory entry.

Without a fixed `gitlab.project`, deployment/review polling is skipped, GitLab webhooks cannot supply the missing mapping, access checks mark runtime mapping unverified, and GitLab rollback cannot be enabled. Candidate commits never enter the deployment ledger. Fixed-project comparison and reviewed exact log-location collection retain their separate configuration. If both exact log-location mapping and discovery are enabled, discovery leads initial selection; the collectors share the same source budget.

## Limits and provenance

Per job attempt, initial discovery and follow-up discovery share sixteen logical metadata operations and a scoped cache. A revision operation can make several HTTP calls, and the existing transport can retry; this is **not** a total network-call, SQL-scan, memory or enterprise throughput guarantee. Existing denial/rate-limit cooldowns remain in force across candidate reads.

Selection examines at most 2,000 retained log records and two distinct ref/path/line hints. Each project/ref tree is limited to two pages of 100 entries, then two strongest matching paths per probe. Every probe gets its first file opportunity before any second filename match. The existing shared source budget remains eight file attempts, 16,000 bytes per file and 64,000 accepted bytes, including ordinary source and follow-up reads. Unsupported files, symlinks, submodules, unsafe paths, missing/denied responses and incomplete inventory remain unknown. Missing or out-of-range line numbers allow conditional file excerpts but cannot invent a reported source point. Counts describe bounded retained input and may overlap.

A claimed job records `discovery-started` before reading. `discovery-collected` and the candidate packet commit together only while the job lease, attempt, incident revision and restore fence still permit acceptance. The packet pins approved scope, reported hints, raw log-record hashes/indexes, resolved refs, observed source bytes/hashes and parent receipt. Numbered source validation checks exact delivered project/SHA/path/quote. Candidate log references remain separate from the stronger configured `reportedLogLocations` path. Omitted parents are marked unavailable; no unseen log citation is invented.

SQL retains the candidate packet across process or database reopen. A subsequent authorized attempt may read again; no exactly-once provider behavior is claimed. Restore holds retain historical source while holding reads, deliveries and actions. Discovery summaries and source locations contribute stable material changes to incident notifications; changing only a receipt ID or observation time does not repeat an identical unsolicited brief. Conflicting immutable file responses withhold location findings. Disagreeing discovery packets from different jobs at the same host time do not receive an invented latest order; their summary remains unknown.

Follow-up `gitlab_file` proposals may optionally name `project`. An explicit project must appear in the delivered `source.additionalProjects`, and its SHA must be delivered for **that project**. Omitting project requires the existing fixed project; the host never defaults to the first candidate. These reads share source budgets and remain candidate mappings. Read-resource history includes explicit project so equal SHA/path values in different projects do not collapse.

Component directory entries may add `projects:["group/project"]` alongside relative `paths`. Candidate source ownership requires both qualifiers; an unqualified relative path is insufficient across repositories. Recommendations remain conditional on runtime mapping and grant no paging, approval or deployment authority. Service-owner and on-call recommendations still use the service-scoped directory and shift windows.

## Offline use

```sh
pnpm sre:discovery:demo
# http://127.0.0.1:3007
# Optional: --directory <new-private-folder> --port <loopback-port>
```

The dedicated database defaults to `.local/sre-source-discovery/agent.sqlite`. The demo creates real local Git history in two repositories, each with `ledger-v7` and `retry.py`, then shows conditional findings, qualified contacts, shared reports and Markdown tickets. Provider HTTP payloads, Teams sends, people and contacts are fictional. Source is read as data and never executed. Claude, native Teams, remote Git writes and deployment execution stay off. Rules mode can surface these candidate locations; it does not implement general code diagnosis, a generic patch executor or remote MR publication. Use both joined groups for competing reports, `sync` for scoped report detail, and `plan` for an immutable ticket.

The separate [dispatch design](DISPATCH-DESIGN.md) remains a design. This source-discovery feature adds no dispatcher, worker concurrency, schema or deployment authority.

## Provider contracts and remaining checks

The reader uses GitLab's documented [single-commit endpoint](https://docs.gitlab.com/api/commits/#get-a-single-commit), [single-tag endpoint](https://docs.gitlab.com/api/tags/#get-a-single-repository-tag), [repository tree](https://docs.gitlab.com/api/repositories/#list-repository-tree), and [repository file](https://docs.gitlab.com/api/repository_files/#get-file-from-repository). Tag resolution uses `commit.id`, including annotated tags. The host accepts only immutable SHAs for tree/file reads and validates returned path, commit, encoding, byte budget and UTF-8 text. Non-UTF-8 conversion is not claimed as original-byte verification.

Mocks verify host scope, ambiguity, denial, cancellation, budgets, provenance, SQL restart/transfer and peer/Markdown behavior. Actual Ally GitLab permissions/API compatibility, approved project inventory, deployed artifact-to-repository identity, Dynatrace log fields/coverage, native Teams delivery and Claude investigation quality still require separate acceptance. A matching commit is not that acceptance.

Optional `gitlab.discovery.history:true` adds bounded provider-reported last-modifying context and exact parent source versions, including rename and merge-parent alternatives. It shares the existing read budgets and checkpoint. [SOURCE-HISTORY.md](SOURCE-HISTORY.md) describes provenance, retained historical observations and `pnpm sre:history:demo` on its separate port/database. A source version difference is not deployment or cause.

An enabled follow-up policy can list a non-recursive directory at a delivered candidate project/SHA, then request an actual related source file. [SOURCE-INVENTORY.md](SOURCE-INVENTORY.md) describes this bounded navigation step and its provenance. Filenames/blob IDs do not establish runtime mapping, contents, ownership or cause, and cannot enlarge approved revision scope.
