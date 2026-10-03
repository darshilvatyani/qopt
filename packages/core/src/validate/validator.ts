import { type Db, errorMessage, pgErrorCode, type Session } from '../db.ts';
import { explainCost, type Measurement, measure } from '../plan/explain.ts';
import { hasSpill, indexesUsed, maxScanQError } from '../plan/tree.ts';
import { type CheckedCandidate, checkCandidate, type ExecIndex, HYPOPG_METHODS } from '../sql/safety.ts';
import type { Candidate, ErrorClass, ExplainResult, TableContext, ValidationResult } from '../types.ts';
import { checkEquivalence } from './equivalence.ts';

// Ground truth for every suggestion:
//   index      -> HypoPG on the target (does the planner pick it? what does cost do?), then a real
//                 build on the shadow inside a rolled-back transaction (does time actually drop?)
//   statistics -> CREATE STATISTICS + ANALYZE on the shadow; did the row estimate improve?
//   config     -> SET LOCAL on the shadow; did time drop / spill disappear?
//   rewrite    -> same result set on the shadow, and faster.

export interface ValidationContext {
  sql: string;
  /** Query has $n parameters and no captured literal values: only cost-based checks are possible. */
  generic: boolean;
  ordered: boolean;
  isSelect: boolean;
  target: Db;
  shadow?: Db;
  hypopgOnTarget: boolean;
  hypopgOnShadow: boolean;
  /** Baseline measurement on the shadow (median of N runs). */
  baseline?: Measurement;
  tables: TableContext[];
  minCostGain: number;
  minTimeGain: number;
  measureRuns: number;
}

function classify(e: unknown): { errorClass: ErrorClass; reason: string } {
  const code = pgErrorCode(e);
  const msg = errorMessage(e);
  // HypoPG re-raises some catalog lookups as XX000, so match the message too.
  if (/\b(column|relation|function|operator( class)?|type|access method|schema)\b.*\bdoes not exist\b/i.test(msg)) {
    return { errorClass: 'hallucination', reason: `references something that does not exist: ${msg}` };
  }
  switch (code) {
    case '42703':
    case '42P01':
    case '42883':
    case '42704':
      return { errorClass: 'hallucination', reason: `references something that does not exist: ${msg}` };
    case '42601':
      return { errorClass: 'invalid_sql', reason: `syntax error: ${msg}` };
    case '57014':
      return { errorClass: 'timeout', reason: `timed out: ${msg}` };
    default:
      return { errorClass: 'db_error', reason: msg };
  }
}

const pct = (x: number) => `${x <= 0 ? '' : '+'}${(x * 100).toFixed(1)}%`;
const delta = (before: number, after: number) => ({ before, after, change: before > 0 ? (after - before) / before : 0 });

function score(v: ValidationResult, checked: CheckedCandidate, tables: TableContext[]): number {
  const gain = -(v.timeMs?.change ?? v.cost?.change ?? 0);
  let s = gain * 100;
  // Penalise index size relative to the table, and write-heavy tables (every index slows writes).
  for (const idx of checked.indexes) {
    const t = tables.find((x) => x.name === idx.shape.table);
    if (!t) continue;
    if (v.indexBytes && t.tableBytes) s -= Math.min(20, (v.indexBytes / t.tableBytes) * 10);
    const writes = t.activity.inserts + t.activity.updates + t.activity.deletes;
    const reads = t.activity.seqScans + t.activity.idxScans;
    if (writes > 10 * Math.max(1, reads)) s -= 5;
  }
  return Math.round(s * 10) / 10;
}

async function hypoCheck(db: Db, ctx: ValidationContext, indexes: ExecIndex[]) {
  return db.withSession(async (s) => {
    await s.query('SELECT hypopg_reset()');
    try {
      const before = await explainCost(s, ctx.sql, { generic: ctx.generic });
      const names: string[] = [];
      const oids: number[] = [];
      for (const idx of indexes) {
        const res = await s.query('SELECT indexrelid::int AS oid, indexname FROM hypopg_create_index($1)', [idx.execSql]);
        names.push(res.rows[0].indexname);
        oids.push(res.rows[0].oid);
      }
      const after = await explainCost(s, ctx.sql, { generic: ctx.generic });
      const size = await s.query('SELECT coalesce(sum(hypopg_relation_size(o)), 0)::bigint AS b FROM unnest($1::oid[]) o', [oids]);
      const used = indexesUsed(after).filter((n) => names.includes(n));
      return { before, after, used, bytes: Number(size.rows[0].b) };
    } finally {
      await s.query('SELECT hypopg_reset()').catch(() => {});
    }
  });
}

