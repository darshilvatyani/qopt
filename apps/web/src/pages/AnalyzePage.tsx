import type { AnalyzeOptions, CapturedQuery, Engine, RunSummary } from '@qopt/core/types';
import { useCallback, useEffect, useState } from 'react';
import { api, type Health, type Job, type WorkloadItem } from '../api.ts';
import { fmtChange, fmtMs, timeAgo } from '../format.ts';

type Selected = { kind: 'captured'; q: CapturedQuery } | { kind: 'workload'; w: WorkloadItem } | null;

export function AnalyzePage({ health, navigate }: { health?: Health; navigate: (path: string) => void }) {
  const [queries, setQueries] = useState<CapturedQuery[]>([]);
  const [captureWarnings, setCaptureWarnings] = useState<string[]>([]);
  const [workload, setWorkload] = useState<WorkloadItem[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [tab, setTab] = useState<'captured' | 'workload'>('captured');
  const [selected, setSelected] = useState<Selected>(null);
  const [sql, setSql] = useState('');
  const [engine, setEngine] = useState<Engine>('both');
  const [rag, setRag] = useState(true);
  const [validate, setValidate] = useState(true);
  const [retries, setRetries] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [job, setJob] = useState<Job>();

  const geminiOn = !!health?.gemini.configured;

  const refresh = useCallback(async () => {
    try {
      const [q, r] = await Promise.all([api.queries(25), api.runs()]);
      setQueries(q.queries);
      setCaptureWarnings(q.warnings);
      setRuns(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api.workload().then(setWorkload).catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (!geminiOn && engine !== 'heuristic') setEngine('heuristic');
  }, [geminiOn, engine]);

  // Poll the workload job while it runs, then refresh the captured list.
  useEffect(() => {
    if (!job?.running) return;
    const t = setInterval(async () => {
      const jobs = await api.jobs();
      setJob(jobs.workload);
      if (!jobs.workload.running) void refresh();
    }, 1000);
    return () => clearInterval(t);
  }, [job?.running, refresh]);

  const pick = (s: Selected) => {
    setSelected(s);
    if (s?.kind === 'captured') setSql(s.q.sample?.queryText ?? s.q.query);
    if (s?.kind === 'workload') setSql(s.w.sql);
  };

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const options: AnalyzeOptions = { engine, rag, validate, retries };
      const capturedUnchanged = selected?.kind === 'captured' && sql === (selected.q.sample?.queryText ?? selected.q.query);
      const { id } = await api.analyze(
        capturedUnchanged
          ? { queryid: selected.q.queryid, options }
          : { sql, label: selected?.kind === 'workload' ? selected.w.id : undefined, options },
      );
      navigate(`/runs/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="grid-2">
      <div className="card">
        <div className="card-head">
          <div className="segmented">
            <button type="button" className={tab === 'captured' ? 'on' : ''} onClick={() => setTab('captured')}>
              Slow queries
            </button>
            <button type="button" className={tab === 'workload' ? 'on' : ''} onClick={() => setTab('workload')}>
              Demo workload
            </button>
          </div>
          <span className="spacer" />
          {tab === 'captured' && (
            <button type="button" className="btn ghost" onClick={() => void refresh()} title="Refresh from pg_stat_statements">
              ↻
            </button>
          )}
        </div>
        {tab === 'captured' ? (
          <div className="list">
            {queries.length === 0 && (
              <div className="empty">
                <p>No statements captured yet.</p>
                <button type="button" className="btn" disabled={job?.running} onClick={() => void api.runWorkload(10).then(setJob)}>
                  {job?.running ? 'Running workload…' : 'Run the demo workload'}
                </button>
              </div>
            )}
            {queries.map((q) => (
              <button
                type="button"
                key={q.queryid}
                className={`list-item${selected?.kind === 'captured' && selected.q.queryid === q.queryid ? ' selected' : ''}`}
                onClick={() => pick({ kind: 'captured', q })}
              >
                <div className="metric-line">
                  <span>
                    <b className="secondary">{fmtMs(q.totalMs)}</b> total
                  </span>
                  <span>{q.calls} calls</span>
                  <span>{fmtMs(q.meanMs)} mean</span>
                  <span className="spacer" />
                  {q.sample ? <span title="auto_explain captured real parameters and the actual plan">● sample</span> : <span>○ no sample</span>}
                </div>
                <div className="q">{q.query}</div>
              </button>
            ))}
            {queries.length > 0 && (
              <div className="card-body row small">
                <span className="muted">From pg_stat_statements, joined with auto_explain samples.</span>
                <button type="button" className="btn ghost" disabled={job?.running} onClick={() => void api.runWorkload(10).then(setJob)}>
                  {job?.running ? 'Running…' : 'Run workload again'}
                </button>
              </div>
            )}
            {captureWarnings.map((w) => (
              <div key={w} className="banner" style={{ margin: 12 }}>
                {w}
              </div>
            ))}
          </div>
        ) : (
          <div className="list">
            {workload.map((w) => (
              <button
                type="button"
                key={w.id}
                className={`list-item${selected?.kind === 'workload' && selected.w.id === w.id ? ' selected' : ''}`}
                onClick={() => pick({ kind: 'workload', w })}
              >
                <div className="row">
                  <span className="tag">{w.id}</span>
                  <b>{w.title}</b>
                </div>
                <div className="small muted">Known fix: {w.expected}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h2>Analyze a query</h2>
            {selected?.kind === 'captured' && <span className="pill">queryid {selected.q.queryid}</span>}
            {selected?.kind === 'workload' && <span className="pill">{selected.w.id}</span>}
          </div>
          <div className="card-body stack">
            <textarea
              className="sql-input"
              spellCheck={false}
              placeholder="SELECT … — or pick a captured slow query"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
            />
            <div className="row">
              <div className="segmented" role="group" aria-label="Engine">
                <button type="button" className={engine === 'heuristic' ? 'on' : ''} onClick={() => setEngine('heuristic')}>
                  Heuristic
                </button>
                <button type="button" className={engine === 'llm' ? 'on' : ''} disabled={!geminiOn} onClick={() => setEngine('llm')}>
                  Gemini
                </button>
                <button type="button" className={engine === 'both' ? 'on' : ''} disabled={!geminiOn} onClick={() => setEngine('both')}>
                  Both
                </button>
              </div>
              <label className="check">
                <input type="checkbox" checked={rag} disabled={engine === 'heuristic'} onChange={(e) => setRag(e.target.checked)} /> Docs (RAG)
              </label>
              <label className="check">
                <input type="checkbox" checked={validate} onChange={(e) => setValidate(e.target.checked)} /> Validate
              </label>
              <label className="check">
                Revisions
                <input type="number" min={0} max={3} value={retries} style={{ width: 56 }} onChange={(e) => setRetries(Number(e.target.value))} />
              </label>
              <span className="spacer" />
              <button type="button" className="btn primary" disabled={busy || !sql.trim()} onClick={() => void submit()}>
                {busy ? 'Starting…' : 'Analyze'}
              </button>
            </div>
            {!geminiOn && (
              <div className="banner">Gemini is not configured. Set GEMINI_API_KEY in .env to enable LLM suggestions; the heuristic advisor and validation work without it.</div>
            )}
            {error && <div className="banner error">{error}</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Recent analyses</h2>
          </div>
          {runs.length === 0 ? (
            <div className="empty">No analyses yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Query</th>
                    <th>Engine</th>
                    <th className="num">Verified fixes</th>
                    <th className="num">Best gain</th>
                    <th className="num">When</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 12).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <a href={`#/runs/${r.id}`} className="mono" style={{ fontSize: 12 }}>
                          {r.sql.replace(/\s+/g, ' ').slice(0, 90)}
                        </a>
                      </td>
                      <td>{r.engine}</td>
                      <td className="num">{r.status === 'failed' ? <span className="delta-bad">failed</span> : r.recommendations}</td>
                      <td className="num delta-good">{r.bestGain !== undefined ? fmtChange(r.bestGain) : '—'}</td>
                      <td className="num muted">{timeAgo(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
