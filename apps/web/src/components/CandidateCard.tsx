import type { DocChunk, ValidatedCandidate } from '@qopt/core/types';
import { useState } from 'react';
import { fmtBytes, fmtChange, fmtMs } from '../format.ts';
import { SourceBadge, VerdictBadge } from './Badges.tsx';
import { PlanTree } from './PlanTree.tsx';
import { Sql } from './Sql.tsx';

const KIND_LABEL = { index: 'Index', rewrite: 'Rewrite', statistics: 'Statistics', config: 'Setting' } as const;

export function CandidateCard({ c, docs, rank }: { c: ValidatedCandidate; docs: DocChunk[]; rank?: number }) {
  const [showPlan, setShowPlan] = useState(false);
  const v = c.validation;
  const t = v?.timeMs;
  const cited = c.citations.map((ref) => docs.find((d) => d.ref === ref)).filter((d): d is DocChunk => !!d);
  return (
    <div className="candidate">
      <div className="row">
        {rank !== undefined && <span className="tag">#{rank}</span>}
        <span className="tag">{KIND_LABEL[c.kind]}</span>
        <span className="candidate-title">{c.title}</span>
        <span className="spacer" />
        <SourceBadge source={c.source} round={c.round} />
        <VerdictBadge v={v} />
      </div>

      {v && (t || v.cost) && (
        <div className="row" style={{ gap: 24 }}>
          {t ? (
            <div className="before-after">
              <span className="muted">{fmtMs(t.before)} →</span>
              <span className="big">{fmtMs(t.after)}</span>
              <span className={t.change < 0 ? 'delta-good' : 'delta-bad'}>{fmtChange(t.change)} measured</span>
            </div>
          ) : (
            v.cost && (
              <div className="before-after">
                <span className="muted">cost {Math.round(v.cost.before).toLocaleString('en-US')} →</span>
                <span className="big">{Math.round(v.cost.after).toLocaleString('en-US')}</span>
                <span className={v.cost.change < 0 ? 'delta-good' : 'delta-bad'}>{fmtChange(v.cost.change)} estimated</span>
              </div>
            )
          )}
          {t && v.cost && <span className="small muted">planner cost {fmtChange(v.cost.change)}</span>}
          {v.indexBytes ? <span className="small muted">index size {fmtBytes(v.indexBytes)}</span> : null}
          {v.qError && (
            <span className="small muted">
              row-estimate error {v.qError.before.toFixed(0)}× → {v.qError.after.toFixed(1)}×
            </span>
          )}
          {v.equivalence && <span className={`small ${v.equivalence.equal ? 'delta-good' : 'delta-bad'}`}>{v.equivalence.equal ? '✓' : '✕'} {v.equivalence.detail}</span>}
        </div>
      )}

      {c.kind === 'rewrite' && c.rewrittenSql && <Sql sql={c.rewrittenSql} copy />}
      {c.statements.length > 0 && <Sql sql={c.statements.map((s) => (s.trim().endsWith(';') ? s : `${s};`)).join('\n')} copy />}

      <p className="rationale">{c.rationale}</p>
      {c.expectedPlanChange && <p className="rationale small">Expected plan change: {c.expectedPlanChange}</p>}
      {v?.reason && <div className="reason">{v.reason}</div>}

      <div className="row small">
        {cited.map((d) => (
          <a key={d.ref} href={d.url} target="_blank" rel="noreferrer" className="pill">
            📖 {d.ref} · {d.heading}
          </a>
        ))}
        <span className="spacer" />
        {v?.afterPlan && (
          <button type="button" className="btn ghost" onClick={() => setShowPlan((x) => !x)}>
            {showPlan ? 'Hide plan with this change' : 'Show plan with this change'}
          </button>
        )}
      </div>
      {showPlan && v?.afterPlan && (
        <div className="card">
          <PlanTree plan={v.afterPlan} />
        </div>
      )}
    </div>
  );
}
