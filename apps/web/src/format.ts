export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  if (ms < 10_000) return `${Math.round(ms).toLocaleString('en-US')} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Relative change as a signed percentage with a real minus sign. */
export function fmtChange(change: number | undefined): string {
  if (change === undefined) return '—';
  const pct = change * 100;
  const abs = Math.abs(pct);
  const digits = abs >= 99.95 || abs < 10 ? 1 : 0;
  return `${pct < 0 ? '−' : '+'}${abs.toFixed(digits)}%`;
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

export function fmtCount(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString('en-US');
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
