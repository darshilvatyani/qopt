// Shared types. Type-only: imported by the API and the web UI as well as core.

// ---------- Plans ----------

export interface PlanNode {
  id: number;
  nodeType: string;
  relation?: string;
  schema?: string;
  alias?: string;
  indexName?: string;
  joinType?: string;
  strategy?: string;
  parentRelationship?: string;
  startupCost: number;
  totalCost: number;
  planRows: number;
  planWidth: number;
  actualRows?: number;
  actualLoops?: number;
  actualTotalTime?: number;
  /** Total ms spent in this node and its children, across all loops. */
  inclusiveMs?: number;
  /** ms spent in this node alone (inclusive minus children). */
  exclusiveMs?: number;
  /** max(est, actual) / min(est, actual) using per-loop rows. */
  qError?: number;
  filter?: string;
  indexCond?: string;
  recheckCond?: string;
  hashCond?: string;
  mergeCond?: string;
  joinFilter?: string;
  sortKey?: string[];
  groupKey?: string[];
  sortMethod?: string;
  sortSpaceType?: string;
  sortSpaceUsedKb?: number;
  rowsRemovedByFilter?: number;
  rowsRemovedByIndexRecheck?: number;
  rowsRemovedByJoinFilter?: number;
  hashBatches?: number;
  originalHashBatches?: number;
  peakMemoryKb?: number;
  diskUsageKb?: number;
  lossyHeapBlocks?: number;
  exactHeapBlocks?: number;
  heapFetches?: number;
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
  tempReadBlocks?: number;
  tempWrittenBlocks?: number;
  workersPlanned?: number;
  workersLaunched?: number;
  children: PlanNode[];
}

export interface ExplainResult {
  root: PlanNode;
  analyzed: boolean;
  totalCost: number;
  planningMs?: number;
  executionMs?: number;
  jitMs?: number;
  queryText?: string;
}

export type PlanSource = 'shadow-analyze' | 'auto_explain' | 'target-explain' | 'target-generic';

// ---------- Findings ----------

export type FindingCode =
  | 'SEQ_SCAN_SELECTIVE'
  | 'SEQ_SCAN_IN_LOOP'
  | 'ROW_MISESTIMATE'
  | 'SORT_SPILL'
  | 'HASH_SPILL'
  | 'LOSSY_BITMAP'
  | 'HEAP_FETCHES'
  | 'TEMP_IO'
  | 'JIT_OVERHEAD'
  | 'HOT_NODE'
  | 'NOT_IN_SUBQUERY'
  | 'NON_SARGABLE_PREDICATE'
  | 'LEADING_WILDCARD'
  | 'LARGE_OFFSET'
  | 'OR_ACROSS_COLUMNS';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  code: FindingCode;
  severity: Severity;
  title: string;
  detail: string;
  nodeId?: number;
  relation?: string;
  evidence: Record<string, string | number | boolean>;
  /** Keywords used to retrieve relevant documentation for this finding. */
  docsQuery: string;
}

// ---------- Schema context ----------

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
}

export interface IndexInfo {
  name: string;
  definition: string;
  method: string;
  columns: string[];
  isPrimary: boolean;
  isUnique: boolean;
  bytes: number;
  scans: number;
}

export interface ColumnStats {
  column: string;
  nullFrac: number;
  nDistinct: number;
  correlation: number | null;
  avgWidth: number;
  mostCommonVals?: string;
  mostCommonFreqs?: number[];
  histogramBuckets: number;
}

export interface TableContext {
  schema: string;
  name: string;
  qualifiedName: string;
  estimatedRows: number;
  tableBytes: number;
  totalBytes: number;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  constraints: string[];
  extendedStats: string[];
  columnStats: ColumnStats[];
  activity: {
    seqScans: number;
    idxScans: number;
    inserts: number;
    updates: number;
    deletes: number;
    liveTuples: number;
    deadTuples: number;
    lastAnalyze: string | null;
  };
}

// ---------- Docs ----------

export interface DocChunk {
  id: number;
  ref: string;
  url: string;
  title: string;
  heading: string;
  content: string;
  score: number;
}

// ---------- Candidates & validation ----------

