import type { FindingCode } from '../types.ts';
import {
  type AstNode,
  constValue,
  exprText,
  hasParams,
  parseOne,
  type StatementKind,
  statementKind,
  strings,
  unwrap,
  walk,
} from './ast.ts';

// Extracts the parts of a query an index advisor cares about: which columns are filtered, how,
// what joins on what, and what the result is ordered by. Columns are resolved to base tables using
// aliases and (for unqualified names) the table column lists from the catalog.

export interface RelRef {
  relname: string;
  schemaname?: string;
}

export type PredKind = 'eq' | 'in' | 'range' | 'like_prefix' | 'like_infix' | 'contains' | 'isnull' | 'neq' | 'other';

export interface Predicate {
  table?: string;
  /** Plain column the predicate applies to. */
  column?: string;
  /** Set when the column is wrapped in an expression, e.g. lower(email). */
  expr?: string;
  op: string;
  kind: PredKind;
  inOr: boolean;
  value?: string;
}

export interface ColumnUse {
  table?: string;
  column: string;
}

export interface JoinPair {
  left: ColumnUse;
  right: ColumnUse;
}

export interface OrderItem {
  table?: string;
  column?: string;
  expr?: string;
  desc: boolean;
}

export interface AntiPattern {
  code: FindingCode;
  detail: string;
  relation?: string;
}

export interface QueryShape {
  kind: StatementKind;
  relations: RelRef[];
  predicates: Predicate[];
  joins: JoinPair[];
  orderBy: OrderItem[];
  groupBy: ColumnUse[];
  /** Columns inside aggregate(DISTINCT col), which need sorted input per group. */
  distinctAggs: ColumnUse[];
  limit?: number;
  offset?: number;
  hasParams: boolean;
  antiPatterns: AntiPattern[];
}

/** relname -> column names. Unqualified column references are resolved against this. */
export type ColumnMap = Map<string, Set<string>>;

interface Scope {
  /** alias or relname -> relname (undefined for subqueries / CTEs) */
  names: Map<string, string | undefined>;
  tables: string[];
  parent?: Scope;
}

const RANGE_OPS = new Set(['<', '>', '<=', '>=']);
const CONTAINS_OPS = new Set(['@>', '<@', '&&', '?', '?|', '?&', '@@']);

export function analyzeQuery(sql: string, columns: ColumnMap = new Map()): QueryShape {
  const stmt = parseOne(sql);
  const shape: QueryShape = {
    kind: statementKind(stmt.type),
    relations: [],
    predicates: [],
    joins: [],
    orderBy: [],
    groupBy: [],
    distinctAggs: [],
    hasParams: hasParams(stmt.body),
    antiPatterns: [],
  };

  const cteNames = new Set<string>();
  walk({ [stmt.type]: stmt.body }, (type, body) => {
    if (type === 'CommonTableExpr') cteNames.add(body.ctename);
  });
  const seen = new Set<string>();
  walk({ [stmt.type]: stmt.body }, (type, body) => {
    if (type !== 'RangeVar' || cteNames.has(body.relname)) return;
    const key = `${body.schemaname ?? ''}.${body.relname}`;
    if (!seen.has(key)) {
      seen.add(key);
      shape.relations.push({ relname: body.relname, schemaname: body.schemaname });
    }
  });
  // IndexStmt/UpdateStmt/DeleteStmt keep their target relation as a bare RangeVar body.
  const target = stmt.body.relation as AstNode | undefined;
  if (target?.relname && !seen.has(`${target.schemaname ?? ''}.${target.relname}`)) {
    shape.relations.unshift({ relname: target.relname, schemaname: target.schemaname });
  }

  const ctx = new Walker(shape, columns, cteNames);
  switch (stmt.type) {
    case 'SelectStmt':
      ctx.select(stmt.body, undefined, true);
      break;
    case 'UpdateStmt':
    case 'DeleteStmt': {
      const scope = ctx.newScope(undefined);
      ctx.addRangeVar(scope, stmt.body.relation);
      for (const f of [...(stmt.body.fromClause ?? []), ...(stmt.body.usingClause ?? [])]) ctx.addFrom(scope, f);
      ctx.conjuncts(scope, stmt.body.whereClause, false);
      break;
    }
    case 'InsertStmt':
      if (stmt.body.selectStmt) ctx.select(unwrap(stmt.body.selectStmt)?.body ?? {}, undefined, false);
      break;
  }
  return shape;
}

