import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { useAuth, displayName } from './lib/auth';
import { Marketplace } from './Marketplace';
import { Publish } from './Publish';

type View = 'market' | 'publish';

export function App() {
  const [view, setView] = useState<View>(() => (location.hash === '#/publish' ? 'publish' : 'market'));
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const check = () =>
      api
        .health()
        .then((h) => setOnline(h.ready))
        .catch(() => setOnline(false));
    check();
    const t = window.setInterval(check, 15_000);
    return () => window.clearInterval(t);
  }, []);

  const go = (v: View) => {
    setView(v);
    location.hash = v === 'publish' ? '#/publish' : '#/';
  };

  return (
    <>
      <header className="hdr">
        <div className="wrap hdr__in">
          <div className="brand" onClick={() => go('market')} style={{ cursor: 'pointer' }}>
            <span className="brand__mark">B</span>
            <span className="brand__name">
              AGENT <em>BAZAAR</em>
            </span>
          </div>
          <span className="hdr__net">
            {online === null ? 'connecting…' : online ? (
              <>
                unicity <b>testnet2</b> · online
              </>
            ) : (
              'backend offline'
            )}
          </span>
          <nav className="hdr__nav">
            <button className={`navlink${view === 'market' ? ' navlink--on' : ''}`} onClick={() => go('market')}>
              marketplace
            </button>
            <button className={`navlink${view === 'publish' ? ' navlink--on' : ''}`} onClick={() => go('publish')}>
              publish agent
            </button>
            <AccountChip />
          </nav>
        </div>
      </header>

      <main className="wrap">{view === 'market' ? <Marketplace online={online} /> : <Publish />}</main>

      <footer className="wrap foot">
        <span>
          <b>Unicity Agent Bazaar</b> — hire an agent, pay on delivery.
        </span>
        <span>escrow-settled on testnet2 · SDK-only · $0</span>
      </footer>
    </>
  );
}

function AccountChip() {
  const { session, phase, signIn, signOut } = useAuth();

  if (phase === 'authenticated' && session) {
    return (
      <div className="acct">
        <span className="acct__id" title={session.chainPubkey}>
          <span className="acct__dot" />
          {displayName(session)}
        </span>
        <button className="acct__out" onClick={() => void signOut()}>
          sign out
        </button>
      </div>
    );
  }

  return (
    <button
      className="btn btn--primary btn--sm"
      disabled={phase === 'signing-in'}
      onClick={() => void signIn()}
    >
      {phase === 'signing-in' ? 'signing in…' : 'Connect wallet'}
    </button>
  );
}
