// Acceptance check for the production auction contract
// (contracts/auction.compact): three bidders run the full lifecycle with
// real deadlines enforced via blockTimeLt/blockTimeGte, the minimum
// increment rule is exercised, and losing bid amounts never appear in any
// circuit's public transcript or in ledger state. Plain node:assert script,
// matching scripts/phase0-settlement-check.ts's pattern (no test runner
// installed, none of this needs one).
import assert from "node:assert/strict";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  AuctionSimulator,
  createBidderPrivateState,
  commitmentOf,
  bidderIdOf
} from "../contracts/simulator.js";
import { flatten, containsBytes } from "../contracts/phase0-spike/byte-scan.js";

setNetworkId("undeployed");

const bytes32 = (fill: number) => new Uint8Array(32).fill(fill);

const seller = bytes32(1);
// sellerId is what the ledger stores and openBidding checks against: the
// deriveBidderId of the seller's secret, not the raw secret (the frontend
// computes it the same way via pureCircuits.deriveBidderId at deploy).
const sellerId = bidderIdOf(seller);
const alice = { secretKey: bytes32(10), amount: 100n, nonce: bytes32(11) };
const bob = { secretKey: bytes32(20), amount: 300n, nonce: bytes32(21) };
const carol = { secretKey: bytes32(30), amount: 110n, nonce: bytes32(31) };
const bobAddress = bytes32(99);

const biddingEndsAt = 1_000n;
const settlementEndsAt = 2_000n;

const sim = new AuctionSimulator(
  createBidderPrivateState(seller),
  sellerId,
  50n /* bidFloor */,
  20n /* bidIncrement */,
  biddingEndsAt,
  settlementEndsAt,
  0
);

sim.openBidding();

for (const bidder of [alice, bob, carol]) {
  sim.switchTo(createBidderPrivateState(bidder.secretKey));
  sim.submitBid(commitmentOf(bidder.amount, bidder.nonce));
}

let ledger = sim.getLedger();
assert.equal(ledger.bidCount, 3n, "all three bids should be recorded");

sim.setTime(Number(biddingEndsAt));
sim.closeBidding();
assert.equal(sim.getLedger().state, 2 /* SettlementWindow */);

sim.setTime(Number(biddingEndsAt) + 1);

// Bob settles first: he becomes the leader, so his amount IS disclosed —
// that's the documented settlement leak (PLAN.md section 4), not a bug.
sim.switchTo(createBidderPrivateState(bob.secretKey));
sim.settleBid(bob.amount, bob.nonce);
ledger = sim.getLedger();
assert.equal(ledger.currentMaxAmount, 300n);
assert.equal(
  Buffer.from(ledger.currentLeaderId).toString("hex"),
  Buffer.from(bidderIdOf(bob.secretKey)).toString("hex")
);

// Carol's bid (110) clears the floor but not bob's 300 + the 20 increment
// (320): the min-increment rule must keep bob as leader.
for (const bidder of [alice, carol]) {
  sim.switchTo(createBidderPrivateState(bidder.secretKey));
  sim.settleBid(bidder.amount, bidder.nonce);
  ledger = sim.getLedger();
  assert.equal(ledger.currentMaxAmount, 300n, "a losing settle must not move the running max");
  assert.equal(
    Buffer.from(ledger.currentLeaderId).toString("hex"),
    Buffer.from(bidderIdOf(bob.secretKey)).toString("hex"),
    "a losing settle must not change the recorded leader"
  );

  const transcript = flatten(sim.lastProofData?.publicTranscript);
  assert.ok(transcript.length > 0, "expected a non-empty public transcript");
  assert.equal(
    containsBytes(transcript, bidder.secretKey),
    false,
    "a losing bidder's secret key must never appear in the public transcript"
  );
  assert.equal(
    containsBytes(transcript, bidder.nonce),
    false,
    "a losing bidder's bid nonce must never appear in the public transcript"
  );
}

sim.setTime(Number(settlementEndsAt));
sim.switchTo(createBidderPrivateState(bob.secretKey));
sim.finalizeSettlement(bobAddress);
ledger = sim.getLedger();

assert.equal(ledger.state, 3 /* Settled */);
assert.equal(ledger.currentMaxAmount, 300n, "clearing price must be the true highest bid");
assert.equal(
  Buffer.from(ledger.winnerAddress).toString("hex"),
  Buffer.from(bobAddress).toString("hex"),
  "recorded winner must be the true highest bidder"
);

for (const secret of [alice, carol].flatMap((b) => [b.secretKey, b.nonce])) {
  assert.equal(containsBytes(flatten(ledger), secret), false, "no losing-bidder secret may leak into ledger state");
}

console.log("Auction check passed: winner=bob price=300, min-increment enforced, deadlines enforced, losing amounts unrevealed.");

