import type { ExplainResult, PlanNode } from '@qopt/core/types';
import { fmtCount, fmtMs } from '../format.ts';

function flatten(root: PlanNode): { node: PlanNode; depth: number }[] {
  const out: { node: PlanNode; depth: number }[] = [];
  const visit = (n: PlanNode, depth: number) => {
    out.push({ node: n, depth });
    n.children.forEach((c) => visit(c, depth + 1));
  };
  visit(root, 0);
  return out;
}

function chips(n: PlanNode): string[] {
  const out: string[] = [];
  const loops = n.actualLoops ?? 1;
  if (n.rowsRemovedByFilter) out.push(`removed ${fmtCount(n.rowsRemovedByFilter * loops)} rows`);
  if (n.qError && n.qError >= 10) out.push(`estimate off ${Math.round(n.qError)}×`);
  if (n.sortSpaceType === 'Disk') out.push(`spilled ${fmtCount(n.sortSpaceUsedKb)} kB`);
  if ((n.hashBatches ?? 1) > 1) out.push(`${n.hashBatches} batches`);
  if (n.lossyHeapBlocks) out.push(`lossy ${n.lossyHeapBlocks} blocks`);
  if (loops > 1) out.push(`${fmtCount(loops)} loops`);
  if (n.workersLaunched) out.push(`${n.workersLaunched} workers`);
  return out;
}

export function PlanTree({ plan, flagged = [], focus }: { plan: ExplainResult; flagged?: number[]; focus?: number }) {
  const rows = flatten(plan.root);
  const total = plan.executionMs ?? plan.root.inclusiveMs ?? 0;
  const maxCost = Math.max(...rows.map((r) => r.node.totalCost), 1);
  return (
    <div className="plan">
      <div className="plan-head">
        <span>Node</span>
        <span className="num-cell">Rows est → actual</span>
        <span className="num-cell">{plan.analyzed ? 'Self time' : 'Cost'}</span>
      </div>
      {rows.map(({ node, depth }) => {
        const detail = node.indexCond ?? node.hashCond ?? node.mergeCond ?? node.filter ?? node.joinFilter ?? node.sortKey?.join(', ') ?? node.groupKey?.join(', ');
        const self = node.exclusiveMs ?? 0;
        const share = total ? Math.min(1, self / total) : node.totalCost / maxCost;
        return (
          <div
            key={node.id}
            id={`plan-node-${node.id}`}
            className={`plan-row${flagged.includes(node.id) ? ' flagged' : ''}${focus === node.id ? ' focus' : ''}`}
          >
            <div style={{ paddingLeft: depth * 18 }}>
              <div>
                <span className="muted small">{depth ? '└ ' : ''}</span>
                <span className="node-name">{node.nodeType}</span>
                {node.joinType && node.joinType !== 'Inner' && <span className="secondary"> ({node.joinType})</span>}
                {node.relation && (
                  <span className="secondary">
                    {' '}
                    on <b>{node.relation}</b>
                    {node.alias && node.alias !== node.relation ? ` ${node.alias}` : ''}
                  </span>
                )}
                {node.indexName && <span className="secondary"> using {node.indexName}</span>}
              </div>
              {detail && <div className="node-detail">{detail}</div>}
              {chips(node).length > 0 && (
                <div className="node-chips">
                  {chips(node).map((c) => (
                    <span key={c} className="tag">
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="num-cell small">
              {fmtCount(node.planRows)}
              {node.actualRows !== undefined && <> → {fmtCount(node.actualRows)}</>}
            </div>
            <div className="num-cell small" title={plan.analyzed ? `${fmtMs(self)} of ${fmtMs(total)}` : `cost ${node.totalCost}`}>
              {plan.analyzed ? fmtMs(self) : Math.round(node.totalCost).toLocaleString('en-US')}
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${Math.max(0.5, share * 100)}%` }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
