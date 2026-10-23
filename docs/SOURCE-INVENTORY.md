# Bounded directory-to-source follow-up

A log location can identify a retry predicate while leaving its caller or conversion helper unknown. An enabled host follow-up policy can now offer `gitlab_tree` alongside `gitlab_file` and `dynatrace_logs`. A reasoner can list a directory, then request a relevant file in the next proposal round. The host supplies no credentials or connector tools to the child.

```json
{
  "kind": "gitlab_tree",
  "project": "approved/example",
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "path": "src/ledger",
  "reason": "Locate the caller beside the reported error file."
}
```

This is a fictional selector. A real proposal must use a project/revision pair delivered in the current host policy. Omitting `project` requires the existing configured fixed project; it never selects the first discovery candidate. An empty `path` explicitly means that repository's root. There is no model-selected URL, mutable ref, recursive flag, query, pagination cursor or other provider route. The operator must enable `investigation.followUp` and source inspection/discovery within the existing approved read boundary. Directory data does not enlarge it.

The reader uses GitLab's documented [repository tree endpoint](https://docs.gitlab.com/api/repositories/#list-repository-tree), fixes `recursive=false`, requests the exact full SHA and optional directory path, and follows at most two configured pages of 100 entries. A source SHA is not replaced by branch HEAD. Actual Ally API compatibility, permissions and immutable-ref behavior require separate live verification; a synthetic transport test does not supply it. Missing or denied paths remain unavailable. Submodules, symlinks, unsafe or nested paths, inconsistent types/modes and duplicate entries are omitted with incomplete coverage. A listing at the 200-entry bound remains partial. A partial or omitted listing cannot prove a file absent.

## Persistence and investigation

Each request uses the existing started/terminal read receipts, revision/lease/restore fencing and atomic SQL artifact transaction. The `gitlab/source_inventory` artifact stores the exact request, host job/attempt/start identity, approved discovery scope when applicable, bounded entries and completeness. It adds no schema or new dispatcher. Reopening and held database transfer preserve the artifact; a failed or denied later attempt does not delete prior retained directory observations. Read history shows the later outcome separately.

Directory requests count toward the shared six-proposal/three-round [follow-up allowance](EVIDENCE-FOLLOWUP.md) and share the sixteen logical metadata-operation cache with discovery/history. One metadata operation can make several HTTP calls or retries; the bound is not a network-call or enterprise throughput guarantee. Directories do not spend file attempts. All actual source files still share eight attempts, 16,000 bytes per file and 64,000 accepted bytes per job attempt. Optional history leaves reads and bytes reserved for remaining primary file requests in the same round, so the first caller's history cannot consume the second caller's allocation. A deferred optional read is not cached as a failed primary file response.

The host revalidates directory scope, direct-child identities and request provenance before deriving `sourceInventories`. The UI, model context, team briefings and Markdown tickets expose a bounded projection with omissions. Model context retains inventory citations only when their artifact is actually delivered. Paths and blob IDs are navigation metadata: they cannot be cited as source text/lines, authorize a commit revision, attest the running repository, select an owner or establish cause. Retrieve and validate the actual file before citing its code. Conflicting immutable directory observations withhold their entries. Imported directory ownership still requires independent project/path evidence.

The UI preserves open inventory readers and their scroll positions while new reports and assessments arrive. Source inventory remains retained observational data; it does not promise current provider availability. Restore-held data is explicitly historical. Stable notification identity ignores receipt IDs and timestamps while including material path/coverage conflicts.

## Offline rehearsal

```sh
pnpm sre:inventory:demo
# http://127.0.0.1:3009
# Optional: --directory <new-private-folder> --port <loopback-port>
```

The dedicated database is `.local/sre-source-inventory/agent.sqlite`. The rehearsal creates actual local Git repositories and source history. Its deterministic fixture planner requests both candidate directories, then both discovered caller files through the real proposal policy, read budgets and SQL checkpoint. The guide and saved assessment identify the scripted planner. It is not Claude, natural-language diagnosis or model-quality evaluation. Provider HTTP, logs, participants, contacts and Teams sends are fictional. Source is read as data. Claude, native Teams forwarding, remote Git writes and deployment execution remain off.

Use the two simulated groups for blocked/probes-only reports, duplicate work and `sync`; save a Markdown ticket to retain the exact caller quotes and source navigation evidence. The runtime mapping and cause remain unknown. Generic QA and remote MR publication remain separate work. Existing discovery/history demo profiles keep their original defaults and databases.

## Reconcile overlapping observations

Compatible partial observations of the same project/SHA/directory now retain their combined paths, with up to four actual supporting artifact IDs per displayed entry. Their union remains partial. An earlier complete witness survives a compatible later subset; the UI identifies that the latest observation is partial rather than claiming fresh provider access. A new path absent from a retained complete witness, disagreeing blob/type/mode, or incompatible complete inventories is a conflict and withholds navigation entries.

SQL selection reserves directory facts inside each project and balances projects before its existing candidate bound. It distinguishes complete/partial entry facts from request/receipt churn, without a new table or dispatcher. Model evidence ordering preserves the same project/directory diversity inside its existing code budget. These are bounded selection rules, not a guarantee of retaining every historical observation or meeting enterprise throughput. Omitted evidence remains unknown.

The shared display byte allowance is allocated in rounds across selected directories. Its conservative entry charge reserves all four provenance slots, so adding duplicate support receipts cannot shrink the displayed path set merely by making reference arrays longer. The model projection rederives paths from delivered artifacts only, drops unsupported paths and completeness witnesses, and preserves a host-known conflict when its full support is outside the transport window. Path-reference panels remain open across UI polling along with their parent inventory and scroll state.

The additional regressions include actual generated Git directories with more than 200 entries and overlapping partial reads, plus explicitly synthetic retained receipt repetition. The synthetic repetition is evidence-selection stress, not extra provider reads, ingestion completeness or a throughput benchmark. Actual Ally transport, runtime identity and real model-quality acceptance remain separate.
