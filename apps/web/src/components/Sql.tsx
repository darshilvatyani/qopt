import { type ReactNode, useState } from 'react';

const KEYWORDS = new Set(
  (
    'select from where and or not in is null as on join left right inner outer full cross group by order having limit offset ' +
    'distinct union all except intersect exists between like ilike case when then else end with insert into values update set ' +
    'delete returning create index concurrently unique using include statistics analyze explain asc desc nulls first last ' +
    'interval timestamptz timestamp date true false array lateral if'
  ).split(' '),
);

/** Tiny tokenizer: enough to make SQL readable without pulling in an editor. */
function highlight(sql: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /('(?:[^']|'')*')|(--[^\n]*)|(\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_][a-zA-Z0-9_]*\b)|(\s+|.)/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(sql))) {
    const [tok, str, comment, num, word] = m;
    if (str) out.push(<span key={i++} className="s">{str}</span>);
    else if (comment) out.push(<span key={i++} className="c">{comment}</span>);
    else if (num) out.push(<span key={i++} className="n">{num}</span>);
    else if (word && KEYWORDS.has(word.toLowerCase())) out.push(<span key={i++} className="k">{word}</span>);
    else out.push(tok);
  }
  return out;
}

export function Sql({ sql, copy = false }: { sql: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-wrap">
      <pre className="sql mono">{highlight(sql.trim())}</pre>
      {copy && (
        <button
          type="button"
          className="btn ghost copy"
          onClick={() => {
            void navigator.clipboard?.writeText(sql.trim()).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  );
}
