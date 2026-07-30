import { useEffect, useState, type MouseEvent } from 'react';
import { useWallet, shortenAddress } from './wallet';
import { ScrollScene } from './ScrollScene';
import { AppPage } from './views/AppPage';

type Page = 'landing' | 'app';

const pageFromPath = (path: string): Page => (path.startsWith('/app') ? 'app' : 'landing');

function App() {
  const wallet = useWallet();
  const [page, setPage] = useState<Page>(() => pageFromPath(window.location.pathname));
  // A landing section to scroll to once the landing view is in the DOM.
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);

  // Back/forward buttons.
  useEffect(() => {
    const onPop = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Landing anchors (#story) only exist while the landing view is rendered,
  // so honor a pending scroll after the page swap has committed.
  useEffect(() => {
    if (page !== 'landing' || !scrollTarget) return;
    document.querySelector(scrollTarget)?.scrollIntoView({ behavior: 'smooth' });
    setScrollTarget(null);
  }, [page, scrollTarget]);

  // Client-side navigation without a router dependency: push the real path
  // (so /app is its own page with its own URL, not a one-page section) and
  // swap the view in place.
  const go = (path: string, anchor?: string) => (e: MouseEvent) => {
    e.preventDefault();
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setPage(pageFromPath(path));
    if (anchor) setScrollTarget(anchor);
    else window.scrollTo(0, 0);
  };

  return (
    <>
      <header className="site-header">
        <a className="wordmark" href="/" onClick={go('/')}>Gavel</a>
        <nav>
          <a href="/" aria-current={page === 'landing' ? 'page' : undefined} onClick={go('/', '#story')}>Story</a>
          <a href="/app" aria-current={page === 'app' ? 'page' : undefined} onClick={go('/app')}>App</a>
        </nav>
        <div className="wallet-slot">
          {wallet.status === 'connected' && wallet.address ? (
            <>
              <span className="address">{wallet.walletName}: {shortenAddress(wallet.address)}</span>
              <button type="button" onClick={wallet.disconnect}>Disconnect</button>
            </>
          ) : (
            <button type="button" onClick={wallet.connect} disabled={wallet.status === 'connecting'}>
              {wallet.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
            </button>
          )}
          {(wallet.status === 'error' || wallet.status === 'network-mismatch') && wallet.error ? (
            <span className="wallet-error" role="alert">{wallet.error}</span>
          ) : null}
        </div>
      </header>

      {page === 'app' ? (
        <AppPage wallet={wallet} />
      ) : (
        <main id="top">
          <section className="hero">
            <img className="hero-art" src="/art.jpg" alt="Seventeenth-century auction house: officials around a table, one raising a gavel" />
            <div className="hero-veil" />
            <div className="hero-copy">
              <h1 className="reveal r2">
                Every bid a secret.<br />
                Every verdict <em>provable</em>.
              </h1>
              <div className="hero-actions reveal r4">
                <a className="button button-primary" href="/app" onClick={go('/app')}>Open the app</a>
                <a className="button" href="/" onClick={go('/', '#story')}>See how it works</a>
              </div>
            </div>
            <div className="scroll-cue reveal r5">Scroll</div>
          </section>

          <ScrollScene />

          <section className="mission">
            <p className="kicker">Why Gavel exists</p>
            <h2>Auctions run on information. Today that information only flows one way.</h2>
            <p>
              Sellers, platforms, and front-runners see everything; bidders reveal
              everything. Gavel inverts that. Built on the Midnight Network, it keeps
              each bid inside a zero-knowledge commitment, so the chain can rank bids
              and crown a winner without any human or any server ever reading them.
            </p>
            <div className="mission-grid">
              <article>
                <h3>Sealed forever</h3>
                <p>
                  Losing bids are never revealed. Not to the seller, not to other
                  bidders, not after settlement. What you were willing to pay stays
                  yours.
                </p>
              </article>
              <article>
                <h3>Provably fair</h3>
                <p>
                  The winner and the final price come with a zero-knowledge proof.
                  You do not trust the auctioneer. You check the math.
                </p>
              </article>
              <article>
                <h3>No trusted hand</h3>
                <p>
                  The contract is the auctioneer. Nobody holds the envelopes, so
                  nobody can peek, leak, or play favorites.
                </p>
              </article>
            </div>
          </section>
        </main>
      )}

      <footer>
        <span className="wordmark">Gavel</span>
        <span>Sealed-bid auctions on the Midnight Network</span>
      </footer>
    </>
  );
}

export default App;