/** Builds the indexes for real (inside the caller's transaction) and returns their names and size. */
async function buildIndexes(s: Session, indexes: ExecIndex[]): Promise<{ names: string[]; bytes: number; analyzed: boolean }> {
  const names: string[] = [];
  const oids: number[] = [];
  let analyzed = false;
  for (const idx of indexes) {
    const rel = idx.shape.schema ? `${idx.shape.schema}.${idx.shape.table}` : idx.shape.table;
    const list = `SELECT i.indexrelid::int AS oid, ic.relname FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = to_regclass($1)`;
    const before = new Set((await s.query(list, [rel])).rows.map((r) => r.oid));
    await s.query(idx.execSql);
    for (const r of (await s.query(list, [rel])).rows) {
      if (before.has(r.oid)) continue;
      names.push(r.relname);
      oids.push(r.oid);
    }
    // Expression indexes get their own statistics only after ANALYZE.
    if (idx.shape.keys.some((k) => k.startsWith('('))) {
      await s.query(`ANALYZE ${rel}`);
      analyzed = true;
    }
  }
  const size = await s.query('SELECT coalesce(sum(pg_relation_size(o)), 0)::bigint AS b FROM unnest($1::oid[]) o', [oids]);
  return { names, bytes: Number(size.rows[0].b), analyzed };
}

async function measureOrCost(s: Session, ctx: ValidationContext): Promise<{ plan: ExplainResult; medianMs?: number; samples?: number }> {
  if (ctx.generic) return { plan: await explainCost(s, ctx.sql, { generic: true }) };
  const m = await measure(s, ctx.sql, ctx.measureRuns);
  return { plan: m.plan, medianMs: m.medianMs, samples: m.samples.length };
}

function timeVerdict(v: ValidationResult, ctx: ValidationContext, what: string): void {
  const t = v.timeMs!;
  if (t.change <= -ctx.minTimeGain) {
    v.verdict = 'accepted';
    v.reason = `${what}: measured ${t.before.toFixed(2)} → ${t.after.toFixed(2)} ms (${pct(t.change)}, median of ${t.samples})`;
  } else {
    v.verdict = 'rejected';
    v.reason = `${what}: measured ${t.before.toFixed(2)} → ${t.after.toFixed(2)} ms (${pct(t.change)}), below the ${(ctx.minTimeGain * 100).toFixed(0)}% threshold`;
  }
}

