import { useState, type ChangeEvent, type FormEvent } from 'react';
import {
  api,
  CATEGORIES,
  INPUT_FIELD_TYPES,
  type Category,
  type InputField,
  type InputFieldType,
  type Listing,
  type ListingHealth,
  type ServiceResult,
} from './lib/api';
import { useAuth, displayName } from './lib/auth';
import { useToast } from './lib/toast';
import { go } from './lib/nav';
import { sampleJson } from './lib/schema';

interface Form {
  title: string;
  description: string;
  category: Category;
  priceUct: number;
  webhookUrl: string;
}

/** A row in the input-schema builder (name is derived from the label at publish). */
interface BuilderField {
  label: string;
  type: InputFieldType;
  required: boolean;
}

const slugKey = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);

/** Turn builder rows into a clean, de-duplicated InputField[] for the API. */
function finalizeSchema(rows: BuilderField[]): InputField[] {
  const used = new Set<string>();
  return rows
    .filter((r) => r.label.trim())
    .map((r, i) => {
      const base = slugKey(r.label) || `field_${i + 1}`;
      let name = base;
      let k = 2;
      while (used.has(name)) name = `${base}_${k++}`;
      used.add(name);
      return { name, label: r.label.trim(), type: r.type, ...(r.required ? { required: true } : {}) };
    });
}

interface Published {
  listing: Listing;
  webhookSecret?: string;
  health?: ListingHealth;
}

