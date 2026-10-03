import { type Db, errorMessage } from '../db.ts';
import { normalizeExplain } from '../plan/tree.ts';
import type { CapturedQuery, ExplainResult } from '../types.ts';

// Capture = pg_stat_statements (what is slow in aggregate) joined with auto_explain log entries
// (a real execution of that statement: literal parameters plus the actual plan).

const STATEMENTS_SQL = `
  SELECT queryid::text AS queryid, query, calls, total_exec_time, mean_exec_time, max_exec_time, rows,
         shared_blks_hit, shared_blks_read, temp_blks_written
  FROM pg_stat_statements
  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND toplevel
    AND query NOT LIKE '/*qopt*/%'
    AND query ~* '^\\s*(select|with|insert|update|delete)\\M'
    AND query !~* '\\m(pg_catalog|information_schema|pg_stat_statements|pg_stat_[a-z_]+|hypopg[a-z_]*|pg_class|pg_namespace|pg_index|pg_attribute|pg_extension|pg_settings|pg_database|pg_ls_logdir|pg_read_file)\\M'
    %FILTER%
  ORDER BY total_exec_time DESC
  LIMIT $1`;

function toCaptured(row: any): CapturedQuery {
  return {
    queryid: row.queryid,
    query: row.query,
    calls: row.calls,
    totalMs: row.total_exec_time,
    meanMs: row.mean_exec_time,
    maxMs: row.max_exec_time,
    rows: row.rows,
    sharedBlksHit: row.shared_blks_hit,
    sharedBlksRead: row.shared_blks_read,
    tempBlksWritten: row.temp_blks_written,
  };
}

export interface PlanSample {
  queryid: string;
  queryText: string;
  durationMs: number;
  loggedAt: string;
  plan: ExplainResult;
}

// query_id is a signed 64-bit hash: JSON.parse would round it, so read it from the raw text.
const QUERY_ID_RE = /"query_id":(-?\d+)/;
const DURATION_RE = /^duration: ([\d.]+) ms\s+plan:\n/;

/** Parse jsonlog lines written by auto_explain (log_format = json, log_destination = jsonlog). */
export function parseAutoExplainLog(text: string): PlanSample[] {
  const out: PlanSample[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"message":"duration: ')) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.application_name === 'string' && rec.application_name.startsWith('qopt-')) continue;
    const qid = QUERY_ID_RE.exec(line)?.[1];
    const m = DURATION_RE.exec(rec.message ?? '');
    if (!qid || qid === '0' || !m) continue;
    try {
      const doc = JSON.parse(rec.message.slice(m[0].length));
      const plan = normalizeExplain(doc);
      out.push({ queryid: qid, queryText: doc['Query Text'], durationMs: Number(m[1]), loggedAt: rec.timestamp, plan });
    } catch {
      // Truncated or non-JSON plan (e.g. log_format = text); skip.
    }
  }
  return out;
}

export interface CaptureResult {
  queries: CapturedQuery[];
  warnings: string[];
}

/** Reads the newest jsonlog files through SQL (pg_ls_logdir / pg_read_file), so it works for Docker and remote servers. */
export async function readPlanSamples(db: Db, maxBytes = 32 * 1024 * 1024): Promise<{ samples: PlanSample[]; warning?: string }> {
  try {
    const files = await db.query(
      "SELECT name, size FROM pg_ls_logdir() WHERE name LIKE '%.json' ORDER BY modification DESC LIMIT 3",
    );
    const samples: PlanSample[] = [];
    let budget = maxBytes;
    for (const f of files.rows) {
      if (budget <= 0) break;
      const size = Number(f.size);
      const len = Math.min(size, budget);
      const offset = size - len;
      const res = await db.query(
        "SELECT pg_read_file(current_setting('log_directory') || '/' || $1, $2, $3) AS body",
        [f.name, offset, len],
      );
      let body: string = res.rows[0]?.body ?? '';
      if (offset > 0) body = body.slice(body.indexOf('\n') + 1); // first line is partial
      samples.push(...parseAutoExplainLog(body));
      budget -= len;
    }
    return { samples };
  } catch (e) {
    return { samples: [], warning: `could not read auto_explain logs (${errorMessage(e)}); need superuser or pg_read_server_files + pg_monitor` };
  }
}

function attachSamples(queries: CapturedQuery[], samples: PlanSample[]): void {
  const best = new Map<string, PlanSample>();
  for (const s of samples) {
    const cur = best.get(s.queryid);
    if (!cur || s.durationMs > cur.durationMs) best.set(s.queryid, s);
  }
  for (const q of queries) {
    const s = best.get(q.queryid);
    if (s) q.sample = { queryText: s.queryText, durationMs: s.durationMs, loggedAt: s.loggedAt, plan: s.plan };
  }
}

export async function captureSlowQueries(db: Db, limit = 20): Promise<CaptureResult> {
  const warnings: string[] = [];
  let rows: any[];
  try {
    rows = (await db.query(STATEMENTS_SQL.replace('%FILTER%', ''), [limit])).rows;
  } catch (e) {
    return { queries: [], warnings: [`pg_stat_statements unavailable: ${errorMessage(e)}`] };
  }
  const queries = rows.map(toCaptured);
  const { samples, warning } = await readPlanSamples(db);
  if (warning) warnings.push(warning);
  attachSamples(queries, samples);
  return { queries, warnings };
}

export async function getCapturedQuery(db: Db, queryid: string): Promise<CapturedQuery | undefined> {
  const res = await db.query(STATEMENTS_SQL.replace('%FILTER%', 'AND queryid::text = $2'), [1, queryid]);
  if (!res.rows.length) return undefined;
  const q = toCaptured(res.rows[0]);
  const { samples } = await readPlanSamples(db);
  attachSamples([q], samples);
  return q;
}
