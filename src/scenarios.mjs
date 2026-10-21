export const scenarios = [
  { id: 'healthy-release', title: 'Healthy release', ticket: 'SA-101', description: 'A release changes its label; auction behavior stays healthy.', replacement: ["release: 'baseline'", "release: 'healthy-release'"], expected: null },
  { id: 'bid-race', title: 'Concurrent bid regression', ticket: 'SA-102', description: 'Two dealers bid at once. An older bid overwrites the winner after optimistic locking is removed.', replacement: ['checkVersion: true', 'checkVersion: false'], expected: 'WINNING_BID_REGRESSED' },
  { id: 'credit-timeout', title: 'Credit check timeout', ticket: 'SA-103', description: 'A timeout change rejects legitimate bids when the credit check takes 25 ms.', replacement: ['creditTimeoutMs: 100', 'creditTimeoutMs: 1'], expected: 'CREDIT_TIMEOUT' },
  { id: 'schema-break', title: 'Incompatible schema release', ticket: 'SA-104', description: 'The new binary expects schema v2 while the store still uses v1. Migration is explicitly irreversible.', replacement: ['schemaVersion: 1', 'schemaVersion: 2'], expected: 'SCHEMA_MISMATCH', irreversible: true },
  { id: 'catalog-latency', title: 'Slow auction catalog', ticket: 'SA-105', description: 'A catalog change introduces a 350 ms delay on every request.', replacement: ['catalogDelayMs: 5', 'catalogDelayMs: 350'], expected: 'CATALOG_LATENCY' },
  { id: 'late-bid', title: 'Bid accepted after close', ticket: 'SA-106', description: 'Removing the close-time check lets a dealer bid on an expired auction.', replacement: ['enforceCloseTime: true', 'enforceCloseTime: false'], expected: 'BID_ACCEPTED_AFTER_CLOSE' },
  { id: 'dependency-outage', title: 'Credit provider outage', ticket: 'SA-107', description: 'The application is unchanged; an external credit provider becomes unavailable.', replacement: null, expected: 'CREDIT_PROVIDER_UNAVAILABLE' },
];

export function publicScenarios() { return scenarios.map(({ replacement, expected, ...x }) => x); }
