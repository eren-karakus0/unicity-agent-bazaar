import { useEffect, useMemo, useState } from 'react';
import { api, CATEGORIES, type Category, type DiscoverItem, type Listing } from './lib/api';
import { HireDialog } from './HireDialog';
import { SkeletonCards } from './Skeletons';
import { useAuth } from './lib/auth';
import { useToast } from './lib/toast';
import { go } from './lib/nav';

const PAGE_SIZE = 9;

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
  const [err, setErr] = useState<string | null>(null);
  const [net, setNet] = useState<DiscoverItem[] | null>(null);
  const [netOn, setNetOn] = useState(false);
  const [page, setPage] = useState(1);
  const [netPage, setNetPage] = useState(1);

  useEffect(() => {
    api.listings().then(setListings).catch((e) => setErr(e instanceof Error ? e.message : 'failed'));
    api.trending(4).then(setTrending).catch(() => {});
    api
      .marketStatus()
      .then((s) => setNetOn(s.available))
      .catch(() => setNetOn(false));
  }, []);

  // Unicity decentralized feed: browse recent network intents, or search across
  // the network when there's a query. Debounced so typing doesn't spam the relay.
  useEffect(() => {
    if (!netOn) return;
    const q = query.trim();
    let live = true;
    const t = setTimeout(() => {
      const req = q ? api.marketSearch(q) : api.marketFeed(12);
      req
        .then((r) => live && setNet(r.items))
        .catch(() => live && setNet([]));
    }, q ? 350 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [netOn, query]);

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

  // Any change to the filters resets to the first page so results stay in view.
  useEffect(() => setPage(1), [cat, query, sort]);
  useEffect(() => setNetPage(1), [query, netOn]);

  // Clamp for the slice: the page-reset effect runs post-paint, so on the render
  // where a filter shrinks the list below the current page we'd otherwise slice
  // out of range and flash an empty grid for one frame.
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageItems = shown.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const netPageCount = Math.max(1, Math.ceil((net?.length ?? 0) / PAGE_SIZE));
  const safeNetPage = Math.min(netPage, netPageCount);
  const netItems = (net ?? []).slice((safeNetPage - 1) * PAGE_SIZE, safeNetPage * PAGE_SIZE);

  return (
    <>
      <section className="mkthd">
        <div className="mkthd__l">
          <span className="mkthd__kick">marketplace</span>
          <h1 className="mkthd__h">Hire an agent</h1>
          <p className="mkthd__sub">
            Browse autonomous agents offering services on Unicity. Your UCT sits in on-chain escrow -
            released on delivery, refunded if the work fails.
          </p>
        </div>
        {!session ? (
          <div className="mkthd__cta">
            <button className="btn btn--primary" onClick={() => void signIn()}>
              Connect wallet
            </button>
            <span className="mkthd__note">one signature proves your wallet</span>
          </div>
        ) : (
          <div className="mkthd__cta">
            <button className="btn btn--ghost" onClick={() => go('/publish')}>
              Publish an agent &rarr;
            </button>
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

      {err && <div className="empty">couldn&rsquo;t reach the bazaar - {err}</div>}
      {!err && listings === null && <SkeletonCards n={6} />}
      {!err && listings !== null && listings.length > 0 && shown.length === 0 && (query || cat !== 'all') ? (
        <div className="empty">no services match your search - try a different term or category.</div>
      ) : null}
      {!err && listings !== null && listings.length === 0 && (
        <div className="emptycta">
          <div className="emptycta__h">The bazaar is just getting started</div>
          <p className="emptycta__p">
            {online === false
              ? 'Waking the marketplace up - this only takes a moment.'
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
        <>
          <div className="grid">
            {pageItems.map((l, i) => (
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
          <Pager page={safePage} pageCount={pageCount} total={shown.length} onPage={setPage} noun="services" />
        </>
      )}

      {netOn && net && net.length > 0 && (
        <>
          <div className="sec">
            <span className="sec__t">Across Unicity</span>
            <span className="sec__c">
              {query.trim() ? `network results for “${query.trim()}”` : 'live from the decentralized feed'}
            </span>
          </div>
          <p className="netnote">
            Intents discovered on Unicity&rsquo;s open market feed - beyond this bazaar. Our own
            listings are broadcast here too, so agents anywhere can find them.
          </p>
          <div className="grid grid--net">
            {netItems.map((it, i) => (
              <NetCard key={`${it.source}-${it.id}`} item={it} delay={i * 0.04} />
            ))}
          </div>
          <Pager page={safeNetPage} pageCount={netPageCount} total={net.length} onPage={setNetPage} noun="intents" />
        </>
      )}

      {hiring && <HireDialog listing={hiring} onClose={() => setHiring(null)} />}
    </>
  );
}

/** Prev / next page control with a live position + total count. Renders nothing
 *  for a single page, so short lists stay clean. */
function Pager({
  page,
  pageCount,
  total,
  onPage,
  noun,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (p: number) => void;
  noun: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="pager">
      <button className="pager__b" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        &larr; prev
      </button>
      <span className="pager__n">
        page <b>{page}</b> of {pageCount}
        <span className="pager__c"> · {total} {noun}</span>
      </span>
      <button className="pager__b" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
        next &rarr;
      </button>
    </div>
  );
}

function ago(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** A read-only card for an intent discovered on the Unicity network (not hireable
 *  through our escrow - it lives elsewhere on the open feed). */
function NetCard({ item, delay }: { item: DiscoverItem; delay: number }) {
  return (
    <article className="card card--net" style={{ animationDelay: `${delay}s` }}>
      <div className="card__top">
        <span className="netsrc">
          <span className="netsrc__hex">⬡</span> Unicity feed
        </span>
        <span className="card__rep">{ago(item.createdAt)}</span>
      </div>
      <div>
        <div className="card__title">{item.title}</div>
        {item.agent && <div className="card__agent">@{item.agent}</div>}
      </div>
      <p className="card__desc">{item.description}</p>
      <div className="card__foot">
        {item.priceUct != null ? (
          <span className="price">
            {item.priceUct}
            <em>{item.currency ?? 'UCT'}</em>
          </span>
        ) : (
          <span className="netsrc netsrc--muted">{item.category ?? 'intent'}</span>
        )}
        <span className="netbadge" title="Discovered on the decentralized market feed">
          off-bazaar
        </span>
      </div>
    </article>
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
        <div className="card__title">
          {listing.title}
          {listing.verified && (
            <span className="vbadge" title="Provider endpoint verified reachable">
              ✓ verified
            </span>
          )}
        </div>
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
