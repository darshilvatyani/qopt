import type { Session } from '../db.ts';
import type { ExplainResult } from '../types.ts';
import { normalizeExplain } from './tree.ts';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

function stripSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

/** Plain EXPLAIN: plans without executing. Safe on production; this is what HypoPG influences. */
export async function explainCost(db: Queryable, sql: string, opts: { generic?: boolean } = {}): Promise<ExplainResult> {
  const flags = ['FORMAT JSON', ...(opts.generic ? ['GENERIC_PLAN'] : [])];
  const res = await db.query(`EXPLAIN (${flags.join(', ')}) ${stripSemicolon(sql)}`);
  return normalizeExplain(res.rows[0]['QUERY PLAN']);
}

/** EXPLAIN ANALYZE: executes the statement. Only ever called against the shadow. */
export async function explainAnalyze(s: Queryable, sql: string): Promise<ExplainResult> {
  const res = await s.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${stripSemicolon(sql)}`);
  return normalizeExplain(res.rows[0]['QUERY PLAN']);
}

export interface Measurement {
  medianMs: number;
  samples: number[];
  plan: ExplainResult;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One warm-up run (to load pages into shared buffers) then `runs` timed runs; returns the median
 * "Execution Time" and the plan of the median run. Must be called inside a transaction: every run
 * sits in a savepoint that is rolled back, so DML measurements see identical data each time.
 */
export async function measure(s: Session, sql: string, runs: number): Promise<Measurement> {
  const results: ExplainResult[] = [];
  for (let i = 0; i <= runs; i++) {
    await s.query('SAVEPOINT qopt_measure');
    try {
      const plan = await explainAnalyze(s, sql);
      if (i > 0) results.push(plan);
    } finally {
      await s.query('ROLLBACK TO SAVEPOINT qopt_measure');
    }
  }
  const samples = results.map((r) => r.executionMs ?? 0);
  const med = median(samples);
  const plan = results.reduce((best, r) =>
    Math.abs((r.executionMs ?? 0) - med) < Math.abs((best.executionMs ?? 0) - med) ? r : best,
  );
  return { medianMs: med, samples, plan };
}
