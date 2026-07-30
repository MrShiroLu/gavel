// Mirrors contracts/auction.compact's AuctionState enum ordinals exactly —
// Compact enums serialize as their declaration order, same convention the
// phase0 check script relies on (scripts/phase0-settlement-check.ts).
export const AUCTION_STATE_NAMES = ['Created', 'Bidding', 'SettlementWindow', 'Settled', 'Cancelled'] as const;

export const auctionStateName = (state: number): string => AUCTION_STATE_NAMES[state] ?? `Unknown(${state})`;

export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// The contract's Uint<64> amounts are raw base units (like lovelace/wei),
// not human tNIGHT — nativeToken() on Midnight uses 6 decimals. The UI
// takes/shows human tNIGHT and converts at the boundary so a typed "150"
// means 150 tNIGHT, not 150 millionths of one.
const NIGHT_DECIMALS = 6;
const NIGHT_SCALE = 10n ** BigInt(NIGHT_DECIMALS);

export const parseNightAmount = (input: string): bigint => {
  const [whole, frac = ''] = input.trim().split('.');
  const paddedFrac = (frac + '0'.repeat(NIGHT_DECIMALS)).slice(0, NIGHT_DECIMALS);
  return BigInt(whole || '0') * NIGHT_SCALE + BigInt(paddedFrac || '0');
};

export const formatNightAmount = (raw: bigint): string => {
  const whole = raw / NIGHT_SCALE;
  const frac = raw % NIGHT_SCALE;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(NIGHT_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
};

// The winner's recorded address is a hash of their wallet address, not the
// address itself — NOTES_Plan.md section 4 calls the on-chain winner field "an
// anonymous claim ticket or an address the winner chooses to use"; hashing
// keeps it a stable, verifiable ticket without a Midnight-address-format
// dependency in the UI layer.
export const addressToClaimTicket = async (address: string): Promise<Uint8Array> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  return new Uint8Array(digest);
};
