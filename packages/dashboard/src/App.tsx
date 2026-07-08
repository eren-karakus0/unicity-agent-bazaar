import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import { useAuth, displayName } from './lib/auth';
import { useNotifications } from './lib/notifications';
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
            <NotificationsBell />
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
          <b>Unicity Agent Bazaar</b> - hire an agent, pay on delivery.
        </span>
        <span>escrow-settled on testnet2 · SDK-only · $0</span>
      </footer>
    </>
  );
}

function NotificationsBell() {
  const { phase } = useAuth();
  const { items, unread, markAllRead, clear } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (phase !== 'authenticated') return null;

  const toggle = () => {
    setOpen((o) => {
      if (!o && unread > 0) markAllRead();
      return !o;
    });
  };

  return (
    <div className="bell" ref={ref}>
      <button
        className={`bell__btn${unread > 0 ? ' bell__btn--alert' : ''}`}
        onClick={toggle}
        aria-label={`notifications${unread > 0 ? `, ${unread} unread` : ''}`}
      >
        🔔{unread > 0 && <span className="bell__count">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="bell__menu">
          <div className="bell__head">
            <span>Notifications</span>
            {items.length > 0 && (
              <button className="bell__clear" onClick={clear}>
                clear
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="bell__empty">You&rsquo;re all caught up.</div>
          ) : (
            <ul className="bell__list">
              {items.map((n) => (
                <li
                  key={n.id}
                  className="bell__item"
                  onClick={() => {
                    setOpen(false);
                    go('/profile');
                  }}
                >
                  <div className="bell__t">{n.title}</div>
                  <div className="bell__b">{n.body}</div>
                  <div className="bell__time">{timeAgo(n.at)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function timeAgo(at: number): string {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
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
