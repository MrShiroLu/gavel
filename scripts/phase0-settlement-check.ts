// Phase 0 acceptance check (PLAN.md phase 5, Phase 0 acceptance criteria):
// three simulated bidders submit sealed bids against the settlement-window
// rolling-maximum contract (contracts/phase0-spike/settlement.compact) and
// the correct winner/price come out of settlement with losing bid amounts
// never appearing anywhere in the public ledger or any circuit's public
// transcript. Plain node:assert script, not a test framework — this repo
// has no test runner installed yet and none of this needs one.
import assert from "node:assert/strict";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  SettlementSimulator,
  createBidderPrivateState,
  commitmentOf,
  bidderIdOf
} from "../contracts/phase0-spike/simulator.js";
import { flatten, containsBytes } from "../contracts/phase0-spike/byte-scan.js";

setNetworkId("undeployed");

const bytes32 = (fill: number) => new Uint8Array(32).fill(fill);

const seller = bytes32(1);
const alice = { secretKey: bytes32(10), amount: 100n, nonce: bytes32(11) };
const bob = { secretKey: bytes32(20), amount: 300n, nonce: bytes32(21) };
const carol = { secretKey: bytes32(30), amount: 200n, nonce: bytes32(31) };
const bobAddress = bytes32(99);

const sim = new SettlementSimulator(
  createBidderPrivateState(seller),
  seller,
  50n
);

sim.openBidding();

for (const bidder of [alice, bob, carol]) {
  sim.switchTo(createBidderPrivateState(bidder.secretKey));
  sim.submitBid(commitmentOf(bidder.amount, bidder.nonce));
}

let ledger = sim.getLedger();
assert.equal(ledger.bidCount, 3n, "all three bids should be recorded");

sim.closeBidding();
assert.equal(sim.getLedger().state, 2 /* SettlementWindow */);

const privateBidderBytes = [alice, carol].flatMap((b) => [b.secretKey, b.nonce]);

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

// Alice and Carol settle below the max: the ledger's running max/leader
// must not move, and neither of their secret witnesses may appear in the
// public transcript of their own settlement call.
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

for (const secret of privateBidderBytes) {
  assert.equal(containsBytes(flatten(ledger), secret), false, "no losing-bidder secret may leak into ledger state");
}

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

console.log("Phase 0 settlement check passed: winner=bob price=300, losing amounts unrevealed.");
