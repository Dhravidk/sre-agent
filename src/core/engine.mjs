export function emptyState() {
  return { deployments: [], incidents: {}, reviews: [], messages: [], processed: [], events: [], clock: Date.now() };
}

function validateEvent(event) {
  for (const key of ['id', 'source', 'tenant', 'service', 'environment', 'type']) {
    if (typeof event[key] !== 'string' || !event[key] || event[key].length > 200) throw new Error('Invalid event.' + key);
  }
  if (!Number.isFinite(event.at)) throw new Error('Invalid event.at');
  if (event.startedAt !== undefined && (!Number.isFinite(event.startedAt) || event.startedAt > event.at)) throw new Error('Invalid event.startedAt');
  if (!['deployment', 'problem', 'health_verified'].includes(event.type)) throw new Error('Unsupported event type');
  if (event.type === 'problem' && (!event.problemId || !['OPEN', 'CLOSED'].includes(event.status))) throw new Error('Invalid problem');
  if (event.type === 'health_verified' && !event.problemId) throw new Error('Invalid recovery event');
  if (event.type === 'deployment' && (!event.sha || !event.artifact || !['success','failed'].includes(event.status))) throw new Error('Invalid deployment');
}

export function diagnose(metrics = {}) {
  const signals = [...(metrics.codes || []), ...(metrics.violations || [])];
  if (signals.includes('CREDIT_PROVIDER_UNAVAILABLE')) return { signal: 'CREDIT_PROVIDER_UNAVAILABLE', summary: 'The credit provider is unavailable.', changeRelated: false };
  if (signals.includes('SCHEMA_MISMATCH')) return { signal: 'SCHEMA_MISMATCH', summary: 'The running release and database schema are incompatible.', changeRelated: true };
  if (signals.includes('WINNING_BID_REGRESSED')) return { signal: 'WINNING_BID_REGRESSED', summary: 'A concurrent update replaced an accepted higher bid with a lower bid.', changeRelated: true };
  if (signals.includes('BID_ACCEPTED_AFTER_CLOSE')) return { signal: 'BID_ACCEPTED_AFTER_CLOSE', summary: 'The bid service accepted a bid after the auction closed.', changeRelated: true };
  if (signals.includes('CREDIT_TIMEOUT')) return { signal: 'CREDIT_TIMEOUT', summary: 'Credit checks are exceeding the configured timeout.', changeRelated: true };
  if ((metrics.requests || 0) >= 3 && metrics.p95Ms > 250) return { signal: 'CATALOG_LATENCY', summary: 'Catalog response latency exceeds the lab threshold.', changeRelated: true };
  return { signal: 'UNKNOWN', summary: 'There is insufficient evidence to identify the cause.', changeRelated: false };
}

