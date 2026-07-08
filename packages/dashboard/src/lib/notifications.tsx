import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type JobSummary } from './api';
import { useAuth } from './auth';
import { useToast } from './toast';

export interface AppNotification {
  /** jobId + state — stable, so the same transition is never shown twice. */
  id: string;
  title: string;
  body: string;
  at: number;
  read: boolean;
  jobId: string;
}

interface Ctx {
  items: AppNotification[];
  unread: number;
  markAllRead: () => void;
  clear: () => void;
}

const NotificationsContext = createContext<Ctx | null>(null);

/** The job-state transitions worth surfacing, framed for the viewer's role. */
function noticeFor(job: JobSummary): { title: string; body: string } | null {
  const what = job.listingTitle ? `“${job.listingTitle}”` : 'your order';
  if (job.role === 'buyer') {
    if (job.state === 'delivered') return { title: 'Delivery ready', body: `${what} was delivered — review & release.` };
    if (job.state === 'released') return { title: 'Order complete', body: `${what} released to the provider.` };
    if (job.state === 'refunded') return { title: 'Refunded', body: `Your ${job.amountUct} UCT for ${what} came back.` };
  } else {
    const svc = job.listingTitle ? `“${job.listingTitle}”` : 'your agent';
    if (job.state === 'funded') return { title: 'New job funded', body: `Someone hired ${svc} — ${job.amountUct} UCT in escrow.` };
    if (job.state === 'released') return { title: 'You got paid', body: `${job.amountUct} UCT released for ${svc}.` };
    if (job.state === 'refunded') return { title: 'Job refunded', body: `${svc} was refunded to the buyer.` };
  }
  return null;
}

function dedupe(list: AppNotification[]): AppNotification[] {
  const seen = new Set<string>();
  return list.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
}

/**
 * In-app notifications without server push: poll the signed-in user's own jobs
 * and raise a notice whenever one crosses a meaningful state. The first poll
 * only establishes a baseline, so we never replay history on sign-in.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { phase } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<AppNotification[]>([]);
  const lastState = useRef<Map<string, string>>(new Map());
  const primed = useRef(false);

  useEffect(() => {
    if (phase !== 'authenticated') {
      lastState.current = new Map();
      primed.current = false;
      setItems([]);
      return;
    }
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const p = await api.myProfile();
        const jobs: JobSummary[] = [...p.asBuyer, ...p.asProvider];
        const fresh: AppNotification[] = [];
        for (const job of jobs) {
          const prev = lastState.current.get(job.jobId);
          lastState.current.set(job.jobId, job.state);
          if (!primed.current || prev === job.state) continue;
          const n = noticeFor(job);
          if (n) fresh.push({ id: `${job.jobId}:${job.state}`, ...n, at: Date.now(), read: false, jobId: job.jobId });
        }
        primed.current = true;
        if (fresh.length) {
          setItems((prevItems) => dedupe([...fresh, ...prevItems]).slice(0, 30));
          for (const n of fresh) toast(`${n.title} — ${n.body}`, 'info');
        }
      } catch {
        /* backend asleep or offline — retry on the next tick */
      }
      if (!stopped) timer = window.setTimeout(tick, 12_000);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [phase, toast]);

  const markAllRead = () => setItems((prev) => prev.map((n) => ({ ...n, read: true })));
  const clear = () => setItems([]);
  const unread = items.reduce((n, i) => n + (i.read ? 0 : 1), 0);

  return (
    <NotificationsContext.Provider value={{ items, unread, markAllRead, clear }}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): Ctx {
  const c = useContext(NotificationsContext);
  if (!c) throw new Error('useNotifications used outside NotificationsProvider');
  return c;
}
