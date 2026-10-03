import { join } from 'node:path';
import { ApiError, GoogleGenAI } from '@google/genai';
import { DiskCache } from './cache.ts';
import type { Embedder, LlmJsonRequest, LlmJsonResponse, LlmProvider } from './provider.ts';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Quota errors carry the wait the server wants ("retryDelay":"31s" / "retry in 31.3s"). */
function serverRetryDelayMs(e: unknown): number | undefined {
  const msg = e instanceof Error ? e.message : '';
  const m = /"retryDelay":"(\d+(?:\.\d+)?)s"/.exec(msg) ?? /retry in (\d+(?:\.\d+)?)s/i.exec(msg);
  return m ? Math.ceil(Number(m[1]) * 1000) + 1000 : undefined;
}

/** A per-day quota won't recover by waiting; per-minute quotas and 503s will. */
export function isDailyQuota(e: unknown): boolean {
  return e instanceof ApiError && e.status === 429 && /PerDay/i.test(e.message);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 5, onWait?: (ms: number) => void): Promise<T> {
  let delay = 2000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : undefined;
      if (i >= attempts || status === undefined || !RETRYABLE.has(status) || isDailyQuota(e)) throw e;
      const wait = Math.min(120_000, serverRetryDelayMs(e) ?? Math.min(60_000, delay) + Math.random() * 500);
      onWait?.(wait);
      await new Promise((r) => setTimeout(r, wait));
      delay *= 2;
    }
  }
}

interface CachedGeneration {
  raw: string;
  inputTokens: number;
  outputTokens: number;
}

function isOverloaded(e: unknown): boolean {
  return e instanceof ApiError && RETRYABLE.has(e.status);
}

/**
 * Tries `models` in order: a brief retry on the primary, then the next model when the API is
 * overloaded (503) or rate-limited (429). A model whose daily quota is spent is skipped for the
 * rest of the process. The response says which model actually answered.
 */
export class GeminiLlm implements LlmProvider {
  readonly name = 'gemini';
  private readonly ai: GoogleGenAI;
  private readonly cache: DiskCache;
  private readonly exhausted = new Set<string>();

  constructor(
    apiKey: string,
    private readonly models: string[],
    cacheDir: string,
  ) {
    if (!models.length) throw new Error('at least one Gemini model is required');
    this.ai = new GoogleGenAI({ apiKey });
    this.cache = new DiskCache(join(cacheDir, 'llm'));
  }

  get model(): string {
    return this.models[0];
  }

  async generateJson<T>(req: LlmJsonRequest, parse: (value: unknown) => T): Promise<LlmJsonResponse<T>> {
    const temperature = req.temperature ?? 0.2;
    const keyFor = (model: string) => this.cache.key({ model, system: req.system, messages: req.messages, schema: req.schema, temperature });
    for (const model of this.models) {
      const hit = await this.cache.get<CachedGeneration>(keyFor(model));
      if (hit) return { data: parse(JSON.parse(hit.raw)), ...hit, model, cached: true };
    }

    let lastError: unknown;
    const available = this.models.filter((m) => !this.exhausted.has(m));
    for (const [i, model] of available.entries()) {
      const last = i === available.length - 1;
      let res;
      try {
        res = await withRetry(
          () =>
            this.ai.models.generateContent({
              model,
              contents: req.messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
              config: {
                systemInstruction: req.system,
                temperature,
                responseMimeType: 'application/json',
                responseJsonSchema: req.schema,
              },
            }),
          last ? 6 : 2,
        );
      } catch (e) {
        lastError = e;
        if (isDailyQuota(e)) {
          this.exhausted.add(model);
          continue;
        }
        if (!last && isOverloaded(e)) continue;
        throw e;
      }
      const raw = res.text ?? '';
      if (!raw) throw new Error(`${model} returned no text (finish reason: ${res.candidates?.[0]?.finishReason ?? 'unknown'})`);
      // Parse before caching so a malformed answer is never replayed from the cache.
      const data = parse(JSON.parse(raw));
      const entry: CachedGeneration = {
        raw,
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      };
      await this.cache.set(keyFor(model), entry);
      return { data, ...entry, model, cached: false };
    }
    if (this.exhausted.size === this.models.length) {
      throw new Error(
        `Gemini free-tier daily quota used up for ${this.models.join(', ')}. Quotas reset at midnight Pacific time; enabling billing on the key removes the cap.`,
      );
    }
    throw lastError;
  }
}

export class GeminiEmbedder implements Embedder {
  private readonly ai: GoogleGenAI;
  private readonly cache: DiskCache;
  /** Progress hook for long, rate-limited embedding runs. */
  onWait?: (msg: string) => void;

  constructor(
    apiKey: string,
    readonly model: string,
    readonly dims: number,
    cacheDir: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
    this.cache = new DiskCache(join(cacheDir, 'embeddings'));
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    const out: number[][] = [];
    const taskType = kind === 'document' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY';
    for (let i = 0; i < texts.length; i += 50) {
      const batch = texts.slice(i, i + 50);
      const key = this.cache.key({ model: this.model, taskType, dims: this.dims, batch });
      const hit = await this.cache.get<number[][]>(key);
      if (hit) {
        out.push(...hit);
        continue;
      }
      // Free-tier quotas count every text in a batch, so waits between batches are expected.
      const res = await withRetry(
        () =>
          this.ai.models.embedContent({
            model: this.model,
            contents: batch,
            config: { taskType, outputDimensionality: this.dims },
          }),
        10,
        (ms) => this.onWait?.(`rate limited; waiting ${Math.round(ms / 1000)}s`),
      );
      const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
      if (vectors.length !== batch.length || vectors.some((v) => v.length !== this.dims)) {
        throw new Error(`embedding response had ${vectors.length} vectors for ${batch.length} inputs`);
      }
      await this.cache.set(key, vectors);
      out.push(...vectors);
    }
    return out;
  }
}
