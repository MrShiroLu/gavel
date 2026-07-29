/**
 * Real on-chain acceptance check for the auction contract on Preprod, using
 * three distinct wallets (seller, alice, bob) that each pay their own gas —
 * this is NOTES_Plan.md Phase 3's "at least three distinct wallets" acceptance bar.
 * scripts/auction-onchain-check.ts already covers the same lifecycle faster
 * on the local devnet with one funded wallet and two bidder identities; this
 * script is the Preprod proof that three independent parties can run it.
 *
 * Each role gets its own seed and wallet-sync-state, namespaced under
 * .midnight-preprod-auction/<role>/ (gitignored) by passing a distinct `cwd`
 * into src/network.ts's getOrCreateSeed and src/wallet.ts's createWallet —
 * both already accept a `cwd` override, so this never touches the project's
 * single-wallet .midnight-state.json / .midnight-wallet-state used by
 * src/deploy.ts, src/cli.ts, etc.
 *
 * The Preprod faucet is a captcha'd web form, not an API, so funding can't be
 * automated here. All three wallets are synced and their addresses printed
 * together up front, so a human can paste all three into the faucet in one
 * pass instead of being forced through three serialized wait loops; funding
 * is then polled as one batch under a single shared timeout (see
 * prepareWallets/waitForFunding below).
 *
 * OPERATOR WORKFLOW — memory note and warm-up mode:
 *
 * A from-genesis Preprod wallet sync has been measured north of 10 GB of
 * resident memory for a single wallet (replaying ~1.7M blocks of history).
 * `prepareWallets()` below holds all three role wallets synced and alive at
 * once, so a cold run of this script needs on the order of 30 GB of RAM.
 *
 * `--role <seller|alice|bob>` runs a warm-up: sync exactly that one role,
 * persist its state under .midnight-preprod-auction/<role>/, stop the
 * wallet, and exit — releasing that wallet's sync memory back to the OS
 * before the next role is synced. Run all three warm-ups one at a time
 * (each in its own process), then run the full check; `createWallet` in
 * src/wallet.ts restores each role from its persisted state, so the full
 * run only does a cheap catch-up sync per wallet instead of three
 * concurrent from-genesis syncs:
 *
 *   npm run test:auction:preprod:warm -- seller
 *   npm run test:auction:preprod:warm -- alice
 *   npm run test:auction:preprod:warm -- bob
 *   npm run test:auction:preprod
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import * as Rx from 'rxjs';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { resolveNetwork, getOrCreateSeed } from '../src/network.js';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from '../src/wallet.js';
import { createBidderPrivateState, witnesses, type BidderPrivateState } from '../contracts/witnesses.js';
import {
  PREPROD_CHECK_BID_FLOOR,
  PREPROD_CHECK_BID_INCREMENT,
  PREPROD_CHECK_ALICE_BID_AMOUNT,
  PREPROD_CHECK_BOB_BID_AMOUNT,
  PREPROD_CHECK_BIDDING_WINDOW_SECONDS,
  PREPROD_CHECK_SETTLEMENT_WINDOW_SECONDS,
  PREPROD_CHECK_DEADLINE_MARGIN_MS,
  PREPROD_FAUCET_POLL_INTERVAL_MS,
  PREPROD_SYNC_PROGRESS_INTERVAL_MS,
  PREPROD_FAUCET_TIMEOUT_MS_DEFAULT,
} from '../contracts/config.js';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
if (network !== 'preprod') {
  console.error(
    `\n❌ This check is for Preprod only (got network=${network}).\n` +
      `   Run \`npm run network preprod\` first, then re-run this script.\n`,
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Role = 'seller' | 'alice' | 'bob';
const ROLES: Role[] = ['seller', 'alice', 'bob'];
const ROOT = path.resolve(__dirname, '..');
const roleDir = (role: Role) => path.join(ROOT, '.midnight-preprod-auction', role);

// Warm-up mode: `--role <role>` syncs exactly one role's wallet, persists its
// state, stops it, and exits — before the compiled-contract check below,
// since warm-up never touches the contract at all. See the header comment
// for the full rationale and operator workflow. `syncWallet` is a hoisted
// function declaration defined further down; calling it here (before its
// textual definition) is safe because ROLES/roleDir/networkConfig above it
// are already initialized by this point.
const warmUpRoleFlagIndex = process.argv.indexOf('--role');
if (warmUpRoleFlagIndex !== -1) {
  const roleValue = process.argv[warmUpRoleFlagIndex + 1];
  if (!ROLES.includes(roleValue as Role)) {
    console.error(`\n❌ --role must be one of ${ROLES.join(', ')} (got ${roleValue ?? '<missing>'}).\n`);
    process.exit(1);
  }
  const role = roleValue as Role;
  console.log(`\n─── Warm-up: syncing ${role} only, then exiting ────────────────\n`);
  const prepared = await syncWallet(role);
  await prepared.ctx.wallet.stop();
  console.log(
    `\n  ✅ ${role} synced and cached under ${prepared.cwd} ` +
      `(balance: ${prepared.initialBalance.toLocaleString()} tNight).\n` +
      `  Process exiting to release sync memory back to the OS.\n`,
  );
  process.exit(0);
}

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

const bytes32 = (fill: number) => new Uint8Array(32).fill(fill);
const SELLER_MARKER = bytes32(1);
const BID = {
  alice: { secretKey: bytes32(10), amount: PREPROD_CHECK_ALICE_BID_AMOUNT, nonce: bytes32(11) },
  bob: { secretKey: bytes32(20), amount: PREPROD_CHECK_BOB_BID_AMOUNT, nonce: bytes32(21) },
} as const;
const bobClaimAddress = bytes32(99);

const PRIVATE_STATE_PASSWORD = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Preprod-Auction-Check-Placeholder-1';

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
  await new Promise((r) => setTimeout(r, remaining + PREPROD_CHECK_DEADLINE_MARGIN_MS));
}

interface PreparedWallet {
  role: Role;
  cwd: string;
  ctx: WalletContext;
  address: string;
  initialBalance: bigint;
}

function balanceOf(state: { unshielded: { balances: Record<string, bigint | undefined> } }): bigint {
  return state.unshielded.balances[unshieldedToken().raw] ?? 0n;
}

function syncedState(ctx: WalletContext) {
  return Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
}

/**
 * Derive and sync a single role's wallet. No faucet waiting, no DUST
 * registration — just get the wallet to a synced state so its address and
 * balance are known. Split out so all three roles can be synced (and their
 * addresses printed together) before anyone has to wait on the faucet.
 */
