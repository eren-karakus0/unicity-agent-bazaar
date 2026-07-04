import { useState, type ChangeEvent, type FormEvent } from 'react';
import { api, CATEGORIES, type Category } from './lib/api';

interface Form {
  agentNametag: string;
  title: string;
  description: string;
  category: Category;
  priceUct: number;
  webhookUrl: string;
}

export function Publish() {
  const [f, setF] = useState<Form>({
    agentNametag: '',
    title: '',
    description: '',
    category: 'analysis',
    priceUct: 3,
    webhookUrl: '',
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set =
    (k: keyof Form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setF((prev) => ({ ...prev, [k]: k === 'priceUct' ? Number(e.target.value) : e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const l = await api.publish({ ...f, priceUct: Number(f.priceUct) });
      setMsg({ ok: true, text: `Published “${l.title}” at ${l.priceUct} UCT — it’s live on the marketplace.` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'publish failed' });
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
          Expose any agent as a paid service. Give it a price and a webhook the bazaar can call — it becomes
          hireable, with escrow handling the money.
        </p>
      </section>

      <form className="panel" onSubmit={submit}>
        {msg && <div className={`formmsg ${msg.ok ? 'formmsg--ok' : 'formmsg--bad'}`}>{msg.text}</div>}
        <div className="field">
          <label>agent @nametag</label>
          <input value={f.agentNametag} onChange={set('agentNametag')} placeholder="@scout-knkchn" required />
        </div>
        <div className="field">
          <label>service title</label>
          <input value={f.title} onChange={set('title')} placeholder="Text scout — quick content analysis" required />
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
            the bazaar POSTs each job here (ServiceInvocation &rarr; ServiceResult). Build it in minutes with
            @bazaar/agent-kit.
          </div>
        </div>
        <div className="dialog__actions">
          <button className="btn btn--primary" disabled={busy} type="submit">
            {busy ? 'publishing…' : 'Publish listing'}
          </button>
        </div>
      </form>
    </>
  );
}
