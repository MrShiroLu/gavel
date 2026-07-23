import { WebSocket } from 'ws';
import { NETWORK_CONFIGS, getOrCreateSeed } from '../src/network.js';
import { createWallet, persistWalletState, unshieldedToken } from '../src/wallet.js';

// @ts-expect-error wallet sync needs a global WebSocket
globalThis.WebSocket = WebSocket;

const network = 'preprod' as const;
const networkConfig = NETWORK_CONFIGS[network];
const seed = getOrCreateSeed(network);

const walletCtx = await createWallet({ network, networkConfig, seed });
console.log('Address:', walletCtx.unshieldedKeystore.getBech32Address().toString());
console.log('Syncing...');
const state = await walletCtx.wallet.waitForSyncedState();
await persistWalletState(network, walletCtx);
const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
console.log('Balance:', balance.toLocaleString(), 'tNight');
await walletCtx.wallet.stop();
process.exit(0);
