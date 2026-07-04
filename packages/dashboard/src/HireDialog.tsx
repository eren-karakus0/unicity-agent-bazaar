import { useEffect, useRef, useState } from 'react';
import { api, type EscrowState, type HireResult, type JobView, type Listing } from './lib/api';
import { useAuth, displayName } from './lib/auth';

const STEPS: { key: EscrowState; label: string }[] = [
  { key: 'quoted', label: 'quoted' },
  { key: 'funded', label: 'funded' },
  { key: 'delivered', label: 'delivered' },
  { key: 'released', label: 'released' },
];
const ORDER: EscrowState[] = ['quoted', 'funded', 'delivered', 'released'];

/** whole UCT → base-unit integer string, without floating-point error. */
function toBaseUnits(amountUct: number, decimals: number): string {
  return (BigInt(Math.trunc(amountUct)) * 10n ** BigInt(decimals)).toString();
}

export function HireDialog({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  const { session, phase, signIn, wallet } = useAuth();
  const [input, setInput] = useState('');
  const [hire, setHire] = useState<HireResult | null>(null);
  const [jobv, setJobv] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
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
      const h = await api.hire(listing.id, parsed);
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

  const payWithWallet = async () => {
    if (!hire) return;
    setErr(null);
    setPaying(true);
    try {
      await wallet.deposit({
        to: hire.payTo,
        amountBase: toBaseUnits(hire.amountUct, hire.decimals),
        coinId: hire.coinId,
        memo: hire.memo,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'wallet payment was cancelled');
    } finally {
      setPaying(false);
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
          {phase !== 'authenticated' ? (
            <div className="gate">
              <div className="card__title" style={{ marginBottom: 4 }}>
                {listing.title}
              </div>
              <div className="card__agent" style={{ marginBottom: 16 }}>
                {listing.agentNametag} · {listing.priceUct} UCT
              </div>
              <p className="gate__p">
                Connect your wallet to hire this agent. Your UCT is held in on-chain escrow and only released
                when the work is delivered.
              </p>
              <button className="btn btn--primary" disabled={phase === 'signing-in'} onClick={() => void signIn()}>
                {phase === 'signing-in' ? 'signing in…' : 'Connect wallet to hire'}
              </button>
            </div>
          ) : !hire ? (
            <>
              <div className="card__title" style={{ marginBottom: 4 }}>
                {listing.title}
              </div>
              <div className="card__agent" style={{ marginBottom: 16 }}>
                {listing.agentNametag} · {listing.priceUct} UCT
              </div>
              {err && <div className="formmsg formmsg--bad">{err}</div>}
              <div className="field">
                <label>hiring as</label>
                <div className="whoami">
                  <span className="acct__dot" />
                  {displayName(session)}
                </div>
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
                <button className="btn btn--primary" disabled={busy} onClick={openEscrow}>
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

              {state === 'quoted' && (
                <>
                  <div className="dialog__actions" style={{ marginTop: 14 }}>
                    <button className="btn btn--primary" disabled={paying} onClick={payWithWallet}>
                      {paying ? 'confirm in wallet…' : `Pay ${hire.amountUct} UCT with wallet`}
                    </button>
                  </div>
                  <div className="hint" style={{ marginTop: 8 }}>
                    One click opens your wallet to approve the transfer — the memo is attached automatically. Or
                    send {hire.amountUct} UCT to {hire.payTo} manually with the memo above.
                  </div>
                </>
              )}

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