async function validateIndex(c: CheckedCandidate, ctx: ValidationContext): Promise<ValidationResult> {
  const hypoable = c.indexes.every((i) => HYPOPG_METHODS.has(i.shape.method));
  const hypoDb = ctx.hypopgOnTarget ? ctx.target : ctx.hypopgOnShadow ? ctx.shadow : undefined;
  const v: ValidationResult = { verdict: 'rejected', method: 'hypopg', reason: '', score: 0 };

  if (hypoable && hypoDb) {
    const h = await hypoCheck(hypoDb, ctx, c.indexes);
    v.cost = delta(h.before.totalCost, h.after.totalCost);
    v.usesCandidate = h.used.length > 0;
    v.indexBytes = h.bytes;
    v.afterPlan = h.after;
    if (!v.usesCandidate) {
      v.reason = `HypoPG: the planner ignored the hypothetical index (cost ${h.before.totalCost.toFixed(0)} → ${h.after.totalCost.toFixed(0)})`;
      return v;
    }
    if (v.cost.change > -ctx.minCostGain) {
      v.reason = `HypoPG: the index is used but estimated cost only changes ${pct(v.cost.change)} (threshold ${(ctx.minCostGain * 100).toFixed(0)}%)`;
      return v;
    }
    if (!ctx.shadow || ctx.generic) {
      v.verdict = 'accepted';
      v.reason = `HypoPG: planner uses it; estimated cost ${h.before.totalCost.toFixed(0)} → ${h.after.totalCost.toFixed(0)} (${pct(v.cost.change)})${ctx.generic ? '; not timed (no captured parameter values)' : '; not timed (no shadow configured)'}`;
      return v;
    }
    v.method = 'hypopg+shadow';
  } else if (!ctx.shadow) {
    return { verdict: 'skipped', method: 'static', reason: `${c.indexes.map((i) => i.shape.method).join('/')} indexes cannot be simulated by HypoPG and no shadow database is configured`, score: 0 };
  } else {
    v.method = 'shadow';
  }

  // Real build on the shadow, rolled back afterwards.
  const shadow = ctx.shadow!;
  const r = await shadow.sandbox(async (s) => {
    // Without a timed baseline (generic plans), compare estimated costs within this transaction.
    const before = ctx.baseline ? undefined : await explainCost(s, ctx.sql, { generic: ctx.generic });
    const built = await buildIndexes(s, c.indexes);
    const after = await measureOrCost(s, ctx);
    return { built, after, before };
  });
  v.indexBytes = r.built.bytes;
  v.afterPlan = r.after.plan;
  const used = indexesUsed(r.after.plan).filter((n) => r.built.names.includes(n));
  v.usesCandidate = used.length > 0;
  if (!v.cost) v.cost = delta(r.before?.totalCost ?? ctx.baseline?.plan.totalCost ?? 0, r.after.plan.totalCost);
  if (r.after.medianMs === undefined || !ctx.baseline) {
    v.verdict = v.usesCandidate && v.cost.change <= -ctx.minCostGain ? 'accepted' : 'rejected';
    v.reason = `shadow (cost only): ${v.usesCandidate ? 'used' : 'not used'} by the planner, cost ${pct(v.cost.change)}`;
    return v;
  }
  v.timeMs = { ...delta(ctx.baseline.medianMs, r.after.medianMs), samples: r.after.samples ?? 0 };
  if (!v.usesCandidate) {
    v.reason = `shadow: index built but the planner did not use it (${v.timeMs.before.toFixed(2)} → ${v.timeMs.after.toFixed(2)} ms)`;
    return v;
  }
  timeVerdict(v, ctx, v.method === 'hypopg+shadow' ? `HypoPG cost ${pct(v.cost.change)}; shadow` : 'shadow');
  return v;
}

async function validateStatistics(c: CheckedCandidate, ctx: ValidationContext): Promise<ValidationResult> {
  if (!ctx.shadow || !ctx.baseline) {
    return { verdict: 'skipped', method: 'static', reason: 'extended statistics need a shadow database and a concrete query to verify', score: 0 };
  }
  const tables = [...new Set(c.statistics.map((x) => (x.schema ? `${x.schema}.${x.table}` : x.table)))];
  const r = await ctx.shadow.sandbox(async (s) => {
    for (const st of c.statistics) await s.query(st.execSql);
    for (const t of tables) await s.query(`ANALYZE ${t}`);
    return measure(s, ctx.sql, ctx.measureRuns);
  });
  const relation = c.statistics[0].table;
  const v: ValidationResult = {
    verdict: 'rejected',
    method: 'shadow',
    reason: '',
    qError: delta(maxScanQError(ctx.baseline.plan, relation), maxScanQError(r.plan, relation)),
    timeMs: { ...delta(ctx.baseline.medianMs, r.medianMs), samples: r.samples.length },
    cost: delta(ctx.baseline.plan.totalCost, r.plan.totalCost),
    afterPlan: r.plan,
    score: 0,
  };
  const q = v.qError!;
  const t = v.timeMs!;
  const estimateFixed = q.after <= q.before / 2;
  // Only a clear slowdown counts as a regression; a few percent is run-to-run noise on short queries.
  if (t.change > 0.25) {
    v.reason = `shadow: estimates ${q.before.toFixed(0)}x → ${q.after.toFixed(0)}x off, but time regressed ${pct(t.change)}`;
  } else if (estimateFixed || t.change <= -ctx.minTimeGain) {
    v.verdict = 'accepted';
    v.reason = `shadow: row estimate error on ${relation} ${q.before.toFixed(0)}x → ${q.after.toFixed(1)}x; time ${t.before.toFixed(2)} → ${t.after.toFixed(2)} ms (${pct(t.change)})`;
  } else {
    v.reason = `shadow: row estimate error on ${relation} ${q.before.toFixed(0)}x → ${q.after.toFixed(1)}x, time ${pct(t.change)}; no meaningful improvement`;
  }
  return v;
}

