import { errorMessage, type Session } from '../db.ts';

// A rewrite is only acceptable if it returns the same rows. We check this on real data:
// equal row counts, then multiset equality via EXCEPT ALL in both directions, then (when the
// original is ordered) the same sequence. Testing on data can't prove equivalence, but it catches
// the classic mistakes: NOT IN vs NOT EXISTS with NULLs, lost DISTINCT, wrong join type, ties.

export interface EquivalenceResult {
  equal: boolean;
  rowsOriginal: number;
  rowsRewrite: number;
  detail: string;
}

const MAX_ROWS_IN_MEMORY = 50_000;

async function fetchRows(s: Session, sql: string): Promise<string[]> {
  const res = await s.client.query({ text: sql, rowMode: 'array' });
  return res.rows.map((r) => JSON.stringify(r));
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

export async function checkEquivalence(s: Session, original: string, rewrite: string, ordered: boolean): Promise<EquivalenceResult> {
  const o = original.trim().replace(/;+\s*$/, '');
  const r = rewrite.trim().replace(/;+\s*$/, '');

  const counts = await s.query(`SELECT (SELECT count(*) FROM (${o}) a) AS n1, (SELECT count(*) FROM (${r}) b) AS n2`);
  const n1 = Number(counts.rows[0].n1);
  const n2 = Number(counts.rows[0].n2);
  if (n1 !== n2) return { equal: false, rowsOriginal: n1, rowsRewrite: n2, detail: `row counts differ: ${n1} vs ${n2}` };

  let multisetEqual: boolean | undefined;
  await s.query('SAVEPOINT qopt_equiv');
  try {
    const diff = await s.query(
      `SELECT (SELECT count(*) FROM ((${o}) EXCEPT ALL (${r})) x) AS missing,
              (SELECT count(*) FROM ((${r}) EXCEPT ALL (${o})) y) AS extra`,
    );
    const missing = Number(diff.rows[0].missing);
    const extra = Number(diff.rows[0].extra);
    await s.query('RELEASE SAVEPOINT qopt_equiv');
    if (missing || extra) {
      return { equal: false, rowsOriginal: n1, rowsRewrite: n2, detail: `${missing} rows missing and ${extra} extra rows compared with the original` };
    }
    multisetEqual = true;
  } catch (e) {
    await s.query('ROLLBACK TO SAVEPOINT qopt_equiv');
    // Column count/type mismatch means the shapes differ; types without equality (json) need an in-memory compare.
    const msg = errorMessage(e);
    if (/same number of columns|could not be matched|types .* cannot be matched/i.test(msg)) {
      return { equal: false, rowsOriginal: n1, rowsRewrite: n2, detail: `result columns differ: ${msg}` };
    }
    if (n1 > MAX_ROWS_IN_MEMORY) {
      return { equal: false, rowsOriginal: n1, rowsRewrite: n2, detail: `could not compare results (${msg})` };
    }
  }

  if (!ordered && multisetEqual) {
    return { equal: true, rowsOriginal: n1, rowsRewrite: n2, detail: `same ${n1} rows (multiset)` };
  }
  if (n1 > MAX_ROWS_IN_MEMORY) {
    return { equal: true, rowsOriginal: n1, rowsRewrite: n2, detail: `same ${n1} rows (multiset); order not compared above ${MAX_ROWS_IN_MEMORY} rows` };
  }

  const [a, b] = [await fetchRows(s, o), await fetchRows(s, r)];
  if (!sameMultiset(a, b)) return { equal: false, rowsOriginal: n1, rowsRewrite: n2, detail: 'rows differ' };
  if (ordered) {
    const firstDiff = a.findIndex((v, i) => v !== b[i]);
    if (firstDiff >= 0) {
      return {
        equal: false,
        rowsOriginal: n1,
        rowsRewrite: n2,
        detail: `same rows but different order from position ${firstDiff + 1} (ORDER BY ties can cause this; the rewrite must keep the original ORDER BY)`,
      };
    }
    return { equal: true, rowsOriginal: n1, rowsRewrite: n2, detail: `same ${n1} rows in the same order` };
  }
  return { equal: true, rowsOriginal: n1, rowsRewrite: n2, detail: `same ${n1} rows` };
}
