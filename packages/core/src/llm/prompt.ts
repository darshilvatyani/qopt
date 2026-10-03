import { renderContext } from '../context/schema.ts';
import { renderPlanText } from '../plan/tree.ts';
import { CONFIG_WHITELIST } from '../sql/safety.ts';
import type { CapturedQuery, DocChunk, ExplainResult, Finding, PlanSource, TableContext, ValidatedCandidate } from '../types.ts';

export interface PromptInput {
  sql: string;
  generic: boolean;
  pgVersion: string;
  plan: ExplainResult;
  planSource: PlanSource;
  findings: Finding[];
  tables: TableContext[];
  docs: DocChunk[];
  workload?: Pick<CapturedQuery, 'calls' | 'meanMs' | 'totalMs'>;
  minTimeGain: number;
}

export function systemPrompt(input: Pick<PromptInput, 'pgVersion' | 'minTimeGain'>): string {
  const pct = Math.round(input.minTimeGain * 100);
  return `You are a senior PostgreSQL performance engineer. You propose changes that make ONE query faster.

Every candidate you propose is machine-verified before a human sees it:
- index: simulated with HypoPG (btree, brin, hash) and then built for real on a shadow copy of the database inside a rolled-back transaction. Kept only if the planner actually uses it AND measured execution time drops by at least ${pct}%.
- rewrite: executed on the shadow copy. Kept only if it returns exactly the same rows (same multiset, and the same order when the original has ORDER BY) AND is at least ${pct}% faster.
- statistics: CREATE STATISTICS + ANALYZE on the shadow. Kept if it fixes the row misestimate or reduces time.
- config: SET for one of ${[...CONFIG_WHITELIST].join(', ')}, applied with SET LOCAL on the shadow. Kept if measured time drops by ${pct}%.
Rejected candidates are thrown away, so propose only what you expect to pass.

Rules:
1. Use only tables and columns present in the schema section. Never invent names.
2. kind=index: statements holds complete "CREATE INDEX CONCURRENTLY qopt_<name> ON <table> ..." statements (never UNIQUE; several statements only if they must work together, e.g. one per OR branch). Do not duplicate an existing index. Prefer the smallest index that works: partial (WHERE), covering (INCLUDE), expression, or the access method the operator needs (GIN for @> on jsonb/arrays, GIN with gin_trgm_ops for LIKE '%x%', BRIN for large naturally ordered columns).
3. Functions in index expressions must be IMMUTABLE. For example date(timestamptz) and to_char are not; rewrite the predicate as a range instead.
4. kind=rewrite: rewritten_sql is the complete rewritten query with identical semantics, including NULL handling, duplicates and ORDER BY/LIMIT. statements may hold CREATE INDEX statements the rewrite relies on.
5. kind=statistics: statements holds one "CREATE STATISTICS qopt_<name> (dependencies, mcv) ON col1, col2 FROM table".
6. kind=config: statements holds one "SET name = 'value'" meant for this query's session only. Keep work_mem at or below 1GB.
7. Cite the documentation excerpts you relied on by id (e.g. "D2"); use [] if none apply.
8. Return 1 to 4 candidates, best first, and a one-paragraph root-cause diagnosis.

Target server: PostgreSQL ${input.pgVersion}.`;
}

function renderFindings(findings: Finding[]): string {
  if (!findings.length) return '(none)';
  return findings
    .map((f) => {
      const ev = Object.entries(f.evidence)
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      return `- [${f.code}/${f.severity}]${f.nodeId ? ` node ${f.nodeId}` : ''} ${f.title}. ${f.detail}${ev ? ` (${ev})` : ''}`;
    })
    .join('\n');
}

export function renderDocs(docs: DocChunk[]): string {
  return docs.map((d) => `[${d.ref}] ${d.title} — ${d.heading} (${d.url})\n${d.content}`).join('\n\n');
}

export function userPrompt(input: PromptInput): string {
  const parts: string[] = [];
  parts.push('## Query\n```sql\n' + input.sql.trim() + '\n```');
  if (input.generic) {
    parts.push('The query contains $n placeholders and no concrete parameter values were captured; reason about typical values.');
  }
  if (input.workload) {
    parts.push(
      `## Workload (pg_stat_statements)\ncalls=${input.workload.calls}, mean=${input.workload.meanMs.toFixed(2)} ms, total=${input.workload.totalMs.toFixed(0)} ms`,
    );
  }
  parts.push(`## Findings (deterministic analysis of the plan)\n${renderFindings(input.findings)}`);
  const sourceLabel: Record<PlanSource, string> = {
    'shadow-analyze': 'EXPLAIN ANALYZE on the shadow copy',
    auto_explain: 'captured by auto_explain on the target',
    'target-explain': 'EXPLAIN (estimates only) on the target',
    'target-generic': 'EXPLAIN (GENERIC_PLAN, estimates only) on the target',
  };
  parts.push(`## Execution plan (${sourceLabel[input.planSource]})\n${renderPlanText(input.plan)}`);
  parts.push(`## Schema and statistics\n${renderContext(input.tables)}`);
  if (input.docs.length) parts.push(`## PostgreSQL documentation excerpts\n${renderDocs(input.docs)}`);
  return parts.join('\n\n');
}

export function feedbackPrompt(results: ValidatedCandidate[]): string {
  const lines = results.map((c, i) => {
    const v = c.validation;
    const verdict = v ? v.verdict.toUpperCase() : 'NOT VALIDATED';
    const sql = c.kind === 'rewrite' ? c.rewrittenSql : c.statements.join('; ');
    return `${i + 1}. (${c.kind}) ${c.title}\n   SQL: ${sql}\n   Result: ${verdict}: ${v?.reason ?? ''}`;
  });
  return `Validation results for your candidates:\n${lines.join('\n')}\n\nPropose up to 3 new or revised candidates that address these results. Do not repeat a rejected statement unchanged. If a candidate was rejected because the planner did not use an index, reconsider column order, selectivity, or whether a different kind of change is needed.`;
}
