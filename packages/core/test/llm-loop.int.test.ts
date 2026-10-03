import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDbs, getDbs } from '../src/db.ts';
import type { LlmJsonRequest, LlmJsonResponse, LlmProvider } from '../src/llm/provider.ts';
import type { LlmSuggestionsT } from '../src/llm/schema.ts';
import { MemoryRunStore } from '../src/meta/store.ts';
import { analyze } from '../src/pipeline.ts';
import type { Services } from '../src/services.ts';

// A scripted model: exercises the whole generate -> validate -> feedback -> revise loop against the
// live databases without calling Gemini.
class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-test-model';
  readonly requests: LlmJsonRequest[] = [];
  constructor(private readonly turns: LlmSuggestionsT[]) {}
  async generateJson<T>(req: LlmJsonRequest, parse: (v: unknown) => T): Promise<LlmJsonResponse<T>> {
    this.requests.push(structuredClone(req));
    const turn = this.turns[this.requests.length - 1];
    if (!turn) throw new Error('script exhausted');
    return { data: parse(turn), raw: JSON.stringify(turn), inputTokens: 100, outputTokens: 50, model: this.model, cached: false };
  }
}

const c = (kind: string, title: string, statements: string[], rewritten_sql = '') => ({
  kind: kind as 'index',
  title,
  statements,
  rewritten_sql,
  rationale: 'test',
  expected_plan_change: 'test',
  citations: [],
});

let available = false;
beforeAll(async () => {
  const dbs = getDbs();
  available = (await dbs.target.ping()) && !!dbs.shadow && (await dbs.shadow.ping());
});
afterAll(async () => {
  await closeDbs();
});

describe('LLM feedback loop', () => {
  it('feeds rejections back and keeps only the revised candidate that passes', async ({ skip }) => {
    if (!available) skip();
    const llm = new ScriptedLlm([
      {
        diagnosis: 'Full scan of orders to find one customer.',
        candidates: [
          c('index', 'Index on a column that does not exist', ['CREATE INDEX CONCURRENTLY qopt_bad ON orders (customer_uuid)']),
          c('index', 'Index the planner will not use', ['CREATE INDEX CONCURRENTLY qopt_useless ON orders (total)']),
          c('index', 'Sneaky DDL', ['DROP INDEX orders_pkey']),
        ],
      },
      {
        diagnosis: 'Revised.',
        candidates: [c('index', 'Composite index for filter + sort', ['CREATE INDEX CONCURRENTLY qopt_orders_cust_created ON orders (customer_id, created_at)'])],
      },
    ]);
    const services: Services = { dbs: getDbs(), llm, store: new MemoryRunStore() };
    const run = await analyze(
      { sql: 'SELECT id, total FROM orders WHERE customer_id = 777 ORDER BY created_at DESC LIMIT 20', options: { engine: 'llm', rag: false, validate: true, retries: 1 } },
      services,
    );

    expect(run.status).toBe('done');
    expect(llm.requests).toHaveLength(2);
    // The second turn carries the validator's verdicts.
    const feedback = llm.requests[1].messages.at(-1)!.text;
    expect(feedback).toMatch(/customer_uuid/);
    expect(feedback).toMatch(/does not exist/);
    expect(feedback).toMatch(/single CREATE INDEX/);

    const byTitle = Object.fromEntries(run.candidates.map((x) => [x.title, x.validation]));
    expect(byTitle['Index on a column that does not exist']).toMatchObject({ verdict: 'error', errorClass: 'hallucination' });
    expect(byTitle['Index the planner will not use']).toMatchObject({ verdict: 'rejected' });
    expect(byTitle['Sneaky DDL']).toMatchObject({ verdict: 'rejected', errorClass: 'unsafe' });
    expect(run.recommendations.map((r) => r.title)).toEqual(['Composite index for filter + sort']);
    expect(run.recommendations[0].round).toBe(1);
    expect(run.llm).toMatchObject({ calls: 2, model: 'scripted-test-model' });
  });

  it('does not ask for another round when the first one already has a winner', async ({ skip }) => {
    if (!available) skip();
    const llm = new ScriptedLlm([
      { diagnosis: 'x', candidates: [c('index', 'Good', ['CREATE INDEX CONCURRENTLY qopt_good ON orders (customer_id)'])] },
    ]);
    const run = await analyze(
      { sql: 'SELECT id FROM orders WHERE customer_id = 99', options: { engine: 'llm', rag: false, validate: true, retries: 2 } },
      { dbs: getDbs(), llm, store: new MemoryRunStore() },
    );
    expect(llm.requests).toHaveLength(1);
    expect(run.recommendations).toHaveLength(1);
  });
});
