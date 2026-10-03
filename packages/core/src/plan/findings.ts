import type { AntiPattern } from '../sql/shape.ts';
import type { ExplainResult, Finding, FindingCode, PlanNode, Severity } from '../types.ts';
import { flatten } from './tree.ts';

// Deterministic diagnosis of a plan. The LLM receives these structured findings rather than being
// asked to "read" raw EXPLAIN output, and the heuristic advisor keys its candidates off them.

const DOCS_QUERIES: Record<FindingCode, string> = {
  SEQ_SCAN_SELECTIVE: 'multicolumn index btree equality range scan combining multiple indexes',
  SEQ_SCAN_IN_LOOP: 'nested loop join inner index scan join column index',
  ROW_MISESTIMATE: 'extended statistics functional dependencies row estimation planner statistics',
  SORT_SPILL: 'work_mem sort external merge disk memory',
  HASH_SPILL: 'work_mem hash_mem_multiplier hash join batches hash aggregate',
  LOSSY_BITMAP: 'bitmap heap scan lossy work_mem',
  HEAP_FETCHES: 'index-only scans visibility map vacuum',
  TEMP_IO: 'work_mem temporary files',
  JIT_OVERHEAD: 'jit_above_cost just-in-time compilation',
  HOT_NODE: 'using explain analyze actual time',
  NOT_IN_SUBQUERY: 'NOT IN subquery NULL NOT EXISTS anti join',
  NON_SARGABLE_PREDICATE: 'indexes on expressions function immutable',
  LEADING_WILDCARD: 'pg_trgm trigram gin index LIKE ILIKE',
  LARGE_OFFSET: 'LIMIT OFFSET rows skipped',
  OR_ACROSS_COLUMNS: 'combining multiple indexes bitmap OR',
};

