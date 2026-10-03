import type { AnalysisResult } from '@qopt/core/types';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { SeverityBadge, VerdictBadge } from '../components/Badges.tsx';
import { CandidateCard } from '../components/CandidateCard.tsx';
import { PlanTree } from '../components/PlanTree.tsx';
import { Sql } from '../components/Sql.tsx';
import { fmtBytes, fmtChange, fmtCount, fmtMs } from '../format.ts';

const PLAN_SOURCE = {
  'shadow-analyze': 'EXPLAIN ANALYZE on the shadow database',
  auto_explain: 'captured by auto_explain on the target',
  'target-explain': 'EXPLAIN on the target (estimates only)',
  'target-generic': 'EXPLAIN (GENERIC_PLAN) on the target (estimates only)',
} as const;

export function RunPage({ id }: { id: string }) {
  const [run, setRun] = useState<AnalysisResult>();
  const [error, setError] = useState<string>();
  const [focus, setFocus] = useState<number>();

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api.run(id);
        if (stop) return;
        setRun(r);
        if (r.status === 'running') timer = setTimeout(poll, 700);
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);

  if (error) return <div className="banner error">{error}</div>;
  if (!run) return <div className="empty">Loading…</div>;

  const running = run.status === 'running';
  const best = run.recommendations[0];
  const bestGain = best?.validation?.timeMs?.change ?? best?.validation?.cost?.change;
  const accepted = run.candidates.filter((c) => c.validation?.verdict === 'accepted').length;
  const flagged = run.findings.map((f) => f.nodeId).filter((x): x is number => x !== undefined);
  const rejected = run.candidates.filter((c) => !run.recommendations.includes(c));

  const goToNode = (nodeId?: number) => {
    if (nodeId === undefined) return;
    setFocus(nodeId);
    document.getElementById(`plan-node-${nodeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="stack">
      <div>
        <div className="row">
          <h1>Analysis</h1>
          {run.source.label && <span className="tag">{run.source.label}</span>}
          {run.source.queryid && <span className="pill">queryid {run.source.queryid}</span>}
          <span className="pill">engine: {run.options.engine}</span>
          {run.options.rag && run.options.engine !== 'heuristic' && <span className="pill">RAG</span>}
          {!run.options.validate && <span className="pill warn">⚠ validation off</span>}
          {run.pgVersion && <span className="pill">PostgreSQL {run.pgVersion.split(' ')[0]}</span>}
        </div>
      </div>
      <Sql sql={run.sql} copy />

      <div className="stages">
        {run.stages.map((s, i) => (
          <span key={`${s.name}-${i}`} className={`pill ${s.status === 'failed' ? 'bad' : s.status === 'skipped' ? 'warn' : ''}`} title={s.note}>
            {s.status === 'running' ? <span className="spinner" /> : s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : '−'} {s.name}
            {s.ms !== undefined && <span className="muted"> {fmtMs(s.ms)}</span>}
          </span>
        ))}
      </div>

      {run.status === 'failed' && <div className="banner error">Analysis failed: {run.error}</div>}
      {run.warnings.map((w) => (
        <div key={w} className="banner">
          {w}
        </div>
      ))}

      <div className="tiles">
        <div className="card tile">
          <div className="label">Baseline</div>
          <div className="value">{run.baseline?.medianMs !== undefined ? fmtMs(run.baseline.medianMs) : run.baseline ? `cost ${fmtCount(Math.round(run.baseline.plan.totalCost))}` : '—'}</div>
          <div className="sub">{run.baseline ? (run.baseline.samples ? `median of ${run.baseline.samples} runs on shadow` : PLAN_SOURCE[run.baseline.source]) : ''}</div>
        </div>
        <div className="card tile">
          <div className="label">Best verified fix</div>
          <div className={`value ${bestGain !== undefined ? 'delta-good' : ''}`}>{bestGain !== undefined ? fmtChange(bestGain) : '—'}</div>
          <div className="sub">
            {best?.validation?.timeMs ? `${fmtMs(best.validation.timeMs.before)} → ${fmtMs(best.validation.timeMs.after)}` : best ? 'estimated cost' : running ? 'working…' : 'nothing passed validation'}
          </div>
        </div>
        <div className="card tile">
          <div className="label">Candidates verified</div>
          <div className="value">
            {accepted}
            <span className="muted" style={{ fontSize: 16 }}>
              {' '}
              / {run.candidates.length}
            </span>
          </div>
          <div className="sub">{running ? 'validating…' : accepted === run.candidates.length ? 'all passed validation' : `${run.candidates.length - accepted} rejected by validation`}</div>
        </div>
        {run.llm && (
          <div className="card tile">
            <div className="label">Gemini</div>
            <div className="value">
              {run.llm.calls} <span style={{ fontSize: 14 }} className="muted">calls</span>
            </div>
            <div className="sub">
              {fmtCount(run.llm.inputTokens)} in · {fmtCount(run.llm.outputTokens)} out{run.llm.cachedCalls ? ` · ${run.llm.cachedCalls} cached` : ''}
            </div>
          </div>
        )}
      </div>

      {run.diagnosis && (
        <div className="card">
          <div className="card-head">
            <h3>Diagnosis</h3>
            <span className="pill accent">Gemini</span>
          </div>
          <div className="card-body">{run.diagnosis}</div>
        </div>
      )}

      <div className="section-title">Recommendations</div>
      <div className="card">
        {run.recommendations.length === 0 ? (
          <div className="empty">{running ? 'Validating candidates…' : 'No candidate passed validation. See the rejected candidates below for why.'}</div>
        ) : (
          run.recommendations.map((c, i) => <CandidateCard key={c.id} c={c} docs={run.docs} rank={i + 1} />)
        )}
      </div>

      {run.findings.length > 0 && (
        <>
          <div className="section-title">Findings</div>
          <div className="card">
            <table className="data">
              <tbody>
                {run.findings.map((f, i) => (
                  <tr key={`${f.code}-${i}`}>
                    <td style={{ width: 110 }}>
                      <SeverityBadge s={f.severity} />
                    </td>
                    <td>
                      <b>{f.title}</b>
                      <div className="secondary small">{f.detail}</div>
                    </td>
                    <td className="num" style={{ width: 90 }}>
                      {f.nodeId !== undefined && (
                        <button type="button" className="btn ghost" onClick={() => goToNode(f.nodeId)}>
                          node {f.nodeId}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {run.baseline && (
        <>
          <div className="section-title">Baseline plan</div>
          <div className="card">
            <div className="card-head">
              <span className="small muted">{PLAN_SOURCE[run.baseline.source]}</span>
              <span className="spacer" />
              {run.baseline.plan.executionMs !== undefined && <span className="small muted">execution {fmtMs(run.baseline.plan.executionMs)}</span>}
            </div>
            <PlanTree plan={run.baseline.plan} flagged={flagged} focus={focus} />
          </div>
        </>
      )}

      {rejected.length > 0 && (
        <>
          <div className="section-title">Rejected and unverified candidates</div>
          <div className="card">
            <details>
              <summary className="card-head">
                <h3>
                  {rejected.length} candidate{rejected.length > 1 ? 's' : ''} did not make the cut
                </h3>
              </summary>
              {rejected.map((c) => (
                <CandidateCard key={c.id} c={c} docs={run.docs} />
              ))}
            </details>
          </div>
        </>
      )}

      {run.candidates.length > 0 && (
        <div className="card table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Verdict</th>
                <th>Source</th>
                <th>Kind</th>
                <th>Candidate</th>
                <th className="num">Change</th>
              </tr>
            </thead>
            <tbody>
              {run.candidates.map((c) => (
                <tr key={c.id}>
                  <td>
                    <VerdictBadge v={c.validation} />
                  </td>
                  <td>{c.source === 'llm' ? `Gemini${c.round ? ` r${c.round}` : ''}` : 'Heuristic'}</td>
                  <td>{c.kind}</td>
                  <td>{c.title}</td>
                  <td className="num">{fmtChange(c.validation?.timeMs?.change ?? c.validation?.cost?.change)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {run.context.length > 0 && (
        <>
          <div className="section-title">Schema context</div>
          <div className="card">
            {run.context.map((t) => (
              <details key={t.qualifiedName} style={{ borderBottom: '1px solid var(--border)' }}>
                <summary className="card-head" style={{ borderBottom: 0 }}>
                  <h3>{t.qualifiedName}</h3>
                  <span className="muted small">
                    ~{fmtCount(t.estimatedRows)} rows · {fmtBytes(t.tableBytes)} · {t.indexes.length} index{t.indexes.length === 1 ? '' : 'es'}
                  </span>
                </summary>
                <div className="card-body stack small">
                  <div>
                    <b>Columns</b>: <span className="mono">{t.columns.map((c) => `${c.name} ${c.type}`).join(', ')}</span>
                  </div>
                  <div>
                    <b>Indexes</b>
                    {t.indexes.map((i) => (
                      <div key={i.name} className="mono muted">
                        {i.definition} · {fmtBytes(i.bytes)} · {i.scans} scans
                      </div>
                    ))}
                  </div>
                  {t.columnStats.length > 0 && (
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Column</th>
                          <th className="num">n_distinct</th>
                          <th className="num">null frac</th>
                          <th className="num">correlation</th>
                          <th>Most common values</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.columnStats.map((s) => (
                          <tr key={s.column}>
                            <td className="mono">{s.column}</td>
                            <td className="num">{fmtCount(s.nDistinct)}</td>
                            <td className="num">{s.nullFrac}</td>
                            <td className="num">{s.correlation?.toFixed(3) ?? '—'}</td>
                            <td className="mono muted">{s.mostCommonVals?.slice(0, 80) ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </details>
            ))}
          </div>
        </>
      )}

      {run.docs.length > 0 && (
        <>
          <div className="section-title">Documentation retrieved</div>
          <div className="card">
            {run.docs.map((d) => (
              <details key={d.ref} style={{ borderBottom: '1px solid var(--border)' }}>
                <summary className="card-head" style={{ borderBottom: 0 }}>
                  <span className="tag">{d.ref}</span>
                  <span>
                    {d.title} — <b>{d.heading}</b>
                  </span>
                  <span className="spacer" />
                  <a href={d.url} target="_blank" rel="noreferrer" className="small" onClick={(e) => e.stopPropagation()}>
                    postgresql.org ↗
                  </a>
                </summary>
                <div className="card-body small secondary" style={{ whiteSpace: 'pre-wrap' }}>
                  {d.content}
                </div>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
