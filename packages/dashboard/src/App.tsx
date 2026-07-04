import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { useAuth, displayName } from './lib/auth';
import { go } from './lib/nav';
import { Marketplace } from './Marketplace';
import { Publish } from './Publish';
import { Profile } from './Profile';

type Route =
  | { name: 'market' }
  | { name: 'publish' }
  | { name: 'profile'; principal: string | null };

function parseHash(): Route {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('/publish')) return { name: 'publish' };
  if (h.startsWith('/agent/')) return { name: 'profile', principal: decodeURIComponent(h.slice('/agent/'.length)) };
  if (h.startsWith('/profile')) return { name: 'profile', principal: null };
  return { name: 'market' };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Adaptive health poll: while the backend is down (the free tier sleeps and
  // takes ~30s to wake), retry quickly; once up, back off.
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      let ready = false;
      try {
        ready = (await api.health()).ready;
      } catch {
        ready = false;
      }
      if (stopped) return;
      setOnline(ready);
      timer = window.setTimeout(tick, ready ? 15_000 : 5_000);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <header className="hdr">
        <div className="wrap hdr__in">
          <div className="brand" onClick={() => go('/')} style={{ cursor: 'pointer' }}>
            <span className="brand__mark">B</span>
            <span className="brand__name">
              AGENT <em>BAZAAR</em>
            </span>
          </div>
          <span className={`hdr__net${online === false ? ' hdr__net--wake' : ''}`}>
            {online === null ? (
              'connecting…'
            ) : online ? (
              <>
                unicity <b>testnet2</b> · online
              </>
            ) : (
              'waking the bazaar…'
            )}
          </span>
          <nav className="hdr__nav">
            <button
              className={`navlink${route.name === 'market' ? ' navlink--on' : ''}`}
              onClick={() => go('/')}
            >
              marketplace
            </button>
            <button
              className={`navlink${route.name === 'publish' ? ' navlink--on' : ''}`}
              onClick={() => go('/publish')}
            >
              publish agent
            </button>
            <AccountChip active={route.name === 'profile' && route.principal === null} />
          </nav>
        </div>
      </header>

      <main className="wrap">
        <div
          className="page"
          key={route.name === 'profile' ? `profile:${route.principal ?? 'me'}` : route.name}
        >
          {route.name === 'market' && <Marketplace online={online} />}
          {route.name === 'publish' && <Publish />}
          {route.name === 'profile' && <Profile principal={route.principal} />}
        </div>
      </main>

      <footer className="wrap foot">
        <span>
          <b>Unicity Agent Bazaar</b> — hire an agent, pay on delivery.
        </span>
        <span>escrow-settled on testnet2 · SDK-only · $0</span>
      </footer>
    </>
  );
}

function AccountChip({ active }: { active: boolean }) {
  const { session, phase, balance, signIn, signOut } = useAuth();

  if (phase === 'authenticated' && session) {
    return (
      <div className="acct">
        {balance !== null && (
          <span className="acct__bal" title="your confirmed UCT balance">
            {balance} <em>UCT</em>
          </span>
        )}
        <button
          className={`acct__id${active ? ' acct__id--on' : ''}`}
          title={session.chainPubkey}
          onClick={() => go('/profile')}
        >
          <span className="acct__dot" />
          {displayName(session)}
        </button>
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
