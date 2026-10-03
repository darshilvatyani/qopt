import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  type AnalysisResult,
  type AnalyzeOptions,
  analyze,
  captureSlowQueries,
  closeDbs,
  config,
  dbStatus,
  DEFAULT_OPTIONS,
  EVAL_CONFIGS,
  errorMessage,
  getServices,
  initParser,
  loadLatestEval,
  REPO_ROOT,
  rng,
  runEval,
  runWorkload,
  WORKLOAD,
} from '@qopt/core';
import Fastify from 'fastify';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cors, { origin: true });
await initParser();
const services = getServices();

// Validation times queries on the shadow, so experiments run one at a time: concurrent runs would
// measure each other.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

const live = new Map<string, AnalysisResult>();

interface Job {
  name: string;
  running: boolean;
  log: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}
const jobs: Record<string, Job> = {
  workload: { name: 'workload', running: false, log: [] },
  eval: { name: 'eval', running: false, log: [] },
};

function startJob(job: Job, fn: (log: (m: string) => void) => Promise<unknown>): boolean {
  if (job.running) return false;
  Object.assign(job, { running: true, log: [], error: undefined, startedAt: new Date().toISOString(), finishedAt: undefined });
  const log = (m: string) => {
    job.log.push(m);
    if (job.log.length > 500) job.log.shift();
  };
  void exclusive(() => fn(log))
    .catch((e) => {
      job.error = errorMessage(e);
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    });
  return true;
}

app.get('/api/health', async () => {
  const docs = services.retriever ? await services.retriever.stats().catch(() => []) : [];
  return {
    databases: await dbStatus(),
    gemini: { configured: !!services.llm, model: config.geminiModel, embedModel: config.geminiEmbedModel },
    docs,
    thresholds: { minCostGain: config.minCostGain, minTimeGain: config.minTimeGain, measureRuns: config.measureRuns },
  };
});

app.get<{ Querystring: { limit?: string } }>('/api/queries', async (req) => {
  const limit = Math.min(100, Number(req.query.limit ?? 20) || 20);
  return captureSlowQueries(services.dbs.target, limit);
});

app.get('/api/workload', async () =>
  WORKLOAD.map((w) => ({ id: w.id, title: w.title, expected: w.expectedLabel, sql: w.sql(rng(1), 1) })),
);

app.post<{ Body: { iterations?: number } }>('/api/workload/run', async (req, reply) => {
  const iterations = Math.min(200, Math.max(1, Number(req.body?.iterations ?? 10)));
  const started = startJob(jobs.workload, (log) => runWorkload({ iterations, scale: 1, seed: Date.now() % 100_000, reset: false }, log));
  return reply.code(started ? 202 : 409).send(jobs.workload);
});

app.post<{ Body: { sql?: string; queryid?: string; label?: string; options?: Partial<AnalyzeOptions> } }>('/api/analyze', async (req, reply) => {
  const { sql, queryid, label } = req.body ?? {};
  if (!sql?.trim() && !queryid) return reply.code(400).send({ error: 'sql or queryid is required' });
  const options: AnalyzeOptions = { ...DEFAULT_OPTIONS, ...req.body.options };
  const id = randomUUID();
  const placeholder: AnalysisResult = {
    id,
    createdAt: new Date().toISOString(),
    status: 'running',
    sql: sql ?? '',
    source: { type: queryid ? 'captured' : 'adhoc', queryid, label },
    options,
    stages: [{ name: 'queued', status: 'running' }],
    findings: [],
    context: [],
    docs: [],
    candidates: [],
    recommendations: [],
    warnings: [],
  };
  live.set(id, placeholder);
  void exclusive(() =>
    analyze({ sql, queryid, label, options, runId: id, onUpdate: (run) => live.set(id, run) }, services).then((run) => {
      live.set(id, run);
      // Keep finished runs briefly in memory; the store has them afterwards.
      setTimeout(() => live.delete(id), 10 * 60_000).unref();
    }),
  ).catch((e) => {
    live.set(id, { ...placeholder, status: 'failed', error: errorMessage(e) });
  });
  return reply.code(202).send({ id });
});

app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
  const run = live.get(req.params.id) ?? (await services.store.get(req.params.id));
  if (!run) return reply.code(404).send({ error: 'run not found' });
  return run;
});

app.get<{ Querystring: { limit?: string } }>('/api/runs', async (req) => services.store.list(Math.min(100, Number(req.query.limit ?? 30) || 30)));

app.get('/api/eval', async () => ({ report: (await loadLatestEval()) ?? null, job: jobs.eval, configs: EVAL_CONFIGS }));

// Re-running some configurations keeps the others' saved results (merge), like `qopt eval --merge`.
app.post<{ Body: { configs?: string[]; queries?: string[] } }>('/api/eval', async (req, reply) => {
  const configs = req.body?.configs?.length ? req.body.configs : Object.keys(EVAL_CONFIGS);
  const started = startJob(jobs.eval, (log) => runEval(services, { configs, queries: req.body?.queries, scale: 1, seed: 42, merge: true }, log));
  return reply.code(started ? 202 : 409).send(jobs.eval);
});

app.get('/api/jobs', async () => jobs);

// Serve the built UI in production (npm run build:web && npm start).
const webDist = join(REPO_ROOT, 'apps', 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
  );
}

const shutdown = async () => {
  await app.close();
  await closeDbs();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.apiPort, host: '127.0.0.1' });