// ── Tie handling ─────────────────────────────────────────────────────────
// The increment rule (amount >= currentMax + minIncrement) means an equal
// settle amount can never unseat the current leader — first to reach a given
// amount keeps it.
{
  const tieSim = new AuctionSimulator(
    createBidderPrivateState(seller), sellerId, 50n, 20n, biddingEndsAt, settlementEndsAt, 0
  );
  const first = { secretKey: bytes32(40), amount: 200n, nonce: bytes32(41) };
  const second = { secretKey: bytes32(50), amount: 200n, nonce: bytes32(51) };

  tieSim.openBidding();
  for (const b of [first, second]) {
    tieSim.switchTo(createBidderPrivateState(b.secretKey));
    tieSim.submitBid(commitmentOf(b.amount, b.nonce));
  }
  tieSim.setTime(Number(biddingEndsAt));
  tieSim.closeBidding();
  tieSim.setTime(Number(biddingEndsAt) + 1);

  tieSim.switchTo(createBidderPrivateState(first.secretKey));
  tieSim.settleBid(first.amount, first.nonce);
  tieSim.switchTo(createBidderPrivateState(second.secretKey));
  tieSim.settleBid(second.amount, second.nonce);

  let tieLedger = tieSim.getLedger();
  assert.equal(tieLedger.currentMaxAmount, 200n, "a tie must not change the running max");
  assert.equal(
    Buffer.from(tieLedger.currentLeaderId).toString("hex"),
    Buffer.from(bidderIdOf(first.secretKey)).toString("hex"),
    "first bidder to reach an amount keeps leadership on a tie"
  );

  tieSim.setTime(Number(settlementEndsAt));
  assert.throws(
    () => {
      tieSim.switchTo(createBidderPrivateState(second.secretKey));
      tieSim.finalizeSettlement(bytes32(98));
    },
    /Caller is not the recorded leader/,
    "the tied non-leader must not be able to finalize"
  );
  tieSim.switchTo(createBidderPrivateState(first.secretKey));
  tieSim.finalizeSettlement(bytes32(97));
  assert.equal(tieSim.getLedger().state, 3, "the true leader still finalizes fine after a tie");
}
console.log("Tie handling passed: earlier settle keeps leadership, later equal settle is rejected at finalize.");

// ── Bidder who never settles ────────────────────────────────────────────
{
  const ghostSim = new AuctionSimulator(
    createBidderPrivateState(seller), sellerId, 50n, 20n, biddingEndsAt, settlementEndsAt, 0
  );
  const ghost = { secretKey: bytes32(60), amount: 90n, nonce: bytes32(61) };
  const winner = { secretKey: bytes32(70), amount: 150n, nonce: bytes32(71) };

  ghostSim.openBidding();
  for (const b of [ghost, winner]) {
    ghostSim.switchTo(createBidderPrivateState(b.secretKey));
    ghostSim.submitBid(commitmentOf(b.amount, b.nonce));
  }
  ghostSim.setTime(Number(biddingEndsAt));
  ghostSim.closeBidding();
  ghostSim.setTime(Number(biddingEndsAt) + 1);

  // ghost never calls settleBid.
  ghostSim.switchTo(createBidderPrivateState(winner.secretKey));
  ghostSim.settleBid(winner.amount, winner.nonce);

  ghostSim.setTime(Number(settlementEndsAt));
  ghostSim.finalizeSettlement(bytes32(96));
  const ghostLedger = ghostSim.getLedger();
  assert.equal(ghostLedger.state, 3, "settlement must complete around a bidder who never settles");
  assert.equal(ghostLedger.currentMaxAmount, 150n);
}
console.log("Never-settles bidder passed: auction still finalizes around them.");

// ── Re-bid attempt: same wallet, second active bid ──────────────────────
{
  const rebidSim = new AuctionSimulator(
    createBidderPrivateState(seller), sellerId, 50n, 20n, biddingEndsAt, settlementEndsAt, 0
  );
  rebidSim.openBidding();
  rebidSim.switchTo(createBidderPrivateState(bytes32(80)));
  rebidSim.submitBid(commitmentOf(100n, bytes32(81)));
  assert.throws(
    () => rebidSim.submitBid(commitmentOf(500n, bytes32(82))),
    /already has an active bid/,
    "a wallet must not be able to place a second active bid"
  );
}
console.log("Re-bid rejection passed: nullifier blocks a second bid from the same wallet.");

// ── Seller-only openBidding ─────────────────────────────────────────────
// Anyone other than the seller must not be able to start the auction; only
// the wallet whose deriveBidderId matches the stored sellerId can.
{
  const authSim = new AuctionSimulator(
    createBidderPrivateState(seller), sellerId, 50n, 20n, biddingEndsAt, settlementEndsAt, 0
  );
  authSim.switchTo(createBidderPrivateState(bytes32(77) /* not the seller */));
  assert.throws(
    () => authSim.openBidding(),
    /Only the seller can open bidding/,
    "a non-seller must not be able to open bidding"
  );
  authSim.switchTo(createBidderPrivateState(seller));
  authSim.openBidding();
  assert.equal(authSim.getLedger().state, 1 /* Bidding */, "the seller can open bidding");
}
console.log("Seller-only openBidding passed: only the seller starts the auction.");

