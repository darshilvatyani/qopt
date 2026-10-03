import type { EvalReport } from '@qopt/core/types';
import { useCallback, useEffect, useState } from 'react';
import { api, type Health, type Job } from '../api.ts';
import { HBarChart } from '../components/HBarChart.tsx';
import { fmtBytes, fmtMs } from '../format.ts';

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function EvalPage({ health }: { health?: Health }) {
  const [report, setReport] = useState<EvalReport | null>(null);
  const [job, setJob] = useState<Job>();
  const [configs, setConfigs] = useState<Record<string, { label: string; needsLlm: boolean }>>({});
  // null until the user touches a checkbox; until then the defaults follow what's configured.
  const [picked, setPicked] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    const r = await api.eval();
    setReport(r.report);
    setJob(r.job);
    setConfigs(r.configs);
  }, []);

  // Health loads separately, so derive the default selection instead of freezing it on first load.
  const chosen = picked ?? Object.entries(configs).filter(([, c]) => !c.needsLlm || health?.gemini.configured).map(([k]) => k);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!job?.running) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [job?.running, load]);

  const start = async () => {
    setJob(await api.startEval(chosen));
  };

  const baselineMs = report?.configs[0]?.totals.baselineMs;

  return (
    <div className="stack">
      <div>
        <h1>Evaluation</h1>
        <p className="secondary" style={{ margin: 0 }}>
          Each configuration analyses the 15-query demo workload. Its recommendations are then applied together on the shadow database, inside one
          rolled-back transaction, and the whole workload is timed again. The known correct fix for each query is the ground truth.
        </p>
      </div>

      <div className="card">
        <div className="card-body row">
          {Object.entries(configs).map(([key, c]) => (
            <label key={key} className="check">
              <input
                type="checkbox"
                checked={chosen.includes(key)}
                disabled={c.needsLlm && !health?.gemini.configured}
                onChange={(e) => setPicked(e.target.checked ? [...chosen, key] : chosen.filter((x) => x !== key))}
              />
              {c.label}
            </label>
          ))}
          <span className="spacer" />
          <button type="button" className="btn primary" disabled={job?.running || !chosen.length} onClick={() => void start()}>
            {job?.running ? 'Running…' : 'Run evaluation'}
          </button>
        </div>
        {(job?.running || job?.error) && (
          <div className="card-body" style={{ paddingTop: 0 }}>
            {job.error && <div className="banner error">{job.error}</div>}
            {job.running && <div className="log">{job.log.slice(-40).join('\n')}</div>}
          </div>
        )}
      </div>

      {!report ? (
        <div className="card empty">No evaluation results yet. Run one above, or run `npm run qopt -- eval` in a terminal.</div>
      ) : (
        <>
          <div className="section-title">Summary</div>
          <div className="card table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Configuration</th>
                  <th className="num" title="Queries where the top recommendation matches the known fix">Found known fix</th>
                  <th className="num" title="Share of proposed candidates that passed validation">Precision</th>
                  <th className="num" title="Candidates referencing columns/tables that don't exist, or invalid SQL">Hallucinated</th>
                  <th className="num" title="Recommended rewrites that return different rows">Wrong results</th>
                  <th className="num">Workload time</th>
                  <th className="num">Speedup</th>
                  <th className="num">New index size</th>
                  <th className="num">LLM calls</th>
                </tr>
              </thead>
              <tbody>
                {report.configs.map((c) => (
                  <tr key={c.config}>
                    <td>
                      <b>{c.label}</b>
                      {c.models?.length ? <div className="small muted">{c.models.join(', ')}</div> : null}
                    </td>
                    <td className="num">{pct(c.totals.hitRate)}</td>
                    <td className="num">{pct(c.totals.precision)}</td>
                    <td className="num">{pct(c.totals.hallucinationRate)}</td>
                    <td className={`num ${c.totals.wrongResults ? 'delta-bad' : ''}`}>{c.totals.wrongResults}</td>
                    <td className="num">
                      {fmtMs(c.totals.baselineMs)} → {fmtMs(c.totals.afterMs)}
                    </td>
                    <td className="num">
                      <b>{c.totals.speedup.toFixed(1)}×</b>
                    </td>
                    <td className="num">{fmtBytes(c.totals.indexBytes)}</td>
                    <td className="num">{c.totals.llmCalls || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.notes.map((n) => (
            <div key={n} className="banner">
              {n}
            </div>
          ))}

          <div className="section-title">Workload time after applying each configuration's recommendations</div>
          <div className="card card-body">
            <HBarChart
              ariaLabel="Total workload execution time per configuration"
              data={[
                ...(baselineMs !== undefined ? [{ label: 'No changes (baseline)', value: baselineMs, display: fmtMs(baselineMs), baseline: true }] : []),
                ...report.configs.map((c) => ({
                  label: c.label,
                  value: c.totals.afterMs,
                  display: fmtMs(c.totals.afterMs),
                  detail: `${c.totals.speedup.toFixed(1)}× faster, ${c.totals.recommended} changes`,
                })),
              ]}
            />
            <p className="small muted" style={{ marginBottom: 0 }}>
              Sum of median execution times over all {report.configs[0]?.queries.length} queries. PostgreSQL {report.pgVersion}
              {report.model ? ` · model ${report.model}` : ''} · {new Date(report.createdAt).toLocaleString()}
            </p>
          </div>

          <div className="section-title">Per query</div>
          <div className="card table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Query</th>
                  <th>Known fix</th>
                  <th className="num">Baseline</th>
                  {report.configs.map((c) => (
                    <th key={c.config} className="num">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.configs[0]?.queries.map((q, i) => (
                  <tr key={q.workloadId}>
                    <td>
                      <span className="tag">{q.workloadId}</span> {q.title}
                    </td>
                    <td className="small secondary">{q.expected}</td>
                    <td className="num">{fmtMs(q.baselineMs)}</td>
                    {report.configs.map((c) => {
                      const r = c.queries[i];
                      return (
                        <td key={c.config} className="num" title={r.recommendedSql.join('\n') || 'no recommendation'}>
                          <span className={r.hit ? 'delta-good' : 'muted'}>{r.hit ? '✓' : '✕'}</span> {fmtMs(r.afterMs)}
                          {r.wrongResults > 0 && <div className="delta-bad small">wrong results</div>}
                          {r.hallucinations > 0 && <div className="delta-bad small">{r.hallucinations} hallucinated</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
