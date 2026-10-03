import type { Db } from '../db.ts';
import { indexShape, parseStatements } from '../sql/ast.ts';
import type { ColumnStats, IndexInfo, TableContext } from '../types.ts';

// Deterministic "RAG over your schema": the tables come from the plan and the query's AST, not a
// vector search. For each one we pull what an index advisor needs from the catalog and pg_stats.

function indexColumns(def: string): string[] {
  try {
    const [stmt] = parseStatements(def);
    return stmt?.type === 'IndexStmt' ? indexShape(stmt.body).keys : [];
  } catch {
    return [];
  }
}

export interface IntrospectOptions {
  /** relname -> columns the query touches; stats are fetched for these (all columns if absent). */
  usedColumns?: Map<string, Set<string>>;
  redactValues?: boolean;
}

export async function introspectTables(db: Db, relations: string[], opts: IntrospectOptions = {}): Promise<TableContext[]> {
  const out: TableContext[] = [];
  const seen = new Set<number>();
  for (const rel of relations) {
    const base = await db.query(
      `SELECT c.oid::int AS oid, n.nspname, c.relname, greatest(c.reltuples, 0)::float8 AS reltuples,
              pg_relation_size(c.oid) AS table_bytes, pg_total_relation_size(c.oid) AS total_bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.oid = to_regclass($1) AND c.relkind IN ('r', 'p', 'm')`,
      [rel],
    );
    const t = base.rows[0];
    if (!t || seen.has(t.oid)) continue;
    seen.add(t.oid);

    const [cols, idx, cons, ext, act] = await Promise.all([
      db.query(
        `SELECT attname, format_type(atttypid, atttypmod) AS type, attnotnull
         FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
        [t.oid],
      ),
      db.query(
        `SELECT ic.relname AS name, pg_get_indexdef(i.indexrelid) AS def, am.amname, i.indisprimary, i.indisunique,
                pg_relation_size(i.indexrelid) AS bytes, coalesce(s.idx_scan, 0) AS scans
         FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_am am ON am.oid = ic.relam
         LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
         WHERE i.indrelid = $1 ORDER BY ic.relname`,
        [t.oid],
      ),
      db.query('SELECT pg_get_constraintdef(oid) AS def, conname FROM pg_constraint WHERE conrelid = $1 ORDER BY conname', [t.oid]),
      db.query(
        `SELECT s.stxname, array_to_string(s.stxkind, ',') AS kinds,
                (SELECT string_agg(a.attname, ', ' ORDER BY a.attnum) FROM pg_attribute a
                 WHERE a.attrelid = s.stxrelid AND a.attnum = ANY (s.stxkeys)) AS cols
         FROM pg_statistic_ext s WHERE s.stxrelid = $1`,
        [t.oid],
      ),
      db.query(
        `SELECT seq_scan, coalesce(idx_scan, 0) AS idx_scan, n_tup_ins, n_tup_upd, n_tup_del, n_live_tup, n_dead_tup,
                greatest(last_analyze, last_autoanalyze)::text AS last_analyze
         FROM pg_stat_user_tables WHERE relid = $1`,
        [t.oid],
      ),
    ]);

    const wanted = opts.usedColumns?.get(t.relname);
    const stats = await db.query(
      `SELECT attname, null_frac, n_distinct, correlation, avg_width,
              most_common_vals::text AS mcv, most_common_freqs AS mcf,
              coalesce(array_length(histogram_bounds, 1), 0) AS hist
       FROM pg_stats WHERE schemaname = $1 AND tablename = $2 ${wanted?.size ? 'AND attname = ANY($3)' : ''}
       ORDER BY attname`,
      wanted?.size ? [t.nspname, t.relname, [...wanted]] : [t.nspname, t.relname],
    );

    const indexes: IndexInfo[] = idx.rows.map((r) => ({
      name: r.name,
      definition: r.def,
      method: r.amname,
      columns: indexColumns(r.def),
      isPrimary: r.indisprimary,
      isUnique: r.indisunique,
      bytes: r.bytes,
      scans: r.scans,
    }));

    const columnStats: ColumnStats[] = stats.rows.map((r) => ({
      column: r.attname,
      nullFrac: r.null_frac,
      // Negative n_distinct is a fraction of the row count.
      nDistinct: r.n_distinct < 0 ? Math.round(-r.n_distinct * t.reltuples) : r.n_distinct,
      correlation: r.correlation,
      avgWidth: r.avg_width,
      mostCommonVals: opts.redactValues || !r.mcv ? undefined : String(r.mcv).slice(0, 200),
      mostCommonFreqs: Array.isArray(r.mcf) ? r.mcf.slice(0, 5).map((x: number) => Math.round(x * 10000) / 10000) : undefined,
      histogramBuckets: r.hist,
    }));

    const a = act.rows[0] ?? {};
    out.push({
      schema: t.nspname,
      name: t.relname,
      qualifiedName: `${t.nspname}.${t.relname}`,
      estimatedRows: Math.round(t.reltuples),
      tableBytes: t.table_bytes,
      totalBytes: t.total_bytes,
      columns: cols.rows.map((c) => ({ name: c.attname, type: c.type, notNull: c.attnotnull })),
      indexes,
      constraints: cons.rows.map((c) => `${c.conname}: ${c.def}`),
      extendedStats: ext.rows.map((e) => `${e.stxname} (${e.kinds}) on ${e.cols}`),
      columnStats,
      activity: {
        seqScans: a.seq_scan ?? 0,
        idxScans: a.idx_scan ?? 0,
        inserts: a.n_tup_ins ?? 0,
        updates: a.n_tup_upd ?? 0,
        deletes: a.n_tup_del ?? 0,
        liveTuples: a.n_live_tup ?? 0,
        deadTuples: a.n_dead_tup ?? 0,
        lastAnalyze: a.last_analyze ?? null,
      },
    });
  }
  return out;
}

export function columnMap(tables: TableContext[]): Map<string, Set<string>> {
  return new Map(tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${n} B`;
}

/** Compact text form for LLM prompts. */
export function renderContext(tables: TableContext[]): string {
  return tables
    .map((t) => {
      const lines = [
        `TABLE ${t.qualifiedName}: ~${t.estimatedRows.toLocaleString('en-US')} rows, ${bytes(t.tableBytes)} heap, ${bytes(t.totalBytes)} total`,
        `  columns: ${t.columns.map((c) => `${c.name} ${c.type}${c.notNull ? ' not null' : ''}`).join(', ')}`,
        `  indexes: ${t.indexes.length ? t.indexes.map((i) => `${i.definition.replace(/^CREATE /, '')} [${bytes(i.bytes)}, ${i.scans} scans]`).join('; ') : '(none)'}`,
      ];
      if (t.constraints.length) lines.push(`  constraints: ${t.constraints.join('; ')}`);
      if (t.extendedStats.length) lines.push(`  extended statistics: ${t.extendedStats.join('; ')}`);
      const w = t.activity;
      lines.push(`  activity: ${w.seqScans} seq scans, ${w.idxScans} index scans, ${w.inserts} inserts, ${w.updates} updates, ${w.deletes} deletes since stats reset`);
      for (const s of t.columnStats) {
        const parts = [`n_distinct=${s.nDistinct}`, `null_frac=${s.nullFrac}`];
        if (s.correlation !== null) parts.push(`correlation=${s.correlation.toFixed(3)}`);
        if (s.mostCommonVals) parts.push(`mcv=${s.mostCommonVals}${s.mostCommonFreqs ? ` freqs=${JSON.stringify(s.mostCommonFreqs)}` : ''}`);
        lines.push(`  stats ${s.column}: ${parts.join(' ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
