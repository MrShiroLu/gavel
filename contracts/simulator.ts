import {
  type CircuitContext,
  type ProofData,
  sampleContractAddress,
  createConstructorContext,
  createCircuitContext
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  ledger,
  pureCircuits
} from "./managed/auction/contract/index.js";
import { type BidderPrivateState, witnesses } from "./witnesses.js";

export class AuctionSimulator {
  readonly contract: Contract<BidderPrivateState>;
  circuitContext: CircuitContext<BidderPrivateState>;
  lastProofData: ProofData | undefined;

  constructor(
    callerState: BidderPrivateState,
    seller: Uint8Array,
    bidFloor: bigint,
    biddingEndsAt: bigint,
    settlementEndsAt: bigint,
    startTime: number
  ) {
    this.contract = new Contract<BidderPrivateState>(witnesses);
    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      this.contract.initialState(
        createConstructorContext(callerState, "0".repeat(64)),
        seller,
        bidFloor,
        biddingEndsAt,
        settlementEndsAt
      );
    this.circuitContext = createCircuitContext(
      sampleContractAddress(),
      currentZswapLocalState,
      currentContractState,
      currentPrivateState,
      undefined,
      undefined,
      startTime
    );
  }

  public getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  public switchTo(state: BidderPrivateState): void {
    this.circuitContext = { ...this.circuitContext, currentPrivateState: state };
  }

  public setTime(time: number): void {
    const queryContext = this.circuitContext.currentQueryContext;
    queryContext.block = { ...queryContext.block, secondsSinceEpoch: BigInt(time) };
  }

  private run<A extends unknown[]>(
    circuit: (context: CircuitContext<BidderPrivateState>, ...args: A) => {
      context: CircuitContext<BidderPrivateState>;
      proofData: ProofData;
    },
    ...args: A
  ): Ledger {
    const result = circuit(this.circuitContext, ...args);
    this.circuitContext = result.context;
    this.lastProofData = result.proofData;
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  openBidding(): Ledger {
    return this.run(this.contract.impureCircuits.openBidding);
  }

  submitBid(commitment: Uint8Array): Ledger {
    return this.run(this.contract.impureCircuits.submitBid, commitment);
  }

  closeBidding(): Ledger {
    return this.run(this.contract.impureCircuits.closeBidding);
  }

  cancelAuction(): Ledger {
    return this.run(this.contract.impureCircuits.cancelAuction);
  }

  settleBid(amount: bigint, nonce: Uint8Array): Ledger {
    return this.run(this.contract.impureCircuits.settleBid, amount, nonce);
  }

  finalizeSettlement(claimedAddress: Uint8Array): Ledger {
    return this.run(this.contract.impureCircuits.finalizeSettlement, claimedAddress);
  }

  claimProceeds(sellerAddress: { bytes: Uint8Array }): Ledger {
    return this.run(this.contract.impureCircuits.claimProceeds, sellerAddress);
  }
}

export const commitmentOf = (amount: bigint, nonce: Uint8Array): Uint8Array =>
  pureCircuits.computeCommitment(amount, nonce);

export const bidderIdOf = (secretKey: Uint8Array): Uint8Array =>
  pureCircuits.deriveBidderId(secretKey);

export { createBidderPrivateState } from "./witnesses.js";
export type { BidderPrivateState };
