import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";
import type { Ledger } from "./managed/auction/contract/index.js";

export type BidderPrivateState = {
  readonly secretKey: Uint8Array;
};

export const createBidderPrivateState = (
  secretKey: Uint8Array
): BidderPrivateState => ({ secretKey });

export const witnesses = {
  localSecretKey: ({
    privateState
  }: WitnessContext<Ledger, BidderPrivateState>): [
    BidderPrivateState,
    Uint8Array
  ] => [privateState, privateState.secretKey]
};
