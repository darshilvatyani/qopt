import { randomUUID } from 'node:crypto';
import { heuristicCandidates } from './advisor/heuristic.ts';
import { getCapturedQuery } from './capture/capture.ts';
import { config } from './config.ts';
import { columnMap, introspectTables } from './context/schema.ts';
import { type Db, errorMessage } from './db.ts';
import { Suggester } from './llm/suggest.ts';
import { explainCost, type Measurement, measure } from './plan/explain.ts';
import { planFindings, queryFindings } from './plan/findings.ts';
import { relationsInPlan } from './plan/tree.ts';
import type { Services } from './services.ts';
import { fingerprint, initParser, parseOne, statementKind } from './sql/ast.ts';
import { analyzeQuery } from './sql/shape.ts';
import type {
  AnalysisResult,
  AnalyzeOptions,
  Candidate,
  CapturedQuery,
  ExplainResult,
  PlanSource,
  ValidatedCandidate,
} from './types.ts';
import { type ValidationContext, validateCandidate } from './validate/validator.ts';

export interface AnalyzeInput {
  sql?: string;
  queryid?: string;
  label?: string;
  sourceType?: AnalysisResult['source']['type'];
  options?: Partial<AnalyzeOptions>;
  /** Called whenever the run changes (stage progress, candidates validated). */
  onUpdate?: (run: AnalysisResult) => void;
  runId?: string;
}

export const DEFAULT_OPTIONS: AnalyzeOptions = { engine: 'both', rag: true, validate: true, retries: 1 };

async function serverInfo(db: Db): Promise<{ version: string; major: string; extensions: string[] }> {
  const res = await db.query(
    "SELECT current_setting('server_version') AS v, current_setting('server_version_num')::int / 10000 AS major, array(SELECT extname::text FROM pg_extension) AS ext",
  );
  return { version: res.rows[0].v, major: String(res.rows[0].major), extensions: res.rows[0].ext };
}

function statementKey(c: Candidate): string {
  const sql = c.kind === 'rewrite' ? [c.rewrittenSql ?? '', ...c.statements] : c.statements;
  return `${c.kind}:${sql.map((s) => fingerprint(s.replace(/\bCONCURRENTLY\b/i, ''))).join('|')}`;
}