class Walker {
  constructor(
    private readonly shape: QueryShape,
    private readonly columns: ColumnMap,
    private readonly cteNames: Set<string>,
  ) {}

  newScope(parent: Scope | undefined): Scope {
    return { names: new Map(), tables: [], parent };
  }

  addRangeVar(scope: Scope, rv: AstNode | undefined): void {
    if (!rv?.relname) return;
    const isCte = this.cteNames.has(rv.relname) && !rv.schemaname;
    const rel = isCte ? undefined : rv.relname;
    scope.names.set(rv.alias?.aliasname ?? rv.relname, rel);
    if (rel) scope.tables.push(rel);
  }

  addFrom(scope: Scope, item: unknown): void {
    const w = unwrap(item);
    if (!w) return;
    if (w.type === 'RangeVar') this.addRangeVar(scope, w.body);
    else if (w.type === 'JoinExpr') {
      this.addFrom(scope, w.body.larg);
      this.addFrom(scope, w.body.rarg);
    } else if (w.type === 'RangeSubselect') {
      const sub = unwrap(w.body.subquery);
      if (sub?.type === 'SelectStmt') this.select(sub.body, scope, false);
      if (w.body.alias?.aliasname) scope.names.set(w.body.alias.aliasname, undefined);
    }
  }

  /** Join conditions live on JoinExpr nodes; collect them after all FROM items are registered. */
  private joinQuals(scope: Scope, item: unknown): void {
    const w = unwrap(item);
    if (w?.type !== 'JoinExpr') return;
    this.joinQuals(scope, w.body.larg);
    this.joinQuals(scope, w.body.rarg);
    if (w.body.quals) this.conjuncts(scope, w.body.quals, false);
  }

  select(body: AstNode, parent: Scope | undefined, topLevel: boolean): void {
    if (body.op && body.op !== 'SETOP_NONE') {
      if (body.larg) this.select(body.larg, parent, false);
      if (body.rarg) this.select(body.rarg, parent, false);
      return;
    }
    for (const cte of body.withClause?.ctes ?? []) {
      const q = unwrap(cte.CommonTableExpr?.ctequery);
      if (q?.type === 'SelectStmt') this.select(q.body, parent, false);
    }
    const scope = this.newScope(parent);
    for (const f of body.fromClause ?? []) this.addFrom(scope, f);
    for (const f of body.fromClause ?? []) this.joinQuals(scope, f);
    this.conjuncts(scope, body.whereClause, false);

    // Sublinks in the select list (scalar subqueries).
    for (const t of body.targetList ?? []) this.sublinks(scope, t);

    if (topLevel) {
      for (const s of body.sortClause ?? []) {
        const sb = s.SortBy as AstNode;
        const col = this.columnOf(scope, sb.node);
        this.shape.orderBy.push({
          table: col?.table,
          column: col?.column,
          expr: col ? undefined : exprText(sb.node),
          desc: sb.sortby_dir === 'SORTBY_DESC',
        });
      }
      for (const g of body.groupClause ?? []) {
        const col = this.columnOf(scope, g);
        if (col) this.shape.groupBy.push(col);
      }
      walk(body.targetList, (type, fn) => {
        if (type !== 'FuncCall' || !fn.agg_distinct) return;
        for (const a of fn.args ?? []) {
          const col = this.columnOf(scope, a);
          if (col) this.shape.distinctAggs.push(col);
        }
      });
      const lim = unwrap(body.limitCount);
      if (lim?.type === 'A_Const') this.shape.limit = Number(constValue(lim.body));
      const off = unwrap(body.limitOffset);
      if (off?.type === 'A_Const') {
        this.shape.offset = Number(constValue(off.body));
        if (this.shape.offset >= 1000) {
          this.shape.antiPatterns.push({
            code: 'LARGE_OFFSET',
            detail: `OFFSET ${this.shape.offset} still reads and discards ${this.shape.offset} rows; keyset pagination avoids it`,
          });
        }
      }
    }
  }

