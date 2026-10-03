import { z } from 'zod';

// Structured output contract with the model. The JSON Schema goes to Gemini (responseJsonSchema);
// zod re-validates the answer, because "matches the schema" still isn't "valid SQL" — that is
// checked separately by the parser and then by the database.

export const LlmCandidate = z.object({
  kind: z.enum(['index', 'rewrite', 'statistics', 'config']).describe('Type of change'),
  title: z.string().describe('Short label, e.g. "B-tree on orders (customer_id, created_at)"'),
  statements: z
    .array(z.string())
    .describe(
      'index: CREATE INDEX CONCURRENTLY statements. statistics: CREATE STATISTICS statement. config: SET statement. rewrite: optional supporting CREATE INDEX statements (may be empty).',
    ),
  rewritten_sql: z.string().describe('For kind=rewrite: the complete rewritten query. Empty string for other kinds.'),
  rationale: z.string().describe('Why this should help, referring to the plan and statistics'),
  expected_plan_change: z.string().describe('How the plan should change, e.g. "Seq Scan on orders -> Index Scan using qopt_..."'),
  citations: z.array(z.string()).describe('Ids of documentation excerpts relied on, e.g. ["D1"]'),
});

export const LlmSuggestions = z.object({
  diagnosis: z.string().describe('Root cause of the slowness in one paragraph'),
  candidates: z.array(LlmCandidate).min(1).max(4),
});

export type LlmSuggestionsT = z.infer<typeof LlmSuggestions>;

export function suggestionsJsonSchema(): object {
  const schema = z.toJSONSchema(LlmSuggestions) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function parseSuggestions(value: unknown): LlmSuggestionsT {
  return LlmSuggestions.parse(value);
}
