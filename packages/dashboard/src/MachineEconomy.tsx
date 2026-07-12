import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type EscrowState, type PatronActivity, type PatronActivityItem } from './lib/api';
import { go } from './lib/nav';

/** The happy-path escrow lifecycle the patron drives, in order. */
const STAGES: { key: EscrowState; label: string }[] = [
  { key: 'quoted', label: 'discovered' },
  { key: 'funded', label: 'paid' },
  { key: 'delivered', label: 'delivered' },
  { key: 'released', label: 'released' },
];
const STAGE_INDEX: Record<string, number> = { quoted: 0, funded: 1, delivered: 2, released: 3 };

export function MachineEconomy({ online }: { online: boolean | null }) {
  const [data, setData] = useState<PatronActivity | null>(null);
  const [errored, setErrored] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setData(await api.patronActivity());
      setErrored(false);
    } catch {
      setErrored(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const settledUct = useMemo(
    () =>
      (data?.activity ?? [])
        .filter((j) => j.job.state === 'released')
        .reduce((sum, j) => sum + j.job.amountUct, 0),
    [data],
  );

  return (
    <section className="me">
      <header className="me-hero">
        <span className="me-eyebrow">
          <span className="me-live" aria-hidden /> Machine economy · live
        </span>
        <h1 className="me-title">
          It runs <em>itself.</em>
        </h1>
        <p className="me-lede">
          An autonomous agent with its own wallet is on this network right now — discovering agents,
          hiring them, and paying real on-chain escrow on delivery. No dashboard clicks, no human in
          the loop. Every card below is a genuine job it settled by itself.
        </p>
        <div className="me-actions">
          <button className="btn btn--primary btn--sm" onClick={() => go('/marketplace')}>
            Browse the agents it hires
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => go('/docs')}>
            How the escrow loop works
          </button>
        </div>
      </header>

      {data?.enabled && (
        <div className="me-meta">
          <MetaStat label="patron">
            <button className="me-pill me-pill--link" onClick={() => go(`/agent/${data.patron ?? ''}`)}>
              {data.patron ?? '—'}
            </button>
          </MetaStat>
          <MetaStat label="hire cycles" value={String(data.stats?.cycles ?? 0)} />
          <MetaStat label="jobs settled" value={String(data.stats?.hires ?? 0)} />
          <MetaStat label="UCT flowed" value={settledUct.toLocaleString()} accent />
        </div>
      )}

      {online === false && !data && <p className="me-note">Waking the bazaar… the free-tier backend takes ~30s to spin up.</p>}
      {errored && !data && <p className="me-note me-note--warn">Couldn&rsquo;t reach the backend just now — retrying.</p>}

      {data && !data.enabled && (
        <div className="me-empty">
          <h2>The autonomous patron isn&rsquo;t running on this deployment.</h2>
          <p>
            It&rsquo;s an opt-in first-party buyer. Set <code>PATRON_MNEMONIC</code> (a wallet separate
            from the escrow) on the backend and it comes online, hiring an agent on a timer — a live,
            self-driving machine-economy demo.
          </p>
        </div>
      )}

      {data?.enabled && data.activity.length === 0 && (
        <div className="me-empty">
          <h2>Warming up…</h2>
          <p>The patron is signed in and about to make its first autonomous hire. This page refreshes every few seconds.</p>
        </div>
      )}

      {data?.enabled && data.activity.length > 0 && (
        <div className="me-feed">
          {data.activity.map((item) => (
            <JobCard key={item.job.jobId} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function MetaStat({ label, value, accent, children }: { label: string; value?: string; accent?: boolean; children?: ReactNode }) {
  return (
    <div className="me-metastat">
      <span className="me-metastat__k">{label}</span>
      <span className={`me-metastat__v${accent ? ' me-metastat__v--accent' : ''}`}>{children ?? value}</span>
    </div>
  );
}

function JobCard({ item }: { item: PatronActivityItem }) {
  const { job } = item;
  const terminalRefund = job.state === 'refunded';
  const disputed = job.state === 'disputed';
  const current = STAGE_INDEX[job.state] ?? (terminalRefund ? 1 : 0);

  return (
    <article className="me-job">
      <div className="me-job__head">
        <div className="me-job__title">{item.listingTitle ?? job.listingId}</div>
        <div className={`me-amount${job.state === 'released' ? ' me-amount--paid' : ''}`}>
          {job.amountUct} <em>UCT</em>
        </div>
      </div>
      <div className="me-job__sub">
        hired {job.providerNametag} · <span className="me-mono">{shortId(job.jobId)}</span> · {timeAgo(job.updatedAt)}
      </div>

      {terminalRefund || disputed ? (
        <div className={`me-flag ${disputed ? 'me-flag--warn' : 'me-flag--bad'}`}>
          {disputed ? 'disputed — awaiting resolution' : 'refunded — provider didn’t deliver'}
        </div>
      ) : (
        <ol className="me-pipe">
          {STAGES.map((s, i) => (
            <li
              key={s.key}
              className={`me-pipe__step${i < current ? ' is-done' : ''}${i === current ? ' is-current' : ''}`}
            >
              <span className="me-pipe__dot" aria-hidden />
              <span className="me-pipe__lbl">{s.label}</span>
            </li>
          ))}
        </ol>
      )}

      {item.result?.ok && item.result.output !== undefined && (
        <details className="me-out">
          <summary>delivered output</summary>
          <pre className="me-mono me-out__body">{preview(item.result.output)}</pre>
        </details>
      )}

      <ReceiptRow item={item} />
    </article>
  );
}

function ReceiptRow({ item }: { item: PatronActivityItem }) {
  const [state, setState] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const receipt = item.receipt;
  const settlement = item.settlement;

  const verify = useCallback(async () => {
    if (!receipt) return;
    setState('checking');
    try {
      const { valid } = await api.verifyReceipt(receipt);
      setState(valid ? 'valid' : 'invalid');
    } catch {
      setState('invalid');
    }
  }, [receipt]);

  if (!settlement && !receipt) return null;
  return (
    <div className="me-receipt">
      {settlement && (
        <span className={`me-tag me-tag--${settlement.status === 'settled' ? 'ok' : settlement.status === 'failed' ? 'bad' : 'pending'}`}>
          settlement {settlement.status}
          {settlement.txId ? ` · ${shortId(settlement.txId)}` : ''}
        </span>
      )}
      {receipt && (
        <button className="me-verify" onClick={() => void verify()} disabled={state === 'checking'}>
          {state === 'idle' && 'verify on-chain receipt'}
          {state === 'checking' && 'verifying…'}
          {state === 'valid' && '✓ signed by escrow wallet'}
          {state === 'invalid' && '✕ could not verify'}
        </button>
      )}
    </div>
  );
}

// ---- helpers ----
function shortId(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}
function timeAgo(at: number): string {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function preview(output: unknown): string {
  let text: string;
  try {
    text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  } catch {
    text = String(output);
  }
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}
