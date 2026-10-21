// Baseline policy. Scenario branches change this executable module.
export const policy = {
  release: 'baseline',
  checkVersion: true,
  enforceCloseTime: true,
  creditTimeoutMs: 100,
  catalogDelayMs: 5,
  schemaVersion: 1,
  rollbackCompatible: true,
};

export function validateBid(lot, amountCents, now) {
  if (policy.enforceCloseTime && now >= lot.endsAt) return 'AUCTION_CLOSED';
  if (!Number.isSafeInteger(amountCents) || amountCents < lot.currentBidCents + 10000) return 'BID_TOO_LOW';
  return null;
}
