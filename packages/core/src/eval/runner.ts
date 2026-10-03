import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, REPO_ROOT } from '../config.ts';
import { errorMessage, type Session } from '../db.ts';
import { measure } from '../plan/explain.ts';
import { analyze } from '../pipeline.ts';
import type { Services } from '../services.ts';
import type { Log } from '../setup.ts';
import { initParser } from '../sql/ast.ts';
import { checkCandidate } from '../sql/safety.ts';
import type { AnalysisResult, AnalyzeOptions, EvalQueryResult, EvalReport, ValidatedCandidate } from '../types.ts';
import { type Expectation, rng, WORKLOAD, type WorkloadQuery } from '../workload/queries.ts';

// Ablation harness. Each configuration analyses every workload query, then the changes it would
// recommend are applied together on the shadow (inside one rolled-back transaction) and the whole
// workload is re-timed. Ground truth comes from WorkloadQuery.expected.

export interface EvalConfig {
  label: string;
  options: AnalyzeOptions;
  /**
   * Score only the model's first answer and recommend all of it, validated or not: what you get by
   * applying LLM output blindly. Shares its analysis runs with the config that has the same options.
   */
  blind?: boolean;
  needsLlm: boolean;
}

export const EVAL_CONFIGS: Record<string, EvalConfig> = {
  heuristic: { label: 'Heuristic advisor (no LLM)', options: { engine: 'heuristic', rag: false, validate: true, retries: 0 }, needsLlm: false },
  'llm-novalidate': {
    label: 'LLM, no validation',
    options: { engine: 'llm', rag: false, validate: true, retries: 1 },
    blind: true,
    needsLlm: true,
  },
  llm: { label: 'LLM + validation', options: { engine: 'llm', rag: false, validate: true, retries: 1 }, needsLlm: true },
  'llm-rag': { label: 'LLM + validation + RAG', options: { engine: 'llm', rag: true, validate: true, retries: 1 }, needsLlm: true },
};

const RESULTS_DIR = join(REPO_ROOT, 'eval', 'results');

/** An overloaded or briefly unavailable model is worth retrying; a spent daily quota is not. */
function transientLlmFailure(run: AnalysisResult): boolean {
  const w = run.warnings.find((x) => x.startsWith('LLM step failed'));
  return !!w && !/daily quota|PerDay/i.test(w);
}

/**
 * What a user would actually apply: the best-ranked recommendation of each kind (an index plus,
 * say, a statistics object), not every accepted alternative.
 */
export function topPicks(ranked: ValidatedCandidate[]): ValidatedCandidate[] {
  const byKind = new Map<string, ValidatedCandidate>();
  for (const c of ranked) if (!byKind.has(c.kind)) byKind.set(c.kind, c);
  return [...byKind.values()];
}

export function matchesExpectation(c: ValidatedCandidate, e: Expectation): boolean {
  if (e.kind === 'rewrite') return c.kind === 'rewrite';
  const check = checkCandidate(c);
  if (!check.ok) return false;
  switch (e.kind) {
    case 'index':
      return (c.kind === 'index' || c.kind === 'rewrite') &&
        check.checked.indexes.some(
          (i) => i.shape.table === e.table && (i.shape.keys[0] === e.column || i.shape.keys[0]?.replace(/\s+/g, '').includes(e.column)) && (!e.method || i.shape.method === e.method),
        );
    case 'statistics':
      return c.kind === 'statistics' && check.checked.statistics.some((s) => s.table === e.table && e.columns.every((col) => s.columns.includes(col)));
    case 'config':
      return c.kind === 'config' && check.checked.settings.some((s) => s.name === e.setting);
  }
}

interface QueryPlan {
  w: WorkloadQuery;
  sql: string;
  recommended: ValidatedCandidate[];
}

