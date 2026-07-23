// Shared tunables config module (CLAUDE.md hard rule: "Tunable values
// (window durations, minimums, limits, fees) live only in a config module,
// never hardcoded" — also PLAN.md section 4).
//
// Placement: contracts/ is the one directory already imported across the
// Node/browser boundary — frontend/src/midnight.ts and
// frontend/src/privateState.ts already reach up into
// contracts/witnesses.js via relative imports, and scripts/*.ts already
// reach it via ../contracts/*.js. Putting the shared config next to
// witnesses.ts reuses that existing crossing instead of inventing a new
// one.
//
// Hard constraint: this file is imported by both the root Node package
// (ESM, tsx) and the frontend Vite/browser package. It must stay pure
// data — no `node:fs`/`node:path`, no `process.env` read at module scope,
// no `import.meta.env` (that's Vite-only and would break under tsx/Node).
// Env-based overrides (see frontend/src/midnight.ts's VITE_PROOF_SERVER_URL
// handling) stay in the consuming file; this module only holds the
// defaults they fall back to.
//
// Deliberately NOT here: test-fixture identities (secret keys, claim
// addresses like bytes32(1)/bytes32(10)/bytes32(99) in the check scripts).
// Those aren't tunable auction parameters, they're fixed actors in a
// scripted scenario — changing them doesn't change auction *behavior*, it
// changes *who* is playing which role. They stay local to the scripts that
// use them.

// --- Frontend: seller-facing defaults for the create-auction form ---
// (seller can still override every one of these before submitting).
export const DEFAULT_MIN_BID = 50n;
export const DEFAULT_MIN_INCREMENT = 10n;
export const DEFAULT_BIDDING_MINUTES = 60;
export const DEFAULT_SETTLEMENT_MINUTES = 30;

// --- Frontend: Preprod indexer endpoints ---
// Defaults only; frontend/src/midnight.ts applies the same
// VITE_*_URL-env-override-with-fallback pattern already used for
// PROOF_SERVER/VITE_PROOF_SERVER_URL.
export const DEFAULT_PREPROD_INDEXER_URL = 'https://indexer.preprod.midnight.network/api/v4/graphql';
export const DEFAULT_PREPROD_INDEXER_WS_URL = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';

// --- scripts/auction-onchain-check.ts (local `undeployed` devnet) ---
//
// Auction parameters for the scripted deploy:
export const ONCHAIN_CHECK_BID_FLOOR = 50n;
export const ONCHAIN_CHECK_BID_INCREMENT = 20n;
//
// Bid amounts for the two simulated bidders (alice loses, bob wins) —
// these are scenario data, not identities, so unlike the secret
// keys/claim address they live here: changing them changes what the
// scripted assertions expect (currentMaxAmount, winner) in a way that's
// meant to be tunable alongside the rest of the scenario.
export const ONCHAIN_CHECK_ALICE_BID_AMOUNT = 100n;
export const ONCHAIN_CHECK_BOB_BID_AMOUNT = 300n;
//
// Window durations, in seconds, from deploy time. Widened 2026-07-21: the
// previous 600s/300s windows were sized on a claimed "~30-60s per proof"
// observation that turned out to be stale on this machine — a real run
// hit "Bidding deadline has passed" because deploy + openBidding + two
// submitBid calls (4 real ZK-proof-generating transactions) didn't land
// in 600s. These new values are deliberately generous (a slow check that
// passes beats a fast one that's flaky): budget ~7-8 minutes per
// proof-generating call, worst case, with room to spare.
//   - Bidding window covers: deploy, openBidding, submitBid x2 (4 calls).
//   - Settlement window covers: closeBidding, settleBid x2 (3 calls).
export const ONCHAIN_CHECK_BIDDING_WINDOW_SECONDS = 1800n; // 30 min for 4 calls
export const ONCHAIN_CHECK_SETTLEMENT_WINDOW_SECONDS = 900n; // 15 min for 3 calls
//
// How long past a computed deadline to sleep before acting, so the chain's
// own clock has unambiguously crossed the boundary.
export const ONCHAIN_CHECK_DEADLINE_MARGIN_MS = 2_000;

// --- scripts/auction-preprod-check.ts (public Preprod testnet) ---
//
// Same family as the onchain check, but for three independent wallets
// over a real public network (real block times, real network latency on
// top of real proof generation), so windows are padded further still.
export const PREPROD_CHECK_BID_FLOOR = 50n;
export const PREPROD_CHECK_BID_INCREMENT = 20n;
export const PREPROD_CHECK_ALICE_BID_AMOUNT = 100n;
export const PREPROD_CHECK_BOB_BID_AMOUNT = 300n;
//
// Window durations, in seconds, from deploy time. Widened 2026-07-21
// alongside the onchain-check windows above, for the same reason (proof
// generation is materially slower than the stale "~30-60s" estimate) plus
// Preprod's own block-time/latency variance on top of that.
export const PREPROD_CHECK_BIDDING_WINDOW_SECONDS = 2700n; // 45 min for 4 calls
export const PREPROD_CHECK_SETTLEMENT_WINDOW_SECONDS = 1800n; // 30 min for 3 calls
//
// Margin slept past a computed deadline before acting.
export const PREPROD_CHECK_DEADLINE_MARGIN_MS = 5_000;
//
// Faucet funding poll: how often to re-check balance, and how long to
// wait before giving up (overridable via MIDNIGHT_FAUCET_TIMEOUT_MS, kept
// as the env-override in the script itself — this is just the fallback).
// How often to print wallet sync progress during the (long, from-genesis)
// Preprod sync. Purely cosmetic; the underlying observable emits far more
// often than anyone wants to read.
export const PREPROD_SYNC_PROGRESS_INTERVAL_MS = 15_000;

export const PREPROD_FAUCET_POLL_INTERVAL_MS = 10_000;
export const PREPROD_FAUCET_TIMEOUT_MS_DEFAULT = 900_000; // 15 min
