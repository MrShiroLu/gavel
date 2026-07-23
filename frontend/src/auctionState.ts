// Mirrors contracts/auction.compact's AuctionState enum ordinals exactly —
// Compact enums serialize as their declaration order, same convention the
// phase0 check script relies on (scripts/phase0-settlement-check.ts).
export const AUCTION_STATE_NAMES = ['Created', 'Bidding', 'SettlementWindow', 'Settled', 'Cancelled'] as const;

export const auctionStateName = (state: number): string => AUCTION_STATE_NAMES[state] ?? `Unknown(${state})`;

export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// The winner's recorded address is a hash of their wallet address, not the
// address itself — PLAN.md section 4 calls the on-chain winner field "an
// anonymous claim ticket or an address the winner chooses to use"; hashing
// keeps it a stable, verifiable ticket without a Midnight-address-format
// dependency in the UI layer.
export const addressToClaimTicket = async (address: string): Promise<Uint8Array> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  return new Uint8Array(digest);
};
