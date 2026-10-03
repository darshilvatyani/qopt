import type { Candidate, ErrorClass } from '../types.ts';
import { type AstNode, constValue, type IndexShape, indexShape, parseStatements, SqlParseError, strings, unwrap, walk } from './ast.ts';

// Every statement an LLM (or the heuristic advisor) proposes goes through here before it touches a
// database. The parser tells us what the statement *is*, independent of what the model claims.

export const CONFIG_WHITELIST = new Set([
  'work_mem',
  'hash_mem_multiplier',
  'random_page_cost',
  'seq_page_cost',
  'effective_cache_size',
  'effective_io_concurrency',
  'jit',
  'jit_above_cost',
  'max_parallel_workers_per_gather',
]);

const MAX_WORK_MEM_KB = 1024 * 1024; // 1GB: the shadow shouldn't be OOM-killed by a suggestion

const FORBIDDEN_FUNCTIONS = [
  /^pg_sleep/,
  /^pg_terminate_backend$/,
  /^pg_cancel_backend$/,
  /^pg_reload_conf$/,
  /^pg_rotate_logfile$/,
  /^pg_read_(binary_)?file$/,
  /^pg_ls_/,
  /^pg_stat_file$/,
  /^pg_advisory/,
  /^pg_switch_wal$/,
  /^pg_promote$/,
  /^pg_create_restore_point$/,
  /^lo_/,
  /^dblink/,
  /^set_config$/,
  /^nextval$/,
  /^setval$/,
];

export interface ExecIndex {
  shape: IndexShape;
  /** Statement to run inside a transaction (CONCURRENTLY removed). */
  execSql: string;
  /** Statement to show the user (with CONCURRENTLY, safe for production). */
  displaySql: string;
}

export interface CheckedCandidate {
  indexes: ExecIndex[];
  statistics: { execSql: string; table: string; schema?: string; columns: string[] }[];
  settings: { name: string; value: string; execSql: string }[];
  rewrite?: string;
}

export type CheckResult = { ok: true; checked: CheckedCandidate } | { ok: false; errorClass: ErrorClass; reason: string };

function fail(errorClass: ErrorClass, reason: string): CheckResult {
  return { ok: false, errorClass, reason };
}

export function toDisplayIndexSql(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  return trimmed.replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?/i, (_m, u) => `CREATE ${u ?? ''}INDEX CONCURRENTLY `);
}

export function toExecIndexSql(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  return trimmed.replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+)CONCURRENTLY\s+/i, '$1');
}

function checkIndex(sql: string): ExecIndex | string {
  const stmts = parseStatements(sql);
  if (stmts.length !== 1 || stmts[0].type !== 'IndexStmt') return `expected a single CREATE INDEX, got ${stmts.map((s) => s.type).join(', ') || 'nothing'}`;
  const shape = indexShape(stmts[0].body);
  if (shape.unique) return 'UNIQUE indexes add a constraint and can change behaviour; not allowed as a performance suggestion';
  return { shape, execSql: toExecIndexSql(sql), displaySql: toDisplayIndexSql(sql) };
}

export function parseMemoryKb(value: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(kB|MB|GB|TB)?\s*$/i.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'kB').toLowerCase();
  const factor = unit === 'kb' ? 1 : unit === 'mb' ? 1024 : unit === 'gb' ? 1024 ** 2 : 1024 ** 3;
  return n * factor;
}

function checkRewriteAst(body: AstNode): string | undefined {
  let problem: string | undefined;
  walk({ SelectStmt: body }, (type, node) => {
    if (problem) return;
    if (type === 'InsertStmt' || type === 'UpdateStmt' || type === 'DeleteStmt' || type === 'MergeStmt') {
      problem = `rewrite contains a data-modifying ${type.replace('Stmt', '').toUpperCase()}`;
    } else if (type === 'SelectStmt' && node.intoClause) {
      problem = 'SELECT INTO creates a table';
    } else if (type === 'SelectStmt' && node.lockingClause) {
      problem = 'row locking clauses (FOR UPDATE/SHARE) are not allowed in a rewrite';
    } else if (type === 'FuncCall') {
      const name = strings(node.funcname).pop() ?? '';
      if (FORBIDDEN_FUNCTIONS.some((re) => re.test(name))) problem = `function ${name}() is not allowed`;
    }
  });
  return problem;
}

