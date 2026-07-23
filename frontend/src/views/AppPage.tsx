import { useState } from 'react';
import type { useWallet } from '../wallet';
import { AuctionList } from './AuctionList';
import { AuctionDetail } from './AuctionDetail';
import { CreateAuction } from './CreateAuction';

type Wallet = ReturnType<typeof useWallet>;
type View = 'list' | 'detail' | 'create';

const TABS: { id: View; label: string }[] = [
  { id: 'list', label: 'Auctions' },
  { id: 'detail', label: 'Detail' },
  { id: 'create', label: 'Create' },
];

export function AppPage({ wallet }: { wallet: Wallet }) {
  const [view, setView] = useState<View>('list');
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  return (
    <main className="app-section">
      <p className="kicker">The auction house</p>
      <h2>Take a seat at the table</h2>

      <div className="app-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            onClick={() => setView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="app-panel">
        {view === 'list' && (
          <AuctionList
            onSelect={(address) => {
              setSelectedAddress(address);
              setView('detail');
            }}
          />
        )}
        {view === 'detail' && <AuctionDetail wallet={wallet} address={selectedAddress} />}
        {view === 'create' && (
          <CreateAuction
            wallet={wallet}
            onCreated={(address) => {
              setSelectedAddress(address);
              setView('detail');
            }}
          />
        )}
      </div>
    </main>
  );
}
