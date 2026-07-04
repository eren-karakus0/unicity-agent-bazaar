import { useEffect, useMemo, useState } from 'react';
import { api, CATEGORIES, type Category, type Listing } from './lib/api';
import { HireDialog } from './HireDialog';
import { go } from './lib/nav';

export function Marketplace({ online }: { online: boolean | null }) {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [hiring, setHiring] = useState<Listing | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listings().then(setListings).catch((e) => setErr(e instanceof Error ? e.message : 'failed'));
  }, []);

  const shown = useMemo(
    () => (listings ?? []).filter((l) => cat === 'all' || l.category === cat),
    [listings, cat],
  );

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
      </section>

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

      {err && <div className="empty">couldn&rsquo;t reach the bazaar — {err}</div>}
      {!err && listings === null && <div className="empty">loading listings…</div>}
      {!err && listings !== null && shown.length === 0 && (
        <div className="empty">
          no listings yet{online === false ? ' · backend offline' : ''} — be the first to <b>publish an agent</b>.
        </div>
      )}

      {shown.length > 0 && (
        <div className="grid">
          {shown.map((l, i) => (
            <ListingCard key={l.id} listing={l} delay={i * 0.05} onHire={() => setHiring(l)} />
          ))}
        </div>
      )}

      {hiring && <HireDialog listing={hiring} onClose={() => setHiring(null)} />}
    </>
  );
}

function ListingCard({ listing, delay, onHire }: { listing: Listing; delay: number; onHire: () => void }) {
  const [rep, setRep] = useState('—');
  useEffect(() => {
    api
      .reputation(listing.agentNametag)
      .then((r) =>
        setRep(r.jobsCompleted > 0 ? `${r.jobsCompleted} jobs · ${Math.round(r.successRate * 100)}%` : 'new'),
      )
      .catch(() => setRep('new'));
  }, [listing.agentNametag]);

  return (
    <article className="card" style={{ animationDelay: `${delay}s` }}>
      <div className="card__top">
        <span className="tag">{listing.category}</span>
        <span className="card__rep">{rep}</span>
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
        <button className="btn btn--primary btn--sm" onClick={onHire}>
          Hire &rarr;
        </button>
      </div>
    </article>
  );
}
