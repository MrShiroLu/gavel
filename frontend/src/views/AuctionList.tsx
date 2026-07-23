import { useEffect, useState } from 'react';
import { readAuctionState, type AuctionLedger } from '../midnight';
import { listAuctions, addAuction, type AuctionRecord } from '../auctionRegistry';
import { auctionStateName } from '../auctionState';

type Row = AuctionRecord & { ledger: AuctionLedger | null };

export function AuctionList({ onSelect }: { onSelect: (address: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [openAddr, setOpenAddr] = useState('');
  const [opening, setOpening] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);

  useEffect(() => {
    const records = listAuctions();
    if (records.length === 0) {
      setStatus('loaded');
      return;
    }
    setStatus('loading');
    Promise.all(
      records.map(async (record) => ({ ...record, ledger: await readAuctionState(record.address).catch(() => null) })),
    )
      .then(setRows)
      .then(() => setStatus('loaded'));
  }, []);

  // The registry is local to this browser, so a bidder joining an auction
  // created elsewhere pastes its contract address here. We confirm it exists
  // on chain before remembering it, then hand off to the detail view.
  const openByAddress = async () => {
    const address = openAddr.trim();
    if (!address) return;
    setOpening(true);
    setOpenErr(null);
    try {
      const ledger = await readAuctionState(address);
      if (!ledger) {
        setOpenErr('No auction found at this address on Preprod.');
        return;
      }
      addAuction({ address, itemDescription: '(opened by address)', createdAt: Date.now() });
      setOpenAddr('');
      onSelect(address);
    } catch (err) {
      setOpenErr(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div>
      <form
        className="open-by-address"
        onSubmit={(e) => {
          e.preventDefault();
          void openByAddress();
        }}
      >
        <label>
          Open an auction by contract address
          <input
            value={openAddr}
            onChange={(e) => setOpenAddr(e.target.value)}
            placeholder="Paste a contract address to join an auction"
          />
        </label>
        <button type="submit" disabled={opening || !openAddr.trim()}>
          {opening ? 'Opening…' : 'Open'}
        </button>
        {openErr && <p role="alert">{openErr}</p>}
      </form>

      {status !== 'loaded' ? (
        <p>Loading auctions…</p>
      ) : rows.length === 0 ? (
        <p>No auctions yet on this browser. Create one, or open an existing one by address above.</p>
      ) : (
        <ul className="auction-grid">
          {rows.map((row) => (
            <li key={row.address}>
              <strong>{row.itemDescription || '(no description)'}</strong>
              <p>
                {row.ledger ? auctionStateName(row.ledger.state) : 'not found on chain'} — {row.address.slice(0, 10)}…
              </p>
              <button type="button" onClick={() => onSelect(row.address)}>
                View
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
