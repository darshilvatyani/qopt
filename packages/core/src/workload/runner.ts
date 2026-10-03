import { errorMessage, getDbs } from '../db.ts';
import type { Log } from '../setup.ts';
import { rng, WORKLOAD, type WorkloadQuery } from './queries.ts';

export interface WorkloadOptions {
  iterations: number;
  scale: number;
  seed: number;
  reset: boolean;
  queries?: string[];
}

/**
 * Plays the demo workload against the target (untagged, like a real application would), so
 * pg_stat_statements and auto_explain have something to capture.
 */
export async function runWorkload(opts: WorkloadOptions, log: Log = console.log): Promise<Map<string, number>> {
  const { targetAdmin } = getDbs();
  const selected: WorkloadQuery[] = opts.queries?.length
    ? WORKLOAD.filter((w) => opts.queries!.some((q) => q.toLowerCase() === w.id.toLowerCase()))
    : WORKLOAD;
  if (opts.reset) {
    await targetAdmin.query('SELECT pg_stat_statements_reset()').catch((e) => log(`! reset failed: ${errorMessage(e)}`));
  }
  const r = rng(opts.seed);
  const timings = new Map<string, number>();
  const started = Date.now();
  await targetAdmin.withSession(async (s) => {
    // Look like an application, not qopt: capture ignores auto_explain entries from qopt-* sessions.
    await s.query("SET application_name = 'shop-app'");
    for (let i = 0; i < opts.iterations; i++) {
      for (const w of selected) {
        const sql = w.sql(r, opts.scale);
        const t = performance.now();
        try {
          await s.query(sql);
        } catch (e) {
          log(`! ${w.id}: ${errorMessage(e)}`);
        }
        timings.set(w.id, (timings.get(w.id) ?? 0) + performance.now() - t);
      }
      if ((i + 1) % Math.max(1, Math.floor(opts.iterations / 5)) === 0) log(`  iteration ${i + 1}/${opts.iterations}`);
    }
  });
  log(`workload: ${opts.iterations} × ${selected.length} queries in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return timings;
}
