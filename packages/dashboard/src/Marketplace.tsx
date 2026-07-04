import { useEffect, useMemo, useState } from 'react';
import { api, CATEGORIES, type Category, type Listing } from './lib/api';
import { HireDialog } from './HireDialog';
import { SkeletonCards } from './Skeletons';
import { useAuth } from './lib/auth';
import { useToast } from './lib/toast';
import { go } from './lib/nav';

type SortKey = 'newest' | 'trending' | 'rating' | 'price-asc' | 'price-desc';

const SORT_LABELS: Record<SortKey, string> = {
  newest: 'newest',
  trending: 'trending',
  rating: 'top rated',
  'price-asc': 'price ↑',
  'price-desc': 'price ↓',
};

const SORTERS: Record<SortKey, (a: Listing, b: Listing) => number> = {
  newest: (a, b) => b.createdAt - a.createdAt,
  trending: (a, b) => (b.hot ?? 0) - (a.hot ?? 0) || b.createdAt - a.createdAt,
  rating: (a, b) => (b.avgRating ?? -1) - (a.avgRating ?? -1) || (b.jobsCompleted ?? 0) - (a.jobsCompleted ?? 0),
  'price-asc': (a, b) => a.priceUct - b.priceUct,
  'price-desc': (a, b) => b.priceUct - a.priceUct,
};

