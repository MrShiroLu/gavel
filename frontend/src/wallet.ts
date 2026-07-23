import { useCallback, useState } from 'react';
import '@midnight-ntwrk/dapp-connector-api';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';

// Lace only speaks to public Midnight networks, not the bundled local
// `undeployed` devnet — Phase 2's wallet-connect flow targets preprod.
export const TARGET_NETWORK_ID = 'preprod';

type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'network-mismatch' | 'error';

type WalletState = {
  status: WalletStatus;
  walletName: string | null;
  address: string | null;
  api: ConnectedAPI | null;
  error: string | null;
};

const initialState: WalletState = {
  status: 'disconnected',
  walletName: null,
  address: null,
  api: null,
  error: null,
};

export function useWallet() {
  const [state, setState] = useState<WalletState>(initialState);

  const connect = useCallback(async () => {
    const injected = window.midnight;
    if (!injected) {
      setState({ ...initialState, status: 'error', error: 'No Midnight wallet found. Install Lace to continue.' });
      return;
    }

    const walletKey = Object.keys(injected)[0];
    if (!walletKey) {
      setState({ ...initialState, status: 'error', error: 'No Midnight wallet found. Install Lace to continue.' });
      return;
    }

    setState((s) => ({ ...s, status: 'connecting', error: null }));

    try {
      const initialApi = injected[walletKey];
      const connectedApi = await initialApi.connect(TARGET_NETWORK_ID);
      const { networkId: activeNetworkId } = await connectedApi.getConfiguration();
      if (activeNetworkId !== TARGET_NETWORK_ID) {
        setState({
          ...initialState,
          status: 'network-mismatch',
          error: `Wallet is on "${activeNetworkId}" — switch it to "${TARGET_NETWORK_ID}" and reconnect.`,
        });
        return;
      }
      const { unshieldedAddress } = await connectedApi.getUnshieldedAddress();
      setState({
        status: 'connected',
        walletName: initialApi.name,
        address: unshieldedAddress,
        api: connectedApi,
        error: null,
      });
    } catch (err) {
      setState({
        ...initialState,
        status: 'error',
        error: err instanceof Error ? err.message : 'Wallet connection was rejected.',
      });
    }
  }, []);

  const disconnect = useCallback(() => setState(initialState), []);

  return { ...state, connect, disconnect };
}

export function shortenAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}
