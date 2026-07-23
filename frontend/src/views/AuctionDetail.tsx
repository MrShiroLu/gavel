import { useEffect, useState } from 'react';
import type { useWallet } from '../wallet';
import { configureProviders, createBrowserWalletProvider, joinAuctionContract, readAuctionState, pureCircuits, type AuctionLedger } from '../midnight';
import { getOrCreateBidderPrivateState, storeBid, getStoredBid, peekBidderSecret } from '../privateState';
import { auctionStateName, toHex, addressToClaimTicket } from '../auctionState';

type Wallet = ReturnType<typeof useWallet>;

// Turn raw contract asserts into something a person can act on.
const friendlyError = (raw: string): string => {
  if (raw.includes('already has an active bid'))
    return 'This wallet has already placed a sealed bid on this auction. Each wallet may bid once.';
  if (raw.includes('Only the seller can open bidding'))
    return 'Only the wallet that created this auction can open bidding.';
  if (raw.includes('Bidding deadline has passed')) return 'The bidding window for this auction has closed.';
  if (raw.includes('Settlement deadline has passed')) return 'The settlement window for this auction has closed.';
  if (raw.includes('Failed to fetch') || raw.includes('ERR_CONNECTION_REFUSED'))
    return 'Cannot reach the proof server (127.0.0.1:6300). Start it with "docker compose up -d proof-server" and try again.';
  return raw;
};

