// The LLM sits behind this interface so the pipeline and eval don't depend on a vendor SDK, and so
// ablations (heuristic-only, no-RAG, other models) are a configuration change.

export interface LlmMessage {
  role: 'user' | 'model';
  text: string;
}

export interface LlmJsonRequest {
  system: string;
  messages: LlmMessage[];
  /** JSON Schema the response must follow. */
  schema: object;
  temperature?: number;
}

export interface LlmJsonResponse<T> {
  data: T;
  raw: string;
  inputTokens: number;
  outputTokens: number;
  /** Model that produced the answer (may be a fallback). */
  model: string;
  cached: boolean;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generateJson<T>(req: LlmJsonRequest, parse: (value: unknown) => T): Promise<LlmJsonResponse<T>>;
}

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
  onWait?: (msg: string) => void;
}
