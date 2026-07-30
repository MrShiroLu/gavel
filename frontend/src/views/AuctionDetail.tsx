import { useEffect, useState } from 'react';
import type { useWallet } from '../wallet';
import { configureProviders, createBrowserWalletProvider, getUnshieldedUserAddress, joinAuctionContract, readAuctionState, pureCircuits, type AuctionLedger } from '../midnight';
import { getOrCreateBidderPrivateState, storeBid, getStoredBid, peekBidderSecret } from '../privateState';
import { auctionStateName, toHex, addressToClaimTicket } from '../auctionState';

type Wallet = ReturnType<typeof useWallet>;

// midnight-js wraps submit/execute failures in "Unexpected error
// (executing|submitting) scoped transaction '...': <String(err)>" via
// `new Error(msg, { cause: err })" — when the inner err is itself a bare
// Error with no message, String(err) is just "Error" and the real reason
// (e.g. the wallet's actual rejection reason) only lives in .cause. Walk the
// chain so matching/display sees the innermost message, not the wrapper.
const collectMessages = (err: unknown): string[] => {
  const messages: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    if (current.message) messages.push(current.message);
    current = current.cause;
  }
  if (messages.length === 0) messages.push(String(err));
  return messages;
};

// Turn raw contract asserts into something a person can act on.
const friendlyError = (err: unknown): string => {
  const messages = collectMessages(err);
  const raw = messages.join(' | ');
  if (raw.includes('already has an active bid'))
    return 'This wallet has already placed a sealed bid on this auction. Each wallet may bid once.';
  if (raw.includes('Only the seller can open bidding'))
    return 'Only the wallet that created this auction can open bidding.';
  if (raw.includes('Only the seller can claim proceeds'))
    return 'Only the wallet that created this auction can withdraw the proceeds.';
  if (raw.includes('Caller is not the recorded leader'))
    return 'Only the winning bidder can finalize and pay the winning amount.';
  if (/insufficient|not enough|balance/i.test(raw))
    return 'Your wallet does not have enough tDUST to cover the winning amount plus fees.';
  if (raw.includes('Bidding deadline has passed')) return 'The bidding window for this auction has closed.';
  if (raw.includes('Settlement window has closed')) return 'The settlement window for this auction has closed.';
  if (raw.includes('Bid below auction floor')) return 'Your revealed bid is below this auction’s minimum bid.';
  if (raw.includes('Amount/nonce do not match stored commitment'))
    return 'This wallet’s saved bid does not match what was submitted on chain. It may have been placed from a different browser.';
  if (raw.includes('Seller cannot bid on their own auction')) return 'The seller cannot bid on their own auction.';
  if (raw.includes('Failed to fetch') || raw.includes('ERR_CONNECTION_REFUSED'))
    return 'Cannot reach the proof server (127.0.0.1:6300). Start it with "docker compose up -d proof-server" and try again.';
  // No known pattern matched — show the innermost (most specific) message
  // instead of the outer "...': Error" wrapper, which is usually empty.
  return messages[messages.length - 1];
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
  const [copied, setCopied] = useState(false);
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
    const id = setInterval(() => setNow(Date.now()), 1000);
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
      console.error(err);
      setError(friendlyError(err));
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
    });

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
    }, 'You paid the winning amount into escrow. The seller can now withdraw it.');

  const claimProceeds = () =>
    run(async (contract) => {
      if (!wallet.api) throw new Error('Wallet unavailable.');
      const sellerAddress = await getUnshieldedUserAddress(wallet.api);
      await contract.callTx.claimProceeds(sellerAddress);
    }, 'The winning amount was sent to your wallet.');

  const stateName = auctionStateName(ledger.state);
  const nowSeconds = BigInt(Math.floor(now / 1000));
  const biddingDeadlinePassed = nowSeconds >= ledger.biddingDeadline;
  const settlementDeadlinePassed = nowSeconds >= ledger.settlementDeadline;
  const disabled = busy || wallet.status !== 'connected';
  const myStoredBid = accountId ? getStoredBid(accountId, address) : null;
  const alreadyBid = !!myStoredBid;

  // Is the connected wallet the seller / the current settlement leader /
  // already settled? deriveBidderId of its stored secret matches
  // sellerId / currentLeaderId / a member of the on-chain settled set.
  const mySecret = accountId ? peekBidderSecret(accountId, address) : null;
  const myBidderIdBytes = mySecret ? pureCircuits.deriveBidderId(mySecret) : null;
  const myBidderId = myBidderIdBytes ? toHex(myBidderIdBytes) : null;
  const isSeller = myBidderId === toHex(ledger.sellerId);
  const isWinner = !!(myBidderId && myBidderId === toHex(ledger.currentLeaderId));
  const alreadySettled = !!(myBidderIdBytes && ledger.settled.member(myBidderIdBytes));
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
        <span className="copy-wrap">
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(address).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            Copy address
          </button>
          {copied && (
            <span className="copied-bubble" role="status">
              Copied. Share it so others can join.
            </span>
          )}
        </span>
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
        <dt>Bidding deadline</dt>
        <dd>{new Date(Number(ledger.biddingDeadline) * 1000).toLocaleString()}</dd>
        <dt>Settlement deadline</dt>
        <dd>{new Date(Number(ledger.settlementDeadline) * 1000).toLocaleString()}</dd>
        {myStoredBid && (
          <>
            <dt className="stat-key">Your bid</dt>
            <dd className="stat-value">{myStoredBid.amount.toString()}</dd>
          </>
        )}
        {(ledger.state === 2 || ledger.state === 3) && (
          <>
            <dt className="stat-key">{ledger.state === 3 ? 'Winning bid' : 'Highest revealed bid'}</dt>
            <dd className="stat-value">{ledger.currentMaxAmount.toString()}</dd>
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
      {stateName === 'Created' && isSeller && (
        <button type="button" disabled={disabled} onClick={() => run((c) => c.callTx.openBidding(), 'Bidding is now open.')}>
          Open bidding
        </button>
      )}

      {stateName === 'Bidding' && !biddingDeadlinePassed && !isSeller && alreadyBid && (
        <p className="notice">Your sealed bid is recorded. You can settle it once the bidding window closes.</p>
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
            <input type="number" min={ledger.minBid.toString()} value={bidAmount} onChange={(e) => setBidAmount(e.target.value)} required />
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

      {stateName === 'SettlementWindow' && !settlementDeadlinePassed && !isSeller && alreadyBid && !alreadySettled && (
        <button type="button" disabled={disabled} onClick={() => void settleMyBid()}>
          Settle my bid
        </button>
      )}

      {stateName === 'SettlementWindow' && !isSeller && alreadySettled && !isWinner && !settlementDeadlinePassed && (
        <p className="notice">Your bid was revealed. Waiting to see if it holds as the highest.</p>
      )}

      {stateName === 'SettlementWindow' && !isSeller && alreadySettled && !isWinner && settlementDeadlinePassed && (
        <p className="notice">Your bid was revealed but did not win. The winner still needs to finalize and pay into escrow.</p>
      )}

      {stateName === 'SettlementWindow' && settlementDeadlinePassed && isWinner && (
        <button type="button" disabled={disabled} onClick={() => void finalize()}>
          Pay winning amount &amp; finalize
        </button>
      )}

      {stateName === 'Settled' && isSeller && !ledger.proceedsClaimed && (
        <button type="button" disabled={disabled} onClick={() => void claimProceeds()}>
          Withdraw proceeds ({ledger.currentMaxAmount.toString()})
        </button>
      )}

      {stateName === 'Settled' && ledger.proceedsClaimed && (
        <p className="notice">The seller has withdrawn the winning amount from escrow.</p>
      )}

        <button type="button" onClick={() => void refresh()}>Refresh</button>
      </div>

      {notice && <p className="notice" role="status">{notice}</p>}
    </div>
  );
}
