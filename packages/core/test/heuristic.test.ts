import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { heuristicCandidates } from '../src/advisor/heuristic.ts';
import { planFindings } from '../src/plan/findings.ts';
import { normalizeExplain } from '../src/plan/tree.ts';
import { initParser } from '../src/sql/ast.ts';
import { analyzeQuery } from '../src/sql/shape.ts';
import type { ExplainResult, TableContext } from '../src/types.ts';

beforeAll(async () => {
  await initParser();
});

function table(name: string, columns: [string, string][], opts: Partial<TableContext> = {}): TableContext {
  return {
    schema: 'public',
    name,
    qualifiedName: `public.${name}`,
    estimatedRows: 600_000,
    tableBytes: 50_000_000,
    totalBytes: 60_000_000,
    columns: columns.map(([n, type]) => ({ name: n, type, notNull: true })),
    indexes: [{ name: `${name}_pkey`, definition: '', method: 'btree', columns: ['id'], isPrimary: true, isUnique: true, bytes: 1, scans: 0 }],
    constraints: [],
    extendedStats: [],
    columnStats: [],
    activity: { seqScans: 10, idxScans: 0, inserts: 0, updates: 0, deletes: 0, liveTuples: 0, deadTuples: 0, lastAnalyze: null },
    ...opts,
  };
}

const orders = table('orders', [['id', 'bigint'], ['customer_id', 'bigint'], ['status', 'text'], ['created_at', 'timestamp with time zone']], {
  columnStats: [
    { column: 'status', nullFrac: 0, nDistinct: 5, correlation: 0.1, avgWidth: 8, histogramBuckets: 0 },
    { column: 'customer_id', nullFrac: 0, nDistinct: 100_000, correlation: 0, avgWidth: 8, histogramBuckets: 100 },
    { column: 'created_at', nullFrac: 0, nDistinct: -1, correlation: 0.99, avgWidth: 8, histogramBuckets: 100 },
  ],
});
const products = table('products', [['id', 'bigint'], ['tags', 'text[]'], ['attributes', 'jsonb'], ['name', 'text']], { estimatedRows: 30_000 });
const seqScanPlan = (rel: string): ExplainResult =>
  normalizeExplain([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': rel, 'Total Cost': 1000, 'Plan Rows': 5, 'Plan Width': 8, Filter: 'x' } }]);

function run(sql: string, tables: TableContext[], plan: ExplainResult, extensions: string[] = []) {
  const shape = analyzeQuery(sql, new Map(tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))])));
  return heuristicCandidates({ shape, findings: planFindings(plan), tables, plan, extensions });
}

describe('heuristicCandidates', () => {
  it('puts equality columns before the range column, and adds an ORDER BY variant for LIMIT', () => {
    const c = run(`SELECT * FROM orders WHERE customer_id = 1 AND created_at > now() ORDER BY created_at DESC LIMIT 10`, [orders], seqScanPlan('orders'));
    const ddl = c.flatMap((x) => x.statements);
    expect(ddl).toContain('CREATE INDEX CONCURRENTLY qopt_orders_customer_id_created_at_idx ON public.orders (customer_id, created_at)');
    expect(ddl.some((d) => d.includes('USING brin (created_at)'))).toBe(true); // correlated range column on a big table
  });

  it('proposes a partial index for a low-cardinality equality constant', () => {
    const c = run(`SELECT id FROM orders WHERE status = 'pending' AND created_at >= '2026-06-01'`, [orders], seqScanPlan('orders'));
    expect(c.flatMap((x) => x.statements)).toContain(
      "CREATE INDEX CONCURRENTLY qopt_orders_created_at_partial_idx ON public.orders (created_at) WHERE status = 'pending'",
    );
  });

  it('uses GIN for containment, with jsonb_path_ops for jsonb @>', () => {
    const arr = run(`SELECT id FROM products WHERE tags @> ARRAY['x']`, [products], seqScanPlan('products'));
    expect(arr[0].statements[0]).toMatch(/USING gin \(tags\)$/);
    const json = run(`SELECT id FROM products WHERE attributes @> '{"a":1}'`, [products], seqScanPlan('products'));
    expect(json[0].statements[0]).toMatch(/USING gin \(attributes jsonb_path_ops\)$/);
  });

  it('only suggests a trigram index when pg_trgm is installed', () => {
    const sql = `SELECT id FROM products WHERE name ILIKE '%x%'`;
    expect(run(sql, [products], seqScanPlan('products'))).toHaveLength(0);
    expect(run(sql, [products], seqScanPlan('products'), ['pg_trgm'])[0].statements[0]).toMatch(/gin_trgm_ops/);
  });

  it('indexes every OR branch together so a BitmapOr is possible', () => {
    const customers = table('customers', [['id', 'bigint'], ['email', 'text'], ['phone', 'text']], { estimatedRows: 100_000 });
    const c = run(`SELECT id FROM customers WHERE email = 'a' OR phone = 'b'`, [customers], seqScanPlan('customers'));
    const both = c.find((x) => x.statements.length === 2);
    expect(both?.statements.join(';')).toMatch(/\(email\).*\(phone\)/);
  });

  it('skips indexes that already exist', () => {
    const indexed = { ...orders, indexes: [...orders.indexes, { name: 'o_c', definition: '', method: 'btree', columns: ['customer_id'], isPrimary: false, isUnique: false, bytes: 1, scans: 5 }] };
    const c = run('SELECT * FROM orders WHERE customer_id = 1', [indexed], seqScanPlan('orders'));
    expect(c.flatMap((x) => x.statements).some((d) => d.includes('(customer_id)'))).toBe(false);
  });

  it('suggests extended statistics for a correlated misestimate and work_mem for a spill', () => {
    const w11 = normalizeExplain(JSON.parse(readFileSync(new URL('./fixtures/plan-w11.json', import.meta.url), 'utf8')));
    const customers = table('customers', [['id', 'bigint'], ['country', 'text'], ['city', 'text']], { estimatedRows: 100_000 });
    const c = run(
      `SELECT c.id, count(o.id) FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.country = 'NZ' AND c.city = 'Auckland' GROUP BY c.id`,
      [customers, orders],
      w11,
    );
    expect(c.find((x) => x.kind === 'statistics')?.statements[0]).toMatch(/CREATE STATISTICS .* \(dependencies, mcv\) ON (country, city|city, country) FROM public\.customers/);
    expect(c.find((x) => x.kind === 'index' && x.statements[0].includes('orders (customer_id)'))).toBeDefined();

    const w13 = normalizeExplain(JSON.parse(readFileSync(new URL('./fixtures/plan-w13.json', import.meta.url), 'utf8')));
    const items = table('order_items', [['id', 'bigint'], ['order_id', 'bigint'], ['product_id', 'bigint']], { estimatedRows: 1_800_000 });
    const spill = run('SELECT product_id, count(DISTINCT order_id) FROM order_items GROUP BY product_id', [items], w13);
    expect(spill.find((x) => x.kind === 'config')?.statements[0]).toMatch(/^SET work_mem = '\d+MB'$/);
    expect(spill.find((x) => x.kind === 'index')?.statements[0]).toMatch(/\(product_id, order_id\)/);
  });
});
