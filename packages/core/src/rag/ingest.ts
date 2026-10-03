import type { Db } from '../db.ts';
import type { Embedder } from '../llm/provider.ts';
import type { Log } from '../setup.ts';
import { chunkDocPage } from './chunk.ts';

// A deliberately small corpus: the parts of the PostgreSQL manual that matter for query tuning,
// for the target's major version only. Version-specific accuracy and citable sources are what
// RAG adds here; the model already knows the manual in general terms.
export const DOC_PAGES = [
  'indexes-intro',
  'indexes-types',
  'indexes-multicolumn',
  'indexes-ordering',
  'indexes-bitmap-scans',
  'indexes-unique',
  'indexes-expressional',
  'indexes-partial',
  'indexes-index-only-scans',
  'indexes-opclass',
  'indexes-examine',
  'btree',
  'hash-index',
  'gin',
  'brin',
  'pgtrgm',
  'datatype-json',
  'textsearch-indexes',
  'using-explain',
  'planner-stats',
  'row-estimation-examples',
  'multivariate-statistics-examples',
  'explicit-joins',
  'runtime-config-query',
  'runtime-config-resource',
  'jit-decision',
  'sql-createindex',
  'sql-createstatistics',
  'sql-explain',
  'sql-analyze',
  'functions-subquery',
  'functions-comparisons',
  'queries-limit',
  'queries-with',
  'routine-vacuuming',
  'storage-vm',
  'pgstatstatements',
  'auto-explain',
];

export function docUrl(version: string, slug: string): string {
  return `https://www.postgresql.org/docs/${version}/${slug}.html`;
}

export interface IngestOptions {
  version: string;
  embed: boolean;
  pages?: string[];
}

export async function ingestDocs(meta: Db, embedder: Embedder | undefined, opts: IngestOptions, log: Log = console.log): Promise<number> {
  const pages = opts.pages ?? DOC_PAGES;
  const rows: { slug: string; url: string; title: string; heading: string; content: string }[] = [];
  for (const slug of pages) {
    const url = docUrl(opts.version, slug);
    const res = await fetch(url, { headers: { 'user-agent': 'qopt-docs-ingest' } });
    if (!res.ok) {
      log(`  ! ${slug}: HTTP ${res.status}, skipped`);
      continue;
    }
    const chunks = chunkDocPage(await res.text());
    for (const c of chunks) rows.push({ slug, url: c.anchor ? `${url}#${c.anchor}` : url, title: c.title, heading: c.heading, content: c.content });
    log(`  ${slug}: ${chunks.length} chunks`);
  }

  let vectors: number[][] | undefined;
  if (opts.embed && embedder) {
    log(`embedding ${rows.length} chunks with ${embedder.model} (${embedder.dims} dims)…`);
    embedder.onWait = (msg) => log(`  ${msg}`);
    vectors = await embedder.embed(
      rows.map((r) => `${r.title} > ${r.heading}\n${r.content}`),
      'document',
    );
  }

  await meta.tx(async (s) => {
    await s.query('DELETE FROM doc_chunks WHERE pg_version = $1', [opts.version]);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await s.query(
        `INSERT INTO doc_chunks (pg_version, slug, url, title, heading, content, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [opts.version, r.slug, r.url, r.title, r.heading, r.content, vectors ? JSON.stringify(vectors[i]) : null],
      );
    }
  });
  log(`stored ${rows.length} chunks for PostgreSQL ${opts.version}${vectors ? ' with embeddings' : ' (keyword search only: no embeddings)'}`);
  return rows.length;
}
