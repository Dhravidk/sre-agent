# Bounded evidence and fixture attribution

The always-on service has two investigation paths. Rules mode recognizes a small, documented auction fixture. Optional Eve mode receives a bounded evidence snapshot and requires separate model evaluation. Passing these tests does not establish production diagnostic accuracy.

## Rules mode

The deterministic catalog compares effective literal values of five policies in src/auction/rules.mjs: bid version checks, close-time enforcement, the documented 25 ms credit-provider timeout, schema version, and the 250 ms catalog threshold. [Acorn](https://github.com/acornjs/acorn/blob/master/acorn/README.md) parses the full before/after files into syntax trees. Fetched source is never executed. Only the known module structure and literal policy fields are supported. Comments, quoted examples, duplicate keys overridden by a later value, and a policy already broken before the change do not create new regression findings. Calls, spreads, accessors, changed implementation functions, extra statements, syntax errors and oversized sources require a broader investigation.

Repository source reads require full immutable commit SHAs, matching paths, strict Base64 and UTF-8, and exact byte counts, within 64 KiB per file. The [GitHub Contents API](https://docs.github.com/en/rest/repos/contents#get-repository-content) and [GitLab repository files API](https://docs.gitlab.com/api/repository_files/#get-file-from-repository) supply the source. Read identities need the corresponding repository-content permission. Arbitrary download links are never followed.

GitHub review collection rechecks both branch identities and obtains an explicit immutable merge-base/head comparison. If the target branch advanced independently, another comparison binds the common ancestor to the topic head. Target-only changes are excluded from that policy delta. GitLab uses diff_refs.base_sha, which its [MR API](https://docs.gitlab.com/api/merge_requests/) defines as the merge base, and rechecks head/base/start identity while collecting diffs. Missing, overflowed or mismatched file counts leave MR coverage incomplete.

An individual supported policy finding is a conditional review warning. Runtime changeAssessment 'likely' additionally requires:

- A recognized, valid current runtime signature, without competing dependency or unknown signals.
- Successful current and preceding deployments for the configured provider at the incident's original start; later failed/pending/ambiguous identity must be reconciled.
- A complete comparison bound to those exact SHAs, supported full sources, a matching new policy regression, and no changed paths outside the known module.
- For catalog latency, at least three distinct successful catalog samples in the deployed window. Slow bid calls, failed requests, repeated copies and aggregate latency alone cannot establish catalog latency.

GitHub comparisons require the recorded preceding release to be the merge base. Exactly 300 listed files are treated as possibly capped. GitLab comparison timeouts, collapsed/too-large/absent diffs, or wrong head identity leave coverage incomplete. These are conservative application limits informed by the [GitHub comparison contract](https://docs.github.com/en/rest/commits/commits#compare-two-commits) and [GitLab comparison contract](https://docs.gitlab.com/api/repositories/#compare-branches-tags-or-commits). A non-ancestor deployment pair currently needs a broader investigation.

The newest metrics-bearing snapshot supersedes older metrics for the same native problem or ticket. Independent correlated tickets remain separate. Future or malformed current metrics cannot fall back to old valid signals. Dependency-only evidence can make deployment attribution unlikely; mixed evidence leaves it unknown. Unsupported or missing evidence never becomes proof by timing. Unknown attribution has no candidate SHA and cannot make rollback eligible. A known finding can remain visible even when a migration or unrelated changed file prevents causal attribution.

All rules forecasts retain unknown outage likelihood and low confidence. The positive and negative tests are authored correctness cases for this catalog, not held-out model evaluations or general code-review accuracy measurements.

## Optional model transport

The boundedContext projection explicitly selects the model's current evidence object, including incident metadata, deployment records, prior assessments and coverage. It enforces a **160000-byte serialized UTF-8 envelope**. This is a byte limit, not a token guarantee. The separate direct operator request is limited to 4000 characters; capability and routing metadata sit outside the evidence object.

Responder evidence has a reserved 40000-byte budget, telemetry 60000 bytes, each content entry 12000 bytes, deployments 26000 bytes and history 8000 bytes. Prior analysis excludes its duplicated formatted text. Console jobs/retry errors, remote session state and unknown publisher debug fields are excluded. The authenticated evidence capability and initial Eve call use the same projection. Full stored evidence and console audit remain available locally.

Oversized content becomes an explicitly marked JSON excerpt. Opaque deployment records are kept intact or omitted in full. Coverage reports available/included records and truncated content; the source-state summary counts all open/closed records even when its preview is shortened. The final envelope accounts for JSON escaping and preserves Unicode code points. Invalid essential identity or oversized direct requests fail before a remote session or model turn is created.

This bounds the current snapshot, not the lifetime history maintained by Eve or a production token/cost budget. Fake Eve tests inspect delivered context without making paid model calls.
