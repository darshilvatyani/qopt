import { config } from './config.ts';
import { type Dbs, getDbs } from './db.ts';
import { GeminiEmbedder, GeminiLlm } from './llm/gemini.ts';
import type { Embedder, LlmProvider } from './llm/provider.ts';
import { MemoryRunStore, PgRunStore, type RunStore } from './meta/store.ts';
import { DocRetriever } from './rag/retrieve.ts';

export interface Services {
  dbs: Dbs;
  llm?: LlmProvider;
  embedder?: Embedder;
  retriever?: DocRetriever;
  store: RunStore;
}

let services: Services | undefined;

export function getServices(): Services {
  if (services) return services;
  const dbs = getDbs();
  const llm = config.geminiApiKey ? new GeminiLlm(config.geminiApiKey, [...new Set([config.geminiModel, ...config.geminiFallbackModels])], config.cacheDir) : undefined;
  const embedder = config.geminiApiKey
    ? new GeminiEmbedder(config.geminiApiKey, config.geminiEmbedModel, config.embedDimensions, config.cacheDir)
    : undefined;
  services = {
    dbs,
    llm,
    embedder,
    retriever: dbs.meta ? new DocRetriever(dbs.meta, embedder) : undefined,
    store: dbs.meta ? new PgRunStore(dbs.meta) : new MemoryRunStore(),
  };
  return services;
}
