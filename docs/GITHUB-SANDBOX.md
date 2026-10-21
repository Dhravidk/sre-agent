# GitHub sandbox publication

The site under test is the generated `.local/auction-pilot` repository. Its healthy main and seven scenario branches contain fictional auction data and deliberate faults. The parent SRE workspace holds the investigator, integration configuration and local recovery harness. Publish only the generated pilot to a dedicated private sandbox.

## Prepare a reviewed package

~~~sh
pnpm sre:sandbox:package
# An explicit destination must be a new directory:
pnpm sre:sandbox:package --output /controlled/path/new-sandbox-package
~~~

The command writes pilot.bundle, manifest.json and publication instructions beneath .local/github-sandbox-packages/ by default. It checks each immutable revision against the trusted generator's exact file bytes, file modes, generated commit metadata and root/direct-child history. It rejects unexpected files, altered code, changed branch mappings and hidden ancestor history. Export selects only the eight approved refs by immutable SHA; unrelated branches, tags, worktree files and unreachable objects are excluded. A bare roundtrip clone must preserve every ref and contain exactly the approved reachable object graph. The command creates no remote, account, repository, pull request, workflow or deployment.

The manifest records the baseline, all branch SHAs, bundle byte count/SHA256 and completed local roundtrip. Existing output directories are preserved. A package mismatch requires review; do not overwrite the retained pilot or its manifest to make validation pass. Installed Node.js/Git and the parent source are trusted inputs to this local preparation.

## Publish after access is available

Use an authenticated GitHub session and a verified dedicated private empty repository. Keep the generated manifest and confirm the intended owner/repository before publication. From the package directory, replace OWNER/REPOSITORY with that actual sandbox:

~~~sh
git clone --bare pilot.bundle auction-sandbox.git
cd auction-sandbox.git
git push --atomic --no-follow-tags https://github.com/OWNER/REPOSITORY.git refs/heads/main \
  refs/heads/scenarios/healthy-release refs/heads/scenarios/bid-race \
  refs/heads/scenarios/credit-timeout refs/heads/scenarios/schema-break \
  refs/heads/scenarios/catalog-latency refs/heads/scenarios/late-bid \
  refs/heads/scenarios/dependency-outage
~~~

A bare clone retains all eight local branch refs for the explicit push. The literal URL selects the verified destination; --no-follow-tags overrides automatic annotated-tag publication. Do not force existing remote refs or push unrelated refs/tags. Verify repository visibility and each remote SHA against manifest.json after publication. Git authentication belongs in the normal credential mechanism; keep tokens out of repository files, command-line URLs and chat messages. Git documents [bundle cloning](https://git-scm.com/docs/git-bundle) and [atomic push](https://git-scm.com/docs/git-push); the latter fails when the server lacks atomic support. GitHub's [repository duplication guide](https://docs.github.com/en/repositories/creating-and-managing-repositories/duplicating-a-repository) describes bare-clone publication. This package uses an explicit allowlist of branch refs.

## Exercise real integration contracts

1. Configure the actual repository mapping and a scoped read identity, with rollback disabled. Run sre:ready --json --strict, replacing explicit placeholder quota labels. Then run the operation-specific sre:check --live probes against exact sandbox PR/source/compare/deployment resources. Missing deployment resources remain unverified.
2. Open a healthy scenario PR, then a fault PR. Retain real GitHub delivery/event IDs, exact base/head/merge SHAs, complete files/patch coverage, review and CI results. Re-send an authenticated delivery to verify idempotency; wrong repository/tenant/signature must fail ingress.
3. Deploy only to the dedicated test service using a separately reviewed workflow. Record artifact digest, immutable deployment identity/time and compatibility metadata. Install an environment-serialized, idempotent protected rollback workflow implementing the version-3 approved-input contract before enabling the separate writer.
4. Observe the real fault through Dynatrace/ServiceNow and independent technical/business probes. Confirm the investigator attributes only supported deployment evidence, abstains on an external dependency and refuses an incompatible data/schema reversal.
5. Require a fresh eligible proposal and authenticated approval. Exercise queued expiry, same-SHA redeployment, a lost workflow response and credential revocation. A submitted/uncertain action needs exact external reconciliation before another action.
6. Close every correlated issue source and collect fresh independent health evidence for the exact resulting deployment/request. Retain real Teams thread delivery and responder context across restart. Workflow success alone cannot resolve the incident.

The [integration guide](INTEGRATIONS.md), [workflow approval contract](WORKFLOW-APPROVAL.md) and [local process drill](PROCESS-ROLLOUT.md) define the existing interfaces and limits. The package installs no workflow, credential or hosted service. The standalone pilot keeps auction state in memory; durable local bid preservation is exercised by the parent deployment harness.

## Current access evidence

The connected GitHub profile is available, but the connector exposes no repository-creation action. The GitHub browser redirects the new-repository page to sign-in; native app access is unavailable while the Mac is locked, and gh is not installed. Neither the parent workspace nor the pilot has a Git remote. The other project chat identifies the local demo but its latest returned turns contain no GitHub repository URL. These are scoped access observations, not proof about every older chat item or all possible account resources.

Local package tests verify clone/atomic push against an owned filesystem bare repository, scope/metadata/content rejection, fresh seeding, path-alias CLI behavior, and an exported pilot's credit-timeout HTTP 504 followed by a healthy baseline's accepted bid after process replacement. Real GitHub publication, webhooks, CI, hosted rollback, tenant permissions and model reasoning remain unverified. Access evidence and local validation reports are retained under .local/development/.
