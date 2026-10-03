import type { ExplainResult, PlanNode } from '../types.ts';

// Normalises EXPLAIN (FORMAT JSON) output into a typed tree and derives the numbers the
// findings detectors use: time spent in each node alone, and how wrong the row estimate was.

type RawPlan = Record<string, any>;

function n(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function s(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function toNode(raw: RawPlan, counter: { next: number }): PlanNode {
  const node: PlanNode = {
    id: counter.next++,
    nodeType: raw['Node Type'],
    relation: s(raw['Relation Name']),
    schema: s(raw['Schema']),
    alias: s(raw['Alias']),
    indexName: s(raw['Index Name']),
    joinType: s(raw['Join Type']),
    strategy: s(raw['Strategy']),
    parentRelationship: s(raw['Parent Relationship']),
    startupCost: n(raw['Startup Cost']) ?? 0,
    totalCost: n(raw['Total Cost']) ?? 0,
    planRows: n(raw['Plan Rows']) ?? 0,
    planWidth: n(raw['Plan Width']) ?? 0,
    actualRows: n(raw['Actual Rows']),
    actualLoops: n(raw['Actual Loops']),
    actualTotalTime: n(raw['Actual Total Time']),
    filter: s(raw['Filter']),
    indexCond: s(raw['Index Cond']),
    recheckCond: s(raw['Recheck Cond']),
    hashCond: s(raw['Hash Cond']),
    mergeCond: s(raw['Merge Cond']),
    joinFilter: s(raw['Join Filter']),
    sortKey: Array.isArray(raw['Sort Key']) ? raw['Sort Key'] : undefined,
    groupKey: Array.isArray(raw['Group Key']) ? raw['Group Key'] : undefined,
    sortMethod: s(raw['Sort Method']),
    sortSpaceType: s(raw['Sort Space Type']),
    sortSpaceUsedKb: n(raw['Sort Space Used']),
    rowsRemovedByFilter: n(raw['Rows Removed by Filter']),
    rowsRemovedByIndexRecheck: n(raw['Rows Removed by Index Recheck']),
    rowsRemovedByJoinFilter: n(raw['Rows Removed by Join Filter']),
    hashBatches: n(raw['Hash Batches']) ?? n(raw['HashAgg Batches']),
    originalHashBatches: n(raw['Original Hash Batches']),
    peakMemoryKb: n(raw['Peak Memory Usage']),
    diskUsageKb: n(raw['Disk Usage']),
    lossyHeapBlocks: n(raw['Lossy Heap Blocks']),
    exactHeapBlocks: n(raw['Exact Heap Blocks']),
    heapFetches: n(raw['Heap Fetches']),
    sharedHitBlocks: n(raw['Shared Hit Blocks']),
    sharedReadBlocks: n(raw['Shared Read Blocks']),
    tempReadBlocks: n(raw['Temp Read Blocks']),
    tempWrittenBlocks: n(raw['Temp Written Blocks']),
    workersPlanned: n(raw['Workers Planned']),
    workersLaunched: n(raw['Workers Launched']),
    children: [],
  };
  node.children = ((raw['Plans'] as RawPlan[]) ?? []).map((c) => toNode(c, counter));
  return node;
}

function deriveTimes(node: PlanNode): void {
  for (const c of node.children) deriveTimes(c);
  if (node.actualTotalTime === undefined) return;
  // "Actual Total Time" is an average per loop; multiply by loops for the node's total.
  node.inclusiveMs = node.actualTotalTime * (node.actualLoops ?? 1);
  // InitPlans/SubPlans run inside their parent, so subtracting every child is correct.
  const childMs = node.children.reduce((sum, c) => sum + (c.inclusiveMs ?? 0), 0);
  node.exclusiveMs = Math.max(0, node.inclusiveMs - childMs);
  if (node.actualRows !== undefined && node.actualLoops) {
    const est = Math.max(node.planRows, 1);
    const act = Math.max(node.actualRows, 1);
    node.qError = Math.max(est, act) / Math.min(est, act);
  }
}

/** Accepts the array EXPLAIN returns, its first element, or a bare auto_explain object. */
export function normalizeExplain(raw: unknown): ExplainResult {
  const top = (Array.isArray(raw) ? raw[0] : raw) as RawPlan;
  if (!top || typeof top !== 'object' || !top['Plan']) throw new Error('not an EXPLAIN (FORMAT JSON) document');
  const root = toNode(top['Plan'], { next: 1 });
  deriveTimes(root);
  const jit = top['JIT'] as RawPlan | undefined;
  return {
    root,
    analyzed: root.actualTotalTime !== undefined,
    totalCost: root.totalCost,
    planningMs: n(top['Planning Time']),
    executionMs: n(top['Execution Time']),
    jitMs: jit ? n(jit['Timing']?.['Total']) : undefined,
    queryText: s(top['Query Text']),
  };
}

export function flatten(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  const visit = (n: PlanNode) => {
    out.push(n);
    n.children.forEach(visit);
  };
  visit(root);
  return out;
}

export function isScan(node: PlanNode): boolean {
  return /Scan$/.test(node.nodeType) && !!node.relation;
}

/** Index names referenced anywhere in the plan. */
export function indexesUsed(plan: ExplainResult): string[] {
  return [...new Set(flatten(plan.root).map((n) => n.indexName).filter((x): x is string => !!x))];
}

/** Relations (schema-qualified when known) scanned anywhere in the plan. */
export function relationsInPlan(plan: ExplainResult): string[] {
  const rels = flatten(plan.root)
    .filter((n) => n.relation)
    .map((n) => (n.schema ? `${n.schema}.${n.relation}` : n.relation!));
  return [...new Set(rels)];
}

export function hasSpill(plan: ExplainResult): boolean {
  return flatten(plan.root).some(
    (n) => n.sortSpaceType === 'Disk' || (n.hashBatches ?? 1) > 1 || (n.diskUsageKb ?? 0) > 0 || (n.lossyHeapBlocks ?? 0) > 0,
  );
}

/** Largest q-error among scan nodes of a relation (misestimates at the leaves cascade upwards). */
export function maxScanQError(plan: ExplainResult, relation?: string): number {
  const errs = flatten(plan.root)
    .filter((n) => isScan(n) && (!relation || n.relation === relation))
    .map((n) => n.qError ?? 1);
  return errs.length ? Math.max(...errs) : 1;
}

function fmt(v: number | undefined, digits = 1): string {
  if (v === undefined) return '?';
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString('en-US');
  return v.toFixed(digits).replace(/\.0+$/, '');
}

/** Compact one-line-per-node text, used in LLM prompts and CLI output. */
export function renderPlanText(plan: ExplainResult, maxNodes = 60): string {
  const lines: string[] = [];
  const visit = (node: PlanNode, depth: number) => {
    if (lines.length >= maxNodes) return;
    const parts: string[] = [`[${node.id}] ${node.nodeType}`];
    if (node.joinType) parts[0] = `[${node.id}] ${node.nodeType} (${node.joinType})`;
    if (node.relation) parts.push(`on ${node.relation}${node.alias && node.alias !== node.relation ? ` ${node.alias}` : ''}`);
    if (node.indexName) parts.push(`using ${node.indexName}`);
    parts.push(`cost=${fmt(node.totalCost)} est_rows=${fmt(node.planRows, 0)}`);
    if (node.actualRows !== undefined) {
      parts.push(`actual_rows=${fmt(node.actualRows, 0)} loops=${node.actualLoops}`);
      if (node.exclusiveMs !== undefined) parts.push(`self=${fmt(node.exclusiveMs, 2)}ms total=${fmt(node.inclusiveMs, 2)}ms`);
      if (node.qError && node.qError >= 10) parts.push(`misestimate=${fmt(node.qError, 0)}x`);
    }
    if (node.indexCond) parts.push(`index_cond=${node.indexCond}`);
    if (node.hashCond) parts.push(`hash_cond=${node.hashCond}`);
    if (node.mergeCond) parts.push(`merge_cond=${node.mergeCond}`);
    if (node.joinFilter) parts.push(`join_filter=${node.joinFilter}`);
    if (node.filter) parts.push(`filter=${node.filter}`);
    if (node.rowsRemovedByFilter) parts.push(`removed_by_filter=${fmt(node.rowsRemovedByFilter * (node.actualLoops ?? 1), 0)}`);
    if (node.sortKey) parts.push(`sort_key=${node.sortKey.join(', ')}`);
    if (node.sortMethod) parts.push(`sort=${node.sortMethod}${node.sortSpaceType ? ` (${node.sortSpaceType} ${node.sortSpaceUsedKb}kB)` : ''}`);
    if ((node.hashBatches ?? 1) > 1) parts.push(`batches=${node.hashBatches}`);
    if (node.diskUsageKb) parts.push(`disk=${node.diskUsageKb}kB`);
    if (node.lossyHeapBlocks) parts.push(`lossy_blocks=${node.lossyHeapBlocks}`);
    if (node.heapFetches) parts.push(`heap_fetches=${node.heapFetches}`);
    lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
    node.children.forEach((c) => visit(c, depth + 1));
  };
  visit(plan.root, 0);
  const footer: string[] = [];
  if (plan.planningMs !== undefined) footer.push(`planning=${fmt(plan.planningMs, 2)}ms`);
  if (plan.executionMs !== undefined) footer.push(`execution=${fmt(plan.executionMs, 2)}ms`);
  if (plan.jitMs) footer.push(`jit=${fmt(plan.jitMs, 2)}ms`);
  if (footer.length) lines.push(footer.join(' '));
  return lines.join('\n');
}
