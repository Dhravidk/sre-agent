import { setTimeout as delay } from 'node:timers/promises';
import * as baseline from './rules.mjs';

export function initialLots(now) {
  return [
    { id: 'LOT-1042', year: 2023, make: 'Toyota', model: 'Camry SE', miles: 28740, color: 'Slate', currentBidCents: 2180000, reserveCents: 2250000, endsAt: now + 600000, version: 0, bids: [] },
    { id: 'LOT-1043', year: 2022, make: 'Ford', model: 'F-150 XLT', miles: 41280, color: 'Cobalt', currentBidCents: 3120000, reserveCents: 3200000, endsAt: now + 900000, version: 0, bids: [] },
    { id: 'LOT-1044', year: 2024, make: 'Honda', model: 'CR-V EX', miles: 12350, color: 'Pearl', currentBidCents: 2790000, reserveCents: 2850000, endsAt: now + 1200000, version: 0, bids: [] },
  ];
}

export class Auction {
  constructor({ clock = Date.now, rules = baseline } = {}) { this.clock = clock; this.rules = rules; this.reset(); }
  reset() { this.lots = initialLots(this.clock()); this.samples = []; this.idempotency = new Map(); this.creditDown = false; this.dataSchemaVersion = 1; }
  async catalog() {
    const start = performance.now();
    await delay(this.rules.policy.catalogDelayMs);
    this.samples.push({ operation: 'catalog', status: 200, durationMs: performance.now() - start, at: this.clock() });
    return structuredClone(this.lots);
  }
  async bid(id, amountCents, dealer = 'Demo Dealer', requestId = '', processingMs = 15) {
    const key = id + ':' + requestId;
    const fingerprint = JSON.stringify([id, amountCents, dealer]);
    if (requestId && this.idempotency.has(key)) {
      const existing = this.idempotency.get(key);
      if (existing.fingerprint !== fingerprint) return { status: 409, code: 'IDEMPOTENCY_CONFLICT' };
      return existing.promise;
    }
    const promise = this.executeBid(id, amountCents, dealer, processingMs);
    if (requestId) this.idempotency.set(key, { fingerprint, promise });
    return promise;
  }
  async executeBid(id, amountCents, dealer, processingMs) {
    const started = performance.now();
    const observedAt = this.clock();
    const lot = this.lots.find(x => x.id === id);
    const finish = (status, code) => {
      this.samples.push({ operation: 'bid', status, code, durationMs: performance.now() - started, at: this.clock(), release: this.rules.policy.release });
      return { status, code, lot: lot ? structuredClone(lot) : undefined };
    };
    if (!lot) return finish(404, 'LOT_NOT_FOUND');
    if (this.dataSchemaVersion !== this.rules.policy.schemaVersion) return finish(500, 'SCHEMA_MISMATCH');
    const invalid = this.rules.validateBid(lot, amountCents, observedAt);
    if (invalid) return finish(409, invalid);
    const version = lot.version;
    if (this.creditDown) return finish(503, 'CREDIT_PROVIDER_UNAVAILABLE');
    const creditLatencyMs = 25;
    await delay(Math.min(creditLatencyMs, this.rules.policy.creditTimeoutMs));
    if (creditLatencyMs > this.rules.policy.creditTimeoutMs) return finish(504, 'CREDIT_TIMEOUT');
    await delay(processingMs);
    if (this.rules.policy.checkVersion && version !== lot.version) return finish(409, 'BID_CONFLICT_RETRY');
    // Re-check close time after I/O, as well as before it.
    if (this.rules.policy.enforceCloseTime && this.clock() >= lot.endsAt) return finish(409, 'AUCTION_CLOSED');
    lot.currentBidCents = amountCents;
    lot.version++;
    lot.bids.push({ amountCents, dealer, at: this.clock() });
    return finish(201, 'BID_ACCEPTED');
  }
  telemetry() {
    const recent = this.samples.slice(-100);
    const codes = [...new Set(recent.filter(x => x.status >= 500).map(x => x.code))];
    const violations = [];
    for (const lot of this.lots) {
      if (lot.bids.some(x => x.amountCents > lot.currentBidCents)) violations.push('WINNING_BID_REGRESSED');
      if (lot.bids.some(x => x.at >= lot.endsAt)) violations.push('BID_ACCEPTED_AFTER_CLOSE');
    }
    const durations = recent.map(x => x.durationMs).sort((a,b) => a-b);
    return {
      requests: recent.length, errors: recent.filter(x => x.status >= 500).length,
      p95Ms: Math.round(durations[Math.max(0, Math.ceil(durations.length * .95) - 1)] || 0),
      codes, violations: [...new Set(violations)], observedAt: this.clock(), samples: recent,
    };
  }
}
