#!/usr/bin/env -S npx tsx
import { readFile } from 'node:fs/promises';
import {
  type AnalysisResult,
  analyze,
  captureSlowQueries,
  closeDbs,
  config,
  dbStatus,
  DEFAULT_OPTIONS,
  type Engine,
  EVAL_CONFIGS,
  GeminiLlm,
  getServices,
  ingestDocs,
  initParser,
  renderPlanText,
  rng,
  runEval,
  runWorkload,
  setupAll,
  syncShadow,
  type ValidatedCandidate,
  workloadQuery,
} from '@qopt/core';
import { Command, Option } from 'commander';

const tty = process.stdout.isTTY;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1);
const dim = c(2);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);

const oneLine = (sql: string, max = 110) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const pct = (x?: number) => (x === undefined ? '' : `${x <= 0 ? '' : '+'}${(x * 100).toFixed(1)}%`);

function printCandidate(cand: ValidatedCandidate): void {
  const v = cand.validation;
  const badge = !v
    ? yellow('UNVERIFIED')
    : v.verdict === 'accepted'
      ? green('ACCEPTED  ')
      : v.verdict === 'rejected'
        ? red('REJECTED  ')
        : v.verdict === 'error'
          ? red('ERROR     ')
          : yellow('SKIPPED   ');
  const gain = v?.timeMs ? pct(v.timeMs.change) : v?.cost ? `${pct(v.cost.change)} cost` : '';
  console.log(`  ${badge} ${dim(`[${cand.source}${cand.round ? ` r${cand.round}` : ''}]`)} ${cand.kind.padEnd(10)} ${bold(cand.title)} ${gain ? cyan(gain) : ''}`);
  if (cand.kind === 'rewrite' && cand.rewrittenSql) console.log(`      ${dim('rewrite:')} ${oneLine(cand.rewrittenSql, 140)}`);
  for (const s of cand.statements) console.log(`      ${s}`);
  if (v) console.log(`      ${dim(`${v.method}${v.errorClass ? ` (${v.errorClass})` : ''}:`)} ${v.reason}`);
}

function printRun(run: AnalysisResult, showPlan: boolean): void {
  console.log(`\n${bold('Query')}  ${oneLine(run.sql)}`);
  if (run.status === 'failed') {
    console.log(red(`Failed: ${run.error}`));
    return;
  }
  const b = run.baseline;
  if (b) {
    const src = { 'shadow-analyze': 'EXPLAIN ANALYZE on shadow', auto_explain: 'auto_explain sample', 'target-explain': 'estimates only', 'target-generic': 'generic plan, estimates only' }[b.source];
    console.log(`${bold('Baseline')}  ${b.medianMs !== undefined ? `${b.medianMs.toFixed(2)} ms (median of ${b.samples})` : `cost ${b.plan.totalCost.toFixed(0)}`} ${dim(`· ${src}`)}`);
  }
  if (run.findings.length) {
    console.log(bold('Findings'));
    for (const f of run.findings) {
      const sev = f.severity === 'high' ? red('HIGH  ') : f.severity === 'medium' ? yellow('MEDIUM') : dim('LOW   ');
      console.log(`  ${sev} ${f.title}${f.nodeId ? dim(` (node ${f.nodeId})`) : ''}`);
    }
  }
  if (showPlan && b) console.log(`${bold('Plan')}\n${renderPlanText(b.plan).replace(/^/gm, '  ')}`);
  if (run.docs.length) console.log(`${bold('Docs')}  ${run.docs.map((d) => `${d.ref} ${d.heading}`).join(dim(' · '))}`);
  if (run.diagnosis) console.log(`${bold('Diagnosis')}  ${run.diagnosis}`);
  console.log(bold(`Candidates (${run.candidates.length})`));
  for (const cand of run.candidates) printCandidate(cand);
  console.log(bold(`Recommendations (${run.recommendations.length})`));
  if (!run.recommendations.length) console.log(dim('  none passed validation'));
  run.recommendations.forEach((r, i) => {
    const gain = r.validation?.timeMs ? pct(r.validation.timeMs.change) : r.validation?.cost ? `${pct(r.validation.cost.change)} cost` : 'unverified';
    console.log(`  ${i + 1}. ${green(r.title)} ${cyan(gain)}`);
  });
  if (run.llm) console.log(dim(`LLM ${run.llm.model}: ${run.llm.calls} calls (${run.llm.cachedCalls} cached), ${run.llm.inputTokens} in / ${run.llm.outputTokens} out tokens`));
  for (const w of run.warnings) console.log(yellow(`! ${w}`));
  console.log(dim(`stages: ${run.stages.map((s) => `${s.name} ${s.ms ?? '-'}ms`).join(' · ')}`));
}

function engineOption() {
  return new Option('--engine <engine>', 'heuristic | llm | both').choices(['heuristic', 'llm', 'both']).default(DEFAULT_OPTIONS.engine);
}

