import type { Db } from '../db.ts';
import type { Embedder } from '../llm/provider.ts';
import type { DocChunk, Finding } from '../types.ts';

// Hybrid retrieval: Postgres full-text search and pgvector cosine similarity, merged with
// reciprocal rank fusion. Works keyword-only when no embeddings are available.

const RRF_K = 60;

interface Row {
  id: number;
  url: string;
  title: string;
  heading: string;
  content: string;
}

export class DocRetriever {
  constructor(
    private readonly meta: Db,
    private readonly embedder?: Embedder,
  ) {}

  /** The version with ingested chunks closest to the requested one. */
  async resolveVersion(version: string): Promise<string | undefined> {
    const res = await this.meta.query('SELECT pg_version, count(*)::int AS n FROM doc_chunks GROUP BY 1');
    const versions = res.rows.map((r) => r.pg_version as string);
    if (versions.includes(version)) return version;
    return versions.sort((a, b) => Number(b) - Number(a))[0];
  }

  async stats(): Promise<{ version: string; chunks: number; embedded: number }[]> {
    const res = await this.meta.query(
      'SELECT pg_version, count(*)::int AS chunks, count(embedding)::int AS embedded FROM doc_chunks GROUP BY 1 ORDER BY 1',
    );
    return res.rows.map((r) => ({ version: r.pg_version, chunks: r.chunks, embedded: r.embedded }));
  }

  private async keyword(query: string, version: string, limit: number): Promise<Row[]> {
    // OR the query's lexemes together: long queries would otherwise match nothing.
    const res = await this.meta.query(
      `WITH q AS (
         SELECT to_tsquery('english', array_to_string(tsvector_to_array(to_tsvector('english', $1)), ' | ')) AS q
       )
       SELECT id, url, title, heading, content FROM doc_chunks, q
       WHERE pg_version = $2 AND tsv @@ q.q
       ORDER BY ts_rank_cd(tsv, q.q, 1) DESC LIMIT $3`,
      [query, version, limit],
    );
    return res.rows;
  }

  private async vector(query: string, version: string, limit: number): Promise<Row[]> {
    if (!this.embedder) return [];
    const [v] = await this.embedder.embed([query], 'query');
    const res = await this.meta.query(
      `SELECT id, url, title, heading, content FROM doc_chunks
       WHERE pg_version = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector LIMIT $3`,
      [JSON.stringify(v), version, limit],
    );
    return res.rows;
  }

  async search(queries: string[], version: string, k: number): Promise<DocChunk[]> {
    const fused = new Map<number, { row: Row; score: number }>();
    const addList = (rows: Row[], weight = 1) => {
      rows.forEach((row, rank) => {
        const cur = fused.get(row.id) ?? { row, score: 0 };
        cur.score += weight / (RRF_K + rank + 1);
        fused.set(row.id, cur);
      });
    };
    for (const q of queries) {
      addList(await this.keyword(q, version, 20));
      try {
        addList(await this.vector(q, version, 20));
      } catch {
        // Embedding API unavailable: keyword results still stand.
      }
    }
    // At most two chunks per section keeps the context diverse.
    const perSection = new Map<string, number>();
    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .filter(({ row }) => {
        const n = (perSection.get(row.url) ?? 0) + 1;
        perSection.set(row.url, n);
        return n <= 2;
      })
      .slice(0, k)
      .map(({ row, score }, i) => ({ id: row.id, ref: `D${i + 1}`, url: row.url, title: row.title, heading: row.heading, content: row.content, score: Math.round(score * 10000) / 10000 }));
  }

  /** One retrieval query per distinct finding, plus the SQL's own vocabulary. */
  async forFindings(findings: Finding[], sql: string, version: string, k = 6): Promise<DocChunk[]> {
    const resolved = await this.resolveVersion(version);
    if (!resolved) return [];
    const queries = [...new Set(findings.map((f) => f.docsQuery))].slice(0, 5);
    const keywords = new Set(
      (sql.match(/\b(ORDER BY|GROUP BY|DISTINCT|LIMIT|OFFSET|ILIKE|LIKE|NOT IN|EXISTS|JOIN|jsonb|ARRAY)\b/gi) ?? []).map((x) => x.toLowerCase()),
    );
    if (sql.includes('@>')) keywords.add('containment gin');
    if (keywords.size) queries.push(`${[...keywords].join(' ')} index performance`);
    if (!queries.length) queries.push('query performance index planner');
    return this.search(queries, resolved, k);
  }
}
