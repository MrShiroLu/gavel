// The bidder secret (BidderPrivateState.secretKey) never touches the chain
// and is not tied to the wallet's own keys — it only has to be stable across
// visits so deriveBidderId/deriveNullifier produce the same value every
// time. localStorage, keyed by (account, contract), is enough for that.
import { createBidderPrivateState, type BidderPrivateState } from '../../contracts/witnesses.js';

const storageKey = (accountId: string, contractAddress: string) => `gavel:secret:${accountId}:${contractAddress}`;

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

export const getOrCreateBidderPrivateState = (
  accountId: string,
  contractAddress: string
): BidderPrivateState => {
  const key = storageKey(accountId, contractAddress);
  const existing = localStorage.getItem(key);
  if (existing) return createBidderPrivateState(fromHex(existing));

  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  localStorage.setItem(key, toHex(secretKey));
  return createBidderPrivateState(secretKey);
};

// Persist a chosen secret (not a fresh random one) for this (account,
// contract). The seller uses this at deploy time so that when they later
// open bidding, getOrCreateBidderPrivateState hands back the same secret and
// deriveBidderId matches the sellerId stored on chain.
// ponytail: browser-local, so the seller can only open bidding from the
// browser that created the auction; cross-device seller control needs the
// secret exported/imported, out of scope for the MVP.
export const storeBidderPrivateState = (
  accountId: string,
  contractAddress: string,
  secretKey: Uint8Array
): void => {
  localStorage.setItem(storageKey(accountId, contractAddress), toHex(secretKey));
};

// Read the stored secret without creating one (unlike
// getOrCreateBidderPrivateState). Used to tell whether this wallet is the
// seller: deriveBidderId(secret) === ledger.sellerId.
export const peekBidderSecret = (accountId: string, contractAddress: string): Uint8Array | null => {
  const raw = localStorage.getItem(storageKey(accountId, contractAddress));
  return raw ? fromHex(raw) : null;
};

const bidStorageKey = (accountId: string, contractAddress: string) => `gavel:bid:${accountId}:${contractAddress}`;

export type StoredBid = { amount: string; nonceHex: string };

// Remembered so the app can auto-drive settlement (NOTES_Plan.md section 4's
// anti-abuse note: bidders shouldn't have to remember their own bid).
export const storeBid = (accountId: string, contractAddress: string, amount: bigint, nonce: Uint8Array): void => {
  localStorage.setItem(
    bidStorageKey(accountId, contractAddress),
    JSON.stringify({ amount: amount.toString(), nonceHex: toHex(nonce) } satisfies StoredBid)
  );
};

export const getStoredBid = (accountId: string, contractAddress: string): { amount: bigint; nonce: Uint8Array } | null => {
  const raw = localStorage.getItem(bidStorageKey(accountId, contractAddress));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as StoredBid;
  return { amount: BigInt(parsed.amount), nonce: fromHex(parsed.nonceHex) };
};
