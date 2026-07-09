import { useCallback, useEffect, useState } from 'react';
import {
  api,
  CATEGORIES,
  canonicalMandate,
  type Category,
  type MandateStatus,
  type SpendingMandate,
} from './lib/api';
import { useAuth } from './lib/auth';
import { useToast } from './lib/toast';

const STORE_KEY = 'bazaar-mandates';
const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/;

function loadIds(): string[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveIds(ids: string[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable - non-fatal */
  }
}

function shortKey(pk: string): string {
  return `${pk.slice(0, 8)}…${pk.slice(-6)}`;
}

export function Delegations() {
  const { session, wallet } = useAuth();
  const toast = useToast();

  const [agent, setAgent] = useState('');
  const [maxTotal, setMaxTotal] = useState('50');
  const [maxPerJob, setMaxPerJob] = useState('10');
  const [cats, setCats] = useState<Set<Category>>(new Set());
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);

  const [ids, setIds] = useState<string[]>(loadIds);
  const [statuses, setStatuses] = useState<Record<string, MandateStatus | null>>({});

  const refresh = useCallback((list: string[]) => {
    for (const id of list) {
      api
        .mandateStatus(id)
        .then((s) => setStatuses((prev) => ({ ...prev, [id]: s })))
        .catch(() => setStatuses((prev) => ({ ...prev, [id]: null })));
    }
  }, []);

  useEffect(() => {
    refresh(ids);
  }, []);

  if (!session) {
    return <div className="empty">Connect your wallet to create spending delegations.</div>;
  }

  const toggleCat = (c: Category) => {
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const create = async () => {
    const agentPk = agent.trim().toLowerCase();
    if (!PUBKEY_RE.test(agentPk)) {
      toast('Enter a valid agent chain pubkey (0x02/03 + 64 hex).', 'bad');
      return;
    }
    const total = Number(maxTotal);
    const perJob = Number(maxPerJob);
    const expDays = Number(days);
    if (!(total > 0) || !(perJob > 0)) {
      toast('Budgets must be positive.', 'bad');
      return;
    }
    if (perJob > total) {
      toast('Per-job cap cannot exceed the total budget.', 'bad');
      return;
    }
    const mandate: SpendingMandate = {
      v: 1,
      mandateId: crypto.randomUUID(),
      buyer: session.chainPubkey,
      agent: agentPk,
      maxTotalUct: Math.floor(total),
      maxPerJobUct: Math.floor(perJob),
      categories: cats.size ? [...cats] : ['*'],
      expiresAt: Date.now() + Math.max(1, Math.floor(expDays)) * 86_400_000,
      createdAt: Date.now(),
    };

    setBusy(true);
    try {
      const signature = await wallet.signMessage(canonicalMandate(mandate)); // wallet approval UI
      await api.registerMandate({ mandate, signature, signer: session.chainPubkey });
      const next = [mandate.mandateId, ...ids];
      setIds(next);
      saveIds(next);
      refresh([mandate.mandateId]);
      toast('Delegation signed and registered.', 'ok');
      setAgent('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'could not create delegation', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const forget = (id: string) => {
    const next = ids.filter((x) => x !== id);
    setIds(next);
    saveIds(next);
  };

  return (
    <>
      <section className="dele-hero">
        <div className="hero__kick">delegated spend</div>
        <h1 className="dele-hero__h">Spending delegations</h1>
        <p className="dele-hero__sub">
          Authorize an agent to hire on your behalf, up to a budget you sign for. The platform
          enforces the caps and anyone can verify your signature. This is authorization, not
          custody - the agent funds each escrow from its own wallet, and never spends past your
          limits.
        </p>
      </section>

      <div className="dele">
        <form
          className="dele-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="sec">
            <span className="sec__t">New delegation</span>
          </div>

          <div className="field">
            <label>agent chain pubkey</label>
            <input
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="02… the agent's compressed pubkey (66 hex)"
              spellCheck={false}
            />
            <div className="hint">The agent you&rsquo;re authorizing (e.g. your MCP agent&rsquo;s wallet key).</div>
          </div>

          <div className="dele-form__row">
            <div className="field">
              <label>total budget (UCT)</label>
              <input type="number" min={1} value={maxTotal} onChange={(e) => setMaxTotal(e.target.value)} />
            </div>
            <div className="field">
              <label>per-job cap (UCT)</label>
              <input type="number" min={1} value={maxPerJob} onChange={(e) => setMaxPerJob(e.target.value)} />
            </div>
            <div className="field">
              <label>expires in (days)</label>
              <input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
          </div>

          <div className="field">
            <label>allowed categories</label>
            <div className="dele-cats">
              {CATEGORIES.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`pill${cats.has(c) ? ' pill--on' : ''}`}
                  onClick={() => toggleCat(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="hint">{cats.size ? ' ' : 'None selected = any category allowed.'}</div>
          </div>

          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'waiting for wallet…' : 'Sign & create delegation'}
          </button>
        </form>

        <div className="dele-list">
          <div className="sec">
            <span className="sec__t">Your delegations</span>
            <span className="sec__c">{ids.length}</span>
          </div>
          {ids.length === 0 ? (
            <div className="dele-empty">No delegations yet. Create one to let an agent hire for you.</div>
          ) : (
            ids.map((id) => (
              <MandateCard key={id} id={id} status={statuses[id]} onForget={() => forget(id)} />
            ))
          )}
        </div>
      </div>
    </>
  );
}

function MandateCard({
  id,
  status,
  onForget,
}: {
  id: string;
  status: MandateStatus | null | undefined;
  onForget: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(id)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => undefined);
  };

  const pct = status && status.maxTotalUct > 0 ? Math.min(100, (status.spentUct / status.maxTotalUct) * 100) : 0;
  const state = status === undefined ? 'loading' : status === null ? 'gone' : status.active ? 'active' : status.expired ? 'expired' : 'spent';

  return (
    <div className="mand">
      <div className="mand__top">
        <span className={`mand__state mand__state--${state}`}>{state}</span>
        <code className="mand__id" title={id}>
          {id.slice(0, 18)}…
        </code>
        <button className={`btn btn--sm ${copied ? 'btn--ok' : ''}`} onClick={copy}>
          {copied ? '✓ id copied' : 'copy id'}
        </button>
        <button className="mand__x" onClick={onForget} title="Remove from this list (does not revoke)">
          ×
        </button>
      </div>
      {status ? (
        <>
          <div className="mand__grid">
            <span>agent</span>
            <b>{shortKey(status.agent)}</b>
            <span>spent</span>
            <b>
              {status.spentUct} / {status.maxTotalUct} UCT · {status.jobs} job{status.jobs === 1 ? '' : 's'}
            </b>
            <span>per-job</span>
            <b>{status.maxPerJobUct} UCT max</b>
            <span>categories</span>
            <b>{status.categories.includes('*') ? 'any' : status.categories.join(', ')}</b>
          </div>
          <div className="mand__bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="mand__note">
            Give this id to your agent (or its <code>hire_agent</code> MCP tool) to spend under it.
          </div>
        </>
      ) : status === null ? (
        <div className="mand__note">Not found on the server - it may have expired off an ephemeral backend.</div>
      ) : (
        <div className="mand__note">loading status…</div>
      )}
    </div>
  );
}