const program = new Command('qopt').description('Postgres slow-query advisor: suggestions validated with HypoPG and a shadow database');

const db = program.command('db').description('set up and inspect the target / shadow / meta databases');
db.command('setup')
  .description('create extensions, seed the demo schema on target + shadow, migrate meta')
  .option('--scale <n>', 'data size multiplier (1 = 600k orders)', parseFloat, 1)
  .option('--no-seed', 'only create extensions and migrate; keep existing data')
  .action(async (o) => {
    await setupAll({ scale: o.scale, seed: o.seed });
  });
db.command('status')
  .description('connectivity, versions, extensions')
  .action(async () => {
    for (const s of await dbStatus()) {
      console.log(`${bold(s.role.padEnd(7))} ${s.reachable ? green('up  ') : red('down')} ${s.url} ${dim(s.version ?? '')}`);
      if (s.reachable) console.log(`        extensions: ${s.extensions.join(', ')} · ${s.tables} tables`);
      for (const n of s.notes) console.log(yellow(`        ! ${n}`));
    }
    console.log(`${bold('gemini ')} ${config.geminiApiKey ? green(`configured (${config.geminiModel})`) : yellow('not configured: heuristic advisor + keyword doc search only')}`);
  });

program
  .command('workload')
  .description('play the demo workload against the target so capture has data')
  .option('--iterations <n>', 'rounds through all queries', (v) => parseInt(v, 10), 20)
  .option('--scale <n>', 'must match the seeded scale', parseFloat, 1)
  .option('--seed <n>', 'parameter RNG seed', (v) => parseInt(v, 10), 1)
  .option('--queries <ids>', 'comma-separated workload ids, e.g. W01,W07')
  .option('--no-reset', 'keep existing pg_stat_statements counters')
  .action(async (o) => {
    await runWorkload({ iterations: o.iterations, scale: o.scale, seed: o.seed, reset: o.reset, queries: o.queries?.split(',') });
  });

program
  .command('capture')
  .description('slowest statements from pg_stat_statements, with auto_explain samples')
  .option('--limit <n>', 'how many', (v) => parseInt(v, 10), 15)
  .option('--json', 'machine-readable output')
  .action(async (o) => {
    const { queries, warnings } = await captureSlowQueries(getServices().dbs.target, o.limit);
    if (o.json) {
      console.log(JSON.stringify({ queries, warnings }, null, 2));
      return;
    }
    console.log(dim('queryid'.padEnd(21) + 'calls'.padStart(7) + 'total ms'.padStart(11) + 'mean ms'.padStart(10) + '  sample  query'));
    for (const q of queries) {
      console.log(
        `${q.queryid.padEnd(21)}${String(q.calls).padStart(7)}${q.totalMs.toFixed(0).padStart(11)}${q.meanMs.toFixed(2).padStart(10)}  ${q.sample ? green('yes   ') : dim('no    ')}  ${oneLine(q.query, 80)}`,
      );
    }
    for (const w of warnings) console.log(yellow(`! ${w}`));
  });

program
  .command('analyze')
  .description('diagnose a query and propose validated fixes')
  .argument('[sql]', 'SQL to analyse')
  .option('-f, --file <path>', 'read SQL from a file')
  .option('--queryid <id>', 'analyse a captured pg_stat_statements entry')
  .option('--workload <id>', 'analyse a demo workload query, e.g. W09')
  .option('--top <n>', 'analyse the N slowest captured statements', (v) => parseInt(v, 10))
  .addOption(engineOption())
  .option('--no-rag', 'skip documentation retrieval')
  .option('--no-validate', 'skip validation (candidates are reported as unverified)')
  .option('--retries <n>', 'LLM revise rounds after rejections', (v) => parseInt(v, 10), DEFAULT_OPTIONS.retries)
  .option('--plan', 'print the baseline plan')
  .option('--json', 'print the full result as JSON')
  .action(async (sqlArg: string | undefined, o) => {
    const services = getServices();
    const options = { engine: o.engine as Engine, rag: o.rag, validate: o.validate, retries: o.retries };
    const inputs: { sql?: string; queryid?: string; label?: string }[] = [];
    if (o.top) {
      const { queries } = await captureSlowQueries(services.dbs.target, o.top);
      inputs.push(...queries.map((q) => ({ queryid: q.queryid })));
    } else if (o.queryid) inputs.push({ queryid: o.queryid });
    else if (o.workload) {
      const w = workloadQuery(o.workload);
      if (!w) throw new Error(`unknown workload query ${o.workload}`);
      inputs.push({ sql: w.sql(rng(1), 1), label: w.id });
    } else if (o.file) inputs.push({ sql: await readFile(o.file, 'utf8') });
    else if (sqlArg) inputs.push({ sql: sqlArg });
    else throw new Error('give SQL, --file, --queryid, --workload or --top');

    for (const input of inputs) {
      const run = await analyze({ ...input, options }, services);
      if (o.json) console.log(JSON.stringify(run, null, 2));
      else printRun(run, !!o.plan);
    }
  });

