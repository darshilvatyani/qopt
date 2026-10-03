import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAutoExplainLog } from '../src/capture/capture.ts';
import { matchesExpectation } from '../src/eval/runner.ts';
import { parseSuggestions, suggestionsJsonSchema } from '../src/llm/schema.ts';
import { chunkDocPage } from '../src/rag/chunk.ts';
import { initParser } from '../src/sql/ast.ts';
import type { ValidatedCandidate } from '../src/types.ts';

beforeAll(async () => {
  await initParser();
});

describe('parseAutoExplainLog', () => {
  const line = readFileSync(new URL('./fixtures/autoexplain-line.jsonl', import.meta.url), 'utf8').trim();

  it('extracts the plan, literal query text and the exact 64-bit query id', () => {
    const [s] = parseAutoExplainLog(line);
    expect(s.queryid).toBe('669985620531413121'); // JSON.parse would have rounded this
    expect(s.queryText).toMatch(/NOT IN \(SELECT customer_id FROM orders WHERE created_at >= '/);
    expect(s.plan.analyzed).toBe(true);
    expect(s.durationMs).toBeGreaterThan(0);
  });

  it("ignores qopt's own sessions and non-plan lines", () => {
    const own = line.replace('"application_name":"shop-app"', '"application_name":"qopt-shadow"');
    expect(parseAutoExplainLog(`${own}\n{"message":"checkpoint starting"}\nnot json`)).toEqual([]);
  });
});

describe('LLM output schema', () => {
  it('produces a JSON Schema Gemini accepts (no $schema key)', () => {
    const s = suggestionsJsonSchema() as Record<string, unknown>;
    expect(s.$schema).toBeUndefined();
    expect(s.type).toBe('object');
  });

  it('rejects answers outside the contract', () => {
    const good = {
      diagnosis: 'd',
      candidates: [{ kind: 'index', title: 't', statements: ['CREATE INDEX i ON t (a)'], rewritten_sql: '', rationale: 'r', expected_plan_change: 'e', citations: [] }],
    };
    expect(parseSuggestions(good).candidates).toHaveLength(1);
    expect(() => parseSuggestions({ ...good, candidates: [{ ...good.candidates[0], kind: 'drop' }] })).toThrow();
    expect(() => parseSuggestions({ ...good, candidates: [] })).toThrow();
  });
});

describe('chunkDocPage', () => {
  it('splits by section, keeps anchors, and drops navigation', () => {
    const para = 'Multicolumn indexes are useful when queries filter on the leading columns. '.repeat(3);
    const html = `<html><body><div id="docContent"><div class="navheader">Prev Next</div>
      <div class="sect1" id="INDEXES-MULTICOLUMN"><h2 class="title">11.3. Multicolumn Indexes <a class="id_link">#</a></h2>
      <p>${para}</p><pre>CREATE INDEX test2_mm_idx ON test2 (major, minor);</pre>
      <div class="sect2" id="SUB"><h3 class="title">11.3.1 Details</h3><p>${para}</p></div></div>
      <div class="navfooter">footer</div></div></body></html>`;
    const chunks = chunkDocPage(html);
    expect(chunks.map((c) => c.anchor)).toEqual(['INDEXES-MULTICOLUMN', 'SUB']);
    expect(chunks[0].heading).toBe('11.3. Multicolumn Indexes');
    expect(chunks[0].content).toContain('CREATE INDEX test2_mm_idx');
    expect(chunks.map((c) => c.content).join(' ')).not.toMatch(/Prev Next|footer/);
  });
});

describe('matchesExpectation', () => {
  const cand = (over: Partial<ValidatedCandidate>): ValidatedCandidate => ({
    id: 'x',
    source: 'llm',
    kind: 'index',
    title: '',
    statements: [],
    rationale: '',
    citations: [],
    round: 0,
    ...over,
  });

  it('matches indexes by table, leading column (or expression) and method', () => {
    expect(matchesExpectation(cand({ statements: ['CREATE INDEX i ON orders (customer_id, created_at)'] }), { kind: 'index', table: 'orders', column: 'customer_id' })).toBe(true);
    expect(matchesExpectation(cand({ statements: ['CREATE INDEX i ON orders (created_at, customer_id)'] }), { kind: 'index', table: 'orders', column: 'customer_id' })).toBe(false);
    expect(matchesExpectation(cand({ statements: ['CREATE INDEX i ON customers ((lower(email)))'] }), { kind: 'index', table: 'customers', column: 'lower(email)' })).toBe(true);
    expect(matchesExpectation(cand({ statements: ['CREATE INDEX i ON products (tags)'] }), { kind: 'index', table: 'products', column: 'tags', method: 'gin' })).toBe(false);
  });

  it('matches statistics, config and rewrites', () => {
    expect(
      matchesExpectation(cand({ kind: 'statistics', statements: ['CREATE STATISTICS s ON city, country FROM customers'] }), {
        kind: 'statistics',
        table: 'customers',
        columns: ['country', 'city'],
      }),
    ).toBe(true);
    expect(matchesExpectation(cand({ kind: 'config', statements: ["SET work_mem = '64MB'"] }), { kind: 'config', setting: 'work_mem' })).toBe(true);
    expect(matchesExpectation(cand({ kind: 'rewrite', rewrittenSql: 'SELECT 1' }), { kind: 'rewrite' })).toBe(true);
  });
});
