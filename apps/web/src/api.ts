import type { AnalysisResult, AnalyzeOptions, CapturedQuery, EvalReport, RunSummary } from '@qopt/core/types';

export interface Health {
  databases: { role: string; url: string; reachable: boolean; version?: string; extensions: string[]; tables?: number; notes: string[] }[];
  gemini: { configured: boolean; model: string; embedModel: string };
  docs: { version: string; chunks: number; embedded: number }[];
  thresholds: { minCostGain: number; minTimeGain: number; measureRuns: number };
}

export interface Job {
  name: string;
  running: boolean;
  log: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface WorkloadItem {
  id: string;
  title: string;
  expected: string;
  sql: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  health: () => req<Health>('/api/health'),
  queries: (limit = 25) => req<{ queries: CapturedQuery[]; warnings: string[] }>(`/api/queries?limit=${limit}`),
  workload: () => req<WorkloadItem[]>('/api/workload'),
  runWorkload: (iterations: number) => req<Job>('/api/workload/run', { method: 'POST', body: JSON.stringify({ iterations }) }),
  jobs: () => req<Record<string, Job>>('/api/jobs'),
  analyze: (body: { sql?: string; queryid?: string; label?: string; options: AnalyzeOptions }) =>
    req<{ id: string }>('/api/analyze', { method: 'POST', body: JSON.stringify(body) }),
  run: (id: string) => req<AnalysisResult>(`/api/runs/${id}`),
  runs: () => req<RunSummary[]>('/api/runs'),
  eval: () => req<{ report: EvalReport | null; job: Job; configs: Record<string, { label: string; needsLlm: boolean }> }>('/api/eval'),
  startEval: (configs: string[]) => req<Job>('/api/eval', { method: 'POST', body: JSON.stringify({ configs }) }),
};
