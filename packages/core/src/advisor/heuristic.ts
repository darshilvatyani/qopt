import { flatten } from '../plan/tree.ts';
import type { Predicate, QueryShape } from '../sql/shape.ts';
import type { Candidate, ExplainResult, Finding, TableContext } from '../types.ts';

// Rule-based index advisor in the spirit of Dexter: equality columns first, then one range column,
// then ORDER BY columns; plus GIN/trigram/BRIN/expression/partial variants, extended statistics
// for correlated-column misestimates, and work_mem for spills. No LLM; this is the baseline.

export interface HeuristicInput {
  shape: QueryShape;
  findings: Finding[];
  tables: TableContext[];
  plan: ExplainResult;
  extensions: string[];
}

function ident(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export function indexName(table: string, keys: string[], suffix = 'idx'): string {
  const base = `qopt_${ident(table)}_${keys.map(ident).join('_')}`;
  return `${base.slice(0, 63 - suffix.length - 1)}_${suffix}`;
}

function quoteLiteral(v: string): string {
  return v.startsWith("'") ? v : `'${v.replace(/'/g, "''")}'`;
}

function kb(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} MB` : `${n} kB`;
}

export function heuristicCandidates(input: HeuristicInput): Candidate[] {
  const { shape, findings, tables, plan } = input;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const byName = new Map(tables.map((t) => [t.name, t]));
  const planNodes = flatten(plan.root);
  const seqScanned = new Set(planNodes.filter((n) => /Seq Scan$/.test(n.nodeType) && n.relation).map((n) => n.relation!));

  const add = (c: Omit<Candidate, 'id' | 'source' | 'round' | 'citations'>) => {
    const key = c.statements.join(';');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...c, id: `h${out.length + 1}`, source: 'heuristic', round: 0, citations: [] });
  };

  /** True when an existing index already starts with exactly these keys. */
  const covered = (t: TableContext, keys: string[]) =>
    t.indexes.some((i) => keys.every((k, pos) => i.columns[pos] === k));

  const btree = (t: TableContext, keys: string[], why: string, extra: { where?: string; title?: string } = {}) => {
    if (!keys.length || (!extra.where && covered(t, keys))) return;
    const name = indexName(t.name, keys, extra.where ? 'partial_idx' : 'idx');
    const where = extra.where ? ` WHERE ${extra.where}` : '';
    add({
      kind: 'index',
      title: extra.title ?? `B-tree on ${t.name} (${keys.join(', ')})${where}`,
      statements: [`CREATE INDEX CONCURRENTLY ${name} ON ${t.qualifiedName} (${keys.join(', ')})${where}`],
      rationale: why,
    });
  };

  const nDistinct = (t: TableContext, col: string) => t.columnStats.find((s) => s.column === col)?.nDistinct ?? 0;
  const colType = (t: TableContext, col: string) => t.columns.find((c) => c.name === col)?.type ?? '';

  for (const t of tables) {
    if (t.estimatedRows < 1000) continue;
    const preds = shape.predicates.filter((p) => p.table === t.name);
    const and = preds.filter((p) => !p.inOr);
    const uniqueCols = (ps: Predicate[]) => [...new Set(ps.map((p) => p.column!).filter(Boolean))];

    const eq = uniqueCols(and.filter((p) => (p.kind === 'eq' || p.kind === 'in') && p.column)).sort(
      (a, b) => nDistinct(t, b) - nDistinct(t, a),
    );
    const range = uniqueCols(and.filter((p) => p.kind === 'range' && p.column))[0];
    const sortOnT = shape.orderBy.length > 0 && shape.orderBy.every((o) => o.table === t.name && o.column);
    const sortCols = sortOnT ? shape.orderBy.map((o) => o.column!) : [];

    // 1. Equality then range (the classic multicolumn rule).
    if (eq.length || range) {
      const keys = [...eq, ...(range ? [range] : [])].slice(0, 3);
      btree(t, keys, `Filter on ${keys.join(', ')}: equality columns lead, the range column goes last so one index range scan covers the predicate.`);
    }
    // 2. Equality then ORDER BY, so a LIMIT can stop early without sorting.
    if (eq.length && sortCols.length && shape.limit !== undefined) {
      const keys = [...eq, ...sortCols.filter((c) => !eq.includes(c))].slice(0, 3);
      btree(t, keys, `Equality on ${eq.join(', ')} plus ORDER BY ${sortCols.join(', ')}: the index returns rows already sorted, so LIMIT ${shape.limit} reads only ${shape.limit} entries.`);
    }
    // 3. ORDER BY alone (pagination / top-N).
    if (!eq.length && !range && sortCols.length && (shape.limit !== undefined || shape.offset !== undefined)) {
      btree(t, sortCols, `ORDER BY ${sortCols.join(', ')} with LIMIT: an index in sort order avoids sorting the whole table.`);
    }
    // 4. Partial index: a low-cardinality equality constant filters a range/sort column.
    const lowCard = and.find((p) => p.kind === 'eq' && p.column && p.value && nDistinct(t, p.column) > 0 && nDistinct(t, p.column) <= 10);
    const partialKey = range ?? sortCols[0];
    if (lowCard && partialKey && partialKey !== lowCard.column) {
      btree(t, [partialKey], `Only rows with ${lowCard.column} = ${lowCard.value} are queried; a partial index stores just those, so it is small and cheap to maintain.`, {
        where: `${lowCard.column} = ${quoteLiteral(lowCard.value!)}`,
      });
    }
    // 5. Expression predicates: index the expression itself.
    for (const p of and.filter((p) => p.expr && (p.kind === 'eq' || p.kind === 'range' || p.kind === 'in'))) {
      btree(t, [`(${p.expr})`], `The predicate is on ${p.expr}, not the bare column; only an expression index matches it (and it also gives the planner statistics for the expression).`, {
        title: `Expression index on ${t.name} ((${p.expr}))`,
      });
    }
    // 6. Containment operators need GIN.
    for (const p of and.filter((p) => p.kind === 'contains' && p.column)) {
      const type = colType(t, p.column!);
      const opclass = type === 'jsonb' && p.op === '@>' ? ' jsonb_path_ops' : '';
      if (t.indexes.some((i) => i.method === 'gin' && i.columns[0] === p.column)) continue;
      add({
        kind: 'index',
        title: `GIN on ${t.name} (${p.column}${opclass})`,
        statements: [`CREATE INDEX CONCURRENTLY ${indexName(t.name, [p.column!], 'gin_idx')} ON ${t.qualifiedName} USING gin (${p.column}${opclass})`],
        rationale: `${p.op} on a ${type} column is served by GIN, which indexes each element/key rather than the whole value.${opclass ? ' jsonb_path_ops is smaller and faster for @>.' : ''}`,
      });
    }
    // 7. Pattern matching.
    for (const p of and.filter((p) => (p.kind === 'like_infix' || p.kind === 'like_prefix') && p.column)) {
      if (p.kind === 'like_infix') {
        if (!input.extensions.includes('pg_trgm')) continue;
        add({
          kind: 'index',
          title: `Trigram GIN on ${t.name} (${p.column})`,
          statements: [`CREATE INDEX CONCURRENTLY ${indexName(t.name, [p.column!], 'trgm_idx')} ON ${t.qualifiedName} USING gin (${p.column} gin_trgm_ops)`],
          rationale: `A leading-wildcard ${p.op === '~~*' ? 'ILIKE' : 'LIKE'} can't use a B-tree; pg_trgm's GIN operator class indexes 3-character substrings and supports it.`,
        });
      } else {
        btree(t, [`${p.column} text_pattern_ops`], `A left-anchored LIKE can use a B-tree with text_pattern_ops (needed unless the column uses the C collation).`);
      }
    }
    // 8. OR across columns: one index per branch lets the planner combine them with BitmapOr.
    const orCols = uniqueCols(preds.filter((p) => p.inOr && (p.kind === 'eq' || p.kind === 'in') && p.column));
    if (orCols.length > 1 && preds.filter((p) => p.inOr).every((p) => p.column)) {
      const missing = orCols.filter((c) => !covered(t, [c]));
      if (missing.length) {
        add({
          kind: 'index',
          title: `B-trees on ${t.name} (${missing.join('), (')}) for BitmapOr`,
          statements: missing.map((c) => `CREATE INDEX CONCURRENTLY ${indexName(t.name, [c])} ON ${t.qualifiedName} (${c})`),
          rationale: `The OR spans ${orCols.join(', ')}. An index on only one branch is useless; with one per branch the planner can BitmapOr them.`,
        });
      }
    }
    // 9. BRIN for range filters on large, physically ordered columns.
    if (range && t.estimatedRows >= 500_000) {
      const corr = t.columnStats.find((s) => s.column === range)?.correlation ?? 0;
      if (Math.abs(corr) >= 0.9 && !t.indexes.some((i) => i.method === 'brin' && i.columns[0] === range)) {
        add({
          kind: 'index',
          title: `BRIN on ${t.name} (${range})`,
          statements: [`CREATE INDEX CONCURRENTLY ${indexName(t.name, [range], 'brin_idx')} ON ${t.qualifiedName} USING brin (${range})`],
          rationale: `${range} has physical correlation ${corr.toFixed(3)}, so block ranges summarise it well: a BRIN index is a tiny fraction of a B-tree's size.`,
        });
      }
    }
  }

  // 10. GROUP BY (+ aggregate DISTINCT) fed by a big sort: an index in group order removes the sort,
  //     and with every referenced column in the key, allows an index-only scan.
  const sorts = planNodes.some((n) => n.nodeType === 'Sort' || n.nodeType === 'Incremental Sort');
  if (shape.relations.length === 1 && shape.groupBy.length && sorts) {
    const t = byName.get(shape.relations[0].relname);
    const cols = [...new Set([...shape.groupBy, ...shape.distinctAggs].map((c) => c.column))];
    if (t && t.estimatedRows >= 10_000 && [...shape.groupBy, ...shape.distinctAggs].every((c) => c.table === t.name)) {
      btree(t, cols.slice(0, 4), `GROUP BY ${shape.groupBy.map((g) => g.column).join(', ')}${shape.distinctAggs.length ? ` with DISTINCT ${shape.distinctAggs.map((d) => d.column).join(', ')}` : ''} needs input sorted by ${cols.join(', ')}; an index in that order (read as an index-only scan) replaces the sort.`);
    }
  }

  // 11. Join keys on large tables that are scanned sequentially.
  for (const j of shape.joins) {
    for (const side of [j.left, j.right]) {
      const t = side.table ? byName.get(side.table) : undefined;
      if (!t || t.estimatedRows < 10_000 || !seqScanned.has(t.name)) continue;
      btree(t, [side.column], `Join key ${t.name}.${side.column} has no index, so the join must scan all of ${t.name}. With an index the planner can use a nested loop driven by the smaller, filtered side.`);
    }
  }

  // 12. Correlated-column misestimates: multivariate statistics.
  for (const f of findings.filter((x) => x.code === 'ROW_MISESTIMATE' && x.relation)) {
    const t = byName.get(f.relation!);
    if (!t) continue;
    const cols = [
      ...new Set(shape.predicates.filter((p) => p.table === t.name && !p.inOr && p.kind === 'eq' && p.column).map((p) => p.column!)),
    ];
    if (cols.length < 2) continue;
    if (t.extendedStats.some((s) => cols.every((c) => s.includes(c)))) continue;
    const name = indexName(t.name, cols, 'stats');
    add({
      kind: 'statistics',
      title: `Extended statistics on ${t.name} (${cols.join(', ')})`,
      statements: [`CREATE STATISTICS ${name} (dependencies, mcv) ON ${cols.join(', ')} FROM ${t.qualifiedName}`],
      rationale: `The planner multiplies the selectivities of ${cols.join(' and ')} as if independent and is off by ${f.evidence.qError}x. Functional-dependency and MCV statistics capture the correlation.`,
    });
  }

  // 13. Spills: size work_mem to the observed spill.
  const spill = planNodes.reduce((m, n) => Math.max(m, n.sortSpaceType === 'Disk' ? n.sortSpaceUsedKb ?? 0 : 0, n.diskUsageKb ?? 0), 0);
  if (spill > 0 || findings.some((x) => x.code === 'LOSSY_BITMAP' || x.code === 'HASH_SPILL')) {
    // In-memory sorts need roughly 2-3x the on-disk run size.
    const neededMb = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, (spill * 3) / 1024))));
    const mb = Math.min(1024, neededMb);
    add({
      kind: 'config',
      title: `SET work_mem = '${mb}MB' for this query`,
      statements: [`SET work_mem = '${mb}MB'`],
      rationale: `The plan spilled ${kb(spill)} to disk. Raising work_mem for this session/statement (not globally: it is per sort/hash node, per connection) lets it run in memory.`,
    });
  }

  return out.slice(0, 8);
}