// mm:ss remaining until a wall-clock deadline (both in seconds).
const formatCountdown = (targetSeconds: bigint, nowSeconds: bigint): string => {
  const remaining = Number(targetSeconds - nowSeconds);
  if (remaining <= 0) return '0:00';
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const PHASES = ['Created', 'Bidding', 'Settlement', 'Settled'] as const;

export function AuctionDetail({ wallet, address }: { wallet: Wallet; address: string | null }) {
  const [ledger, setLedger] = useState<AuctionLedger | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bidAmount, setBidAmount] = useState('');
  const [now, setNow] = useState(() => Date.now());
  // The wallet's coin public key, used to look up whether this wallet has
  // already bid on this auction (bids are remembered locally by account).
  const [accountId, setAccountId] = useState<string | null>(null);

  const refresh = async () => {
    if (!address) return;
    setStatus('loading');
    try {
      setLedger(await readAuctionState(address));
      setStatus('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // Resolve this wallet's account id (cheap: no proof, no contract join) so we
  // can tell, on load, whether it has already bid here.
  useEffect(() => {
    let cancelled = false;
    if (!wallet.api || !address) {
      setAccountId(null);
      return;
    }
    createBrowserWalletProvider(wallet.api)
      .then((wp) => {
        if (!cancelled) setAccountId(wp.getCoinPublicKey());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wallet.api, address]);

  // Deadlines are wall-clock, not on-chain events — without this the
  // "Close bidding" / "Finalize" buttons stay hidden after the deadline
  // passes until something else happens to force a re-render.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  if (!address) return <p>No auction selected. Pick one from the Auctions tab, or create one.</p>;
  if (status === 'loading' && !ledger) return <p>Loading auction…</p>;
  if (status === 'error') return <p role="alert">Could not load auction state: {error}</p>;
  if (!ledger) return <p>Auction not found at this address.</p>;

  type JoinedContract = Awaited<ReturnType<typeof joinAuctionContract>>;
  const run = async (
    action: (contract: JoinedContract, accountId: string) => Promise<unknown>,
    successNotice?: string,
  ) => {
    if (!wallet.api) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const providers = await configureProviders(wallet.api);
      const account = providers.walletProvider.getCoinPublicKey();
      setAccountId(account);
      const privateState = getOrCreateBidderPrivateState(account, address);
      const contract = await joinAuctionContract(providers, privateState, address);
      await action(contract, account);
      await refresh();
      if (successNotice) setNotice(successNotice);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const submitBid = () =>
    run(async (contract, account) => {
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const amount = BigInt(bidAmount);
      const commitment = pureCircuits.computeCommitment(amount, nonce);
      await contract.callTx.submitBid(commitment);
      storeBid(account, address, amount, nonce);
    }, 'Your sealed bid was recorded on chain. It stays secret until you settle it.');

  const settleMyBid = () =>
    run(async (contract, account) => {
      const stored = getStoredBid(account, address);
      if (!stored) throw new Error('No locally remembered bid to settle for this wallet.');
      await contract.callTx.settleBid(stored.amount, stored.nonce);
    }, 'Your bid was revealed to the settlement circuit.');

  const finalize = () =>
    run(async (contract) => {
      if (!wallet.address) throw new Error('Wallet address unavailable.');
      const claimTicket = await addressToClaimTicket(wallet.address);
      await contract.callTx.finalizeSettlement(claimTicket);
    }, 'Settlement finalized.');

  const stateName = auctionStateName(ledger.state);
  const nowSeconds = BigInt(Math.floor(now / 1000));
  const biddingDeadlinePassed = nowSeconds >= ledger.biddingDeadline;
  const settlementDeadlinePassed = nowSeconds >= ledger.settlementDeadline;
  const disabled = busy || wallet.status !== 'connected';
  const alreadyBid = !!(accountId && getStoredBid(accountId, address));

  // Is the connected wallet the seller? deriveBidderId of its stored secret
  // matches the sellerId the contract recorded at deploy.
  const sellerSecret = accountId ? peekBidderSecret(accountId, address) : null;
  const isSeller = !!(sellerSecret && toHex(pureCircuits.deriveBidderId(sellerSecret)) === toHex(ledger.sellerId));
  const roleLabel = isSeller ? 'You are the seller' : alreadyBid ? 'You have placed a sealed bid' : null;

  const countdown =
    stateName === 'Bidding' && !biddingDeadlinePassed
      ? `Bidding closes in ${formatCountdown(ledger.biddingDeadline, nowSeconds)}`
      : stateName === 'SettlementWindow' && !settlementDeadlinePassed
        ? `Settlement closes in ${formatCountdown(ledger.settlementDeadline, nowSeconds)}`
        : null;

  return (
    <div>
      <h2>Auction {address.slice(0, 10)}…</h2>
      <p className="contract-address">
        <code>{address}</code>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(address).then(() => setNotice('Contract address copied. Share it so others can join.'))}>
          Copy address
        </button>
      </p>

      {(roleLabel || countdown) && (
        <p className="role-line">
          {roleLabel && <span className="role-badge">{roleLabel}</span>}
          {countdown && <span className="countdown">{countdown}</span>}
        </p>
      )}

      <ol className="phase-stepper" aria-label="Auction progress">
        {PHASES.map((label, i) => (
          <li
            key={label}
            className={ledger.state === 4 ? 'skip' : i < ledger.state ? 'done' : i === ledger.state ? 'current' : ''}
          >
            {label}
          </li>
        ))}
      </ol>
      {ledger.state === 4 && <p className="notice">This auction was cancelled (no bids).</p>}

      <dl>
        <dt>State</dt>
        <dd>{stateName}</dd>
        <dt>Bids received</dt>
        <dd>{ledger.bidCount.toString()}</dd>
        <dt>Minimum bid</dt>
        <dd>{ledger.minBid.toString()}</dd>
        <dt>Minimum increment</dt>
        <dd>{ledger.minIncrement.toString()}</dd>
        <dt>Bidding deadline</dt>
        <dd>{new Date(Number(ledger.biddingDeadline) * 1000).toLocaleString()}</dd>
        <dt>Settlement deadline</dt>
        <dd>{new Date(Number(ledger.settlementDeadline) * 1000).toLocaleString()}</dd>
        {ledger.state >= 2 && (
          <>
            <dt>Running maximum (leak — PLAN.md section 4)</dt>
            <dd>{ledger.currentMaxAmount.toString()}</dd>
          </>
        )}
        {ledger.state === 3 && (
          <>
            <dt>Winner claim ticket</dt>
            <dd>{toHex(ledger.winnerAddress)}</dd>
          </>
        )}
      </dl>

      {busy && <p>Working… this generates a zero-knowledge proof on your machine and can take a few minutes.</p>}
      {error && <p role="alert">{error}</p>}

      <div className="detail-actions">
      {stateName === 'Created' && (
        <button type="button" disabled={disabled} onClick={() => run((c) => c.callTx.openBidding(), 'Bidding is now open.')}>
          Open bidding
        </button>
      )}

      {stateName === 'Bidding' && !biddingDeadlinePassed && isSeller && (
        <p className="notice">You opened this auction. A seller cannot bid on their own auction; wait for the bidding window to close, then close bidding.</p>
      )}

      {stateName === 'Bidding' && !biddingDeadlinePassed && !isSeller && alreadyBid && (
        <p className="notice">You have already placed a sealed bid on this auction. Each wallet may bid once; settle it during the settlement window.</p>
      )}

      {stateName === 'Bidding' && !biddingDeadlinePassed && !isSeller && !alreadyBid && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitBid();
          }}
        >
          <label>
            Your sealed bid
            <input type="number" min="0" value={bidAmount} onChange={(e) => setBidAmount(e.target.value)} required />
          </label>
          <button type="submit" disabled={disabled}>Submit sealed bid</button>
        </form>
      )}

      {stateName === 'Bidding' && biddingDeadlinePassed && ledger.bidCount > 0n && (
        <button type="button" disabled={disabled} onClick={() => run((c) => c.callTx.closeBidding(), 'Bidding closed. Settlement window is open.')}>
          Close bidding
        </button>
      )}

      {stateName === 'Bidding' && biddingDeadlinePassed && ledger.bidCount === 0n && (
        <button type="button" disabled={disabled} onClick={() => run((c) => c.callTx.cancelAuction(), 'Auction cancelled (no bids).')}>
          Cancel (no bids)
        </button>
      )}

      {stateName === 'SettlementWindow' && !settlementDeadlinePassed && (
        <button type="button" disabled={disabled} onClick={() => void settleMyBid()}>
          Settle my bid
        </button>
      )}

      {stateName === 'SettlementWindow' && settlementDeadlinePassed && (
        <button type="button" disabled={disabled} onClick={() => void finalize()}>
          Finalize as leader
        </button>
      )}

        <button type="button" onClick={() => void refresh()}>Refresh</button>
      </div>

      {notice && <p className="notice" role="status">{notice}</p>}
    </div>
  );
}