async function validateConfig(c: CheckedCandidate, ctx: ValidationContext): Promise<ValidationResult> {
  if (!ctx.shadow || !ctx.baseline) {
    return { verdict: 'skipped', method: 'static', reason: 'settings are verified by timing on the shadow, which needs a concrete query', score: 0 };
  }
  const r = await ctx.shadow.sandbox(async (s) => {
    for (const st of c.settings) await s.query(st.execSql);
    return measure(s, ctx.sql, ctx.measureRuns);
  });
  const v: ValidationResult = {
    verdict: 'rejected',
    method: 'shadow',
    reason: '',
    timeMs: { ...delta(ctx.baseline.medianMs, r.medianMs), samples: r.samples.length },
    cost: delta(ctx.baseline.plan.totalCost, r.plan.totalCost),
    spillResolved: hasSpill(ctx.baseline.plan) ? !hasSpill(r.plan) : undefined,
    afterPlan: r.plan,
    score: 0,
  };
  timeVerdict(v, ctx, `shadow with ${c.settings.map((x) => `${x.name}=${x.value}`).join(', ')}${v.spillResolved ? ' (spill gone)' : ''}`);
  return v;
}

async function validateRewrite(c: CheckedCandidate, ctx: ValidationContext): Promise<ValidationResult> {
  if (!ctx.isSelect) return { verdict: 'skipped', method: 'static', reason: 'only SELECT statements can be rewritten safely', score: 0 };
  if (!ctx.shadow || !ctx.baseline) {
    return { verdict: 'skipped', method: 'static', reason: 'rewrites are verified for identical results on the shadow, which needs a concrete query', score: 0 };
  }
  const rewrite = c.rewrite!;
  const r = await ctx.shadow.sandbox(async (s) => {
    const built = c.indexes.length ? await buildIndexes(s, c.indexes) : { names: [], bytes: 0, analyzed: false };
    // From here on nothing may write, whatever the rewrite contains.
    await s.query('SET LOCAL transaction_read_only = on');
    const equivalence = await checkEquivalence(s, ctx.sql, rewrite, ctx.ordered);
    const m = equivalence.equal ? await measure(s, rewrite, ctx.measureRuns) : undefined;
    return { built, equivalence, m };
  });
  const v: ValidationResult = {
    verdict: 'rejected',
    method: 'shadow',
    reason: '',
    equivalence: r.equivalence,
    indexBytes: r.built.bytes || undefined,
    score: 0,
  };
  if (!r.equivalence.equal) {
    v.reason = `shadow: NOT equivalent: ${r.equivalence.detail}`;
    return v;
  }
  v.timeMs = { ...delta(ctx.baseline.medianMs, r.m!.medianMs), samples: r.m!.samples.length };
  v.cost = delta(ctx.baseline.plan.totalCost, r.m!.plan.totalCost);
  v.afterPlan = r.m!.plan;
  timeVerdict(v, ctx, `shadow: identical results (${r.equivalence.detail})${c.indexes.length ? ' with supporting index' : ''}`);
  return v;
}

export async function validateCandidate(candidate: Candidate, ctx: ValidationContext): Promise<ValidationResult> {
  const check = checkCandidate(candidate);
  if (!check.ok) return { verdict: 'rejected', method: 'static', reason: check.reason, errorClass: check.errorClass, score: 0 };
  try {
    let v: ValidationResult;
    switch (candidate.kind) {
      case 'index':
        v = await validateIndex(check.checked, ctx);
        break;
      case 'statistics':
        v = await validateStatistics(check.checked, ctx);
        break;
      case 'config':
        v = await validateConfig(check.checked, ctx);
        break;
      case 'rewrite':
        v = await validateRewrite(check.checked, ctx);
        break;
    }
    v.score = v.verdict === 'accepted' ? score(v, check.checked, ctx.tables) : 0;
    return v;
  } catch (e) {
    const { errorClass, reason } = classify(e);
    return { verdict: 'error', method: candidate.kind === 'index' ? 'hypopg' : 'shadow', reason, errorClass, score: 0 };
  }
}