  private sublinks(scope: Scope, node: unknown): void {
    walk(node, (type, body) => {
      if (type === 'SubLink') {
        const sub = unwrap(body.subselect);
        if (sub?.type === 'SelectStmt') this.select(sub.body, scope, false);
      }
    });
  }

  conjuncts(scope: Scope, node: unknown, inOr: boolean): void {
    const w = unwrap(node);
    if (!w) return;
    const { type, body } = w;

    if (type === 'BoolExpr') {
      if (body.boolop === 'AND_EXPR') {
        for (const a of body.args) this.conjuncts(scope, a, inOr);
      } else if (body.boolop === 'OR_EXPR') {
        const before = this.shape.predicates.length;
        for (const a of body.args) this.conjuncts(scope, a, true);
        const cols = new Set(
          this.shape.predicates
            .slice(before)
            .map((p) => `${p.table}.${p.column ?? p.expr}`),
        );
        if (cols.size > 1) {
          this.shape.antiPatterns.push({
            code: 'OR_ACROSS_COLUMNS',
            detail: `OR across different columns (${[...cols].map((c) => c.split('.').pop()).join(', ')}) usually prevents a single index scan; consider one index per branch (BitmapOr) or a UNION rewrite`,
          });
        }
      } else if (body.boolop === 'NOT_EXPR') {
        const inner = unwrap(body.args?.[0]);
        if (inner?.type === 'SubLink' && inner.body.subLinkType === 'ANY_SUBLINK') {
          const col = this.columnOf(scope, inner.body.testexpr);
          this.shape.antiPatterns.push({
            code: 'NOT_IN_SUBQUERY',
            relation: col?.table,
            detail:
              'NOT IN (subquery) cannot be turned into an anti-join, returns no rows if the subquery yields a NULL, and degrades to a per-row subplan when the subquery result does not fit in work_mem; NOT EXISTS is usually the intended semantics',
          });
        }
        this.sublinks(scope, body.args);
      }
      return;
    }

    if (type === 'SubLink') {
      this.sublinks(scope, node);
      return;
    }

    if (type === 'NullTest') {
      const col = this.columnOf(scope, body.arg);
      if (col) {
        this.shape.predicates.push({
          ...col,
          op: body.nulltesttype === 'IS_NULL' ? 'IS NULL' : 'IS NOT NULL',
          kind: body.nulltesttype === 'IS_NULL' ? 'isnull' : 'other',
          inOr,
        });
      }
      return;
    }

    if (type !== 'A_Expr') {
      this.sublinks(scope, node);
      return;
    }

    const op = strings(body.name).join('');
    let lhs = body.lexpr;
    let rhs = body.rexpr;
    let lcol = this.columnOf(scope, lhs);
    let rcol = this.columnOf(scope, rhs);
    const lexpr = lcol ? undefined : this.exprOnColumn(scope, lhs);
    const rexpr = rcol ? undefined : this.exprOnColumn(scope, rhs);

    // column = column across two tables is a join key.
    if (op === '=' && body.kind === 'AEXPR_OP' && lcol && rcol) {
      if (lcol.table !== rcol.table || !lcol.table) this.shape.joins.push({ left: lcol, right: rcol });
      return;
    }

    // Normalise so the column side is on the left.
    let exprSide = lexpr;
    if (!lcol && !lexpr && (rcol || rexpr)) {
      [lhs, rhs] = [rhs, lhs];
      [lcol, rcol] = [rcol, lcol];
      exprSide = rexpr;
    }
    const target = lcol ?? (exprSide ? { table: exprSide.table, column: undefined } : undefined);
    if (!target) {
      this.sublinks(scope, node);
      return;
    }

    let kind: PredKind = 'other';
    const value = exprText(rhs);
    switch (body.kind) {
      case 'AEXPR_OP':
        if (op === '=') kind = 'eq';
        else if (op === '<>' || op === '!=') kind = 'neq';
        else if (RANGE_OPS.has(op)) kind = 'range';
        else if (CONTAINS_OPS.has(op)) kind = 'contains';
        break;
      case 'AEXPR_IN':
        kind = op === '=' ? 'in' : 'other';
        break;
      case 'AEXPR_BETWEEN':
      case 'AEXPR_BETWEEN_SYM':
        kind = 'range';
        break;
      case 'AEXPR_LIKE':
      case 'AEXPR_ILIKE': {
        if (op.startsWith('!')) break;
        const pattern = unwrap(rhs)?.type === 'A_Const' ? String(constValue(unwrap(rhs)!.body)) : '';
        const leading = /^[%_]/.test(pattern);
        kind = leading || body.kind === 'AEXPR_ILIKE' ? 'like_infix' : 'like_prefix';
        if (leading) {
          this.shape.antiPatterns.push({
            code: 'LEADING_WILDCARD',
            relation: target.table,
            detail: `${body.kind === 'AEXPR_ILIKE' ? 'ILIKE' : 'LIKE'} '${pattern}' starts with a wildcard, so no B-tree can serve it; a trigram (pg_trgm) GIN index can`,
          });
        }
        break;
      }
    }

    if (exprSide && !lcol) {
      this.shape.antiPatterns.push({
        code: 'NON_SARGABLE_PREDICATE',
        relation: exprSide.table,
        detail: `${exprSide.expr} ${op} … wraps the column in an expression, so a plain index on ${exprSide.column} cannot be used; rewrite the predicate or add an expression index`,
      });
      this.shape.predicates.push({ table: exprSide.table, expr: exprSide.expr, op, kind, inOr, value });
      return;
    }
    this.shape.predicates.push({ table: lcol!.table, column: lcol!.column, op, kind, inOr, value });
    this.sublinks(scope, rhs);
  }