export function applyEvent(inputState, event) {
  validateEvent(event);
  const state = structuredClone(inputState);
  const eventKey = [event.source, event.tenant, event.id].join(':');
  if (state.processed.includes(eventKey)) return { state, duplicate: true, messages: [] };
  state.processed.push(eventKey);
  state.events.push(event);
  state.clock = Math.max(state.clock, event.at);
  if (event.type === 'deployment') {
    state.deployments.push(event);
    return { state, messages: [] };
  }
  const key = [event.tenant,event.environment,event.service,event.problemId].join(':');
  const prior = state.incidents[key];
  const previousSummary = prior ? JSON.stringify([prior.status,prior.summary,prior.candidateDeployment?.sha,prior.rollback]) : null;
  if (prior && (event.at < prior.updatedAt || (event.at === prior.updatedAt && prior.status !== 'open' && event.status === 'OPEN'))) return { state, stale: true, messages: [] };
  if (event.type === 'health_verified') {
    if (!prior || prior.status !== 'verifying' || !event.healthy) return { state, messages: [] };
    prior.status = 'resolved';
    prior.updatedAt = event.at;
  } else if (event.status === 'CLOSED') {
    // A redelivered closure with a newer observation time must not undo an
    // independently verified recovery. A genuinely newer OPEN may reopen it.
    if (prior?.status === 'resolved') return { state, messages: [] };
    state.incidents[key] = { ...prior, id: key, problemId: event.problemId, service: event.service, environment: event.environment, updatedAt: event.at, status: 'verifying', summary: prior?.summary || 'Problem closed; recovery evidence still required.' };
  } else {
    const diagnosis = diagnose(event.metrics);
    const startedAt = (prior?.status !== 'resolved' ? prior?.startedAt : undefined) ?? event.startedAt ?? event.at;
    // An update observed after another deployment is still the same incident.
    // Do not allow that later deployment to become its candidate cause.
    const matching = state.deployments.filter(x => x.status === 'success' && x.tenant === event.tenant && x.service === event.service && x.environment === event.environment && x.at <= startedAt).sort((a,b) => b.at-a.at);
    const recent = matching.find(x => startedAt - x.at <= 60*60*1000);
    const target = matching.find(x => x.healthy && (!recent || x.sha !== recent.sha));
    const candidate = diagnosis.changeRelated ? recent : undefined;
    const rollback = !candidate ? { allowed: false, reason: 'A relevant deployed change has not been established. Investigate the dependency or gather more evidence.' }
      : !candidate.rollbackCompatible ? { allowed: false, reason: 'Schema compatibility is not established. Validate migration state and use the service recovery runbook.' }
      : !target ? { allowed: false, reason: 'No prior healthy artifact is recorded.' }
      : { allowed: true, targetSha: target.sha, targetArtifact: target.artifact, reason: 'Candidate only: verify schema and dependency compatibility before an operator redeploys this artifact.' };
    state.incidents[key] = {
      id: key, problemId: event.problemId, service: event.service, environment: event.environment,
      status: 'open', startedAt, updatedAt: event.at, summary: diagnosis.summary, signal: diagnosis.signal,
      metrics: event.metrics, candidateDeployment: candidate || null,
      causation: candidate ? 'Temporal correlation; code review or a controlled reproduction is still needed.' : 'No deployment cause established.',
      jira: candidate?.ticket || null, rollback, analysisMode: 'deterministic lab rules',
    };
  }
  const incident = state.incidents[key];
  if (previousSummary === JSON.stringify([incident.status,incident.summary,incident.candidateDeployment?.sha,incident.rollback])) return { state, messages: [] };
  const message = { id: eventKey, at: event.at, incidentId: key, status: 'pending', text: '[' + incident.status.toUpperCase() + '] ' + incident.service + ': ' + incident.summary + (incident.rollback ? '\nRecovery: ' + incident.rollback.reason : '') };
  state.messages.push(message);
  return { state, messages: [message] };
}

export function reviewDiff(diff) {
  const added = diff.split('\n').filter(x => x.startsWith('+') && !x.startsWith('+++')).join('\n');
  const findings = [];
  if (/checkVersion:\s*false/.test(added)) findings.push({ severity: 'high', issue: 'Concurrent bids can overwrite one another.', check: 'Run the two-dealer race and assert that the highest accepted bid remains the winner.' });
  if (/enforceCloseTime:\s*false/.test(added)) findings.push({ severity: 'high', issue: 'Bids can be accepted after auction close.', check: 'Advance the test clock past closing time and submit a bid.' });
  if (/creditTimeoutMs:\s*1\b/.test(added)) findings.push({ severity: 'high', issue: 'The credit timeout is below the fixture provider latency.', check: 'Replay a 25 ms provider response and inspect bid failures.' });
  if (/schemaVersion:\s*2/.test(added)) findings.push({ severity: 'high', issue: 'This release changes the required schema version.', check: 'Test mixed-version deployment and migration/rollback compatibility.' });
  if (/catalogDelayMs:\s*350/.test(added)) findings.push({ severity: 'medium', issue: 'The catalog adds latency to every request.', check: 'Run a catalog latency check under representative traffic.' });
  return { mode: 'fixture-specific static rules; not an LLM review', findings, coverage: 'Only the five documented demo patterns are recognized.' };
}

export function answerQuestion(state, text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Enter a request of 1–4000 characters.');
  const incidents = Object.values(state.incidents).filter(x => x.status !== 'resolved');
  if (!incidents.length) return 'No active lab incidents. Deploy a scenario or send traffic, then ask me to investigate. This is scripted lab analysis; it does not assess arbitrary production systems.';
  const lines = incidents.map(x => x.service + ': ' + x.summary + '\n' + (x.candidateDeployment ? 'Deployed commit: ' + x.candidateDeployment.sha.slice(0,8) + '; linked ticket: ' + x.jira + '. ' : '') + x.causation + '\n' + (x.rollback?.reason || 'Recovery verification pending.'));
  return 'Lab investigation (deterministic rules)\n\n' + lines.join('\n\n');
}
