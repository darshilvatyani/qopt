import type { Db } from '../db.ts';
import type { AnalysisResult, RunSummary } from '../types.ts';

// qopt's own storage in the meta database: documentation chunks (with pgvector embeddings) and
// analysis runs. Falls back to memory when META_URL isn't configured.

export async function migrateMeta(meta: Db, dims: number): Promise<void> {
  await meta.query('CREATE EXTENSION IF NOT EXISTS vector');
  await meta.query(`
    CREATE TABLE IF NOT EXISTS doc_chunks (
      id bigserial PRIMARY KEY,
      pg_version text NOT NULL,
      slug text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      heading text NOT NULL,
      content text NOT NULL,
      tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', heading), 'A') || setweight(to_tsvector('english', content), 'B')
      ) STORED,
      embedding vector(${dims}),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await meta.query('CREATE INDEX IF NOT EXISTS doc_chunks_tsv_idx ON doc_chunks USING gin (tsv)');
  await meta.query('CREATE INDEX IF NOT EXISTS doc_chunks_embedding_idx ON doc_chunks USING hnsw (embedding vector_cosine_ops)');
  await meta.query('CREATE INDEX IF NOT EXISTS doc_chunks_version_idx ON doc_chunks (pg_version, slug)');
  await meta.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL,
      status text NOT NULL,
      sql text NOT NULL,
      engine text NOT NULL,
      result jsonb NOT NULL
    )`);
  await meta.query('CREATE INDEX IF NOT EXISTS runs_created_idx ON runs (created_at DESC)');
}

export interface RunStore {
  save(run: AnalysisResult): Promise<void>;
  get(id: string): Promise<AnalysisResult | undefined>;
  list(limit: number): Promise<RunSummary[]>;
}

export function summarize(run: AnalysisResult): RunSummary {
  const gains = run.recommendations
    .map((r) => r.validation?.timeMs?.change ?? r.validation?.cost?.change)
    .filter((x): x is number => typeof x === 'number');
  return {
    id: run.id,
    createdAt: run.createdAt,
    status: run.status,
    sql: run.sql,
    engine: run.options.engine,
    recommendations: run.recommendations.length,
    bestGain: gains.length ? Math.min(...gains) : undefined,
  };
}

export class MemoryRunStore implements RunStore {
  private runs = new Map<string, AnalysisResult>();
  async save(run: AnalysisResult) {
    this.runs.set(run.id, structuredClone(run));
  }
  async get(id: string) {
    return this.runs.get(id);
  }
  async list(limit: number) {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(summarize);
  }
}

export class PgRunStore implements RunStore {
  constructor(private readonly meta: Db) {}

  async save(run: AnalysisResult) {
    await this.meta.query(
      `INSERT INTO runs (id, created_at, status, sql, engine, result) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, result = excluded.result`,
      [run.id, run.createdAt, run.status, run.sql, run.options.engine, JSON.stringify(run)],
    );
  }

  async get(id: string) {
    const res = await this.meta.query('SELECT result FROM runs WHERE id = $1', [id]);
    return res.rows[0]?.result as AnalysisResult | undefined;
  }

  async list(limit: number) {
    const res = await this.meta.query('SELECT result FROM runs ORDER BY created_at DESC LIMIT $1', [limit]);
    return res.rows.map((r) => summarize(r.result as AnalysisResult));
  }
}
