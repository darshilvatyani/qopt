import { fingerprintSync, loadModule, parseSync } from 'libpg-query';

// libpg-query is the real Postgres parser compiled to WASM. It must be loaded once before use.
let loading: Promise<void> | undefined;
let ready = false;

export async function initParser(): Promise<void> {
  loading ??= loadModule().then(() => {
    ready = true;
  });
  await loading;
}

function assertReady(): void {
  if (!ready) throw new Error('SQL parser not initialised: await initParser() first');
}

export type AstNode = Record<string, any>;

export interface ParsedStatement {
  type: string;
  body: AstNode;
}

export class SqlParseError extends Error {}

export function parseStatements(sql: string): ParsedStatement[] {
  assertReady();
  let result;
  try {
    result = parseSync(sql);
  } catch (e) {
    throw new SqlParseError(e instanceof Error ? e.message : String(e));
  }
  return (result.stmts ?? []).map((s: AstNode) => {
    const stmt = s.stmt as AstNode;
    const type = Object.keys(stmt)[0];
    return { type, body: stmt[type] };
  });
}

export function parseOne(sql: string): ParsedStatement {
  const stmts = parseStatements(sql);
  if (stmts.length !== 1) throw new SqlParseError(`expected exactly one statement, got ${stmts.length}`);
  return stmts[0];
}

export function fingerprint(sql: string): string {
  assertReady();
  try {
    return fingerprintSync(sql);
  } catch {
    return sql.replace(/\s+/g, ' ').trim().toLowerCase();
  }
}

/** A wrapped AST node looks like {"ColumnRef": {...}}: one key, capitalised, object value. */
export function unwrap(node: unknown): { type: string; body: AstNode } | undefined {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const keys = Object.keys(node);
  if (keys.length !== 1) return undefined;
  const type = keys[0];
  const body = (node as AstNode)[type];
  if (!/^[A-Z]/.test(type) || typeof body !== 'object' || body === null) return undefined;
  return { type, body };
}

/** Depth-first visit of every wrapped node below `node` (including itself). */
export function walk(node: unknown, visit: (type: string, body: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const w = unwrap(node);
  if (w) visit(w.type, w.body);
  for (const value of Object.values(w ? w.body : (node as AstNode))) {
    if (value && typeof value === 'object') walk(value, visit);
  }
}

export function strings(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((n) => (n as AstNode)?.String?.sval).filter((s): s is string => typeof s === 'string');
}

/** Value of an A_Const body. Protobuf omits zero/false/empty fields, so {ival:{}} means 0. */
export function constValue(body: AstNode): string | number | boolean | null {
  if (body.isnull) return null;
  if ('ival' in body) return body.ival?.ival ?? 0;
  if ('fval' in body) return Number(body.fval?.fval ?? 0);
  if ('sval' in body) return body.sval?.sval ?? '';
  if ('boolval' in body) return body.boolval?.boolval ?? false;
  if ('bsval' in body) return body.bsval?.bsval ?? '';
  return null;
}

function literal(v: string | number | boolean | null): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  return String(v);
}

/**
 * Minimal deparser for the expression shapes that appear in index definitions and predicates
 * (columns, function calls, constants, casts, simple operators). Unknown shapes return undefined.
 */
export function exprText(node: unknown): string | undefined {
  const w = unwrap(node);
  if (!w) return undefined;
  const { type, body } = w;
  switch (type) {
    case 'ColumnRef': {
      const parts = (body.fields as AstNode[]).map((f) => (f.A_Star ? '*' : f.String?.sval));
      return parts.every(Boolean) ? parts.join('.') : undefined;
    }
    case 'A_Const':
      return literal(constValue(body));
    case 'ParamRef':
      return `$${body.number ?? 0}`;
    case 'FuncCall': {
      const name = strings(body.funcname).filter((n) => n !== 'pg_catalog').join('.');
      if (body.agg_star) return `${name}(*)`;
      const args = ((body.args as unknown[]) ?? []).map(exprText);
      return args.every((a) => a !== undefined) ? `${name}(${args.join(', ')})` : undefined;
    }
    case 'TypeCast': {
      const inner = exprText(body.arg);
      const typeName = strings(body.typeName?.names).filter((n) => n !== 'pg_catalog').join('.');
      return inner && typeName ? `${inner}::${typeName}` : undefined;
    }
    case 'A_Expr': {
      if (body.kind !== 'AEXPR_OP') return undefined;
      const op = strings(body.name).join('');
      const r = exprText(body.rexpr);
      if (r === undefined) return undefined;
      if (!body.lexpr) return `(${op} ${r})`;
      const l = exprText(body.lexpr);
      return l === undefined ? undefined : `(${l} ${op} ${r})`;
    }
    case 'A_ArrayExpr': {
      const items = ((body.elements as unknown[]) ?? []).map(exprText);
      return items.every((i) => i !== undefined) ? `ARRAY[${items.join(', ')}]` : undefined;
    }
    default:
      return undefined;
  }
}

export type StatementKind =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'merge'
  | 'create_index'
  | 'create_statistics'
  | 'set'
  | 'explain'
  | 'other';

export function statementKind(type: string): StatementKind {
  switch (type) {
    case 'SelectStmt':
      return 'select';
    case 'InsertStmt':
      return 'insert';
    case 'UpdateStmt':
      return 'update';
    case 'DeleteStmt':
      return 'delete';
    case 'MergeStmt':
      return 'merge';
    case 'IndexStmt':
      return 'create_index';
    case 'CreateStatsStmt':
      return 'create_statistics';
    case 'VariableSetStmt':
      return 'set';
    case 'ExplainStmt':
      return 'explain';
    default:
      return 'other';
  }
}

export function hasParams(node: unknown): boolean {
  let found = false;
  walk(node, (type) => {
    if (type === 'ParamRef') found = true;
  });
  return found;
}

export interface IndexShape {
  name?: string;
  schema?: string;
  table: string;
  method: string;
  unique: boolean;
  concurrent: boolean;
  /** Key columns; expressions are rendered as text in parentheses. */
  keys: string[];
  include: string[];
  predicate?: string;
}

export function indexShape(body: AstNode): IndexShape {
  const keys = ((body.indexParams as AstNode[]) ?? []).map((p) => {
    const el = p.IndexElem as AstNode;
    if (el.name) return el.name as string;
    return `(${exprText(el.expr) ?? 'expr'})`;
  });
  const include = ((body.indexIncludingParams as AstNode[]) ?? []).map((p) => p.IndexElem?.name as string).filter(Boolean);
  return {
    name: body.idxname,
    schema: body.relation?.schemaname,
    table: body.relation?.relname,
    method: (body.accessMethod as string) || 'btree',
    unique: !!body.unique,
    concurrent: !!body.concurrent,
    keys,
    include,
    predicate: body.whereClause ? exprText(body.whereClause) ?? 'partial' : undefined,
  };
}
