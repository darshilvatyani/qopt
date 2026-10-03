import { toDisplayIndexSql } from '../sql/safety.ts';
import type { Candidate, LlmUsage, ValidatedCandidate } from '../types.ts';
import { feedbackPrompt, type PromptInput, systemPrompt, userPrompt } from './prompt.ts';
import type { LlmMessage, LlmProvider } from './provider.ts';
import { type LlmSuggestionsT, parseSuggestions, suggestionsJsonSchema } from './schema.ts';

// One conversation per analysis: the first turn asks for candidates, later turns feed back the
// validator's verdicts so the model can correct itself against ground truth.

export class Suggester {
  private readonly messages: LlmMessage[] = [];
  private readonly system: string;
  private readonly schema = suggestionsJsonSchema();
  private counter = 0;
  readonly usage: LlmUsage;

  constructor(
    private readonly llm: LlmProvider,
    private readonly input: PromptInput,
  ) {
    this.system = systemPrompt(input);
    this.usage = { model: llm.model, calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0 };
  }

  private toCandidates(res: LlmSuggestionsT, round: number): Candidate[] {
    return res.candidates.map((c) => ({
      id: `l${++this.counter}`,
      source: 'llm',
      kind: c.kind,
      title: c.title,
      // Recommend the production-safe form; validation strips CONCURRENTLY to run inside a transaction.
      statements: c.statements
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (/^create\s+(unique\s+)?index\b/i.test(s) ? toDisplayIndexSql(s) : s)),
      rewrittenSql: c.kind === 'rewrite' ? c.rewritten_sql.trim() : undefined,
      rationale: c.rationale,
      expectedPlanChange: c.expected_plan_change,
      citations: c.citations,
      round,
    }));
  }

  private async call(round: number): Promise<{ diagnosis: string; candidates: Candidate[] }> {
    const res = await this.llm.generateJson({ system: this.system, messages: this.messages, schema: this.schema }, parseSuggestions);
    this.usage.calls++;
    this.usage.model = res.model;
    if (res.cached) this.usage.cachedCalls++;
    this.usage.inputTokens += res.inputTokens;
    this.usage.outputTokens += res.outputTokens;
    this.messages.push({ role: 'model', text: res.raw });
    return { diagnosis: res.data.diagnosis, candidates: this.toCandidates(res.data, round) };
  }

  async initial(): Promise<{ diagnosis: string; candidates: Candidate[] }> {
    this.messages.push({ role: 'user', text: userPrompt(this.input) });
    return this.call(0);
  }

  async revise(results: ValidatedCandidate[], round: number): Promise<{ diagnosis: string; candidates: Candidate[] }> {
    this.messages.push({ role: 'user', text: feedbackPrompt(results) });
    return this.call(round);
  }
}
