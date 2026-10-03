import pg from 'pg';
import { config } from './config.ts';

// int8 and numeric arrive as strings by default. Row counts, sizes and costs fit in a double;
// the one int8 that doesn't (pg_stat_statements.queryid) is always selected as ::text.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type DbRole = 'target' | 'target-admin' | 'shadow' | 'meta';

/** Comment prefixed to every statement qopt itself sends to the target, so capture can ignore them. */
export const QOPT_TAG = '/*qopt*/';

export interface DbOptions {
  readOnly?: boolean;
  statementTimeoutMs?: number;
  tag?: boolean;
  max?: number;
}

export class Session {
  constructor(
    readonly client: pg.PoolClient,
    private readonly tag: boolean,
  ) {}

  query<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.client.query<R>(this.tag ? `${QOPT_TAG} ${sql}` : sql, params as any[]);
  }
}

export class Db {
  readonly pool: pg.Pool;

  constructor(
    readonly role: DbRole,
    readonly url: string,
    private readonly opts: DbOptions = {},
  ) {
    const settings: string[] = [];
    if (opts.statementTimeoutMs) settings.push(`-c statement_timeout=${opts.statementTimeoutMs}`);
    if (opts.readOnly) settings.push('-c default_transaction_read_only=on');
    this.pool = new pg.Pool({
      connectionString: url,
      application_name: `qopt-${role}`,
      max: opts.max ?? 4,
      options: settings.length ? settings.join(' ') : undefined,
    });
    // An idle client erroring (e.g. server restart) must not crash the process.
    this.pool.on('error', () => {});
  }

  query<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(this.opts.tag ? `${QOPT_TAG} ${sql}` : sql, params as any[]);
  }

  async withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(new Session(client, !!this.opts.tag));
    } finally {
      client.release();
    }
  }

  /** Runs fn inside a transaction that is always rolled back: the lab pattern used for every experiment. */
  sandbox<T>(fn: (s: Session) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
    return this.withSession(async (s) => {
      await s.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      try {
        return await fn(s);
      } finally {
        await s.query('ROLLBACK').catch(() => {});
      }
    });
  }

  /** Runs fn inside a committed transaction. */
  tx<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    return this.withSession(async (s) => {
      await s.query('BEGIN');
      try {
        const out = await fn(s);
        await s.query('COMMIT');
        return out;
      } catch (e) {
        await s.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export interface Dbs {
  /** Read-only, tagged connection to the tuned database. */
  target: Db;
  /** Writable connection to the target, used only by setup and the workload generator. */
  targetAdmin: Db;
  shadow?: Db;
  meta?: Db;
}

let dbs: Dbs | undefined;

export function getDbs(): Dbs {
  if (dbs) return dbs;
  const timeout = config.statementTimeoutMs;
  dbs = {
    target: new Db('target', config.targetUrl, { readOnly: true, statementTimeoutMs: timeout, tag: true }),
    targetAdmin: new Db('target-admin', config.targetUrl, { max: 2 }),
    shadow: config.shadowUrl ? new Db('shadow', config.shadowUrl, { statementTimeoutMs: timeout, max: 4 }) : undefined,
    meta: config.metaUrl ? new Db('meta', config.metaUrl, { max: 4 }) : undefined,
  };
  return dbs;
}

export async function closeDbs(): Promise<void> {
  if (!dbs) return;
  const all = [dbs.target, dbs.targetAdmin, dbs.shadow, dbs.meta].filter(Boolean) as Db[];
  dbs = undefined;
  await Promise.all(all.map((d) => d.close().catch(() => {})));
}

export function pgErrorCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Quote an identifier the way Postgres does (only when needed). */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}
