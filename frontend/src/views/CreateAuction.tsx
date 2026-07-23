import { useState } from 'react';
import type { useWallet } from '../wallet';
import { configureProviders, deployAuction, pureCircuits } from '../midnight';
import { createBidderPrivateState } from '../../../contracts/witnesses.js';
import { storeBidderPrivateState } from '../privateState';
import {
  DEFAULT_MIN_BID,
  DEFAULT_MIN_INCREMENT,
  DEFAULT_BIDDING_MINUTES,
  DEFAULT_SETTLEMENT_MINUTES,
} from '../../../contracts/config.js';
import { addAuction } from '../auctionRegistry';

type Wallet = ReturnType<typeof useWallet>;

export function CreateAuction({ wallet, onCreated }: { wallet: Wallet; onCreated: (address: string) => void }) {
  const [item, setItem] = useState('');
  const [minBid, setMinBid] = useState(DEFAULT_MIN_BID.toString());
  const [minIncrement, setMinIncrement] = useState(DEFAULT_MIN_INCREMENT.toString());
  const [biddingMinutes, setBiddingMinutes] = useState(DEFAULT_BIDDING_MINUTES.toString());
  const [settlementMinutes, setSettlementMinutes] = useState(DEFAULT_SETTLEMENT_MINUTES.toString());
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [deployedAddress, setDeployedAddress] = useState<string | null>(null);

  const submit = async () => {
    if (!wallet.api) return;
    setStatus('submitting');
    setError(null);
    try {
      const providers = await configureProviders(wallet.api);
      const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
      const biddingEndsAt = nowSeconds + BigInt(Number(biddingMinutes)) * 60n;
      const settlementEndsAt = biddingEndsAt + BigInt(Number(settlementMinutes)) * 60n;

      // The seller keeps a persistent per-auction secret. sellerId on chain is
      // its deriveBidderId, and openBidding proves knowledge of the secret —
      // so only this seller can start the auction. The secret is stored under
      // (account, address) below so the later "Open bidding" click re-joins
      // with the same secret via getOrCreateBidderPrivateState.
      const sellerSecret = crypto.getRandomValues(new Uint8Array(32));
      const sellerId = pureCircuits.deriveBidderId(sellerSecret);
      const sellerPrivateState = createBidderPrivateState(sellerSecret);
      const deployed = await deployAuction(providers, sellerPrivateState, {
        seller: sellerId,
        bidFloor: BigInt(minBid),
        bidIncrement: BigInt(minIncrement),
        biddingEndsAt,
        settlementEndsAt
      });

      const address = deployed.deployTxData.public.contractAddress;
      storeBidderPrivateState(providers.walletProvider.getCoinPublicKey(), address, sellerSecret);
      addAuction({ address, itemDescription: item, createdAt: Date.now() });
      setDeployedAddress(address);
      setStatus('done');
      onCreated(address);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  if (wallet.status !== 'connected') {
    return <p>Connect your wallet to create an auction.</p>;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Item description
        <input value={item} onChange={(e) => setItem(e.target.value)} required />
      </label>
      <label>
        Minimum bid
        <input type="number" min="0" value={minBid} onChange={(e) => setMinBid(e.target.value)} required />
      </label>
      <label>
        Minimum increment
        <input type="number" min="1" value={minIncrement} onChange={(e) => setMinIncrement(e.target.value)} required />
      </label>
      <label>
        Bidding window (minutes)
        <input type="number" min="1" value={biddingMinutes} onChange={(e) => setBiddingMinutes(e.target.value)} required />
      </label>
      <label>
        Settlement window (minutes)
        <input type="number" min="1" value={settlementMinutes} onChange={(e) => setSettlementMinutes(e.target.value)} required />
      </label>
      <button type="submit" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Deploying…' : 'Create auction'}
      </button>
      {status === 'done' && deployedAddress && (
        <p>Auction deployed at <code>{deployedAddress}</code>. Proof generation runs on your machine and can take a few minutes.</p>
      )}
      {status === 'error' && <p role="alert">{error}</p>}
    </form>
  );
}
