# Queued approvals and no-change outcomes

Approval must remain valid when a workflow begins replacing the deployed artifact, including after queue delays. Dispatch contract version 3 adds approved_at and approval_expires_at to GitHub inputs, and APPROVED_AT and APPROVAL_EXPIRES_AT to GitLab variables. These are decimal epoch-millisecond strings derived from the stored authenticated approval. See [the ten-field contract](INTEGRATIONS.md#rollback-workflow-contract).

Both connectors reject missing, invalid, reversed, future or expired approval windows before writing. They recheck expiry after authentication and request preparation, immediately before invoking the deployment transport. Slow OAuth cannot bypass that second check. Policy hashes include version 3, invalidating older pending/approved proposals. The protected deployment-specific workflow must serialize its environment, deduplicate request IDs, check expiry after queueing and recheck it immediately before replacement. An action that already began while authorized can finish.

An exact completed receipt remains readable after expiry without repeating deployment. Changing expiry or any other approved input under the same request ID is rejected. Timestamps are metadata carried by the trusted dispatch identity; they are not a cryptographic assertion about a Teams user. Protect the actual workflow/ref, trigger identity, deployment credentials and environment authorization. GitHub [custom inputs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch) and GitLab [pipeline variables](https://docs.gitlab.com/api/pipelines/#create-a-new-pipeline) carry these values; they do not implement the guards themselves.

## Reconcile a workflow that made no deployment

A submission receipt means acceptance. A failed job, elapsed approval, chat statement or missing deployment does not establish that no change occurred. Submitted/unknown requests continue blocking another action until reconciled.

The independent verifier can send a signed rollback_no_change proof to the existing verification webhook. It must establish a terminal guard rejection before deployment and freshly observe the actual current runtime. A partially executed deployment still needs deployment/health reconciliation.

Example shape; substitute actual observed identities, times, hash and URL:

~~~json
{
  "id": "stable-no-change-event-id",
  "kind": "rollback_no_change",
  "incidentId": "inc_REPLACE",
  "rollbackRequestId": "rb_REPLACE",
  "requestHash": "sha256:HASH_OF_CANONICAL_APPROVED_REQUEST",
  "provider": "github",
  "runId": "12345",
  "terminal": true,
  "deploymentStarted": false,
  "outcome": "blocked",
  "reason": "Approval expired before deployment",
  "observedAt": 1792470000000,
  "environment": "staging",
  "sha": "FULL_ACTUAL_CURRENT_SHA",
  "artifact": "sha256:ACTUAL_CURRENT_ARTIFACT",
  "deploymentId": "ACTUAL_CURRENT_DEPLOYMENT_ID",
  "deploymentAt": 1792469990000,
  "evidenceUrl": "https://YOUR-INDEPENDENT-VERIFIER/evidence/12345"
}
~~~

Use the same timestamped HMAC as recovery proofs and a stable body id across retries. The verifier's separate signing secret never goes to the model or Teams participants.

The requestHash is "sha256:" plus SHA256 of the UTF-8 JSON serialization returned by workflowRequest in src/sre/workflow-contract.mjs. Its fixed key order is requestId, environment, expected, target, approval. The expected fields are sha, artifact, deploymentId (string), deploymentAt (number); target is sha/artifact; approval is approvedAt/expiresAt (numbers). Build this object from the exact original workflow inputs. An empty native deployment ID is allowed only for a native-ID-free trusted attestation. The hash binds intent; the independent HMAC authenticates the observation.

Validation requires a submitted/unknown action, the same incident/service/repository/tenant mapping, exact approved-input hash, and matching native run ID when retained. A missing submission receipt can be supplemented by a verified run ID. The proof must be fresh under the verification window, identify a settled current artifact/deployment/time, and link HTTPS evidence. Wrong identities, stale/future observations, running/partial workflows and unknown requests are rejected.

Acceptance atomically saves result evidence, marks that request not_executed, adds one scoped notice and queues updated analysis. Identical redelivery is idempotent. It does not close sources, resolve the incident, establish health or reuse approval. A new action needs a fresh eligible proposal and explicit approval.

A locally established rejection before deployment submission becomes blocked directly. This includes invalid local request preparation, missing credentials, an unsuccessful OAuth exchange, an already cancelled request, and the final approval-expiry guard. Identity-provider traffic is separate from the deployment transport. Authentication failures save a fixed diagnostic rather than provider-controlled text or credentials. Restoring credentials does not replay the blocked request; request and approve a fresh proposal.

Once the deployment transport has been invoked, transport failures, response-stream exceptions, malformed receipts and HTTP error responses remain unknown. An exception carrying a local preflight class cannot change this after submission. This implementation conservatively quarantines even deployment-endpoint 401/429 responses; their status alone does not release the action. Native provider rejection/no-run reconciliation remains live acceptance work. Neither path blindly retries a write.

## Reproduce

~~~sh
pnpm sre:process-drill credit-timeout --expired-approval
pnpm sre:process-drill credit-timeout --credential-rotation
pnpm sre:process-exercise
pnpm sre:postgres-exercise --bin /absolute/path/to/postgresql/bin
pnpm test
~~~

The process drill uses a three-second real approval window and delayed synthetic workflow. Expiry leaves the faulty process/deployment count unchanged. A wrong native-deployment proof is rejected. Independent no-change verification reconciles the first request while the incident stays open. A new approved request then replaces the actual local process and completes separate technical/business recovery verification.

The credential-restoration drill starts without a write token. The first approved request makes zero deployment calls and leaves the faulty process unchanged. After restarting the agent and restoring the token, that request remains blocked. A different approved request performs the single actual replacement and completes independent recovery verification.

The eleven-case deployment exercise passes with 29 clean owned auction-process exits. The twenty-one-case native PostgreSQL exercise includes concurrent duplicate outcome callbacks: one event/notice commits without another provider submission or incident closure. SQLite/PGlite tests inject failure after the result-state write and verify atomic rollback plus identical redelivery. [Shared coordination time](COORDINATION-TIME.md) covers cross-peer approval deadlines, asynchronous connector clocks and the clock-policy upgrade.

Provider transport, Teams identities and verifier observations are fixtures. Actual vendor queues, protected workflow installation, verifier independence/access, Teams consent and model quality still need live acceptance. Both long SQLite runs use earlier frozen source and do not cover this contract.
