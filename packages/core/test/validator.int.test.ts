import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { introspectTables } from '../src/context/schema.ts';
import { closeDbs, getDbs } from '../src/db.ts';
import { measure } from '../src/plan/explain.ts';
import { initParser } from '../src/sql/ast.ts';
import type { Candidate } from '../src/types.ts';
import { type ValidationContext, validateCandidate } from '../src/validate/validator.ts';

// Requires the seeded local databases (scripts/local-db.sh init && npm run qopt -- db setup).

const dbs = getDbs();
let available = false;

beforeAll(async () => {
  await initParser();
  available = (await dbs.target.ping()) && !!dbs.shadow && (await dbs.shadow.ping());
});
afterAll(async () => {
  await closeDbs();
});

async function context(sql: string, ordered = false): Promise<ValidationContext> {
  const baseline = await dbs.shadow!.sandbox((s) => measure(s, sql, 3), { readOnly: true });
  return {
    sql,
    generic: false,
    ordered,
    isSelect: true,
    target: dbs.target,
    shadow: dbs.shadow,
    hypopgOnTarget: true,
    hypopgOnShadow: true,
    baseline,
    tables: await introspectTables(dbs.target, ['orders', 'customers']),
    minCostGain: 0.2,
    minTimeGain: 0.15,
    measureRuns: 3,
  };
}

const cand = (over: Partial<Candidate>): Candidate => ({
  id: 't',
  source: 'llm',
  kind: 'index',
  title: 'test',
  statements: [],
  rationale: '',
  citations: [],
  round: 0,
  ...over,
});

const indexCount = async () => Number((await dbs.shadow!.query('SELECT count(*) FROM pg_index')).rows[0].count);

describe('validator against live databases', () => {
  it('accepts a useful index via HypoPG + shadow timing and leaves no trace', async ({ skip }) => {
    if (!available) skip();
    const before = await indexCount();
    const ctx = await context('SELECT id FROM orders WHERE customer_id = 4242');
    const v = await validateCandidate(cand({ statements: ['CREATE INDEX CONCURRENTLY qopt_t_idx ON orders (customer_id)'] }), ctx);
    expect(v).toMatchObject({ verdict: 'accepted', method: 'hypopg+shadow', usesCandidate: true });
    expect(v.timeMs!.change).toBeLessThan(-0.5);
    expect(v.indexBytes).toBeGreaterThan(0);
    expect(await indexCount()).toBe(before);
  });

  it('rejects an index the planner ignores', async ({ skip }) => {
    if (!available) skip();
    const ctx = await context('SELECT id FROM orders WHERE customer_id = 4242');
    const v = await validateCandidate(cand({ statements: ['CREATE INDEX qopt_t2_idx ON orders (total)'] }), ctx);
    expect(v.verdict).toBe('rejected');
    expect(v.usesCandidate).toBe(false);
  });

  it('classifies a made-up column as a hallucination', async ({ skip }) => {
    if (!available) skip();
    const ctx = await context('SELECT id FROM orders WHERE customer_id = 4242');
    const v = await validateCandidate(cand({ statements: ['CREATE INDEX qopt_t3_idx ON orders (customer_uuid)'] }), ctx);
    expect(v).toMatchObject({ verdict: 'error', errorClass: 'hallucination' });
  });

  it('rejects a rewrite that changes the result (NOT IN -> join that drops the anti-semantics)', async ({ skip }) => {
    if (!available) skip();
    const original = `SELECT id FROM customers WHERE id NOT IN (SELECT customer_id FROM orders WHERE created_at >= '2026-06-20') ORDER BY id LIMIT 50`;
    const ctx = await context(original, true);
    const wrong = `SELECT DISTINCT c.id FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.created_at < '2026-06-20' ORDER BY c.id LIMIT 50`;
    const v = await validateCandidate(cand({ kind: 'rewrite', rewrittenSql: wrong }), ctx);
    expect(v.verdict).toBe('rejected');
    expect(v.equivalence?.equal).toBe(false);
  });

  it('accepts an equivalent NOT EXISTS rewrite when it is faster (with a supporting index)', async ({ skip }) => {
    if (!available) skip();
    const original = `SELECT id FROM customers WHERE id NOT IN (SELECT customer_id FROM orders WHERE created_at >= '2026-06-20') ORDER BY id LIMIT 50`;
    const ctx = await context(original, true);
    const v = await validateCandidate(
      cand({
        kind: 'rewrite',
        rewrittenSql: `SELECT c.id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.created_at >= '2026-06-20') ORDER BY c.id LIMIT 50`,
        statements: ['CREATE INDEX qopt_t4_idx ON orders (customer_id, created_at)'],
      }),
      ctx,
    );
    expect(v.equivalence?.equal).toBe(true);
    expect(v.verdict).toBe('accepted');
  });

  it('never lets a rewrite write, even if it slips past the parser checks', async ({ skip }) => {
    if (!available) skip();
    const ctx = await context('SELECT id FROM orders WHERE customer_id = 1');
    const v = await validateCandidate(cand({ kind: 'rewrite', rewrittenSql: 'WITH x AS (DELETE FROM orders RETURNING id) SELECT id FROM x' }), ctx);
    expect(v).toMatchObject({ verdict: 'rejected', errorClass: 'unsafe', method: 'static' });
    expect(Number((await dbs.shadow!.query('SELECT count(*) FROM orders')).rows[0].count)).toBeGreaterThan(0);
  });

  it('verifies extended statistics by the change in row-estimate error', async ({ skip }) => {
    if (!available) skip();
    const ctx = await context(`SELECT id FROM customers WHERE country = 'NZ' AND city = 'Auckland'`);
    const v = await validateCandidate(
      cand({ kind: 'statistics', statements: ['CREATE STATISTICS qopt_t_stats (dependencies, mcv) ON country, city FROM customers'] }),
      ctx,
    );
    expect(v.qError!.before).toBeGreaterThan(5);
    expect(v.qError!.after).toBeLessThan(v.qError!.before / 2);
    expect(v.verdict).toBe('accepted');
    const stats = await dbs.shadow!.query("SELECT count(*)::int AS n FROM pg_statistic_ext WHERE stxname = 'qopt_t_stats'");
    expect(stats.rows[0].n).toBe(0);
  });
});