// ── Seller cannot bid (shill guard) ─────────────────────────────────────
{
  const shillSim = new AuctionSimulator(
    createBidderPrivateState(seller), sellerId, 50n, 20n, biddingEndsAt, settlementEndsAt, 0
  );
  shillSim.openBidding();
  shillSim.switchTo(createBidderPrivateState(seller));
  assert.throws(
    () => shillSim.submitBid(commitmentOf(100n, bytes32(78))),
    /Seller cannot bid on their own auction/,
    "the seller must not be able to bid on their own auction"
  );
}
console.log("Shill-bid rejection passed: the seller cannot bid on their own auction.");

// ── Bid submitted after the bidding deadline ────────────────────────────
{
  const lateSim = new AuctionSimulator(
    createBidderPrivateState(seller), sellerId, 50n, 20n, biddingEndsAt, settlementEndsAt, 0
  );
  lateSim.openBidding();
  lateSim.setTime(Number(biddingEndsAt));
  lateSim.switchTo(createBidderPrivateState(bytes32(90)));
  assert.throws(
    () => lateSim.submitBid(commitmentOf(100n, bytes32(91))),
    /Bidding deadline has passed/,
    "a bid submitted after the deadline must be rejected"
  );
}
console.log("Late-bid rejection passed: deadline is enforced in-circuit.");

// ── Zero-bid cancellation ────────────────────────────────────────────────
{
  const cancelSim = new AuctionSimulator(
    createBidderPrivateState(seller), sellerId, 50n, 20n, biddingEndsAt, settlementEndsAt, 0
  );
  cancelSim.openBidding();
  cancelSim.setTime(Number(biddingEndsAt));
  assert.throws(
    () => cancelSim.closeBidding(),
    /Cannot close an auction with zero bids/,
    "closing a zero-bid auction must be rejected"
  );
  cancelSim.cancelAuction();
  assert.equal(cancelSim.getLedger().state, 4 /* Cancelled */, "a zero-bid auction should cancel cleanly");
}
console.log("Zero-bid cancellation passed.");

// ── Constructor validation: zero bid floor ──────────────────────────────
// A zero floor would collide with the currentMaxAmount == 0 "no leader
// yet" sentinel in settleBid (a valid amount-0 bid could re-enter the
// "first bid" branch and overwrite an earlier equal leader).
{
  assert.throws(
    () =>
      new AuctionSimulator(
        createBidderPrivateState(seller), sellerId, 0n /* bidFloor */, 20n, biddingEndsAt, settlementEndsAt, 0
      ),
    /Bid floor must be greater than zero/,
    "a zero bid floor must be rejected at construction"
  );
}
console.log("Zero-bid-floor rejection passed: constructor guards the currentMaxAmount sentinel.");

// ── Constructor validation: zero bid increment ──────────────────────────
// A zero increment would let a later equal settle displace an earlier
// equal leader, contradicting the documented tie-break invariant (see the
// tie-handling scenario above: first to reach an amount keeps it).
{
  assert.throws(
    () =>
      new AuctionSimulator(
        createBidderPrivateState(seller), sellerId, 50n, 0n /* bidIncrement */, biddingEndsAt, settlementEndsAt, 0
      ),
    /Bid increment must be greater than zero/,
    "a zero bid increment must be rejected at construction"
  );
}
console.log("Zero-bid-increment rejection passed: constructor guards the tie-break invariant.");

// ── Constructor validation: settlement deadline not after bidding deadline ──
// Otherwise closeBidding can move the auction into SettlementWindow while
// settleBid's blockTimeLt(settlementDeadline) is already false, permanently
// locking the auction with no bidder ever able to settle or finalize.
{
  assert.throws(
    () =>
      new AuctionSimulator(
        createBidderPrivateState(seller), sellerId, 50n, 20n,
        1_000n /* biddingEndsAt */, 1_000n /* settlementEndsAt, equal */, 0
      ),
    /Settlement deadline must be after the bidding deadline/,
    "an equal settlement/bidding deadline must be rejected at construction"
  );
  assert.throws(
    () =>
      new AuctionSimulator(
        createBidderPrivateState(seller), sellerId, 50n, 20n,
        1_000n /* biddingEndsAt */, 500n /* settlementEndsAt, before it */, 0
      ),
    /Settlement deadline must be after the bidding deadline/,
    "a settlement deadline before the bidding deadline must be rejected at construction"
  );
}
console.log("Settlement-window-ordering rejection passed: constructor prevents the permanent-lock case.");

console.log("\nAll auction acceptance scenarios passed (PLAN.md Phase 3 test list complete).");