async function syncWallet(role: Role): Promise<PreparedWallet> {
  const cwd = roleDir(role);
  const seed = getOrCreateSeed('preprod', { cwd });
  const ctx = await createWallet({ network: 'preprod', networkConfig, seed, cwd });
  console.log(`  Syncing ${role} with network...`);

  // A from-genesis Preprod sync replays the whole chain (measured: 10+ GB of
  // heap and many minutes for one wallet). Without progress output there is no
  // way to tell a slow sync from a hung one, so report the shielded wallet's
  // applied-vs-highest index as it advances. Throttled, because the underlying
  // observable emits far too often to log every update.
  const syncStarted = Date.now();
  let lastReport = 0;
  const progressSub = ctx.wallet.state().subscribe((s) => {
    const now = Date.now();
    if (now - lastReport < PREPROD_SYNC_PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    const p = s.shielded.progress;
    const applied = p.appliedIndex;
    const highest = p.highestIndex;
    const pct = highest > 0n ? Number((applied * 100n) / highest) : 0;
    const elapsed = Math.round((now - syncStarted) / 1000);
    console.log(
      `    ${role}: ${applied.toLocaleString()} / ${highest.toLocaleString()} (${pct}%) ` +
        `after ${elapsed}s${p.isConnected ? '' : ' [disconnected]'}`,
    );
  });

  let state;
  try {
    state = await ctx.wallet.waitForSyncedState();
  } finally {
    progressSub.unsubscribe();
  }
  // Checkpoint right after the (slow) sync so a later failure doesn't force
  // re-syncing from scratch on the next run.
  await persistWalletState('preprod', ctx, cwd);
  const address = ctx.unshieldedKeystore.getBech32Address().toString();
  return { role, cwd, ctx, address, initialBalance: balanceOf(state) };
}

/**
 * Poll all not-yet-funded wallets together under a single shared timeout
 * budget (MIDNIGHT_FAUCET_TIMEOUT_MS override, else
 * PREPROD_FAUCET_TIMEOUT_MS_DEFAULT), so the clock starts once for the whole
 * batch instead of restarting for each role. Wallets already funded from a
 * previous run are reported and never polled.
 */
async function waitForFunding(prepared: PreparedWallet[]): Promise<void> {
  const pending = new Map<Role, PreparedWallet>();
  for (const p of prepared) {
    if (p.initialBalance > 0n) {
      console.log(`  ✅ ${p.role} already funded (${p.initialBalance.toLocaleString()} tNight) — skipping wait.`);
    } else {
      pending.set(p.role, p);
    }
  }
  if (pending.size === 0) return;

  const rawTimeout = Number(process.env.MIDNIGHT_FAUCET_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : PREPROD_FAUCET_TIMEOUT_MS_DEFAULT;
  const start = Date.now();
  console.log(
    `\n  Waiting for tNIGHT on: ${[...pending.keys()].join(', ')} ` +
      `(poll every ${PREPROD_FAUCET_POLL_INTERVAL_MS / 1000}s, ${Math.round(timeoutMs / 60_000)} min total budget for the whole batch)...`,
  );

  while (pending.size > 0) {
    await new Promise((r) => setTimeout(r, PREPROD_FAUCET_POLL_INTERVAL_MS));
    for (const [role, p] of pending) {
      const s = await syncedState(p.ctx);
      const tn = balanceOf(s);
      if (tn > 0n) {
        console.log(`  ✅ ${role} funded! tNIGHT balance: ${tn.toLocaleString()}`);
        pending.delete(role);
      }
    }
    if (pending.size > 0 && Date.now() - start > timeoutMs) {
      throw new Error(
        `Wallet(s) not funded within ${Math.round(timeoutMs / 60_000)} min: ${[...pending.keys()].join(', ')}. ` +
          `Faucet: ${networkConfig.faucet}`,
      );
    }
  }
}

/**
 * Register any unregistered NIGHT UTXOs for DUST generation and wait for
 * DUST to arrive, then checkpoint. Assumes the wallet is already funded
 * (call after waitForFunding resolves).
 */
async function ensureDust(p: PreparedWallet): Promise<void> {
  const { role, ctx, cwd } = p;
  const dustState = await syncedState(ctx);
  const unregisteredUtxos = dustState.unshielded.availableCoins.filter(
    (c: any) => !c.meta?.registeredForDustGeneration,
  );
  if (unregisteredUtxos.length > 0) {
    console.log(`  [${role}] Registering ${unregisteredUtxos.length} NIGHT UTXO(s) for DUST generation...`);
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
      unregisteredUtxos,
      ctx.unshieldedKeystore.getPublicKey(),
      (payload) => ctx.unshieldedKeystore.signData(payload),
    );
    const finalized = await ctx.wallet.finalizeRecipe(recipe);
    await ctx.wallet.submitTransaction(finalized);
  }
  if (dustState.dust.balance(new Date()) === 0n) {
    console.log(`  [${role}] Waiting for DUST...`);
    await Rx.firstValueFrom(
      ctx.wallet.state().pipe(
        Rx.throttleTime(5000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
      ),
    );
  }
  console.log(`  [${role}] ✅ DUST ready.`);

  // Checkpoint again now that funding + DUST registration are done, so a
  // later failure (e.g. mid-auction) doesn't force re-doing this step.
  await persistWalletState('preprod', ctx, cwd);
}

/**
 * Full per-role preparation: sync all three wallets first (so every address
 * is known up front), print them together with faucet instructions, poll
 * funding as one batch, then register DUST for each. Returns a Role-keyed
 * map of wallet contexts, mirroring the shape `main()` used to build one
 * role at a time via the old prepareWallet().
 */
async function prepareWallets(): Promise<Record<Role, WalletContext>> {
  console.log('\n─── Deriving and syncing wallets (seller, alice, bob) ──────────\n');
  const prepared: PreparedWallet[] = [];
  for (const role of ROLES) {
    prepared.push(await syncWallet(role));
  }

  console.log('\n─── Fund these addresses now ────────────────────────────────────\n');
  for (const p of prepared) {
    console.log(`  ${p.role.padEnd(6)} ${p.address}  (balance: ${p.initialBalance.toLocaleString()} tNight)`);
  }
  console.log(`\n  Faucet: ${networkConfig.faucet}`);
  console.log('  → Paste all three addresses into the faucet now. Already-funded wallets are skipped automatically.\n');

  await waitForFunding(prepared);

  console.log('\n─── Registering DUST for each wallet ───────────────────────────\n');
  for (const p of prepared) {
    await ensureDust(p);
  }

  const wallets: Record<Role, WalletContext> = {} as any;
  for (const p of prepared) wallets[p.role] = p.ctx;
  return wallets;
}

async function buildProviders(ctx: WalletContext, role: Role, zkConfigProvider: NodeZkConfigProvider<string>, publicDataProvider: ReturnType<typeof indexerPublicDataProvider>) {
  const state = await ctx.wallet.waitForSyncedState();
  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signedRecipe = await ctx.wallet.signRecipe(recipe, (payload) => ctx.unshieldedKeystore.signData(payload));
      return ctx.wallet.finalizeRecipe(signedRecipe);
    },
    submitTx: (tx: any) => ctx.wallet.submitTransaction(tx) as any,
  };
  const accountId = ctx.unshieldedKeystore.getBech32Address().toString();
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `gavel-auction-preprod-check-${role}`,
      accountId,
      privateStoragePasswordProvider: () => PRIVATE_STATE_PASSWORD,
    }),
    publicDataProvider,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Auction contract — Preprod, three distinct wallets             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('  Checking local proof server...');
  if (!(await waitForProofServer(networkConfig.proofServer))) {
    console.error('\n❌ Proof server not responding. Run: docker compose up -d --wait proof-server\n');
    process.exit(1);
  }

  const wallets = await prepareWallets();

  console.log('\n─── Setting up providers ───────────────────────────────────────\n');
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const publicDataProvider = indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS);
  const providers: Record<Role, Awaited<ReturnType<typeof buildProviders>>> = {} as any;
  for (const role of ROLES) {
    providers[role] = await buildProviders(wallets[role], role, zkConfigProvider, publicDataProvider);
  }

  const PRIVATE_STATE_ID = 'gavelAuctionPrivateState-preprod-check';
  const joinAs = (providersForRole: Awaited<ReturnType<typeof buildProviders>>, bidderState: BidderPrivateState, contractAddress: string) =>
    findDeployedContract(providersForRole, {
      contractAddress,
      compiledContract: compiledContract as any,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: bidderState,
    });

  // Generous windows: three real wallets, real Preprod block times, real
  // proof generation for every call. Padded well beyond the local-devnet
  // check's windows (see contracts/config.ts's ONCHAIN_CHECK_*_WINDOW_SECONDS
  // for the reasoning on why proof generation needs more headroom than
  // originally assumed) to also absorb Preprod network latency variance.
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const biddingEndsAt = nowSeconds + PREPROD_CHECK_BIDDING_WINDOW_SECONDS;
  const settlementEndsAt = biddingEndsAt + PREPROD_CHECK_SETTLEMENT_WINDOW_SECONDS;

  console.log('\n─── Deploying auction (seller) ─────────────────────────────────\n');
  console.log(`  bidFloor=${PREPROD_CHECK_BID_FLOOR} bidIncrement=${PREPROD_CHECK_BID_INCREMENT} biddingEndsAt=${biddingEndsAt} settlementEndsAt=${settlementEndsAt}`);
  // openBidding checks deriveBidderId(localSecretKey()) == sellerId, so the
  // constructor needs the derived id, not the raw secret (same bug fixed in
  // auction-onchain-check.ts).
  const sellerId = AuctionModule.pureCircuits.deriveBidderId(SELLER_MARKER);
  const deployed = await deployContract(providers.seller, {
    compiledContract: compiledContract as any,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: createBidderPrivateState(SELLER_MARKER),
    args: [sellerId, PREPROD_CHECK_BID_FLOOR, PREPROD_CHECK_BID_INCREMENT, biddingEndsAt, settlementEndsAt],
  });
  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log(`  ✅ Deployed at ${contractAddress}`);

  console.log('\n─── Opening bidding (seller) ────────────────────────────────────\n');
  await deployed.callTx.openBidding();
  console.log('  ✅ Bidding open');

  console.log('\n─── Submitting sealed bids ─────────────────────────────────────\n');
  for (const role of ['alice', 'bob'] as const) {
    const bidder = BID[role];
    const contract = await joinAs(providers[role], createBidderPrivateState(bidder.secretKey), contractAddress);
    const commitment = AuctionModule.pureCircuits.computeCommitment(bidder.amount, bidder.nonce);
    await contract.callTx.submitBid(commitment);
    console.log(`  ✅ ${role} bid submitted (sealed commitment only, amount never left this process)`);
  }

  await waitUntil(biddingEndsAt, 'bidding deadline');
  console.log('\n─── Closing bidding (seller) ────────────────────────────────────\n');
  await deployed.callTx.closeBidding();
  console.log('  ✅ Bidding closed, settlement window open');

  console.log('\n─── Settling bids ──────────────────────────────────────────────\n');
  for (const role of ['alice', 'bob'] as const) {
    const bidder = BID[role];
    const contract = await joinAs(providers[role], createBidderPrivateState(bidder.secretKey), contractAddress);
    await contract.callTx.settleBid(bidder.amount, bidder.nonce);
    console.log(`  ✅ ${role} settled`);
  }

  await waitUntil(settlementEndsAt, 'settlement deadline');
  console.log('\n─── Finalizing settlement (bob) ─────────────────────────────────\n');
  const bobContract = await joinAs(providers.bob, createBidderPrivateState(BID.bob.secretKey), contractAddress);
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
    PREPROD_CHECK_BOB_BID_AMOUNT,
    `clearing price must be the true highest bid (bob, ${PREPROD_CHECK_BOB_BID_AMOUNT})`,
  );
  assert.equal(
    Buffer.from(ledgerState.winnerAddress).toString('hex'),
    Buffer.from(bobClaimAddress).toString('hex'),
    "recorded winner must be bob's claim address",
  );

  console.log('  ✅ On-chain state matches expectations: winner=bob price=300, three distinct wallets used.');
  console.log('\nPreprod auction acceptance check passed.\n');

  for (const role of ROLES) {
    await persistWalletState('preprod', wallets[role], roleDir(role));
    await wallets[role].wallet.stop();
  }
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\n❌ auction-preprod-check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
