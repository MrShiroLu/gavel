/**
 * Real on-chain acceptance check for the auction contract (contracts/auction.compact),
 * against a live Midnight node — not the in-memory simulator scripts/auction-check.ts
 * uses. Deploys a fresh instance, drives the full lifecycle (open, two sealed bids,
 * close, two settles, finalize) with real proofs submitted to a real node, then reads
 * the result back through the public indexer. Exits non-zero on any failure.
 *
 * Only one wallet pays gas here (the network's single funded genesis wallet on
 * `undeployed`); "two bidders" are two distinct BidderPrivateState identities
 * (secretKey), which is all the contract's nullifier/bidderId scheme cares about —
 * matches how the frontend re-joins with a different private state per action
 * (see frontend/src/midnight.ts's joinAuctionContract).
 *
 * Does NOT touch .midnight-state.json's deployment record — that slot belongs to
 * the hello-world scaffold contract used by `npm run cli` / `npm run test:e2e`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { resolveNetwork, getOrCreateSeed } from '../src/network.js';
import { createWallet, persistWalletState, unshieldedToken } from '../src/wallet.js';
import { createBidderPrivateState, witnesses, type BidderPrivateState } from '../contracts/witnesses.js';
import {
  ONCHAIN_CHECK_BID_FLOOR,
  ONCHAIN_CHECK_BID_INCREMENT,
  ONCHAIN_CHECK_ALICE_BID_AMOUNT,
  ONCHAIN_CHECK_BOB_BID_AMOUNT,
  ONCHAIN_CHECK_BIDDING_WINDOW_SECONDS,
  ONCHAIN_CHECK_SETTLEMENT_WINDOW_SECONDS,
  ONCHAIN_CHECK_DEADLINE_MARGIN_MS,
} from '../contracts/config.js';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
if (network !== 'undeployed') {
  console.error(`❌ This check is for the local devnet only (got network=${network}). Run \`npm run network undeployed\` first.`);
  process.exit(1);
}
const SEED = getOrCreateSeed(network);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'auction');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
if (!fs.existsSync(contractPath)) {
  console.error('\n❌ Auction contract not compiled! Run: npm run compile:auction\n');
  process.exit(1);
}
const AuctionModule = await import(pathToFileURL(contractPath).href);

const compiledContract = CompiledContract.make('auction', AuctionModule.Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

const PRIVATE_STATE_ID = 'gavelAuctionPrivateState-onchain-check';

const bytes32 = (fill: number) => new Uint8Array(32).fill(fill);
const seller = bytes32(1);
const alice = { secretKey: bytes32(10), amount: ONCHAIN_CHECK_ALICE_BID_AMOUNT, nonce: bytes32(11) };
const bob = { secretKey: bytes32(20), amount: ONCHAIN_CHECK_BOB_BID_AMOUNT, nonce: bytes32(21) };
const bobClaimAddress = bytes32(99);

async function waitForProofServer(url: string, maxAttempts = 60, delayMs = 2000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) });
      return true;
    } catch (err: any) {
      const code = err?.cause?.code || err?.code || '';
      if (code !== 'ECONNREFUSED' && code !== 'UND_ERR_CONNECT_TIMEOUT' && code !== 'UND_ERR_SOCKET') return true;
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function waitUntil(targetEpochSeconds: bigint, label: string): Promise<void> {
  const targetMs = Number(targetEpochSeconds) * 1000;
  const remaining = targetMs - Date.now();
  if (remaining <= 0) return;
  console.log(`  Waiting ${Math.ceil(remaining / 1000)}s for ${label}...`);
  await new Promise((r) => setTimeout(r, remaining + ONCHAIN_CHECK_DEADLINE_MARGIN_MS));
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Auction contract — real devnet acceptance check               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('  Checking proof server...');
  if (!(await waitForProofServer(networkConfig.proofServer))) {
    console.error('\n❌ Proof server not responding. Run: docker compose up -d --wait\n');
    process.exit(1);
  }

  console.log('  Creating wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  console.log('  Syncing with network (this can take a while on first run)...');
  const state = await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);

  const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`  Wallet balance: ${balance.toLocaleString()} tNight`);
  if (balance === 0n) {
    console.error('\n❌ Genesis wallet has zero tNight. Is the local devnet up? `docker compose up -d --wait`\n');
    await walletCtx.wallet.stop();
    process.exit(1);
  }

  const privateStatePassword = 'Local-Devnet-Onchain-Check-Placeholder-1';
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
        walletCtx.unshieldedKeystore.signData(payload),
      );
      return walletCtx.wallet.finalizeRecipe(signedRecipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const publicDataProvider = indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS);
  const providers = {
    privateStateProvider: levelPrivateStateProvider<typeof PRIVATE_STATE_ID>({
      privateStateStoreName: 'gavel-auction-onchain-check-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  const joinAs = (bidderState: BidderPrivateState, contractAddress: string) =>
    findDeployedContract(providers, {
      contractAddress,
      compiledContract: compiledContract as any,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: bidderState,
    });

  // Generous buffers: deploy + openBidding + two submitBid calls must all land
  // before biddingEndsAt; closeBidding + two settleBid calls before
  // settlementEndsAt. Real proof generation on this devnet has been observed
  // to take well past the minute mark per call — see the window sizing
  // rationale in contracts/config.ts (ONCHAIN_CHECK_*_WINDOW_SECONDS).
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const biddingEndsAt = nowSeconds + ONCHAIN_CHECK_BIDDING_WINDOW_SECONDS;
  const settlementEndsAt = biddingEndsAt + ONCHAIN_CHECK_SETTLEMENT_WINDOW_SECONDS;

  console.log('\n─── Deploying auction ──────────────────────────────────────────\n');
  console.log(`  bidFloor=${ONCHAIN_CHECK_BID_FLOOR} bidIncrement=${ONCHAIN_CHECK_BID_INCREMENT} biddingEndsAt=${biddingEndsAt} settlementEndsAt=${settlementEndsAt}`);
  // openBidding checks deriveBidderId(localSecretKey()) == sellerId, so the
  // constructor needs the derived id, not the raw secret — passing the raw
  // secret here made every openBidding call fail (this was the CI break).
  const sellerId = AuctionModule.pureCircuits.deriveBidderId(seller);
  const deployed = await deployContract(providers, {
    compiledContract: compiledContract as any,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: createBidderPrivateState(seller),
    args: [sellerId, ONCHAIN_CHECK_BID_FLOOR, ONCHAIN_CHECK_BID_INCREMENT, biddingEndsAt, settlementEndsAt],
  });
  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log(`  ✅ Deployed at ${contractAddress}`);

  console.log('\n─── Opening bidding ────────────────────────────────────────────\n');
  await deployed.callTx.openBidding();
  console.log('  ✅ Bidding open');

  console.log('\n─── Submitting sealed bids ─────────────────────────────────────\n');
  for (const bidder of [alice, bob]) {
    const contract = await joinAs(createBidderPrivateState(bidder.secretKey), contractAddress);
    const commitment = AuctionModule.pureCircuits.computeCommitment(bidder.amount, bidder.nonce);
    await contract.callTx.submitBid(commitment);
    console.log(`  ✅ Bid submitted (sealed commitment only, amount never left this process)`);
  }

  await waitUntil(biddingEndsAt, 'bidding deadline');
  console.log('\n─── Closing bidding ────────────────────────────────────────────\n');
  await deployed.callTx.closeBidding();
  console.log('  ✅ Bidding closed, settlement window open');

  console.log('\n─── Settling bids ──────────────────────────────────────────────\n');
  for (const bidder of [alice, bob]) {
    const contract = await joinAs(createBidderPrivateState(bidder.secretKey), contractAddress);
    await contract.callTx.settleBid(bidder.amount, bidder.nonce);
    console.log(`  ✅ Settled`);
  }

  await waitUntil(settlementEndsAt, 'settlement deadline');
  console.log('\n─── Finalizing settlement ──────────────────────────────────────\n');
  const bobContract = await joinAs(createBidderPrivateState(bob.secretKey), contractAddress);
  await bobContract.callTx.finalizeSettlement(bobClaimAddress);
  console.log('  ✅ Finalized');

  console.log('\n─── Verifying via public indexer ───────────────────────────────\n');
  const onChainState = await publicDataProvider.queryContractState(contractAddress);
  assert.ok(onChainState, 'contract state must be queryable from the indexer');
  const ledgerState = AuctionModule.ledger(onChainState!.data);

  assert.equal(ledgerState.state, 3, 'auction must be in Settled state');
  assert.equal(ledgerState.bidCount, 2n, 'both bids must be recorded');
  assert.equal(
    ledgerState.currentMaxAmount,
    ONCHAIN_CHECK_BOB_BID_AMOUNT,
    `clearing price must be the true highest bid (bob, ${ONCHAIN_CHECK_BOB_BID_AMOUNT})`,
  );
  assert.equal(
    Buffer.from(ledgerState.winnerAddress).toString('hex'),
    Buffer.from(bobClaimAddress).toString('hex'),
    'recorded winner must be bob\'s claim address',
  );

  console.log('  ✅ On-chain state matches expectations: winner=bob price=300');
  console.log('\nAuction on-chain acceptance check passed.\n');

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\n❌ auction-onchain-check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