/** Static validation: is each statement what the candidate claims, and safe to run in the lab? */
export function checkCandidate(c: Pick<Candidate, 'kind' | 'statements' | 'rewrittenSql'>): CheckResult {
  const checked: CheckedCandidate = { indexes: [], statistics: [], settings: [] };
  try {
    switch (c.kind) {
      case 'index': {
        if (!c.statements.length) return fail('invalid_sql', 'index candidate has no CREATE INDEX statement');
        for (const s of c.statements) {
          const r = checkIndex(s);
          if (typeof r === 'string') return fail('unsafe', r);
          checked.indexes.push(r);
        }
        break;
      }
      case 'statistics': {
        if (!c.statements.length) return fail('invalid_sql', 'statistics candidate has no statement');
        for (const s of c.statements) {
          const stmts = parseStatements(s);
          if (stmts.length !== 1 || stmts[0].type !== 'CreateStatsStmt') return fail('unsafe', 'expected a single CREATE STATISTICS statement');
          const b = stmts[0].body;
          const rel = unwrap(b.relations?.[0]);
          if (!rel || rel.type !== 'RangeVar') return fail('invalid_sql', 'CREATE STATISTICS must name one table');
          const columns = ((b.exprs as AstNode[]) ?? []).map((e) => e.StatsElem?.name).filter(Boolean);
          checked.statistics.push({ execSql: s.trim().replace(/;+\s*$/, ''), table: rel.body.relname, schema: rel.body.schemaname, columns });
        }
        break;
      }
      case 'config': {
        if (!c.statements.length) return fail('invalid_sql', 'config candidate has no SET statement');
        for (const s of c.statements) {
          const stmts = parseStatements(s);
          if (stmts.length !== 1 || stmts[0].type !== 'VariableSetStmt') return fail('unsafe', 'expected a single SET statement');
          const b = stmts[0].body;
          const name = String(b.name ?? '').toLowerCase();
          if (b.kind !== 'VAR_SET_VALUE' || !CONFIG_WHITELIST.has(name)) {
            return fail('unsafe', `setting ${name || '(unknown)'} is not in the allowed list (${[...CONFIG_WHITELIST].join(', ')})`);
          }
          const args = ((b.args as unknown[]) ?? []).map((a) => {
            const w = unwrap(a);
            return w?.type === 'A_Const' ? String(constValue(w.body)) : undefined;
          });
          if (args.length !== 1 || args[0] === undefined) return fail('invalid_sql', `SET ${name} needs a single constant value`);
          const value = args[0];
          if (name === 'work_mem') {
            const kb = parseMemoryKb(value);
            if (kb === undefined) return fail('invalid_sql', `cannot parse work_mem value '${value}'`);
            if (kb > MAX_WORK_MEM_KB) return fail('unsafe', `work_mem ${value} exceeds the 1GB safety cap`);
          }
          checked.settings.push({ name, value, execSql: `SET LOCAL ${name} = '${value.replace(/'/g, "''")}'` });
        }
        break;
      }
      case 'rewrite': {
        if (!c.rewrittenSql?.trim()) return fail('invalid_sql', 'rewrite candidate has no rewritten SQL');
        const stmts = parseStatements(c.rewrittenSql);
        if (stmts.length !== 1 || stmts[0].type !== 'SelectStmt') return fail('unsafe', 'a rewrite must be a single SELECT statement');
        const problem = checkRewriteAst(stmts[0].body);
        if (problem) return fail('unsafe', problem);
        checked.rewrite = c.rewrittenSql.trim().replace(/;+\s*$/, '');
        for (const s of c.statements) {
          const r = checkIndex(s);
          if (typeof r === 'string') return fail('unsafe', `supporting statement: ${r}`);
          checked.indexes.push(r);
        }
        break;
      }
    }
  } catch (e) {
    if (e instanceof SqlParseError) return fail('invalid_sql', `does not parse: ${e.message}`);
    throw e;
  }
  return { ok: true, checked };
}

/** Methods HypoPG can simulate. Everything else must be built for real on the shadow. */
export const HYPOPG_METHODS = new Set(['btree', 'brin', 'hash', 'bloom']);