export async function analyze(input: AnalyzeInput, services: Services): Promise<AnalysisResult> {
  const options: AnalyzeOptions = { ...DEFAULT_OPTIONS, ...input.options };
  const { dbs } = services;
  const run: AnalysisResult = {
    id: input.runId ?? randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'running',
    sql: input.sql ?? '',
    source: { type: input.sourceType ?? (input.queryid ? 'captured' : 'adhoc'), queryid: input.queryid, label: input.label },
    options,
    stages: [],
    findings: [],
    context: [],
    docs: [],
    candidates: [],
    recommendations: [],
    warnings: [],
  };
  const emit = () => input.onUpdate?.(run);

  async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const log = { name, status: 'running' as const, ms: undefined as number | undefined };
    run.stages.push(log);
    emit();
    const t = performance.now();
    try {
      const out = await fn();
      Object.assign(log, { status: 'done', ms: Math.round(performance.now() - t) });
      return out;
    } catch (e) {
      Object.assign(log, { status: 'failed', ms: Math.round(performance.now() - t), note: errorMessage(e) });
      throw e;
    } finally {
      emit();
    }
  }
  const skip = (name: string, note: string) => {
    run.stages.push({ name, status: 'skipped', note });
    emit();
  };

  try {
    await initParser();

    // 1. What are we analysing?
    let captured: CapturedQuery | undefined;
    if (input.queryid) {
      captured = await stage('capture', () => getCapturedQuery(dbs.target, input.queryid!));
      if (!captured) throw new Error(`queryid ${input.queryid} not found in pg_stat_statements`);
      run.sql = captured.sample?.queryText ?? captured.query;
      run.observedPlan = captured.sample?.plan;
      if (!captured.sample) run.warnings.push('No auto_explain sample for this statement: parameters are unknown, so validation is cost-based (GENERIC_PLAN).');
    }
    if (!run.sql.trim()) throw new Error('no SQL to analyse');
    const parsed = parseOne(run.sql);
    const kind = statementKind(parsed.type);
    if (!['select', 'insert', 'update', 'delete'].includes(kind)) throw new Error(`only SELECT/INSERT/UPDATE/DELETE can be analysed (got ${parsed.type})`);
    const isSelect = kind === 'select';
    const preShape = analyzeQuery(run.sql);
    const generic = preShape.hasParams;

    const [targetInfo, shadowInfo] = await stage('connect', async () =>
      Promise.all([serverInfo(dbs.target), dbs.shadow ? serverInfo(dbs.shadow).catch(() => undefined) : Promise.resolve(undefined)]),
    );
    run.pgVersion = targetInfo.version;
    const shadow = shadowInfo ? dbs.shadow : undefined;
    if (dbs.shadow && !shadowInfo) run.warnings.push('Shadow database unreachable: validation is limited to HypoPG cost estimates.');

    // 2. Baseline: a real execution on the shadow when possible, estimates otherwise.
    let targetPlan: ExplainResult;
    let baseline: Measurement | undefined;
    let planSource: PlanSource;
    let basePlan: ExplainResult;
    await stage('baseline', async () => {
      targetPlan = await explainCost(dbs.target, run.sql, { generic });
      if (shadow && !generic) {
        try {
          baseline = await shadow.sandbox((s) => measure(s, run.sql, config.measureRuns), { readOnly: isSelect });
        } catch (e) {
          run.warnings.push(`Baseline on shadow failed (${errorMessage(e)}); using estimates from the target.`);
        }
      }
      if (baseline) {
        basePlan = baseline.plan;
        planSource = 'shadow-analyze';
      } else if (run.observedPlan) {
        basePlan = run.observedPlan;
        planSource = 'auto_explain';
      } else {
        basePlan = targetPlan;
        planSource = generic ? 'target-generic' : 'target-explain';
      }
      run.baseline = { plan: basePlan, source: planSource, medianMs: baseline?.medianMs, samples: baseline?.samples.length };
    });

    // 3. Schema context for every table the query or plan touches.
    const relations = [
      ...new Set([...relationsInPlan(basePlan!), ...preShape.relations.map((r) => (r.schemaname ? `${r.schemaname}.${r.relname}` : r.relname))]),
    ];
    run.context = await stage('context', () => introspectTables(dbs.target, relations, { redactValues: config.redactValues }));
    const shape = analyzeQuery(run.sql, columnMap(run.context));
    const used = new Map<string, Set<string>>();
    const touch = (t: string | undefined, c: string | undefined) => {
      if (!t || !c) return;
      if (!used.has(t)) used.set(t, new Set());
      used.get(t)!.add(c);
    };
    for (const p of shape.predicates) touch(p.table, p.column ?? p.expr?.match(/\((\w+)/)?.[1]);
    for (const j of shape.joins) [j.left, j.right].forEach((s) => touch(s.table, s.column));
    for (const o of shape.orderBy) touch(o.table, o.column);
    for (const t of run.context) t.columnStats = t.columnStats.filter((s) => used.get(t.name)?.has(s.column));

    // 4. Deterministic diagnosis.
    run.findings = [...planFindings(basePlan!), ...queryFindings(shape.antiPatterns)];
    emit();

    // 5. Documentation retrieval.
    const docsVersion = targetInfo.major;
    if (options.rag && services.retriever && (options.engine !== 'heuristic')) {
      run.docs = await stage('retrieve docs', () => services.retriever!.forFindings(run.findings, run.sql, docsVersion)).catch((e) => {
        run.warnings.push(`Doc retrieval failed: ${errorMessage(e)}`);
        return [];
      });
      if (!run.docs.length) run.warnings.push('No documentation chunks found; run `qopt docs ingest` to enable RAG.');
    } else if (options.rag && options.engine !== 'heuristic') {
      skip('retrieve docs', 'META_URL not configured');
    }

    // 6. Validation context shared by every candidate.
    const vctx: ValidationContext = {
      sql: run.sql,
      generic,
      ordered: shape.orderBy.length > 0,
      isSelect,
      target: dbs.target,
      shadow,
      hypopgOnTarget: targetInfo.extensions.includes('hypopg'),
      hypopgOnShadow: !!shadowInfo?.extensions.includes('hypopg'),
      baseline,
      tables: run.context,
      minCostGain: config.minCostGain,
      minTimeGain: config.minTimeGain,
      measureRuns: config.measureRuns,
    };
    const seen = new Set<string>();
    const validateAll = async (cands: Candidate[]) => {
      const fresh: ValidatedCandidate[] = [];
      for (const c of cands) {
        let key: string;
        try {
          key = statementKey(c);
        } catch {
          key = `${c.id}`;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        const vc: ValidatedCandidate = { ...c };
        run.candidates.push(vc);
        fresh.push(vc);
        if (options.validate) {
          vc.validation = await validateCandidate(c, vctx);
          emit();
        }
      }
      return fresh;
    };

    // 7. Candidates: heuristic baseline and/or LLM.
    if (options.engine === 'heuristic' || options.engine === 'both') {
      const h = heuristicCandidates({ shape, findings: run.findings, tables: run.context, plan: basePlan!, extensions: targetInfo.extensions });
      await stage(`heuristic: validate ${h.length}`, () => validateAll(h));
    }
    if (options.engine === 'llm' || options.engine === 'both') {
      if (!services.llm) {
        skip('llm', 'GEMINI_API_KEY not set');
        run.warnings.push('LLM step skipped: set GEMINI_API_KEY in .env to enable Gemini suggestions.');
      } else {
        const suggester = new Suggester(services.llm, {
          sql: run.sql,
          generic,
          pgVersion: targetInfo.version,
          plan: basePlan!,
          planSource: planSource!,
          findings: run.findings,
          tables: run.context,
          docs: run.docs,
          workload: captured,
          minTimeGain: config.minTimeGain,
        });
        run.llm = suggester.usage;
        try {
          const first = await stage('llm: suggest', () => suggester.initial());
          run.diagnosis = first.diagnosis;
          let latest = await stage(`llm: validate ${first.candidates.length}`, () => validateAll(first.candidates));
          for (let round = 1; round <= options.retries && options.validate; round++) {
            if (latest.some((c) => c.validation?.verdict === 'accepted') || !latest.length) break;
            const next = await stage(`llm: revise (round ${round})`, () => suggester.revise(latest, round));
            latest = await stage(`llm: validate ${next.candidates.length}`, () => validateAll(next.candidates));
          }
        } catch (e) {
          run.warnings.push(`LLM step failed: ${errorMessage(e)}`);
        }
      }
    }

    // 8. Recommendations: validated winners, best first. Without validation, everything is "unverified".
    run.recommendations = options.validate
      ? run.candidates.filter((c) => c.validation?.verdict === 'accepted').sort((a, b) => (b.validation?.score ?? 0) - (a.validation?.score ?? 0))
      : [...run.candidates];
    run.status = 'done';
  } catch (e) {
    run.status = 'failed';
    run.error = errorMessage(e);
  }
  emit();
  await services.store.save(run).catch((e) => run.warnings.push(`Could not save run: ${errorMessage(e)}`));
  return run;
}