function f(
  code: FindingCode,
  severity: Severity,
  title: string,
  detail: string,
  node: PlanNode | undefined,
  evidence: Finding['evidence'],
): Finding {
  return { code, severity, title, detail, nodeId: node?.id, relation: node?.relation, evidence, docsQuery: DOCS_QUERIES[code] };
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export function planFindings(plan: ExplainResult): Finding[] {
  const out: Finding[] = [];
  const nodes = flatten(plan.root);
  const totalMs = plan.executionMs ?? plan.root.inclusiveMs;

  const parentOf = new Map<number, PlanNode>();
  for (const n of nodes) for (const c of n.children) parentOf.set(c.id, n);

  // Nodes below a Limit stop early, so "fewer rows than estimated" there is expected, not a misestimate.
  const underLimit = new Set<number>();
  const markLimit = (node: PlanNode, inside: boolean) => {
    if (inside) underLimit.add(node.id);
    for (const c of node.children) markLimit(c, inside || node.nodeType === 'Limit');
  };
  markLimit(plan.root, false);
  const misestimated = (node: PlanNode): boolean => {
    if (node.qError === undefined || node.qError < 10) return false;
    if (Math.max(node.planRows, node.actualRows ?? 0) < 100) return false;
    const over = (node.actualRows ?? 0) < node.planRows;
    return !(over && underLimit.has(node.id));
  };

  for (const node of nodes) {
    const loops = node.actualLoops ?? 1;
    const share = totalMs && node.exclusiveMs !== undefined ? Math.min(1, node.exclusiveMs / totalMs) : undefined;

    if (/Seq Scan$/.test(node.nodeType) && node.relation) {
      const parent = parentOf.get(node.id);
      if (loops > 1 && parent?.nodeType === 'Nested Loop') {
        out.push(
          f('SEQ_SCAN_IN_LOOP', 'high', `Sequential scan of ${node.relation} repeated ${loops} times`,
            `The inner side of a Nested Loop scans ${node.relation} sequentially on every outer row. An index on the join/filter column turns each repetition into an index lookup.`,
            node, { loops, rowsPerLoop: node.actualRows ?? 0, filter: node.filter ?? '' }),
        );
      } else if (node.actualRows !== undefined && node.rowsRemovedByFilter !== undefined) {
        const kept = node.actualRows;
        const removed = node.rowsRemovedByFilter;
        const scanned = (kept + removed) * loops;
        const keptFrac = kept / Math.max(1, kept + removed);
        if (scanned >= 10_000 && keptFrac <= 0.1) {
          out.push(
            f('SEQ_SCAN_SELECTIVE', share !== undefined && share >= 0.3 ? 'high' : 'medium',
              `Selective filter on ${node.relation} evaluated by a full scan`,
              `Read ${scanned.toLocaleString('en-US')} rows to return ${(kept * loops).toLocaleString('en-US')} (${round(keptFrac * 100, 2)}% kept). An index matching the filter can skip the rest.`,
              node, { scannedRows: scanned, keptRows: kept * loops, keptPercent: round(keptFrac * 100, 3), filter: node.filter ?? '', selfMs: round(node.exclusiveMs ?? 0, 2) }),
          );
        }
      } else if (!plan.analyzed && node.filter && node.planRows < 1000) {
        // Cost-only plans: a filtered seq scan expected to return few rows is still worth flagging.
        out.push(
          f('SEQ_SCAN_SELECTIVE', 'medium', `Selective filter on ${node.relation} evaluated by a full scan`,
            `The planner expects ${node.planRows} rows after filtering but must scan the whole table.`,
            node, { estimatedRows: node.planRows, filter: node.filter }),
        );
      }
    }

    // Report a misestimate only where it originates; parents inherit their children's errors.
    if (misestimated(node) && !node.children.some(misestimated) && node.qError !== undefined) {
      const under = (node.actualRows ?? 0) > node.planRows;
      out.push(
        f('ROW_MISESTIMATE', node.qError >= 100 ? 'high' : 'medium',
          `Row estimate off by ${Math.round(node.qError)}x at ${node.nodeType}${node.relation ? ` on ${node.relation}` : ''}`,
          `Planner expected ${node.planRows.toLocaleString('en-US')} rows per loop, got ${(node.actualRows ?? 0).toLocaleString('en-US')} (${under ? 'underestimate' : 'overestimate'}). Bad estimates propagate to join order and join method choices. Correlated columns are a common cause; CREATE STATISTICS can fix it.`,
          node, { estimated: node.planRows, actual: node.actualRows ?? 0, qError: Math.round(node.qError), filter: node.filter ?? node.indexCond ?? '' }),
      );
    }

    if (node.sortSpaceType === 'Disk') {
      out.push(
        f('SORT_SPILL', 'high', `Sort spilled ${node.sortSpaceUsedKb ?? '?'} kB to disk`,
          `Sort Method "${node.sortMethod}" means the sort did not fit in work_mem and used temporary files.`,
          node, { spaceKb: node.sortSpaceUsedKb ?? 0, method: node.sortMethod ?? '' }),
      );
    }

    if ((node.hashBatches ?? 1) > 1 || (node.diskUsageKb ?? 0) > 0) {
      out.push(
        f('HASH_SPILL', 'medium', `${node.nodeType} split into ${node.hashBatches ?? '?'} batches`,
          'The hash table exceeded work_mem × hash_mem_multiplier and was partitioned to disk.',
          node, { batches: node.hashBatches ?? 0, diskKb: node.diskUsageKb ?? 0, peakMemoryKb: node.peakMemoryKb ?? 0 }),
      );
    }

    if ((node.lossyHeapBlocks ?? 0) > 0) {
      out.push(
        f('LOSSY_BITMAP', 'medium', `Bitmap went lossy on ${node.lossyHeapBlocks} blocks`,
          'The bitmap did not fit in work_mem, so whole pages are rechecked row by row.',
          node, { lossyBlocks: node.lossyHeapBlocks ?? 0, exactBlocks: node.exactHeapBlocks ?? 0, recheckRemoved: node.rowsRemovedByIndexRecheck ?? 0 }),
      );
    }

    if (node.nodeType === 'Index Only Scan' && (node.heapFetches ?? 0) > 0.1 * Math.max(1, (node.actualRows ?? 0) * loops)) {
      out.push(
        f('HEAP_FETCHES', 'low', `Index-only scan on ${node.relation} still visits the heap`,
          'Many pages are not marked all-visible, so the "index-only" scan fetches heap tuples. VACUUM updates the visibility map.',
          node, { heapFetches: node.heapFetches ?? 0 }),
      );
    }
  }

  if (!out.some((x) => x.code === 'SORT_SPILL' || x.code === 'HASH_SPILL')) {
    const temp = nodes.reduce((sum, n) => sum + (n.tempWrittenBlocks ?? 0), 0);
    if (temp > 0) {
      out.push(f('TEMP_IO', 'low', `${temp} temp blocks written`, 'Some operation wrote temporary files.', plan.root, { tempBlocks: temp }));
    }
  }

  if (plan.jitMs && plan.executionMs && plan.jitMs / plan.executionMs > 0.2) {
    out.push(
      f('JIT_OVERHEAD', 'low', `JIT compilation took ${round(plan.jitMs)} ms`,
        `JIT accounted for ${Math.round((plan.jitMs / plan.executionMs) * 100)}% of execution time. For short queries, raising jit_above_cost or disabling JIT is cheaper.`,
        plan.root, { jitMs: round(plan.jitMs, 2), executionMs: round(plan.executionMs, 2) }),
    );
  }

  if (plan.analyzed && totalMs) {
    const hot = nodes.reduce((a, b) => ((b.exclusiveMs ?? 0) > (a.exclusiveMs ?? 0) ? b : a));
    const share = (hot.exclusiveMs ?? 0) / totalMs;
    if (share >= 0.5 && totalMs >= 5) {
      out.push(
        f('HOT_NODE', 'low', `${Math.round(Math.min(1, share) * 100)}% of time in ${hot.nodeType}${hot.relation ? ` on ${hot.relation}` : ''}`,
          'This node dominates execution time; improvements elsewhere will not matter much.',
          hot, { selfMs: round(hot.exclusiveMs ?? 0, 2), totalMs: round(totalMs, 2) }),
      );
    }
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function queryFindings(antiPatterns: AntiPattern[]): Finding[] {
  const titles: Partial<Record<FindingCode, string>> = {
    NOT_IN_SUBQUERY: 'NOT IN (subquery)',
    NON_SARGABLE_PREDICATE: 'Predicate wraps an indexed column in a function',
    LEADING_WILDCARD: 'Leading-wildcard pattern match',
    LARGE_OFFSET: 'Large OFFSET pagination',
    OR_ACROSS_COLUMNS: 'OR across different columns',
  };
  const seen = new Set<string>();
  return antiPatterns
    .filter((a) => {
      const key = `${a.code}:${a.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((a) => ({
      code: a.code,
      severity: a.code === 'NOT_IN_SUBQUERY' || a.code === 'NON_SARGABLE_PREDICATE' ? 'medium' : 'low',
      title: titles[a.code] ?? a.code,
      detail: a.detail,
      relation: a.relation,
      evidence: {},
      docsQuery: DOCS_QUERIES[a.code],
    }));
}
