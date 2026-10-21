# Local auction deployment tests

These tests deploy retained artifacts into separate, owned auction server processes. Accepted bids and idempotency receipts live in a shared SQLite store and survive replacement. The SRE agent reviews the actual fixture Git diff, diagnoses measured HTTP behavior, requests approval through its normal router/policy, submits the simulated provider workflow, and accepts a signed recovery proof only after source closure and independent checks.

```sh
pnpm sre:process-drill credit-timeout
pnpm sre:process-drill bid-race
pnpm sre:process-drill late-bid
pnpm sre:process-drill credit-timeout --lost-response
pnpm sre:process-drill credit-timeout --same-sha-race
pnpm sre:process-drill credit-timeout --expired-approval
pnpm sre:process-drill credit-timeout --credential-rotation
pnpm sre:process-exercise
```

The exercise runs all seven auction scenarios plus four dispatch-fault variants. It retains a summary, per-case reports/databases, source fingerprints, process logs, and source artifacts under `.local/deployment-drills/`. Fingerprints before/after the exercise must match. Each normal case must close every owned service process with exit code zero. The existing [process soak](PROCESS-SOAK.md) separately measures wall-clock duration and abrupt agent-process recovery.

## What is executed

| Component | Evidence and boundary |
| --- | --- |
| Auction behavior | Actual HTTP calls execute the generated, allowlisted Git revision's auction service/rules in a separate Node process. No external PR code is executed. |
| Artifact replacement | Baseline, faulty version, and recovered baseline have separate OS processes. The retained source bundle includes the runtime wrapper and exact Git source; its content digest is rechecked before replacement. Rollback does not rebuild a branch. |
| Transaction state | Bid state and its response receipt commit together before HTTP acknowledgement. The same request ID returns its stored result after replacement or a lost response, without accepting another bid. Corrupt state fails startup instead of resetting the book. |
| Business verification | A checker outside the deployed artifact reads SQLite directly, checks winners/close times, and compares bid rows with accepted request receipts. It can reject a green application metrics response when the receipt ledger is incomplete. A healthy target also requires an actual accepted bid probe. |
| Approval/execution | The actual SRE inbox, policy, approval nonce, durable rollback record, and GitHub client are exercised. GitHub responses/workflow transport and Teams identities are fixtures. Only the owned local controller replaces a service. |
| SRE restart | The process drill closes/reopens its HTTP/store instance inside the supervisor process, retaining the incident/session and action state. The multi-hour soak separately kills/restarts the agent's OS process. |

The fixture deployer has one exclusive controller per run directory and serializes its actions. Its durable request receipt prevents a duplicate invocation from replacing the server again. A changed request ID/body binding, missing/changed target bytes, incompatible metadata, or changed actual deployment blocks replacement. This is not proof of distributed CI locking, real tenant permissions, container provenance, or a production deployment mechanism.

## Expected decisions

| Case | Required outcome |
| --- | --- |
| credit-timeout / catalog-latency | Measured failure, approved artifact replacement, retained accepted transactions, fresh successful probe, verified recovery |
| bid-race | Two concurrent accepted bids expose a regressed winner. Redeployment retains that corruption; verification initially fails. An explicit synthetic operator reconciliation changes the winner while preserving bid history, then verification can succeed. |
| late-bid | The fixture shortens the auction duration to 1.5 seconds and waits for its real close time. Accepted late transactions remain after replacement; verification is withheld. |
| healthy-release | Actual healthy traffic; no runtime incident/rollback |
| schema-break | Actual binary/schema expectation mismatch; rollback blocked. The deliberately incompatible migration file is reviewed but never executed. |
| dependency-outage | The running code is unchanged and its synthetic dependency is unavailable; no deployment blame/rollback |
| lost workflow response | Local replacement completes but the simulated GitHub response is lost. The agent records `unknown`, submits no second dispatch after restart, and reconciles through the exact deployment/request health proof. |
| same-SHA redeployment race | A newer process/deployment uses the same SHA while the workflow is queued. The pipeline rejects the earlier deployment identity before stopping the newer process. Workflow submission remains distinct from successful execution/recovery. |
| credential restoration | The write token is initially absent. Approval produces a blocked request with zero deployment calls and no process replacement. After agent restart and token restoration, it stays blocked. Only a different approved request replaces the process and verifies recovery. |

The expired-approval variant makes no deployment until a signed independent no-change result reconciles the old request and a new proposal receives explicit approval. Completed receipts remain readable after expiry without another replacement. See [queued approval and no-change contracts](WORKFLOW-APPROVAL.md).

The source bundles use the installed Node runtime, whose version enters the dependency fingerprint. They are not production container images. The winning-bid repair is a synthetic operator action, outside the agent/executor; it does not validate settlement, financial transactions, or a production data-recovery procedure. The known-signature reasoner remains a limited fixture catalog. Live GitHub/Dynatrace/ServiceNow/Teams and model reasoning require their own acceptance work.

## Deployment workflow contract

Dispatch contract version 3 includes approval/expiry times and the approved **current** artifact, native deployment identity, and epoch-millisecond deployment time as well as the SHA. A workflow must compare all of them with the actual running version immediately before replacement, including after queue delays. An empty native ID is allowed only for a trusted release attestation with no native ID; the exact SHA/artifact/time binding still applies. See [the integration contract](INTEGRATIONS.md#rollback-workflow-contract) for parameter names and live installation requirements.
