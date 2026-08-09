/**
 * Durable persistence for the marketplace snapshot, behind one async interface
 * with two interchangeable backends:
 *
 *   - Postgres (when DATABASE_URL is set): a single JSONB row. Survives process
 *     restarts and redeploys on any host - this is production.
 *   - File (fallback): a JSON file on disk, for local dev with no database.
 *
 * Both round-trip the exact `BazaarService.snapshot()` / `restore()` shape, so
 * the marketplace logic itself is untouched - we only swap where the bytes land.
 */
import pg from 'pg';
import { loadSnapshot, saveSnapshot } from './persist.js';
import type { Logger } from './logger.js';

export interface SnapshotStore<T> {
  readonly kind: 'postgres' | 'file';
  load(): Promise<T | null>;
  save(snapshot: T): Promise<boolean>;
  close(): Promise<void>;
}

/** How long the first round-trip to Postgres may take before boot gives up. */
const STORE_CONNECT_TIMEOUT_MS = 20_000;

/** Reject with `message` if `p` has not settled within `ms`. */
async function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class FileStore<T> implements SnapshotStore<T> {
  readonly kind = 'file' as const;
  constructor(private readonly file: string) {}
  load(): Promise<T | null> {
    return Promise.resolve(loadSnapshot<T>(this.file));
  }
  save(snapshot: T): Promise<boolean> {
    return Promise.resolve(saveSnapshot(this.file, snapshot));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class PgStore<T> implements SnapshotStore<T> {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;
  private readonly ready: Promise<void>;

  constructor(
    databaseUrl: string,
    private readonly logger?: Logger,
  ) {
    // A connect must never wait forever: pg defaults connectionTimeoutMillis to
    // 0 (infinite), so a stalled database (a suspended free-tier instance, a
    // black-holed route) would hang every query - and, at boot, the whole
    // service - with no error to react to.
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 10_000 });
    // A dropped idle connection must not crash the process.
    this.pool.on('error', (err) => this.logger?.warn(`pg pool error: ${err.message}`));
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS bazaar_state (
         id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
         data       jsonb NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
  }

  async load(): Promise<T | null> {
    await this.ready;
    const res = await this.pool.query<{ data: T }>('SELECT data FROM bazaar_state WHERE id = 1');
    return res.rows[0]?.data ?? null;
  }

  async save(snapshot: T): Promise<boolean> {
    try {
      await this.ready;
      await this.pool.query(
        `INSERT INTO bazaar_state (id, data, updated_at) VALUES (1, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [JSON.stringify(snapshot)],
      );
      return true;
    } catch (err) {
      this.logger?.error(`snapshot save failed: ${(err as Error).message}`);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Pick a backend from the environment. A configured DATABASE_URL selects
 * Postgres (and the connection is validated up-front so a misconfiguration
 * fails at boot, not on the first save); otherwise state falls back to a file.
 */
export async function createSnapshotStore<T>(opts: {
  databaseUrl?: string;
  file: string;
  logger?: Logger;
}): Promise<SnapshotStore<T>> {
  if (opts.databaseUrl) {
    const store = new PgStore<T>(opts.databaseUrl, opts.logger);
    // Eager connect + ensure schema; throws if unreachable. Bounded on top of
    // the pool's connect timeout because a socket that connects but never
    // answers would otherwise leave this query - and boot - pending forever.
    // Failing loudly is deliberate: the supervisor restarts us and we retry,
    // which is how a briefly-suspended database heals. Silently falling back to
    // the local file would fork marketplace state away from the real snapshot.
    await withDeadline(store.load(), STORE_CONNECT_TIMEOUT_MS, 'database did not respond');
    return store;
  }
  return new FileStore<T>(opts.file);
}
