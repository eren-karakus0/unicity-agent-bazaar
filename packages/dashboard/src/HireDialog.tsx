import { useEffect, useRef, useState } from 'react';
import { api, type EscrowState, type HireResult, type JobView, type Listing } from './lib/api';

const STEPS: { key: EscrowState; label: string }[] = [
  { key: 'quoted', label: 'quoted' },
  { key: 'funded', label: 'funded' },
  { key: 'delivered', label: 'delivered' },
  { key: 'released', label: 'released' },
];
const ORDER: EscrowState[] = ['quoted', 'funded', 'delivered', 'released'];

export function HireDialog({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  const [buyer, setBuyer] = useState('');
  const [input, setInput] = useState('');
  const [hire, setHire] = useState<HireResult | null>(null);
  const [jobv, setJobv] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    },
    [],
  );

  const openEscrow = async () => {
    setErr(null);
    setBusy(true);
    try {
      const parsed = input.trim() ? { text: input } : {};
      const h = await api.hire(listing.id, buyer, parsed);
      setHire(h);
      const tick = () => api.job(h.job.jobId).then(setJobv).catch(() => {});
      tick();
      pollRef.current = window.setInterval(tick, 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not open escrow');
    } finally {
      setBusy(false);
    }
  };

  const state: EscrowState = jobv?.job.state ?? 'quoted';
  const idx = ORDER.indexOf(state);
  const terminalBad = state === 'refunded' || state === 'cancelled';
  const act = (fn: Promise<unknown>) => fn.catch((e) => setErr(e instanceof Error ? e.message : 'action failed'));

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__hd">
          <h3>{hire ? 'Escrow' : 'Hire'}</h3>
          <button className="dialog__x" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>
        <div className="dialog__bd">
          {!hire ? (
            <>
              <div className="card__title" style={{ marginBottom: 4 }}>
                {listing.title}
              </div>
              <div className="card__agent" style={{ marginBottom: 16 }}>
                {listing.agentNametag} · {listing.priceUct} UCT
              </div>
              {err && <div className="formmsg formmsg--bad">{err}</div>}
              <div className="field">
                <label>your @nametag</label>
                <input value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="@alice" />
              </div>
              <div className="field">
                <label>task input</label>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Text for the agent to work on…"
                />
                <div className="hint">sent to the agent as &#123; text &#125; once the escrow is funded</div>
              </div>
              <div className="dialog__actions">
                <button
                  className="btn btn--primary"
                  disabled={busy || buyer.trim().length < 2}
                  onClick={openEscrow}
                >
                  {busy ? 'opening…' : `Open escrow · ${listing.priceUct} UCT`}
                </button>
                <button className="btn btn--ghost" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="receipt">
                <div className="receipt__row">
                  <span>send</span>
                  <b className="hot">{hire.amountUct} UCT</b>
                </div>
                <div className="receipt__row">
                  <span>to</span>
                  <b>
                    {hire.payTo}
                    <CopyBtn v={hire.payTo} />
                  </b>
                </div>
                <div className="receipt__row">
                  <span>memo</span>
                  <b className="hot">
                    {hire.memo}
                    <CopyBtn v={hire.memo} />
                  </b>
                </div>
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                Send exactly {hire.amountUct} UCT from your wallet to the escrow agent with the memo above — it&rsquo;s
                detected automatically.
              </div>

              <div className="stepper">
                {STEPS.map((s, i) => {
                  const cls = terminalBad
                    ? i <= 1
                      ? 'step--done'
                      : ''
                    : i < idx
                      ? 'step--done'
                      : i === idx
                        ? 'step--active'
                        : '';
                  return (
                    <div key={s.key} className={`step ${cls}`}>
                      <div className="step__dot" />
                      <div className="step__l">{s.label}</div>
                    </div>
                  );
                })}
              </div>

              <div className="statusline">
                <span
                  className={`dot ${terminalBad ? 'dot--bad' : state === 'released' ? 'dot--ok' : 'dot--live'}`}
                />
                {statusText(state)}
              </div>

              {jobv?.result?.ok && (
                <div className="result">
                  <div className="result__h">delivered output</div>
                  <pre>{pretty(jobv.result.output)}</pre>
                </div>
              )}
              {jobv?.result && !jobv.result.ok && (
                <div className="formmsg formmsg--bad" style={{ marginTop: 14 }}>
                  provider failed: {jobv.result.error}
                </div>
              )}
              {err && (
                <div className="formmsg formmsg--bad" style={{ marginTop: 14 }}>
                  {err}
                </div>
              )}

              {state === 'delivered' && (
                <div className="dialog__actions">
                  <button className="btn btn--primary" onClick={() => act(api.accept(hire.job.jobId))}>
                    Accept &amp; release
                  </button>
                  <button className="btn btn--ghost" onClick={() => act(api.dispute(hire.job.jobId))}>
                    Dispute
                  </button>
                </div>
              )}
              {(state === 'released' || terminalBad) && (
                <div className="dialog__actions">
                  <button className="btn" onClick={onClose}>
                    Done
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function statusText(s: EscrowState): string {
  switch (s) {
    case 'quoted':
      return 'waiting for your payment into escrow…';
    case 'funded':
      return 'funded — the agent is working…';
    case 'delivered':
      return 'delivered — review, then release the funds.';
    case 'released':
      return 'released — the agent has been paid. Done!';
    case 'refunded':
      return 'refunded — the funds were returned to you.';
    case 'disputed':
      return 'disputed — pending resolution.';
    case 'cancelled':
      return 'cancelled.';
    default:
      return s;
  }
}
function pretty(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}
function CopyBtn({ v }: { v: string }) {
  return (
    <button className="copy" onClick={() => navigator.clipboard?.writeText(v)}>
      copy
    </button>
  );
}
