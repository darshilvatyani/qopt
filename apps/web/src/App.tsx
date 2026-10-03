import { useCallback, useEffect, useState } from 'react';
import { api, type Health } from './api.ts';
import { StatusDot } from './components/Badges.tsx';
import { AnalyzePage } from './pages/AnalyzePage.tsx';
import { EvalPage } from './pages/EvalPage.tsx';
import { RunPage } from './pages/RunPage.tsx';

function useHashRoute(): [string, (path: string) => void] {
  const read = () => window.location.hash.replace(/^#/, '') || '/';
  const [path, setPath] = useState(read);
  useEffect(() => {
    const on = () => {
      setPath(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((p: string) => {
    window.location.hash = p;
  }, []);
  return [path, navigate];
}

type Theme = 'system' | 'light' | 'dark';

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('qopt-theme') as Theme) || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('qopt-theme', theme);
    } catch {
      // storage unavailable: theme just won't persist
    }
  }, [theme]);
  const cycle = () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'));
  return [theme, cycle];
}

export function App() {
  const [path, navigate] = useHashRoute();
  const [health, setHealth] = useState<Health>();
  const [healthError, setHealthError] = useState<string>();
  const [theme, cycleTheme] = useTheme();

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((e) => setHealthError(e instanceof Error ? e.message : String(e)));
  }, []);

  const runMatch = /^\/runs\/([\w-]+)$/.exec(path);
  const db = (role: string) => health?.databases.find((d) => d.role === role);
  const docs = health?.docs.reduce((a, d) => a + d.chunks, 0) ?? 0;

  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand" style={{ textDecoration: 'none' }}>
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--accent)" />
            <path d="M9 21l5-6 4 3 5-8" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          qopt <small>query advisor</small>
        </a>
        <nav className="nav">
          <a href="#/" className={path === '/' || runMatch ? 'active' : ''}>
            Analyze
          </a>
          <a href="#/eval" className={path === '/eval' ? 'active' : ''}>
            Evaluation
          </a>
        </nav>
        <div className="health">
          {healthError ? (
            <span className="pill bad">✕ API unreachable</span>
          ) : (
            <>
              {['target', 'shadow', 'meta'].map((r) => (
                <StatusDot key={r} ok={health ? !!db(r)?.reachable : undefined} label={r} title={db(r)?.notes.join('; ') || db(r)?.url} />
              ))}
              <StatusDot ok={health ? health.gemini.configured : undefined} label={health?.gemini.configured ? health.gemini.model : 'Gemini off'} />
              <span className="pill" title="Documentation chunks available for retrieval">
                📖 {docs} chunks
              </span>
            </>
          )}
          <button type="button" className="btn ghost" onClick={cycleTheme} title="Theme: system → light → dark">
            {theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'}
          </button>
        </div>
      </header>
      <main>
        {healthError && (
          <div className="banner error" style={{ marginBottom: 16 }}>
            Cannot reach the qopt API ({healthError}). Start it with <code>npm run api</code>.
          </div>
        )}
        {runMatch ? <RunPage id={runMatch[1]} /> : path === '/eval' ? <EvalPage health={health} /> : <AnalyzePage health={health} navigate={navigate} />}
      </main>
    </>
  );
}