export type CandidateKind = 'index' | 'rewrite' | 'statistics' | 'config';
export type CandidateSource = 'heuristic' | 'llm';

export interface Candidate {
  id: string;
  source: CandidateSource;
  kind: CandidateKind;
  title: string;
  /** index: CREATE INDEX statements; statistics: CREATE STATISTICS; config: SET; rewrite: supporting CREATE INDEX (optional). */
  statements: string[];
  rewrittenSql?: string;
  rationale: string;
  expectedPlanChange?: string;
  citations: string[];
  round: number;
}

export type Verdict = 'accepted' | 'rejected' | 'error' | 'skipped';
export type ErrorClass = 'invalid_sql' | 'hallucination' | 'unsafe' | 'timeout' | 'db_error';
export type ValidationMethod = 'static' | 'hypopg' | 'shadow' | 'hypopg+shadow';

export interface Delta {
  before: number;
  after: number;
  /** Relative change: (after - before) / before. Negative is an improvement. */
  change: number;
}

export interface ValidationResult {
  verdict: Verdict;
  method: ValidationMethod;
  reason: string;
  errorClass?: ErrorClass;
  cost?: Delta;
  timeMs?: Delta & { samples: number };
  usesCandidate?: boolean;
  equivalence?: { equal: boolean; rowsOriginal: number; rowsRewrite: number; detail: string };
  qError?: Delta;
  spillResolved?: boolean;
  indexBytes?: number;
  afterPlan?: ExplainResult;
  /** Higher is better; used to rank accepted candidates. */
  score: number;
}

export interface ValidatedCandidate extends Candidate {
  validation?: ValidationResult;
}

// ---------- Capture ----------

export interface CapturedQuery {
  queryid: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
  tempBlksWritten: number;
  sample?: {
    queryText: string;
    durationMs: number;
    loggedAt: string;
    plan: ExplainResult;
  };
}

// ---------- Analysis runs ----------

export type Engine = 'heuristic' | 'llm' | 'both';

export interface AnalyzeOptions {
  engine: Engine;
  rag: boolean;
  validate: boolean;
  retries: number;
}

export interface StageLog {
  name: string;
  status: 'running' | 'done' | 'skipped' | 'failed';
  ms?: number;
  note?: string;
}

export interface LlmUsage {
  model: string;
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AnalysisResult {
  id: string;
  createdAt: string;
  status: 'running' | 'done' | 'failed';
  error?: string;
  sql: string;
  source: { type: 'adhoc' | 'captured' | 'workload'; queryid?: string; label?: string };
  options: AnalyzeOptions;
  stages: StageLog[];
  pgVersion?: string;
  baseline?: { plan: ExplainResult; source: PlanSource; medianMs?: number; samples?: number };
  observedPlan?: ExplainResult;
  findings: Finding[];
  context: TableContext[];
  docs: DocChunk[];
  diagnosis?: string;
  candidates: ValidatedCandidate[];
  recommendations: ValidatedCandidate[];
  llm?: LlmUsage;
  warnings: string[];
}

export interface RunSummary {
  id: string;
  createdAt: string;
  status: AnalysisResult['status'];
  sql: string;
  engine: Engine;
  recommendations: number;
  bestGain?: number;
}

// ---------- Eval ----------

export interface EvalQueryResult {
  workloadId: string;
  title: string;
  expected: string;
  candidates: number;
  accepted: number;
  recommended: number;
  hallucinations: number;
  unsafe: number;
  wrongResults: number;
  hit: boolean;
  baselineMs: number;
  afterMs: number;
  recommendedSql: string[];
  /** Gemini model that answered (fallbacks can differ from the configured one). */
  model?: string;
  error?: string;
}

export interface EvalConfigResult {
  config: string;
  label: string;
  models?: string[];
  queries: EvalQueryResult[];
  totals: {
    candidates: number;
    accepted: number;
    recommended: number;
    precision: number;
    hallucinationRate: number;
    wrongResults: number;
    hitRate: number;
    baselineMs: number;
    afterMs: number;
    speedup: number;
    indexBytes: number;
    llmCalls: number;
  };
}

export interface EvalReport {
  createdAt: string;
  pgVersion: string;
  model?: string;
  configs: EvalConfigResult[];
  notes: string[];
}
