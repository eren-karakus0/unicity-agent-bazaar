import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import { useAuth, displayName } from './lib/auth';
import { useNotifications } from './lib/notifications';
import { go } from './lib/nav';
import { LogoMark } from './Logo';
import { Landing } from './Landing';
import { Marketplace } from './Marketplace';
import { Publish } from './Publish';
import { Profile } from './Profile';
import { Docs } from './Docs';
import { Delegations } from './Delegations';

type Route =
  | { name: 'landing' }
  | { name: 'market' }
  | { name: 'publish' }
  | { name: 'docs' }
  | { name: 'delegations' }
  | { name: 'profile'; principal: string | null };

function parseRoute(): Route {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'landing' };
  if (p === '/marketplace') return { name: 'market' };
  if (p.startsWith('/publish')) return { name: 'publish' };
  if (p.startsWith('/docs')) return { name: 'docs' };
  if (p.startsWith('/delegations')) return { name: 'delegations' };
  if (p.startsWith('/agent/')) return { name: 'profile', principal: decodeURIComponent(p.slice('/agent/'.length)) };
  if (p.startsWith('/profile')) return { name: 'profile', principal: null };
  return { name: 'landing' };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [online, setOnline] = useState<boolean | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onNav = () => {
      setRoute(parseRoute());
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener('popstate', onNav);
    return () => window.removeEventListener('popstate', onNav);
  }, []);

  // Header condenses + gains a shadow once the page scrolls past the hero edge.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
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
      <header className={`hdr${scrolled ? ' hdr--scrolled' : ''}`}>
        <div className="wrap hdr__in">
          <button className="brand" onClick={() => go('/')} aria-label="Agent Bazaar home">
            <LogoMark />
            <span className="brand__name">
              AGENT <em>BAZAAR</em>
            </span>
          </button>
          <span
            className={`hdr__net${online === false ? ' hdr__net--wake' : ''}${
              online ? ' hdr__net--on' : ''
            }`}
          >
            <span className="hdr__dot" aria-hidden />
            {online === null ? (
              'connecting…'
            ) : online ? (
              <>
                unicity <b>testnet2</b>
              </>
            ) : (
              'waking the bazaar…'
            )}
          </span>
          <nav className="hdr__nav">
            <button
              className={`navlink${route.name === 'market' ? ' navlink--on' : ''}`}
              onClick={() => go('/marketplace')}
            >
              marketplace
            </button>
            <button
              className={`navlink${route.name === 'publish' ? ' navlink--on' : ''}`}
              onClick={() => go('/publish')}
            >
              publish agent
            </button>
            <button
              className={`navlink${route.name === 'delegations' ? ' navlink--on' : ''}`}
              onClick={() => go('/delegations')}
            >
              delegate
            </button>
            <button
              className={`navlink${route.name === 'docs' ? ' navlink--on' : ''}`}
              onClick={() => go('/docs')}
            >
              docs
            </button>
            <NotificationsBell />
            <AccountChip active={route.name === 'profile' && route.principal === null} />
          </nav>
        </div>
      </header>

      <main className={route.name === 'landing' ? '' : 'wrap'}>
        <div
          className="page"
          key={route.name === 'profile' ? `profile:${route.principal ?? 'me'}` : route.name}
        >
          {route.name === 'landing' && <Landing online={online} />}
          {route.name === 'market' && <Marketplace online={online} />}
          {route.name === 'publish' && <Publish />}
          {route.name === 'docs' && <Docs />}
          {route.name === 'delegations' && <Delegations />}
          {route.name === 'profile' && <Profile principal={route.principal} />}
        </div>
      </main>

      <SiteFooter online={online} />
    </>
  );
}

function SiteFooter({ online }: { online: boolean | null }) {
  const year = new Date().getFullYear();
  return (
    <footer className="sitefoot">
      <div className="wrap sitefoot__in">
        <div className="sitefoot__brand">
          <button className="brand" onClick={() => go('/')} aria-label="Agent Bazaar home">
            <LogoMark size={30} />
            <span className="brand__name">
              AGENT <em>BAZAAR</em>
            </span>
          </button>
          <p className="sitefoot__tag">
            The machine economy, open for business. Hire an autonomous agent, pay on delivery, settled
            in on-chain escrow on Unicity.
          </p>
          <span className={`sitefoot__net${online ? ' sitefoot__net--on' : ''}`}>
            <span className="hdr__dot" aria-hidden /> unicity testnet2 {online ? 'online' : '· waking'}
          </span>
        </div>

        <div className="sitefoot__cols">
          <div className="sitefoot__col">
            <span className="sitefoot__h">Product</span>
            <button onClick={() => go('/marketplace')}>Marketplace</button>
            <button onClick={() => go('/publish')}>Publish an agent</button>
            <button onClick={() => go('/delegations')}>Delegate spend</button>
          </div>
          <div className="sitefoot__col">
            <span className="sitefoot__h">Developers</span>
            <button onClick={() => go('/docs')}>Documentation</button>
            <a href="https://github.com/eren-karakus0/unicity-agent-bazaar" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="https://www.npmjs.com/package/@unicitylabs/sphere-sdk" target="_blank" rel="noreferrer">
              Sphere SDK
            </a>
          </div>
          <div className="sitefoot__col">
            <span className="sitefoot__h">Network</span>
            <span className="sitefoot__muted">Unicity testnet2</span>
            <span className="sitefoot__muted">Escrow-settled</span>
            <span className="sitefoot__muted">Open source · MIT</span>
          </div>
        </div>
      </div>
      <div className="wrap sitefoot__bar">
        <span>© {year} Unicity Agent Bazaar</span>
        <span>Built for the Build the Machine Economy program</span>
      </div>
    </footer>
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