  /** f(col) or col::type — an expression over exactly one column. */
  private exprOnColumn(scope: Scope, node: unknown): { table?: string; column: string; expr: string } | undefined {
    const w = unwrap(node);
    if (!w || (w.type !== 'FuncCall' && w.type !== 'TypeCast' && w.type !== 'A_Expr')) return undefined;
    const refs: AstNode[] = [];
    walk(node, (type, body) => {
      if (type === 'ColumnRef') refs.push(body);
      if (type === 'SubLink') refs.push({}, {});
    });
    if (refs.length !== 1) return undefined;
    const col = this.columnOf(scope, { ColumnRef: refs[0] });
    const expr = exprText(node);
    if (!col || !expr) return undefined;
    // Render with the bare column name so it can be used in CREATE INDEX.
    const bare = expr.replace(new RegExp(`\\b[\\w]+\\.${col.column}\\b`, 'g'), col.column);
    return { table: col.table, column: col.column, expr: bare };
  }

  columnOf(scope: Scope, node: unknown): ColumnUse | undefined {
    const w = unwrap(node);
    if (w?.type !== 'ColumnRef') return undefined;
    const parts = strings(w.body.fields);
    if (parts.length !== (w.body.fields as unknown[]).length) return undefined; // contains *
    if (parts.length === 1) return { table: this.resolveUnqualified(scope, parts[0]), column: parts[0] };
    const qualifier = parts[parts.length - 2];
    const column = parts[parts.length - 1];
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      if (s.names.has(qualifier)) return { table: s.names.get(qualifier), column };
    }
    return { table: qualifier, column };
  }

  private resolveUnqualified(scope: Scope, column: string): string | undefined {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      if (s.tables.length === 1 && !this.columns.size) return s.tables[0];
      const owners = s.tables.filter((t) => this.columns.get(t)?.has(column));
      if (owners.length === 1) return owners[0];
      if (s.tables.length === 1 && !this.columns.has(s.tables[0])) return s.tables[0];
    }
    return undefined;
  }
}
