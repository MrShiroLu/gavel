// Wires the frontend to the real Gavel auction contract
// (contracts/auction.compact). One contract instance per auction — there is
// no on-chain registry, so auction discovery is a local concern (see
// auctionRegistry.ts). Bridges the injected Lace wallet (dapp-connector-api,
// transaction-string based) to the WalletProvider/MidnightProvider shape
// midnight-js expects (typed ledger transaction objects), mirroring the
// Node wallet adapter in ../../src/deploy.ts but delegating balancing/
// signing/submission to the browser wallet the user already connected.
import { Contract, ledger, type Ledger } from '../../contracts/managed/auction/contract/index.js';
import { witnesses, type BidderPrivateState } from '../../contracts/witnesses.js';
import { DEFAULT_PREPROD_INDEXER_URL, DEFAULT_PREPROD_INDEXER_WS_URL } from '../../contracts/config.js';
import type { ContractAddress } from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import {
  ZKConfigProvider,
  createProverKey,
  createVerifierKey,
  createZKIR,
  type ProverKey,
  type VerifierKey,
  type ZKIR,
  type MidnightProviders,
  type WalletProvider,
  type MidnightProvider
} from '@midnight-ntwrk/midnight-js-types';
import {
  findDeployedContract,
  deployContract,
  type FoundContract
} from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as ledgerApi from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m, ShieldedAddress, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { TARGET_NETWORK_ID } from './wallet';

setNetworkId(TARGET_NETWORK_ID);

const INDEXER = import.meta.env.VITE_INDEXER_URL ?? DEFAULT_PREPROD_INDEXER_URL;
const INDEXER_WS = import.meta.env.VITE_INDEXER_WS_URL ?? DEFAULT_PREPROD_INDEXER_WS_URL;
const PROOF_SERVER = import.meta.env.VITE_PROOF_SERVER_URL ?? 'http://127.0.0.1:6300';
const ZK_BASE = `${import.meta.env.BASE_URL}zk`;

