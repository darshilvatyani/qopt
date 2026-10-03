import { config } from './config.ts';
import { type Db, errorMessage, getDbs } from './db.ts';
import { migrateMeta } from './meta/store.ts';
import { CHECKSUM_SQL, POST_SEED, seedStatements } from './workload/seed.ts';

export type Log = (msg: string) => void;

async function ensureExtensions(db: Db, names: string[], log: Log): Promise<void> {
  for (const ext of names) {
    try {
      await db.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    } catch (e) {
      log(`  ! ${db.role}: could not create extension ${ext}: ${errorMessage(e)}`);
    }
  }
}

async function seed(db: Db, scale: number, log: Log): Promise<void> {
  const started = Date.now();
  // One session so setseed() governs every random() call that follows.
  await db.withSession(async (s) => {
    await s.query('SET max_parallel_workers_per_gather = 0');
    for (const stmt of seedStatements(scale)) {
      const label = stmt.trim().split('\n')[0].slice(0, 70);
      const t = Date.now();
      await s.query(stmt);
      if (/^(INSERT|ALTER)/i.test(stmt.trim())) log(`  ${db.role}: ${label}… ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
    for (const stmt of POST_SEED) await s.query(stmt);
  });
  log(`  ${db.role}: seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

export async function checksum(db: Db): Promise<string | undefined> {
  try {
    const res = await db.query(CHECKSUM_SQL);
    return res.rows[0]?.checksum;
  } catch {
    return undefined;
  }
}

export interface SetupOptions {
  scale: number;
  seed: boolean;
}

export async function setupAll(opts: SetupOptions, log: Log = console.log): Promise<void> {
  const dbs = getDbs();

  log(`target (${redact(config.targetUrl)})`);
  await ensureExtensions(dbs.targetAdmin, ['pg_stat_statements', 'hypopg', 'pg_trgm'], log);
  if (opts.seed) await seed(dbs.targetAdmin, opts.scale, log);

  if (dbs.shadow) {
    log(`shadow (${redact(config.shadowUrl)})`);
    await ensureExtensions(dbs.shadow, ['hypopg', 'pg_trgm'], log);
    if (opts.seed) await seed(dbs.shadow, opts.scale, log);
  } else {
    log('shadow: SHADOW_URL not set; skipping (validation will be cost-only)');
  }

  if (dbs.meta) {
    log(`meta (${redact(config.metaUrl)})`);
    await migrateMeta(dbs.meta, config.embedDimensions);
    log('  meta: migrated');
  }

  if (opts.seed && dbs.shadow) {
    const [a, b] = await Promise.all([checksum(dbs.targetAdmin), checksum(dbs.shadow)]);
    log(a && a === b ? `data checksum matches (${a.slice(0, 12)})` : `! target/shadow data differ (${a} vs ${b})`);
  }

  try {
    await dbs.targetAdmin.query('SELECT pg_stat_statements_reset()');
    log('pg_stat_statements reset');
  } catch (e) {
    log(`! could not reset pg_stat_statements: ${errorMessage(e)} (is it in shared_preload_libraries?)`);
  }
}

export function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]+@/, '//$1:***@');
}

export interface DbStatus {
  role: string;
  url: string;
  reachable: boolean;
  version?: string;
  extensions: string[];
  tables?: number;
  notes: string[];
}

export async function dbStatus(): Promise<DbStatus[]> {
  const dbs = getDbs();
  const entries: [string, Db | undefined, string][] = [
    ['target', dbs.target, config.targetUrl],
    ['shadow', dbs.shadow, config.shadowUrl],
    ['meta', dbs.meta, config.metaUrl],
  ];
  return Promise.all(
    entries.map(async ([role, db, url]) => {
      const st: DbStatus = { role, url: url ? redact(url) : '(not configured)', reachable: false, extensions: [], notes: [] };
      if (!db) return st;
      try {
        const v = await db.query("SELECT current_setting('server_version') AS v");
        st.reachable = true;
        st.version = v.rows[0].v;
        const ext = await db.query('SELECT extname FROM pg_extension ORDER BY 1');
        st.extensions = ext.rows.map((r) => r.extname);
        const t = await db.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')");
        st.tables = t.rows[0].n;
        if (role === 'target') {
          const pre = await db.query("SELECT current_setting('shared_preload_libraries') AS v");
          const libs = String(pre.rows[0].v);
          if (!libs.includes('pg_stat_statements')) st.notes.push('pg_stat_statements not preloaded: capture disabled');
          if (!libs.includes('auto_explain')) st.notes.push('auto_explain not preloaded: no captured plans with real parameters');
          if (!st.extensions.includes('hypopg')) st.notes.push('hypopg missing: index validation will use the shadow only');
        }
      } catch (e) {
        st.notes.push(errorMessage(e));
      }
      return st;
    }),
  );
}