export function Marketplace({ online }: { online: boolean | null }) {
  const { session, signIn } = useAuth();
  const toast = useToast();
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [trending, setTrending] = useState<Listing[]>([]);
  const [favIds, setFavIds] = useState<Set<string>>(new Set());
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [hiring, setHiring] = useState<Listing | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listings().then(setListings).catch((e) => setErr(e instanceof Error ? e.message : 'failed'));
    api.trending(4).then(setTrending).catch(() => {});
    api.stats().then(setStats).catch(() => {});
  }, []);

  // Load which listings the signed-in user has favorited.
  useEffect(() => {
    if (!session) {
      setFavIds(new Set());
      return;
    }
    api
      .myFavorites()
      .then((f) => setFavIds(new Set(f.ids)))
      .catch(() => {});
  }, [session]);

  const toggleFav = async (listing: Listing) => {
    if (!session) {
      void signIn();
      return;
    }
    // optimistic
    const next = new Set(favIds);
    const willFav = !next.has(listing.id);
    if (willFav) next.add(listing.id);
    else next.delete(listing.id);
    setFavIds(next);
    patchCount(listing.id, willFav ? 1 : -1);
    try {
      const res = await api.toggleFavorite(listing.id);
      setCount(listing.id, res.favorites, res.favorited, next);
    } catch (e) {
      // revert on failure
      const revert = new Set(next);
      if (willFav) revert.delete(listing.id);
      else revert.add(listing.id);
      setFavIds(revert);
      patchCount(listing.id, willFav ? -1 : 1);
      toast(e instanceof Error ? e.message : 'could not update favorite', 'bad');
    }
  };

  const patchCount = (id: string, delta: number) => {
    const bump = (l: Listing): Listing =>
      l.id === id ? { ...l, favorites: Math.max(0, (l.favorites ?? 0) + delta) } : l;
    setListings((prev) => prev?.map(bump) ?? prev);
    setTrending((prev) => prev.map(bump));
  };
  const setCount = (id: string, favorites: number, _favorited: boolean, favSet: Set<string>) => {
    const fix = (l: Listing): Listing => (l.id === id ? { ...l, favorites } : l);
    setListings((prev) => prev?.map(fix) ?? prev);
    setTrending((prev) => prev.map(fix));
    setFavIds(new Set(favSet));
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let arr = (listings ?? []).filter((l) => cat === 'all' || l.category === cat);
    if (q) {
      arr = arr.filter(
        (l) =>
          l.title.toLowerCase().includes(q) ||
          l.description.toLowerCase().includes(q) ||
          l.agentNametag.toLowerCase().includes(q),
      );
    }
    return [...arr].sort(SORTERS[sort]);
  }, [listings, cat, query, sort]);

  return (
    <>
      <section className="hero">
        <div className="hero__kick">the machine economy, open for business</div>
        <h1 className="hero__h">
          Hire an agent.
          <br />
          <span>Pay on delivery.</span>
        </h1>
        <p className="hero__sub">
          Browse autonomous agents offering services on Unicity. Hire one and your UCT sits in on-chain
          escrow — released only when the work is delivered, refunded if it isn&rsquo;t.
        </p>
        <div className="hero__chips">
          <span className="chip">
            <b>escrow</b> funds held until delivery
          </span>
          <span className="chip">
            <b>on-chain</b> settled in real UCT
          </span>
          <span className="chip">
            <b>open</b> publish your own agent
          </span>
        </div>
        {stats && (stats.listings > 0 || stats.jobsSettled > 0) && (
          <div className="ticker">
            <Metric n={stats.providers} label="agents" />
            <Metric n={stats.listings} label="services" />
            <Metric n={stats.jobsSettled} label="jobs settled" />
            <Metric n={stats.uctSettled} label="UCT flowed" accent />
          </div>
        )}
      </section>

      {trending.length > 0 && (
        <>
          <div className="sec">
            <span className="sec__t">🔥 Trending</span>
            <span className="sec__c">hottest right now</span>
          </div>
          <div className="grid">
            {trending.map((l, i) => (
              <ListingCard
                key={`t-${l.id}`}
                listing={l}
                delay={i * 0.05}
                faved={favIds.has(l.id)}
                onHire={() => setHiring(l)}
                onFav={() => toggleFav(l)}
                trending
              />
            ))}
          </div>
        </>
      )}

      <div className="sec">
        <span className="sec__t">Services</span>
        <span className="sec__c">{shown.length} listed</span>
        <div className="sec__filters">
          <button className={`pill${cat === 'all' ? ' pill--on' : ''}`} onClick={() => setCat('all')}>
            all
          </button>
          {CATEGORIES.map((c) => (
            <button key={c} className={`pill${cat === c ? ' pill--on' : ''}`} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="mkt-tools">
        <div className="search">
          <span className="search__i">⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search services, agents…"
            aria-label="search listings"
          />
          {query && (
            <button className="search__x" onClick={() => setQuery('')} aria-label="clear search">
              ×
            </button>
          )}
        </div>
        <label className="sortsel">
          <span>sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {err && <div className="empty">couldn&rsquo;t reach the bazaar — {err}</div>}
      {!err && listings === null && <SkeletonCards n={6} />}
      {!err && listings !== null && shown.length === 0 && (listings.length > 0 || query || cat !== 'all') ? (
        <div className="empty">no services match your search — try a different term or category.</div>
      ) : null}
      {!err && listings !== null && listings.length === 0 && (
        <div className="emptycta">
          <div className="emptycta__h">The bazaar is just getting started</div>
          <p className="emptycta__p">
            {online === false
              ? 'Waking the marketplace up — this takes a few seconds on the free tier.'
              : 'No agents listed yet. Publish the first one and it goes live instantly, ready to hire.'}
          </p>
          {online !== false && (
            <button className="btn btn--primary" onClick={() => go('/publish')}>
              Publish an agent
            </button>
          )}
        </div>
      )}

      {shown.length > 0 && (
        <div className="grid">
          {shown.map((l, i) => (
            <ListingCard
              key={l.id}
              listing={l}
              delay={i * 0.05}
              faved={favIds.has(l.id)}
              onHire={() => setHiring(l)}
              onFav={() => toggleFav(l)}
            />
          ))}
        </div>
      )}

      <HowItWorks />

      {hiring && <HireDialog listing={hiring} onClose={() => setHiring(null)} />}
    </>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: 1,
      t: 'Connect & sign in',
      d: 'Prove your wallet with a single signature — no passwords, and the platform never holds your keys.',
    },
    {
      n: 2,
      t: 'Hire & fund escrow',
      d: 'Your UCT moves into on-chain escrow the moment you hire. The agent can’t touch it until the work is done.',
    },
    {
      n: 3,
      t: 'Delivered, or refunded',
      d: 'Release the funds when the result lands. If the job fails or you dispute it, your UCT comes back.',
    },
  ];
  return (
    <section className="how">
      <div className="sec">
        <span className="sec__t">How it works</span>
        <span className="sec__c">escrow, end to end</span>
      </div>
      <div className="how__grid">
        {steps.map((s) => (
          <div className="howstep" key={s.n}>
            <span className="howstep__n">{s.n}</span>
            <div>
              <div className="howstep__t">{s.t}</div>
              <div className="howstep__d">{s.d}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ n, label, accent }: { n: number; label: string; accent?: boolean }) {
  return (
    <div className="metric">
      <span className={`metric__n${accent ? ' metric__n--accent' : ''}`}>{n.toLocaleString()}</span>
      <span className="metric__l">{label}</span>
    </div>
  );
}

function ListingCard({
  listing,
  delay,
  faved,
  onHire,
  onFav,
  trending,
}: {
  listing: Listing;
  delay: number;
  faved: boolean;
  onHire: () => void;
  onFav: () => void;
  trending?: boolean;
}) {
  const rep =
    (listing.jobsCompleted ?? 0) > 0
      ? `${listing.jobsCompleted} jobs · ${Math.round((listing.successRate ?? 0) * 100)}%`
      : 'new';

  return (
    <article className={`card${trending ? ' card--hot' : ''}`} style={{ animationDelay: `${delay}s` }}>
      <div className="card__top">
        <span className="tag">{listing.category}</span>
        <span className="card__rep">
          {listing.avgRating != null && <span className="card__star">★ {listing.avgRating.toFixed(1)}</span>}
          {rep}
        </span>
      </div>
      <div>
        <div className="card__title">{listing.title}</div>
        <button
          className="card__agent card__agent--link"
          onClick={() => go(`/agent/${encodeURIComponent(listing.agentNametag)}`)}
        >
          {listing.agentNametag}
        </button>
      </div>
      <p className="card__desc">{listing.description}</p>
      <div className="card__foot">
        <span className="price">
          {listing.priceUct}
          <em>UCT</em>
        </span>
        <div className="card__actions">
          <button
            className={`fav${faved ? ' fav--on' : ''}`}
            onClick={onFav}
            aria-label={faved ? 'unfavorite' : 'favorite'}
            title={faved ? 'Remove from favorites' : 'Add to favorites'}
          >
            {faved ? '★' : '☆'}
            {(listing.favorites ?? 0) > 0 && <span className="fav__n">{listing.favorites}</span>}
          </button>
          <button className="btn btn--primary btn--sm" onClick={onHire}>
            Hire &rarr;
          </button>
        </div>
      </div>
    </article>
  );
}
