import { beforeAll, describe, expect, it } from 'vitest';
import { exprText, initParser, parseOne } from '../src/sql/ast.ts';
import { checkCandidate, toDisplayIndexSql, toExecIndexSql } from '../src/sql/safety.ts';
import { analyzeQuery } from '../src/sql/shape.ts';

beforeAll(async () => {
  await initParser();
});

const cols = new Map([
  ['orders', new Set(['id', 'customer_id', 'status', 'created_at', 'total'])],
  ['customers', new Set(['id', 'email', 'phone', 'country', 'city'])],
]);

describe('analyzeQuery', () => {
  it('extracts equality, range, order by and limit with alias resolution', () => {
    const s = analyzeQuery(
      `SELECT o.id FROM orders o WHERE o.customer_id = 42 AND o.created_at >= '2026-01-01' ORDER BY o.created_at DESC LIMIT 20`,
      cols,
    );
    expect(s.kind).toBe('select');
    expect(s.relations).toEqual([{ relname: 'orders', schemaname: undefined }]);
    expect(s.predicates).toEqual([
      expect.objectContaining({ table: 'orders', column: 'customer_id', kind: 'eq', inOr: false }),
      expect.objectContaining({ table: 'orders', column: 'created_at', kind: 'range' }),
    ]);
    expect(s.orderBy).toEqual([{ table: 'orders', column: 'created_at', expr: undefined, desc: true }]);
    expect(s.limit).toBe(20);
  });

  it('resolves unqualified columns across a join using the catalog column map', () => {
    const s = analyzeQuery(`SELECT 1 FROM customers c JOIN orders o ON o.customer_id = c.id WHERE country = 'NZ' AND status = 'x'`, cols);
    expect(s.joins).toEqual([{ left: { table: 'orders', column: 'customer_id' }, right: { table: 'customers', column: 'id' } }]);
    expect(s.predicates.map((p) => `${p.table}.${p.column}`)).toEqual(['customers.country', 'orders.status']);
  });

  it('flags anti-patterns', () => {
    const codes = (sql: string) => analyzeQuery(sql, cols).antiPatterns.map((a) => a.code);
    expect(codes('SELECT id FROM customers WHERE id NOT IN (SELECT customer_id FROM orders)')).toContain('NOT_IN_SUBQUERY');
    expect(codes(`SELECT id FROM customers WHERE lower(email) = 'a'`)).toContain('NON_SARGABLE_PREDICATE');
    expect(codes(`SELECT id FROM customers WHERE email ILIKE '%x%'`)).toContain('LEADING_WILDCARD');
    expect(codes('SELECT id FROM orders ORDER BY id OFFSET 5000 LIMIT 10')).toContain('LARGE_OFFSET');
    expect(codes(`SELECT id FROM customers WHERE email = 'a' OR phone = 'b'`)).toContain('OR_ACROSS_COLUMNS');
  });

  it('records expression predicates with the bare column name', () => {
    const s = analyzeQuery(`SELECT id FROM customers c WHERE lower(c.email) = lower('X')`, cols);
    expect(s.predicates[0]).toMatchObject({ table: 'customers', expr: 'lower(email)', kind: 'eq' });
  });

  it('marks OR branches and detects parameters', () => {
    const s = analyzeQuery('SELECT id FROM customers WHERE email = $1 OR phone = $2', cols);
    expect(s.hasParams).toBe(true);
    expect(s.predicates.every((p) => p.inOr)).toBe(true);
  });

  it('collects aggregate DISTINCT columns and group by', () => {
    const s = analyzeQuery('SELECT customer_id, count(DISTINCT status) FROM orders GROUP BY customer_id', cols);
    expect(s.groupBy).toEqual([{ table: 'orders', column: 'customer_id' }]);
    expect(s.distinctAggs).toEqual([{ table: 'orders', column: 'status' }]);
  });
});

describe('exprText', () => {
  it('renders simple expressions', () => {
    const where = parseOne(`SELECT 1 FROM t WHERE date_trunc('day', ts)::date = 1`).body.whereClause;
    expect(exprText(where.A_Expr.lexpr)).toBe(`date_trunc('day', ts)::date`);
  });
});

describe('checkCandidate (safety)', () => {
  const ok = (c: Parameters<typeof checkCandidate>[0]) => checkCandidate(c).ok;

  it('accepts well-formed candidates of every kind', () => {
    expect(ok({ kind: 'index', statements: ['CREATE INDEX CONCURRENTLY i ON orders (customer_id)'] })).toBe(true);
    expect(ok({ kind: 'statistics', statements: ['CREATE STATISTICS s (dependencies) ON country, city FROM customers'] })).toBe(true);
    expect(ok({ kind: 'config', statements: ["SET work_mem = '64MB'"] })).toBe(true);
    expect(ok({ kind: 'rewrite', statements: [], rewrittenSql: 'SELECT id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)' })).toBe(true);
  });

  it('rejects statements that are not what the candidate claims', () => {
    const r = checkCandidate({ kind: 'index', statements: ['DROP TABLE orders'] });
    expect(r).toMatchObject({ ok: false, errorClass: 'unsafe' });
    expect(checkCandidate({ kind: 'index', statements: ['CREATE INDEX i ON t (a); DROP TABLE t'] })).toMatchObject({ ok: false });
  });

  it('rejects UNIQUE indexes, data-modifying rewrites and dangerous functions', () => {
    expect(checkCandidate({ kind: 'index', statements: ['CREATE UNIQUE INDEX i ON t (a)'] })).toMatchObject({ ok: false, errorClass: 'unsafe' });
    expect(checkCandidate({ kind: 'rewrite', statements: [], rewrittenSql: 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d' })).toMatchObject({
      ok: false,
      errorClass: 'unsafe',
    });
    expect(checkCandidate({ kind: 'rewrite', statements: [], rewrittenSql: 'SELECT pg_sleep(10)' })).toMatchObject({ ok: false });
    expect(checkCandidate({ kind: 'rewrite', statements: [], rewrittenSql: 'SELECT * INTO x FROM t' })).toMatchObject({ ok: false });
    expect(checkCandidate({ kind: 'rewrite', statements: [], rewrittenSql: 'SELECT * FROM t FOR UPDATE' })).toMatchObject({ ok: false });
  });

  it('only allows whitelisted settings with sane values', () => {
    expect(checkCandidate({ kind: 'config', statements: ["SET statement_timeout = '0'"] })).toMatchObject({ ok: false, errorClass: 'unsafe' });
    expect(checkCandidate({ kind: 'config', statements: ["SET work_mem = '8GB'"] })).toMatchObject({ ok: false, errorClass: 'unsafe' });
    const r = checkCandidate({ kind: 'config', statements: ["SET work_mem = '256MB'"] });
    expect(r.ok && r.checked.settings[0].execSql).toBe("SET LOCAL work_mem = '256MB'");
  });

  it('reports unparseable SQL as invalid_sql', () => {
    expect(checkCandidate({ kind: 'index', statements: ['CREAT INDEX i ON t (a)'] })).toMatchObject({ ok: false, errorClass: 'invalid_sql' });
  });

  it('removes CONCURRENTLY for transactional validation and adds it for display', () => {
    expect(toExecIndexSql('CREATE INDEX CONCURRENTLY i ON t (a);')).toBe('CREATE INDEX i ON t (a)');
    expect(toDisplayIndexSql('create index i on t (a)')).toBe('CREATE INDEX CONCURRENTLY i on t (a)');
  });
});
