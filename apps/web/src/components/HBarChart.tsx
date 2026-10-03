import { useState } from 'react';

export interface BarDatum {
  label: string;
  value: number;
  display: string;
  detail?: string;
  baseline?: boolean;
}

/** Single-series horizontal bars from one baseline, direct value labels, hover tooltip. */
export function HBarChart({ data, ariaLabel }: { data: BarDatum[]; ariaLabel: string }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="hbar-chart" role="img" aria-label={ariaLabel}>
      {data.map((d) => (
        <div className="hbar-row" key={d.label}>
          <span className="lbl">{d.label}</span>
          <div className="hbar-track">
            <div
              className={`hbar${d.baseline ? ' baseline' : ''}`}
              style={{ width: `${Math.max(0.4, (d.value / max) * 100)}%` }}
              onMouseMove={(e) => setTip({ x: e.clientX + 12, y: e.clientY + 12, text: `${d.label}: ${d.display}${d.detail ? ` · ${d.detail}` : ''}` })}
              onMouseLeave={() => setTip(null)}
            />
          </div>
          <span className="val">{d.display}</span>
        </div>
      ))}
      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}
