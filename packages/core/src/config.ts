import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const envFile = resolve(REPO_ROOT, '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A malformed .env shouldn't stop the CLI; values fall back to defaults below.
  }
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function str(name: string, fallback = ''): string {
  const raw = process.env[name]?.trim();
  return raw ? raw : fallback;
}

export interface Config {
  targetUrl: string;
  shadowUrl: string;
  metaUrl: string;
  geminiApiKey: string;
  geminiModel: string;
  /** Tried in order when the primary model is overloaded or rate-limited. */
  geminiFallbackModels: string[];
  geminiEmbedModel: string;
  embedDimensions: number;
  minCostGain: number;
  minTimeGain: number;
  measureRuns: number;
  statementTimeoutMs: number;
  redactValues: boolean;
  apiPort: number;
  cacheDir: string;
}

export function loadConfig(): Config {
  return {
    targetUrl: str('TARGET_URL', 'postgres://postgres:postgres@localhost:5433/qopt'),
    shadowUrl: str('SHADOW_URL'),
    metaUrl: str('META_URL'),
    geminiApiKey: str('GEMINI_API_KEY'),
    geminiModel: str('GEMINI_MODEL', 'gemini-3.8-flash'),
    geminiFallbackModels: str('GEMINI_FALLBACK_MODELS', 'gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-3.5-flash-lite')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    geminiEmbedModel: str('GEMINI_EMBED_MODEL', 'gemini-embedding-001'),
    // pgvector's HNSW index supports at most 2000 dims for `vector`; Gemini defaults to 3072.
    embedDimensions: 768,
    minCostGain: num('QOPT_MIN_COST_GAIN', 0.2),
    minTimeGain: num('QOPT_MIN_TIME_GAIN', 0.15),
    measureRuns: Math.max(1, Math.round(num('QOPT_MEASURE_RUNS', 5))),
    statementTimeoutMs: num('QOPT_STATEMENT_TIMEOUT_MS', 30000),
    redactValues: bool('QOPT_REDACT_VALUES', false),
    apiPort: num('QOPT_API_PORT', 8787),
    cacheDir: resolve(REPO_ROOT, '.cache'),
  };
}

export const config = loadConfig();
