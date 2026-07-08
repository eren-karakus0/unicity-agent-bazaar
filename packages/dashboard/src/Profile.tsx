import { useCallback, useEffect, useState } from 'react';
import {
  api,
  badgeUrl,
  type EscrowState,
  type JobSummary,
  type Listing,
  type ProfileView,
  type TrustScore,
} from './lib/api';
import { useAuth } from './lib/auth';
import { HireDialog } from './HireDialog';
import { SkeletonProfile } from './Skeletons';
import { go } from './lib/nav';

const TIER_ICON: Record<TrustScore['tier'], string> = {
  gold: '◆',
  silver: '◆',
  bronze: '◆',
  new: '○',
};
const TIER_HINT: Record<TrustScore['tier'], string> = {
  gold: 'Gold: proven, highly rated provider',
  silver: 'Silver: reliable provider with a solid record',
  bronze: 'Bronze: established provider, building a record',
  new: 'New: no completed jobs yet',
};

/** A stable hue from any principal string, for the generated avatar. */
function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function Avatar({ principal, nametag, size = 72 }: { principal: string; nametag?: string; size?: number }) {
  const h = hueOf(principal);
  const letter = (nametag?.[0] ?? '⬡').toUpperCase();
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(150deg, hsl(${h} 85% 58%), hsl(${(h + 40) % 360} 85% 42%))`,
      }}
      aria-hidden
    >
      {letter}
    </div>
  );
}

function shortKey(pk?: string): string {
  return pk ? `${pk.slice(0, 10)}…${pk.slice(-6)}` : '';
}

function relTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const STATE_TONE: Record<EscrowState, string> = {
  quoted: 'tone-wait',
  funded: 'tone-live',
  delivered: 'tone-live',
  released: 'tone-ok',
  refunded: 'tone-bad',
  disputed: 'tone-bad',
  cancelled: 'tone-bad',
};

export function Profile({ principal }: { principal: string | null }) {
  const { session } = useAuth();
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [trust, setTrust] = useState<TrustScore | null>(null);
  const [favorites, setFavorites] = useState<Listing[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hiring, setHiring] = useState<Listing | null>(null);

  const target = principal; // null = me
  const load = useCallback(() => {
    setErr(null);
    const req = target === null ? api.myProfile() : api.profile(target);
    req.then(setProfile).catch((e) => setErr(e instanceof Error ? e.message : 'could not load profile'));
  }, [target]);

  useEffect(() => {
    setProfile(null);
    setTrust(null);
    load();
  }, [load]);

  // Trust score is derived from the same principal the profile resolves to.
  useEffect(() => {
    const p = profile?.principal;
    if (!p) return;
    let live = true;
    api
      .trust(p)
      .then((t) => live && setTrust(t))
      .catch(() => live && setTrust(null));
    return () => {
      live = false;
    };
  }, [profile?.principal]);

  // Favorites are private - only shown on your own (`#/profile`) view.
  useEffect(() => {
    if (target !== null || !session) {
      setFavorites(null);
      return;
    }
    api
      .myFavorites()
      .then((f) => setFavorites(f.listings))
      .catch(() => setFavorites([]));
  }, [target, session]);

  if (target === null && !session) {
    return <div className="empty">Connect your wallet to see your profile.</div>;
  }
  if (err) {
    return (
      <div className="empty">
        <div>couldn&rsquo;t load this profile - the bazaar may be waking up.</div>
        <button className="btn btn--primary btn--sm" style={{ marginTop: 16 }} onClick={load}>
          Retry
        </button>
      </div>
    );
  }
  if (!profile) return <SkeletonProfile />;

  const isMe = !!session && profile.principal === (session.nametag ? `@${session.nametag}` : session.chainPubkey);
  const name = profile.nametag ? `@${profile.nametag}` : shortKey(profile.principal);
  const rep = profile.reputation;

  return (
    <>
      <section className="prof">
        <Avatar principal={profile.principal} nametag={profile.nametag} />
        <div className="prof__id">
          <div className="prof__name">
            {name}
            {isMe && <span className="prof__you">you</span>}
          </div>
          {profile.chainPubkey && (
            <div className="prof__key" title={profile.chainPubkey}>
              {shortKey(profile.chainPubkey)}
            </div>
          )}
          <div className="prof__reptags">
            {trust && (
              <span className={`tier tier--${trust.tier}`} title={TIER_HINT[trust.tier]}>
                <span className="tier__i">{TIER_ICON[trust.tier]}</span>
                {trust.tier}
                {trust.tier !== 'new' && <span className="tier__s">{trust.score}</span>}
              </span>
            )}
            <span className={`repbadge ${rep.jobsCompleted > 0 ? 'repbadge--on' : ''}`}>
              {rep.jobsCompleted > 0 ? `${rep.jobsCompleted} jobs · ${Math.round(rep.successRate * 100)}%` : 'new'}
            </span>
            {rep.avgRating !== null && <span className="repbadge">★ {rep.avgRating.toFixed(1)}</span>}
            {profile.chainPubkey && (
              <span className="repbadge repbadge--verified" title="Identity proven by a wallet signature">
                ✓ wallet-verified
              </span>
            )}
          </div>
        </div>
      </section>

      <div className="stats">
        <Stat label="active listings" value={String(profile.stats.listingsActive)} />
        <Stat label="jobs sold" value={String(profile.stats.jobsAsProvider)} />
        <Stat label="jobs bought" value={String(profile.stats.jobsAsBuyer)} />
        <Stat label="UCT earned" value={String(profile.stats.earnedUct)} accent />
        <Stat label="UCT spent" value={String(profile.stats.spentUct)} />
        <Stat label="favorites" value={String(profile.stats.favoritesReceived)} />
      </div>

      {profile.achievements.length > 0 && (
        <>
          <div className="sec">
            <span className="sec__t">Achievements</span>
            <span className="sec__c">{profile.achievements.length} earned</span>
          </div>
          <div className="badges">
            {profile.achievements.map((a) => (
              <div key={a.id} className={`badge badge--${a.side}`} title={a.description}>
                <span className="badge__i">{a.side === 'provider' ? '◆' : '●'}</span>
                <div className="badge__body">
                  <div className="badge__l">{a.label}</div>
                  <div className="badge__d">{a.description}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {profile.listings.length > 0 && (
        <>
          <div className="sec">
            <span className="sec__t">Services</span>
            <span className="sec__c">{profile.listings.length} listed</span>
          </div>
          <div className="grid">
            {profile.listings.map((l, i) => (
              <ProfileListingCard key={l.id} listing={l} delay={i * 0.04} onHire={() => setHiring(l)} />
            ))}
          </div>
        </>
      )}

      {target === null && favorites && favorites.length > 0 && (
        <>
          <div className="sec">
            <span className="sec__t">★ Favorites</span>
            <span className="sec__c">{favorites.length} saved</span>
          </div>
          <div className="grid">
            {favorites.map((l, i) => (
              <ProfileListingCard key={l.id} listing={l} delay={i * 0.04} onHire={() => setHiring(l)} />
            ))}
          </div>
        </>
      )}

      {profile.reviews.length > 0 && (
        <>
          <div className="sec">
            <span className="sec__t">Reviews</span>
            <span className="sec__c">{profile.reviews.length}</span>
          </div>
          <div className="reviews">
            {profile.reviews.map((r) => (
              <div className="rev" key={r.jobId}>
                <div className="rev__top">
                  <span className="rev__stars">
                    {'★'.repeat(r.stars)}
                    <span className="rev__stars-off">{'★'.repeat(5 - r.stars)}</span>
                  </span>
                  <span className="rev__by">{r.buyerNametag}</span>
                  <span className="rev__t">{relTime(r.createdAt)}</span>
                </div>
                {r.text && <p className="rev__text">“{r.text}”</p>}
              </div>
            ))}
          </div>
        </>
      )}

      {isMe && trust && <EmbedBadge principal={profile.principal} trust={trust} />}

      <div className="actgrid">
        <ActivityColumn title="Sold" empty="no jobs sold yet" jobs={profile.asProvider} />
        <ActivityColumn title="Bought" empty="no jobs bought yet" jobs={profile.asBuyer} />
      </div>

      {hiring && <HireDialog listing={hiring} onClose={() => setHiring(null)} />}
    </>
  );
}

function ProfileListingCard({
  listing,
  delay,
  onHire,
}: {
  listing: Listing;
  delay: number;
  onHire: () => void;
}) {
  return (
    <article className="card" style={{ animationDelay: `${delay}s` }}>
      <div className="card__top">
        <span className="tag">{listing.category}</span>
        <span className="card__rep">
          {listing.avgRating != null && <span className="card__star">★ {listing.avgRating.toFixed(1)}</span>}
          {(listing.favorites ?? 0) > 0 ? `♥ ${listing.favorites}` : ''}
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
        <button className="btn btn--primary btn--sm" onClick={onHire}>
          Hire &rarr;
        </button>
      </div>
    </article>
  );
}

function EmbedBadge({ principal, trust }: { principal: string; trust: TrustScore }) {
  const [copied, setCopied] = useState(false);
  const src = badgeUrl(principal);
  const handle = principal.startsWith('@') ? principal : `@${principal.slice(0, 8)}`;
  const snippet = `<a href="${window.location.origin}/#/agent/${encodeURIComponent(principal)}">\n  <img src="${src}" alt="Unicity Bazaar trust: ${trust.tier} ${trust.score}" height="20">\n</a>`;

  const copy = () => {
    navigator.clipboard
      .writeText(snippet)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };

  return (
    <>
      <div className="sec">
        <span className="sec__t">Trust badge</span>
        <span className="sec__c">live, self-updating</span>
      </div>
      <div className="embed">
        <div className="embed__preview">
          <img src={src} alt={`trust badge for ${handle}`} height={20} />
          <span className="embed__hint">{TIER_HINT[trust.tier]}</span>
        </div>
        <div className="embed__snip">
          <div className="embed__snip-h">
            <span>Embed on your site or README</span>
            <button className={`btn btn--sm ${copied ? 'btn--ok' : ''}`} onClick={copy}>
              {copied ? '✓ copied' : 'Copy'}
            </button>
          </div>
          <pre className="embed__code">{snippet}</pre>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="stat">
      <div className={`stat__v${accent ? ' stat__v--accent' : ''}`}>{value}</div>
      <div className="stat__l">{label}</div>
    </div>
  );
}

function ActivityColumn({ title, jobs, empty }: { title: string; jobs: JobSummary[]; empty: string }) {
  return (
    <div className="actcol">
      <div className="actcol__h">
        {title} <span>{jobs.length}</span>
      </div>
      {jobs.length === 0 ? (
        <div className="actcol__empty">{empty}</div>
      ) : (
        <div className="actlist">
          {jobs.slice(0, 12).map((j) => (
            <div className="actrow" key={j.jobId}>
              <div className="actrow__main">
                <div className="actrow__title">{j.listingTitle ?? j.listingId}</div>
                <div className="actrow__meta">
                  {j.role === 'provider' ? '←' : '→'} {j.counterparty} · {relTime(j.updatedAt)}
                </div>
              </div>
              <div className="actrow__right">
                <span className="actrow__amt">{j.amountUct} UCT</span>
                <span className={`sbadge ${STATE_TONE[j.state]}`}>{j.state}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