/** Apply every recommended change on the shadow, time the workload before and after, roll back. */
async function measureWorkload(s: Session, plans: QueryPlan[], runs: number, log: Log) {
  const baseline = new Map<string, number>();
  for (const p of plans) baseline.set(p.w.id, (await measure(s, p.sql, runs)).medianMs);

  const applied = new Set<string>();
  const newIndexOids: number[] = [];
  const analyzeTables = new Set<string>();
  const before = new Set((await s.query('SELECT indexrelid::int AS oid FROM pg_index')).rows.map((r) => r.oid));
  for (const p of plans) {
    for (const c of p.recommended) {
      const check = checkCandidate(c);
      if (!check.ok) continue;
      const ddl = [...check.checked.indexes.map((i) => i.execSql), ...check.checked.statistics.map((x) => x.execSql)];
      for (const x of check.checked.statistics) analyzeTables.add(x.schema ? `${x.schema}.${x.table}` : x.table);
      for (const stmt of ddl) {
        if (applied.has(stmt)) continue;
        applied.add(stmt);
        await s.query('SAVEPOINT qopt_apply');
        try {
          await s.query(stmt);
          await s.query('RELEASE SAVEPOINT qopt_apply');
        } catch (e) {
          await s.query('ROLLBACK TO SAVEPOINT qopt_apply');
          log(`    (skipped failing DDL: ${errorMessage(e)})`);
        }
      }
    }
  }
  for (const t of analyzeTables) await s.query(`ANALYZE ${t}`);
  for (const r of (await s.query('SELECT indexrelid::int AS oid FROM pg_index')).rows) if (!before.has(r.oid)) newIndexOids.push(r.oid);
  const size = await s.query('SELECT coalesce(sum(pg_relation_size(o)), 0)::bigint AS b FROM unnest($1::oid[]) o', [newIndexOids]);

  const after = new Map<string, number>();
  for (const p of plans) {
    const rewrite = p.recommended.find((c) => c.kind === 'rewrite' && c.rewrittenSql);
    const settings = p.recommended.flatMap((c) => {
      const check = c.kind === 'config' ? checkCandidate(c) : undefined;
      return check?.ok ? check.checked.settings.map((x) => x.execSql) : [];
    });
    await s.query('SAVEPOINT qopt_query');
    try {
      for (const st of settings) await s.query(st);
      after.set(p.w.id, (await measure(s, rewrite?.rewrittenSql ?? p.sql, runs)).medianMs);
    } catch (e) {
      log(`    ${p.w.id}: recommended change failed at run time (${errorMessage(e)}); timing the original`);
      await s.query('ROLLBACK TO SAVEPOINT qopt_query');
      await s.query('SAVEPOINT qopt_query');
      after.set(p.w.id, (await measure(s, p.sql, runs)).medianMs);
    }
    await s.query('ROLLBACK TO SAVEPOINT qopt_query');
  }
  return { baseline, after, indexBytes: Number(size.rows[0].b) };
}

export interface EvalOptions {
  configs: string[];
  queries?: string[];
  scale: number;
  seed: number;
  /** Keep configs from the previous report that this run doesn't redo (e.g. finish one after a quota reset). */
  merge?: boolean;
}