export function Publish() {
  const { session, phase, signIn } = useAuth();
  const toast = useToast();
  const [f, setF] = useState<Form>({
    title: '',
    description: '',
    category: 'analysis',
    priceUct: 3,
    webhookUrl: '',
  });
  const [fields, setFields] = useState<BuilderField[]>([]);
  const [published, setPublished] = useState<Published | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set =
    (k: keyof Form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setF((prev) => ({ ...prev, [k]: k === 'priceUct' ? Number(e.target.value) : e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const inputSchema = finalizeSchema(fields);
      const res = await api.publish({
        ...f,
        priceUct: Number(f.priceUct),
        ...(inputSchema.length ? { inputSchema } : {}),
      });
      setPublished(res);
      toast(`Published “${res.listing.title}”`, 'ok');
      setF({ title: '', description: '', category: 'analysis', priceUct: 3, webhookUrl: '' });
      setFields([]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      const text = err instanceof Error ? err.message : 'publish failed';
      setError(text);
      toast(text, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="hero" style={{ paddingBottom: 12 }}>
        <div className="hero__kick">list your agent</div>
        <h1 className="hero__h" style={{ fontSize: 'clamp(34px, 5vw, 60px)' }}>
          Publish an <span>agent</span>
        </h1>
        <p className="hero__sub">
          Expose any agent as a paid service. Give it a price and a webhook the bazaar can call - it becomes
          hireable, with escrow handling the money.
        </p>
      </section>

      {published && <PublishSuccess data={published} onDismiss={() => setPublished(null)} />}

      {phase !== 'authenticated' ? (
        <div className="panel gate">
          <h3 className="gate__h">Sign in to publish</h3>
          <p className="gate__p">
            Listings are owned by the wallet that publishes them - connect yours and sign a one-time message to
            prove it. No funds move; it just links the listing to your on-chain identity.
          </p>
          <button className="btn btn--primary" disabled={phase === 'signing-in'} onClick={() => void signIn()}>
            {phase === 'signing-in' ? 'signing in…' : 'Connect wallet to publish'}
          </button>
        </div>
      ) : (
        <form className="panel" onSubmit={submit}>
          {error && <div className="formmsg formmsg--bad">{error}</div>}
          <div className="field">
            <label>publishing as</label>
            <div className="whoami">
              <span className="acct__dot" />
              {displayName(session)}
              {!session?.nametag && (
                <span className="whoami__hint">- register a @nametag in your wallet for a friendlier handle</span>
              )}
            </div>
          </div>
          <div className="field">
            <label>service title</label>
            <input value={f.title} onChange={set('title')} placeholder="Text scout - quick content analysis" required />
          </div>
          <div className="field">
            <label>description</label>
            <textarea
              value={f.description}
              onChange={set('description')}
              placeholder="What does your agent do, and what input does it expect?"
              required
            />
          </div>
          <div className="field field--row">
            <div>
              <label>category</label>
              <select value={f.category} onChange={set('category')}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>price (UCT)</label>
              <input type="number" min={1} value={f.priceUct} onChange={set('priceUct')} />
            </div>
          </div>
          <div className="field">
            <label>webhook URL</label>
            <input value={f.webhookUrl} onChange={set('webhookUrl')} placeholder="https://my-agent.example.com/hook" required />
            <div className="hint">
              the bazaar POSTs each job here (ServiceInvocation &rarr; ServiceResult), signed so you can verify it.
              Build it in minutes with @bazaar/agent-kit.
            </div>
          </div>

          <SchemaBuilder fields={fields} onChange={setFields} />

          <div className="dialog__actions">
            <button className="btn btn--primary" disabled={busy} type="submit">
              {busy ? 'publishing…' : 'Publish listing'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

/** Optional builder: declare the typed input fields the hire form should render. */
function SchemaBuilder({ fields, onChange }: { fields: BuilderField[]; onChange: (f: BuilderField[]) => void }) {
  const add = () => onChange([...fields, { label: '', type: 'text', required: false }]);
  const update = (i: number, patch: Partial<BuilderField>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(fields.filter((_, j) => j !== i));

  return (
    <div className="field">
      <label>input fields <span className="whoami__hint">- optional; buyers get a typed form instead of a text box</span></label>
      {fields.length === 0 && (
        <div className="hint" style={{ marginBottom: 8 }}>
          No fields yet - buyers will send a single free-text input. Add fields to define exactly what your agent
          expects.
        </div>
      )}
      <div className="fieldrows">
        {fields.map((f, i) => (
          <div className="fieldrow" key={i}>
            <input
              className="fieldrow__label"
              value={f.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Field label (e.g. Repository URL)"
            />
            <select value={f.type} onChange={(e) => update(i, { type: e.target.value as InputFieldType })}>
              {INPUT_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label className="fieldrow__req" title="required">
              <input
                type="checkbox"
                checked={f.required}
                onChange={(e) => update(i, { required: e.target.checked })}
              />
              req
            </label>
            <button type="button" className="fieldrow__x" onClick={() => remove(i)} aria-label="remove field">
              ✕
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn--ghost btn--sm" onClick={add} style={{ marginTop: 8 }}>
        + add field
      </button>
    </div>
  );
}

/** Post-publish console: secret handoff, reachability, and a live test invocation. */
function PublishSuccess({ data, onDismiss }: { data: Published; onDismiss: () => void }) {
  const toast = useToast();
  const [health, setHealth] = useState<ListingHealth | undefined>(data.health);
  const [checking, setChecking] = useState(false);
  const [testInput, setTestInput] = useState(() =>
    data.listing.inputSchema?.length ? sampleJson(data.listing.inputSchema) : '{\n  "example": "value"\n}',
  );
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ServiceResult | null>(null);
  const [secretShown, setSecretShown] = useState(false);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`, 'ok');
    } catch {
      toast('copy failed - select and copy manually', 'bad');
    }
  };

  const recheck = async () => {
    setChecking(true);
    try {
      setHealth(await api.recheckHealth(data.listing.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'health check failed', 'bad');
    } finally {
      setChecking(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    let input: unknown = testInput;
    try {
      input = JSON.parse(testInput);
    } catch {
      // not JSON - send the raw string as the input
    }
    try {
      setResult(await api.testInvoke(data.listing.id, input));
    } catch (e) {
      setResult({ jobId: 'test', ok: false, error: e instanceof Error ? e.message : 'test failed' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="panel publish-ok">
      <div className="publish-ok__head">
        <div>
          <div className="publish-ok__kick">live on the marketplace</div>
          <h3 className="publish-ok__h">“{data.listing.title}” is published</h3>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={onDismiss} aria-label="dismiss">
          ✕
        </button>
      </div>

      <div className="publish-ok__row">
        <HealthPill health={health} />
        <button className="btn btn--ghost btn--sm" disabled={checking} onClick={() => void recheck()}>
          {checking ? 'checking…' : 're-check'}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => go('/profile')}>
          View in your profile →
        </button>
      </div>

      {data.webhookSecret && (
        <div className="secretbox">
          <div className="secretbox__label">
            signing secret <span className="secretbox__once">shown once - save it now</span>
          </div>
          <p className="secretbox__hint">
            The bazaar signs every job POST with this secret (header <code>x-bazaar-signature</code>). Verify it in
            your agent so only real, escrow-backed jobs run. Pass it as <code>secret</code> to{' '}
            <code>createAgentServer</code>.
          </p>
          <div className="secretbox__row">
            <code className="secretbox__code">
              {secretShown ? data.webhookSecret : '•'.repeat(Math.min(48, data.webhookSecret.length))}
            </code>
            <button className="btn btn--ghost btn--sm" onClick={() => setSecretShown((s) => !s)}>
              {secretShown ? 'hide' : 'reveal'}
            </button>
            <button className="btn btn--primary btn--sm" onClick={() => void copy(data.webhookSecret!, 'Secret')}>
              copy
            </button>
          </div>
        </div>
      )}

      <div className="testbox">
        <div className="testbox__label">test invocation</div>
        <p className="secretbox__hint">
          Send a sample input straight to your webhook (no escrow, no charge) to confirm it answers before a buyer
          hires it.
        </p>
        <textarea
          className="testbox__in"
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          spellCheck={false}
          rows={4}
        />
        <div className="testbox__actions">
          <button className="btn btn--primary btn--sm" disabled={testing} onClick={() => void runTest()}>
            {testing ? 'calling your agent…' : 'Run test'}
          </button>
        </div>
        {result && (
          <div className={`testresult ${result.ok ? 'testresult--ok' : 'testresult--bad'}`}>
            <div className="testresult__head">
              <span>{result.ok ? '✓ agent responded' : '✕ call failed'}</span>
              <button
                className="copy"
                onClick={() =>
                  void copy(
                    result.ok
                      ? JSON.stringify(result.output ?? null, null, 2)
                      : (result.error ?? 'no error detail'),
                    'Output',
                  )
                }
              >
                copy output
              </button>
            </div>
            <pre className="testresult__body">
              {result.ok
                ? JSON.stringify(result.output ?? null, null, 2)
                : (result.error ?? 'no error detail')}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function HealthPill({ health }: { health?: ListingHealth }) {
  if (!health) return <span className="hpill hpill--unknown">reachability unknown</span>;
  if (health.ok) return <span className="hpill hpill--ok">✓ verified - endpoint reachable</span>;
  return <span className="hpill hpill--bad">unreachable{health.detail ? ` - ${health.detail}` : ''}</span>;
}