const docs = program.command('docs').description('PostgreSQL documentation for RAG');
docs
  .command('ingest')
  .description('fetch, chunk and (with GEMINI_API_KEY) embed the tuning-related manual pages')
  .option('--version <major>', 'PostgreSQL major version (default: the target server)')
  .option('--no-embed', 'store chunks for keyword search only')
  .action(async (o) => {
    const services = getServices();
    if (!services.dbs.meta) throw new Error('META_URL is not set');
    const version = o.version ?? String((await services.dbs.target.query("SELECT current_setting('server_version_num')::int / 10000 AS v")).rows[0].v);
    if (o.embed && !services.embedder) console.log(yellow('! GEMINI_API_KEY not set: storing chunks without embeddings (keyword search only)'));
    await ingestDocs(services.dbs.meta, services.embedder, { version, embed: o.embed });
  });
docs
  .command('search')
  .description('try the retriever')
  .argument('<query>')
  .option('--k <n>', 'results', (v) => parseInt(v, 10), 5)
  .action(async (query: string, o) => {
    const { retriever, dbs } = getServices();
    if (!retriever) throw new Error('META_URL is not set');
    const major = String((await dbs.target.query("SELECT current_setting('server_version_num')::int / 10000 AS v")).rows[0].v);
    const version = await retriever.resolveVersion(major);
    if (!version) throw new Error('no docs ingested; run `qopt docs ingest`');
    for (const d of await retriever.search([query], version, o.k)) {
      console.log(`${bold(d.ref)} ${d.title} — ${cyan(d.heading)} ${dim(`(${d.score})`)}\n   ${dim(d.url)}\n   ${oneLine(d.content, 200)}`);
    }
  });
docs
  .command('status')
  .description('ingested chunk counts')
  .action(async () => {
    const { retriever } = getServices();
    if (!retriever) throw new Error('META_URL is not set');
    const stats = await retriever.stats();
    if (!stats.length) console.log(yellow('no docs ingested; run `qopt docs ingest`'));
    for (const s of stats) console.log(`PostgreSQL ${s.version}: ${s.chunks} chunks, ${s.embedded} with embeddings`);
  });

program
  .command('eval')
  .description('ablation study over the demo workload (needs the shadow)')
  .option('--configs <names>', `comma-separated: ${Object.keys(EVAL_CONFIGS).join(', ')}`, Object.keys(EVAL_CONFIGS).join(','))
  .option('--queries <ids>', 'subset of workload ids')
  .option('--scale <n>', 'must match the seeded scale', parseFloat, 1)
  .option('--seed <n>', 'parameter RNG seed', (v) => parseInt(v, 10), 42)
  .option('--model <name>', 'pin one Gemini model (no fallbacks), so LLM configs are compared on equal terms')
  .option('--merge', 'keep configs from the previous report that this run does not redo')
  .action(async (o) => {
    const base = getServices();
    const services = o.model && config.geminiApiKey ? { ...base, llm: new GeminiLlm(config.geminiApiKey, [o.model], config.cacheDir) } : base;
    const report = await runEval(services, { configs: o.configs.split(','), queries: o.queries?.split(','), scale: o.scale, seed: o.seed, merge: !!o.merge });
    console.log(`\n${bold('config'.padEnd(28))}${'hit rate'.padStart(9)}${'precision'.padStart(11)}${'halluc.'.padStart(9)}${'wrong'.padStart(7)}${'workload ms'.padStart(20)}${'speedup'.padStart(9)}${'index MB'.padStart(10)}`);
    for (const r of report.configs) {
      const t = r.totals;
      console.log(
        `${r.label.padEnd(28)}${`${(t.hitRate * 100).toFixed(0)}%`.padStart(9)}${`${(t.precision * 100).toFixed(0)}%`.padStart(11)}${`${(t.hallucinationRate * 100).toFixed(0)}%`.padStart(9)}${String(t.wrongResults).padStart(7)}${`${t.baselineMs.toFixed(0)} → ${t.afterMs.toFixed(0)}`.padStart(20)}${`${t.speedup.toFixed(1)}x`.padStart(9)}${(t.indexBytes / 1024 / 1024).toFixed(1).padStart(10)}`,
      );
    }
    for (const n of report.notes) console.log(yellow(`! ${n}`));
  });

const shadowCmd = program.command('shadow').description('manage the shadow database');
shadowCmd
  .command('sync')
  .description('refresh the shadow from the target with pg_dump | psql')
  .option('--schema-only', 'copy schema only')
  .action(async (o) => {
    await syncShadow({ schemaOnly: !!o.schemaOnly });
  });

await initParser();
try {
  await program.parseAsync(process.argv);
} catch (e) {
  console.error(red(`error: ${e instanceof Error ? e.message : String(e)}`));
  process.exitCode = 1;
} finally {
  await closeDbs();
}