class FetchZkConfigProvider<K extends string> extends ZKConfigProvider<K> {
  private readonly baseUrl: string;
  constructor(baseUrl: string) {
    super();
    this.baseUrl = baseUrl;
  }
  private async fetchBytes(path: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/${path}`);
    if (!res.ok) throw new Error(`Failed to fetch ZK artifact ${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  getProverKey(circuitId: K): Promise<ProverKey> {
    return this.fetchBytes(`keys/${circuitId}.prover`).then(createProverKey);
  }
  getVerifierKey(circuitId: K): Promise<VerifierKey> {
    return this.fetchBytes(`keys/${circuitId}.verifier`).then(createVerifierKey);
  }
  getZKIR(circuitId: K): Promise<ZKIR> {
    return this.fetchBytes(`zkir/${circuitId}.bzkir`).then(createZKIR);
  }
}

type AuctionCircuits =
  | 'openBidding'
  | 'submitBid'
  | 'closeBidding'
  | 'cancelAuction'
  | 'settleBid'
  | 'finalizeSettlement'
  | 'claimProceeds';
const AuctionPrivateStateId = 'gavelAuctionPrivateState';
type AuctionProviders = MidnightProviders<AuctionCircuits, typeof AuctionPrivateStateId, BidderPrivateState>;
type AuctionContract = Contract<BidderPrivateState>;
export type DeployedAuctionContract = FoundContract<AuctionContract>;

const auctionCompiledContract = CompiledContract.make('auction', Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(ZK_BASE)
);

export const createBrowserWalletProvider = async (
  connectedApi: ConnectedAPI
): Promise<WalletProvider & MidnightProvider> => {
  const { shieldedAddress } = await connectedApi.getShieldedAddresses();
  const { coinPublicKey, encryptionPublicKey } = MidnightBech32m.parse(shieldedAddress).decode(
    ShieldedAddress,
    TARGET_NETWORK_ID
  );

  return {
    getCoinPublicKey: () => coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => encryptionPublicKey.toHexString(),
    async balanceTx(tx) {
      const { tx: balancedHex } = await connectedApi.balanceUnsealedTransaction(Buffer.from(tx.serialize()).toString('hex'));
      return ledgerApi.Transaction.deserialize('signature', 'proof', 'binding', Buffer.from(balancedHex, 'hex'));
    },
    async submitTx(tx) {
      await connectedApi.submitTransaction(Buffer.from(tx.serialize()).toString('hex'));
      return tx.identifiers()[0];
    }
  };
};

// The seller's unshielded (UserAddress) payout target for claimProceeds.
// Decoded the same way createBrowserWalletProvider decodes the shielded
// address, but from getUnshieldedAddress — sendUnshielded pays a UserAddress,
// not a shielded coin public key.
export const getUnshieldedUserAddress = async (
  connectedApi: ConnectedAPI
): Promise<{ bytes: Uint8Array }> => {
  const { unshieldedAddress } = await connectedApi.getUnshieldedAddress();
  const parsed = MidnightBech32m.parse(unshieldedAddress).decode(UnshieldedAddress, TARGET_NETWORK_ID);
  return { bytes: new Uint8Array(parsed.data) };
};

export const configureProviders = async (connectedApi: ConnectedAPI): Promise<AuctionProviders> => {
  const walletProvider = await createBrowserWalletProvider(connectedApi);
  const accountId = walletProvider.getCoinPublicKey();
  const storagePassword = `${btoa(accountId)}!`;
  const zkConfigProvider = new FetchZkConfigProvider<AuctionCircuits>(ZK_BASE);
  // ponytail: loaded lazily, not at module scope — this package's browser
  // build breaks Vite's dep pre-bundling on eager import.
  const { levelPrivateStateProvider } = await import('@midnight-ntwrk/midnight-js-level-private-state-provider');
  return {
    privateStateProvider: levelPrivateStateProvider<typeof AuctionPrivateStateId>({
      privateStateStoreName: 'gavel-auction-private-state',
      accountId,
      privateStoragePasswordProvider: () => storagePassword
    }),
    publicDataProvider: indexerPublicDataProvider(INDEXER, INDEXER_WS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider
  };
};

export type AuctionConstructorArgs = {
  seller: Uint8Array;
  bidFloor: bigint;
  bidIncrement: bigint;
  biddingEndsAt: bigint;
  settlementEndsAt: bigint;
};

export const deployAuction = async (
  providers: AuctionProviders,
  privateState: BidderPrivateState,
  args: AuctionConstructorArgs
): Promise<DeployedAuctionContract> =>
  deployContract(providers, {
    compiledContract: auctionCompiledContract,
    privateStateId: AuctionPrivateStateId,
    initialPrivateState: privateState,
    args: [args.seller, args.bidFloor, args.bidIncrement, args.biddingEndsAt, args.settlementEndsAt]
  });

// Always passes initialPrivateState: the bidder's secret lives in
// localStorage (see privateState.ts), not on chain, so re-supplying it on
// every join is an idempotent overwrite, not a data-loss risk.
export const joinAuctionContract = async (
  providers: AuctionProviders,
  privateState: BidderPrivateState,
  contractAddress: ContractAddress
): Promise<DeployedAuctionContract> =>
  findDeployedContract(providers, {
    contractAddress,
    compiledContract: auctionCompiledContract,
    privateStateId: AuctionPrivateStateId,
    initialPrivateState: privateState
  });

export const readAuctionState = async (contractAddress: ContractAddress): Promise<Ledger | null> => {
  const publicDataProvider = indexerPublicDataProvider(INDEXER, INDEXER_WS);
  const state = await publicDataProvider.queryContractState(contractAddress);
  if (state === null) return null;
  return ledger(state.data);
};

export { pureCircuits } from '../../contracts/managed/auction/contract/index.js';
export type { Ledger as AuctionLedger };
