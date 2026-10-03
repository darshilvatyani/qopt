import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planFindings } from '../src/plan/findings.ts';
import { flatten, hasSpill, normalizeExplain, renderPlanText } from '../src/plan/tree.ts';

// Fixtures are real EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) output from the demo workload.
const fixture = (name: string) => normalizeExplain(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')));

describe('normalizeExplain', () => {
  it('derives inclusive and exclusive time that add up', () => {
    const plan = fixture('plan-w11');
    for (const n of flatten(plan.root)) {
      if (n.inclusiveMs === undefined) continue;
      const children = n.children.reduce((s, c) => s + (c.inclusiveMs ?? 0), 0);
      expect(n.exclusiveMs).toBeGreaterThanOrEqual(0);
      expect(n.exclusiveMs! + Math.min(children, n.inclusiveMs)).toBeCloseTo(n.inclusiveMs, 5);
    }
    expect(plan.analyzed).toBe(true);
    expect(plan.executionMs).toBeGreaterThan(0);
  });

  it('accepts a cost-only plan', () => {
    const plan = normalizeExplain([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 't', 'Total Cost': 10, 'Plan Rows': 5, 'Plan Width': 4 } }]);
    expect(plan.analyzed).toBe(false);
    expect(plan.root.qError).toBeUndefined();
  });

  it('renders a compact text plan', () => {
    const text = renderPlanText(fixture('plan-w01'));
    expect(text).toMatch(/Seq Scan on orders/);
    expect(text).toMatch(/removed_by_filter=/);
    expect(text).toMatch(/execution=/);
  });
});

describe('planFindings', () => {
  it('reports a correlated-column misestimate only where it originates', () => {
    const plan = fixture('plan-w11');
    const mis = planFindings(plan).filter((f) => f.code === 'ROW_MISESTIMATE');
    expect(mis.length).toBeGreaterThanOrEqual(1);
    expect(mis[0].relation).toBe('customers');
    // Parent nodes that merely inherit the bad estimate are not reported again.
    const flagged = new Set(mis.map((f) => f.nodeId));
    for (const n of flatten(plan.root)) {
      if (flagged.has(n.id)) expect(n.children.some((c) => flagged.has(c.id))).toBe(false);
    }
  });

  it('does not call early termination under LIMIT a misestimate', () => {
    const plan = fixture('plan-w09');
    const mis = planFindings(plan).filter((f) => f.code === 'ROW_MISESTIMATE');
    expect(mis.find((f) => f.relation === 'customers')).toBeUndefined();
  });

  it('detects a sort spilling to disk', () => {
    const plan = fixture('plan-w13');
    expect(planFindings(plan).map((f) => f.code)).toContain('SORT_SPILL');
    expect(hasSpill(plan)).toBe(true);
  });

  it('detects a selective filter evaluated by a sequential scan', () => {
    const f = planFindings(fixture('plan-w01')).find((x) => x.code === 'SEQ_SCAN_SELECTIVE');
    expect(f).toMatchObject({ relation: 'orders', severity: 'high' });
    expect(Number(f!.evidence.keptPercent)).toBeLessThan(1);
  });
});