export async function runEval(services: Services, opts: EvalOptions, log: Log = console.log): Promise<EvalReport> {
  await initParser();
  const shadow = services.dbs.shadow;
  if (!shadow) throw new Error('eval needs SHADOW_URL: the workload is re-timed on the shadow');
  const pg = await services.dbs.target.query("SELECT current_setting('server_version') AS v");
  const report: EvalReport = {
    createdAt: new Date().toISOString(),
    pgVersion: pg.rows[0].v,
    model: services.llm?.model,
    configs: [],
    notes: [],
  };
  const workload = opts.queries?.length ? WORKLOAD.filter((w) => opts.queries!.some((q) => q.toLowerCase() === w.id.toLowerCase())) : WORKLOAD;

  if (opts.merge) {
    const previous = await loadLatestEval();
    if (previous) {
      report.configs = previous.configs.filter((c) => !opts.configs.includes(c.config));
      report.notes = previous.notes.filter((n) => !opts.configs.some((c) => n.startsWith(EVAL_CONFIGS[c]?.label ?? c)));
    }
  }
  const stamp = report.createdAt.replace(/[:.]/g, '-');
  const save = async () => {
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(join(RESULTS_DIR, `${stamp}.json`), JSON.stringify(report, null, 2));
    await writeFile(join(RESULTS_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  };

  // Configs with identical pipeline options (llm and llm-novalidate) share one analysis per query,
  // so the model is asked once and both are scored on the same answers.
  const runs = new Map<string, AnalysisResult>();

  for (const name of opts.configs) {
    const cfg = EVAL_CONFIGS[name];
    if (!cfg) throw new Error(`unknown eval config "${name}" (known: ${Object.keys(EVAL_CONFIGS).join(', ')})`);
    if (cfg.needsLlm && !services.llm) {
      report.notes.push(`${name}: skipped (GEMINI_API_KEY not set)`);
      log(`${name}: skipped, no GEMINI_API_KEY`);
      continue;
    }
    log(`\n${cfg.label}`);
    const plans: QueryPlan[] = [];
    const rows: EvalQueryResult[] = [];
    let llmCalls = 0;
    for (const [i, w] of workload.entries()) {
      const sql = w.sql(rng(opts.seed + i), opts.scale);
      const key = `${JSON.stringify(cfg.options)}|${w.id}`;
      const reused = runs.has(key);
      let run = runs.get(key);
      for (let attempt = 0; !run || (attempt <= 2 && transientLlmFailure(run)); attempt++) {
        if (run) {
          log(`  ${w.id}: Gemini was unavailable; retrying in 30s (attempt ${attempt + 1} of 3)`);
          await new Promise((r) => setTimeout(r, 30_000));
        }
        run = await analyze({ sql, sourceType: 'workload', label: w.id, options: cfg.options }, services);
      }
      runs.set(key, run);
      const candidates = cfg.blind ? run.candidates.filter((c) => c.round === 0) : run.candidates;
      const recommended = cfg.blind ? candidates.filter((c) => checkCandidate(c).ok) : topPicks(run.recommendations);
      llmCalls += cfg.blind ? Math.min(1, run.llm?.calls ?? 0) : run.llm?.calls ?? 0;
      const row: EvalQueryResult = {
        workloadId: w.id,
        title: w.title,
        expected: w.expectedLabel,
        candidates: candidates.length,
        accepted: candidates.filter((c) => c.validation?.verdict === 'accepted').length,
        recommended: recommended.length,
        hallucinations: candidates.filter((c) => c.validation?.errorClass === 'hallucination' || c.validation?.errorClass === 'invalid_sql').length,
        unsafe: candidates.filter((c) => c.validation?.errorClass === 'unsafe').length,
        wrongResults: recommended.filter((c) => c.kind === 'rewrite' && c.validation?.equivalence?.equal === false).length,
        // A change that errors or returns different rows fixes nothing, whatever its shape.
        hit: recommended.some(
          (c) => c.validation?.verdict !== 'error' && c.validation?.equivalence?.equal !== false && w.expected.some((e) => matchesExpectation(c, e)),
        ),
        baselineMs: run.baseline?.medianMs ?? 0,
        afterMs: 0,
        recommendedSql: recommended.map((c) => (c.kind === 'rewrite' ? c.rewrittenSql ?? '' : c.statements.join('; '))),
        model: run.llm?.calls ? run.llm.model : undefined,
        error: run.error ?? run.warnings.find((x) => x.startsWith('LLM step failed')),
      };
      rows.push(row);
      plans.push({ w, sql, recommended });
      log(
        `  ${w.id} ${row.hit ? 'HIT ' : 'miss'} candidates=${row.candidates} accepted=${row.accepted} recommended=${row.recommended}${row.hallucinations ? ` hallucinated=${row.hallucinations}` : ''}${row.model ? ` model=${row.model}` : ''}${reused ? ' (shared run)' : ''}${row.error ? ` error=${row.error}` : ''}`,
      );
    }

    log('  timing the workload with all recommendations applied (shadow, rolled back)…');
    const timing = await shadow.sandbox((s) => measureWorkload(s, plans, config.measureRuns, log));
    for (const row of rows) {
      row.baselineMs = timing.baseline.get(row.workloadId) ?? row.baselineMs;
      row.afterMs = timing.after.get(row.workloadId) ?? row.baselineMs;
    }
    const sum = (f: (r: EvalQueryResult) => number) => rows.reduce((a, r) => a + f(r), 0);
    const totals = {
      candidates: sum((r) => r.candidates),
      accepted: sum((r) => r.accepted),
      recommended: sum((r) => r.recommended),
      precision: sum((r) => r.candidates) ? sum((r) => r.accepted) / sum((r) => r.candidates) : 0,
      hallucinationRate: sum((r) => r.candidates) ? sum((r) => r.hallucinations) / sum((r) => r.candidates) : 0,
      wrongResults: sum((r) => r.wrongResults),
      hitRate: rows.length ? rows.filter((r) => r.hit).length / rows.length : 0,
      baselineMs: sum((r) => r.baselineMs),
      afterMs: sum((r) => r.afterMs),
      speedup: sum((r) => r.afterMs) ? sum((r) => r.baselineMs) / sum((r) => r.afterMs) : 1,
      indexBytes: timing.indexBytes,
      llmCalls,
    };
    const models = [...new Set(rows.map((r) => r.model).filter((m): m is string => !!m))];
    report.configs.push({ config: name, label: cfg.label, queries: rows, totals, models });
    const order = Object.keys(EVAL_CONFIGS);
    report.configs.sort((a, b) => order.indexOf(a.config) - order.indexOf(b.config));
    const failed = rows.filter((r) => r.error);
    if (failed.length) report.notes.push(`${cfg.label}: ${failed.length} of ${rows.length} queries failed (${failed[0].error})`);
    if (models.length > 1) report.notes.push(`${cfg.label}: answers came from several models (${models.join(', ')}) because of fallbacks`);
    log(
      `  => hit rate ${(totals.hitRate * 100).toFixed(0)}%, precision ${(totals.precision * 100).toFixed(0)}%, workload ${totals.baselineMs.toFixed(0)} → ${totals.afterMs.toFixed(0)} ms (${totals.speedup.toFixed(1)}x), indexes ${(totals.indexBytes / 1024 / 1024).toFixed(1)} MB${failed.length ? `, ${failed.length} FAILED` : ''}`,
    );
    await save();
  }

  await save();
  log(`\nsaved eval/results/${stamp}.json`);
  return report;
}

export async function loadLatestEval(): Promise<EvalReport | undefined> {
  try {
    return JSON.parse(await readFile(join(RESULTS_DIR, 'latest.json'), 'utf8')) as EvalReport;
  } catch {
    return undefined;
  }
}
