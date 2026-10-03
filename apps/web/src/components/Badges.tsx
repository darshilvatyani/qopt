import type { Severity, ValidationResult } from '@qopt/core/types';

// Status colours always travel with an icon and a word, never colour alone.

const METHOD_LABEL: Record<string, string> = {
  static: 'static check',
  hypopg: 'HypoPG',
  shadow: 'shadow DB',
  'hypopg+shadow': 'HypoPG + shadow DB',
};

export function VerdictBadge({ v }: { v?: ValidationResult }) {
  if (!v) return <span className="pill warn">⚠ Unverified</span>;
  switch (v.verdict) {
    case 'accepted':
      return <span className="pill good">✓ Verified · {METHOD_LABEL[v.method]}</span>;
    case 'rejected':
      return <span className="pill bad">✕ Rejected · {METHOD_LABEL[v.method]}</span>;
    case 'error':
      return (
        <span className="pill bad">
          ✕ {v.errorClass === 'hallucination' ? 'Hallucinated' : v.errorClass === 'invalid_sql' ? 'Invalid SQL' : 'Failed'}
        </span>
      );
    default:
      return <span className="pill warn">− Skipped</span>;
  }
}

export function SeverityBadge({ s }: { s: Severity }) {
  if (s === 'high') return <span className="pill bad">▲ High</span>;
  if (s === 'medium') return <span className="pill warn">● Medium</span>;
  return <span className="pill">○ Low</span>;
}

export function SourceBadge({ source, round }: { source: 'heuristic' | 'llm'; round: number }) {
  return source === 'llm' ? (
    <span className="pill accent">Gemini{round ? ` · revision ${round}` : ''}</span>
  ) : (
    <span className="pill">Heuristic</span>
  );
}

export function StatusDot({ ok, label, title }: { ok: boolean | undefined; label: string; title?: string }) {
  return (
    <span className={`pill ${ok === undefined ? '' : ok ? 'good' : 'bad'}`} title={title}>
      <span className="dot" />
      {label}
    </span>
  );
}
