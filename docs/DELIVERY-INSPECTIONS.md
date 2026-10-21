# Inspect an uncertain Teams delivery

When a send times out or fails, the outbox retains `unknown` or `failed`. A late receipt is separate transport evidence; it does not prove that a participant read the message. The console now offers **Inspect delivery** for these rows. The API advertises `deliveryInspectionVersion: 1`; older running backends do not display the control.

Review the message identity, conversation, attempt, original queued body, prepared send body and retained transport facts. Record an observation (`observed`, `not_found`, or `inconclusive`), an observation time within ten minutes, a reason, and up to five HTTPS references. An observed message requires a reference. References are stored operator assertions: the service does not fetch them or independently verify their content. Never put credentials in evidence links.

**Still required** is the default follow-up choice. **Handled manually** closes operational attention for the exact reviewed snapshot. It leaves transport status, original message, recipient acknowledgement and incident action permissions unchanged. No send or re-enrollment occurs. An operator may describe an alternate handoff, but this record does not broadcast that private note to other teams. Use the existing incident update/acknowledgement commands for their separate purposes.

A new transport fact, changed message/scope or newer inspector decision makes an old review historical. Attention reopens where current follow-up is unhandled. The console preserves a typed draft and disables submission until **Review current facts** is used. An in-flight response for another message cannot replace this review. Lost write responses can be retried with the same exact request identity; changing the request under that identity is rejected.

Inspection records are append-only in `sre_delivery_inspections`. SQLite and PostgreSQL use the same relational contract. Current-attention queries consider the latest matching inspection without changing raw delivery rows. Twenty recent records appear in the detail view; the database retains older records and still recognizes their idempotent request identities. Normal process/database restarts retain the current inspection. Database restore or offline transfer preserves history but invalidates pre-restore handled certainty; fresh inspection is held until restore reconciliation is released. A historical duplicate request returns its original receipt identity without reapplying its old positive state.

## Operator API

`GET /api/deliveries/<encoded-outbox-id>/inspection` returns the reviewed transport snapshot, `reviewFingerprint`, current inspection and history. Send `POST` to the same path with:

```json
{
  "requestId": "stable-unique-inspection-id",
  "expectedFingerprint": "<64 hex characters from the reviewed GET>",
  "finding": "inconclusive",
  "followUp": "required",
  "reason": "Checked the named conversation and time window; the lead still needs to confirm the handoff.",
  "observedAt": 1792580000000,
  "references": []
}
```

Use the actual observation time. Connected mode requires the existing operator API token. Audit records identify use of that shared credential (`operator-api / SRE_API_TOKEN`), not an individually authenticated person. Loopback fixtures record `local-operator / loopback operator`. Client-supplied actors, transport states and action fields are refused. Ordinary Teams messages, free-form agreement and `yes` cannot record an operator inspection.

A stale review or restore hold returns 409; malformed observations return 400; missing/out-of-scope records return 404/403. Storage failures are retryable 503s and leave the append uncommitted. A disabled historical conversation may be inspected without restoring its access. No retry-send endpoint is provided by this workflow.

## Verification boundary

Regression coverage checks SQLite and PGlite, concurrent reviewers, atomic failures, exact replay after newer decisions, history limits, nullable/scope changes, restore quarantine and SQLite ↔ PostgreSQL-adapter transfer. Browser controller tests hold reads and writes across message switches and preserve drafts. Native acceptance uses owned PostgreSQL 17.11, separate SRE processes and the installed Teams SDK with fictional loopback receivers. The native restore-fence exercise uses paused writers and does not establish recovery from an external backup. These tests do not validate a new Microsoft tenant session, Ally permissions, Claude output or cloud-scale operation.
