import { useEffect, useRef, useState } from 'react';
import {
  api,
  type EscrowState,
  type HireResult,
  type InputField,
  type JobView,
  type Listing,
  type Review,
  type SignedReceipt,
} from './lib/api';
import { useAuth, displayName } from './lib/auth';
import { useToast } from './lib/toast';
import { buildInput, firstMissingRequired, initialValues, type FieldValues } from './lib/schema';

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
  const { session, phase, signIn, wallet, refreshBalance } = useAuth();
  const schema = listing.inputSchema ?? [];
  const [input, setInput] = useState('');
  const [values, setValues] = useState<FieldValues>(() => initialValues(schema));
  const [hire, setHire] = useState<HireResult | null>(null);
  const [jobv, setJobv] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    },
    [],
  );

  const openEscrow = async () => {
    setErr(null);
    if (schema.length > 0) {
      const missing = firstMissingRequired(schema, values);
      if (missing) {
        setErr(`“${missing.label}” is required`);
        return;
      }
    }
    setBusy(true);
    try {
      const parsed =
        schema.length > 0 ? buildInput(schema, values) : input.trim() ? { text: input } : {};
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
      refreshBalance(); // funds left the wallet - reflect the new balance
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
              {schema.length > 0 ? (
                <SchemaFields schema={schema} values={values} onChange={setValues} />
              ) : (
                <div className="field">
                  <label>task input</label>
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Text for the agent to work on…"
                  />
                  <div className="hint">sent to the agent as &#123; text &#125; once the escrow is funded</div>
                </div>
              )}
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
                    One click opens your wallet to approve the transfer - the memo is attached automatically. Or
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
                  <div className="result__h">
                    <span>delivered output</span>
                    <CopyBtn v={pretty(jobv.result.output)} label="copy output" />
                  </div>
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
              {state === 'released' && (
                <ReviewBlock
                  provider={listing.agentNametag}
                  existing={review ?? jobv?.review ?? null}
                  onSubmit={async (stars, text) => {
                    const r = await api.review(hire.job.jobId, stars, text);
                    setReview(r);
                  }}
                />
              )}
              {(jobv?.children?.length || jobv?.parentJobId) && (
                <div className="lineage">
                  <span className="lineage__i">⑃</span>
                  {jobv?.children?.length
                    ? `This agent sub-hired ${jobv.children.length} other agent${jobv.children.length > 1 ? 's' : ''} to complete the job (nested escrow).`
                    : 'This job is part of a larger job that sub-hired it.'}
                </div>
              )}
              {jobv?.receipt && <ReceiptBlock signed={jobv.receipt} />}
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

/** Renders a listing's declared input schema as a typed form. */
function SchemaFields({
  schema,
  values,
  onChange,
}: {
  schema: InputField[];
  values: FieldValues;
  onChange: (v: FieldValues) => void;
}) {
  const set = (name: string, v: string | boolean) => onChange({ ...values, [name]: v });
  return (
    <>
      {schema.map((f) => (
        <div className="field" key={f.name}>
          <label>
            {f.label}
            {f.required && <span className="req"> *</span>}
          </label>
          {f.type === 'textarea' ? (
            <textarea
              value={String(values[f.name] ?? '')}
              onChange={(e) => set(f.name, e.target.value)}
              placeholder={f.placeholder}
            />
          ) : f.type === 'boolean' ? (
            <label className="checkrow">
              <input
                type="checkbox"
                checked={values[f.name] === true}
                onChange={(e) => set(f.name, e.target.checked)}
              />
              <span>{f.placeholder ?? 'yes'}</span>
            </label>
          ) : (
            <input
              type={f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}
              value={String(values[f.name] ?? '')}
              onChange={(e) => set(f.name, e.target.value)}
              placeholder={f.placeholder}
            />
          )}
          {f.help && <div className="hint">{f.help}</div>}
        </div>
      ))}
    </>
  );
}

function statusText(s: EscrowState): string {
  switch (s) {
    case 'quoted':
      return 'waiting for your payment into escrow…';
    case 'funded':
      return 'funded - the agent is working…';
    case 'delivered':
      return 'delivered - review, then release the funds.';
    case 'released':
      return 'released - the agent has been paid. Done!';
    case 'refunded':
      return 'refunded - the funds were returned to you.';
    case 'disputed':
      return 'disputed - pending resolution.';
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
/** The signed, independently-verifiable proof that the escrow settled. */
function ReceiptBlock({ signed }: { signed: SignedReceipt }) {
  const toast = useToast();
  const [state, setState] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const r = signed.receipt;

  const verify = async () => {
    setState('checking');
    try {
      const { valid } = await api.verifyReceipt(signed);
      setState(valid ? 'valid' : 'invalid');
      toast(valid ? 'Receipt signature verified' : 'Receipt did not verify', valid ? 'ok' : 'bad');
    } catch (e) {
      setState('idle');
      toast(e instanceof Error ? e.message : 'could not verify', 'bad');
    }
  };

  return (
    <div className="receiptbox">
      <div className="receiptbox__h">
        <span>⛓ settlement receipt</span>
        <CopyBtn v={JSON.stringify(signed, null, 2)} label="copy receipt" />
      </div>
      <div className="receiptbox__grid">
        <span>outcome</span>
        <b>{r.outcome === 'release' ? 'released to provider' : 'refunded to buyer'}</b>
        <span>amount</span>
        <b>{r.amountUct} UCT</b>
        <span>signed by</span>
        <b title={signed.signer}>escrow · {signed.signer.slice(0, 10)}…</b>
        {r.txId && (
          <>
            <span>on-chain tx</span>
            <b title={r.txId}>{r.txId.slice(0, 16)}…</b>
          </>
        )}
      </div>
      <div className="receiptbox__foot">
        <button
          className={`btn btn--sm${state === 'valid' ? ' btn--ok' : ''}`}
          disabled={state === 'checking'}
          onClick={() => void verify()}
        >
          {state === 'checking'
            ? 'verifying…'
            : state === 'valid'
              ? '✓ signature verified'
              : state === 'invalid'
                ? '✗ invalid'
                : 'Verify signature'}
        </button>
        <span className="receiptbox__note">
          signed by the escrow wallet - anyone can verify it offline with the Sphere SDK.
        </span>
      </div>
    </div>
  );
}

function CopyBtn({ v, label = 'copy' }: { v: string; label?: string }) {
  const toast = useToast();
  return (
    <button
      className="copy"
      onClick={() => {
        void navigator.clipboard?.writeText(v);
        toast('Copied to clipboard', 'info');
      }}
    >
      {label}
    </button>
  );
}

function ReviewBlock({
  provider,
  existing,
  onSubmit,
}: {
  provider: string;
  existing: Review | null;
  onSubmit: (stars: number, text: string) => Promise<void>;
}) {
  const [stars, setStars] = useState(5);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (existing) {
    return (
      <div className="reviewbox reviewbox--done">
        <div className="reviewbox__h">your review</div>
        <div className="stars stars--static">
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} className={n <= existing.stars ? 'star star--on' : 'star'}>
              ★
            </span>
          ))}
        </div>
        {existing.text && <p className="reviewbox__text">“{existing.text}”</p>}
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(stars, text.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not post review');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reviewbox">
      <div className="reviewbox__h">rate {provider}</div>
      <div className="stars" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className={n <= (hover || stars) ? 'star star--on' : 'star'}
            onMouseEnter={() => setHover(n)}
            onClick={() => setStars(n)}
            aria-label={`${n} stars`}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        className="reviewbox__input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="How did it go? (optional)"
        maxLength={600}
      />
      {err && <div className="formmsg formmsg--bad">{err}</div>}
      <button className="btn btn--primary btn--sm" disabled={busy} onClick={submit}>
        {busy ? 'posting…' : 'Post review'}
      </button>
    </div>
  );
}
