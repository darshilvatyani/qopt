# qopt: a Postgres query advisor that checks its own work

qopt connects to a PostgreSQL database and finds its slow queries. It reads their execution plans and proposes indexes, query rewrites, extended statistics or settings, using Gemini with retrieval over the PostgreSQL manual plus your schema, alongside a rule-based advisor. **Every suggestion is verified against the real planner and real executions before it is recommended.**

Most "AI for SQL" tools only generate text. Here, every proposal is checked against ground truth:

| Suggestion | How it is verified |
|---|---|
| **Index** (btree/hash/brin) | HypoPG creates it *hypothetically* on the target: does the planner pick it, and does the cost drop ≥ 20%? If so, it is built for real on a **shadow** copy inside a rolled-back transaction and timed (median of 5 runs). It is kept only if execution time drops ≥ 15%. |
| **Index** (GIN, trigram, GiST) | HypoPG can't simulate these, so they are built and timed on the shadow directly. |
| **Rewrite** | Run on the shadow in a read-only transaction. It must return **the same rows**: equal counts, multiset equality via `EXCEPT ALL` in both directions, and the same order when the original has `ORDER BY`. It must also be faster. |
| **Extended statistics** | `CREATE STATISTICS` + `ANALYZE` on the shadow. Kept if the row-estimate error (q-error) at least halves or the query gets faster. |
| **Setting** (`work_mem`, …) | `SET LOCAL` on the shadow; kept if measured time drops. Only an allow-list of settings is accepted, with sane caps. |

Rejected candidates go back to the LLM with the reasons (for example, "planner ignored the index; cost 10934 → 10934" or "NOT equivalent: 12 rows missing"), and it gets another attempt.

```
 target DB ──► capture ──────► plan analyzer ───► context builder ──► suggesters
 (pg_stat_     pg_stat_          EXPLAIN JSON →      catalog + pg_stats   ├─ heuristic advisor
  statements,  statements +      findings (misest.,  of tables in plan    └─ Gemini (+ RAG over
  auto_explain) auto_explain       spills, seq scans,  + docs (RAG)            PG manual, pgvector)
               samples by queryid  anti-patterns)                                 │
                                                                                  ▼
            report / UI ◄── rank by measured gain ◄── validator: static SQL safety → HypoPG → shadow
                                                          │ (rolled-back transactions only)
                                                          └── rejections + reasons ──► LLM revise
```

## Quick start

Requirements: Node 22+, and either Homebrew (macOS) or Docker.

```bash
npm install
```

**Databases, option A: Homebrew (no Docker).** Three clusters in `./.pgdata`, with no background service:

```bash
brew install postgresql@17
# HypoPG and pgvector are not in Homebrew core; build them into postgresql@17 (see "Extensions" below)
npm run db:local -- init        # also: start | stop | status | destroy
```

**Databases, option B: Docker.**

```bash
npm run db:up                   # builds postgres:17 + hypopg + pgvector, starts target/shadow/meta
```

Then:

```bash
cp .env.example .env            # add GEMINI_API_KEY to enable the LLM (optional)
npm run qopt -- db setup        # extensions, demo schema (~15 s per DB), meta migrations
npm run qopt -- workload        # play the demo workload so pg_stat_statements/auto_explain fill up
npm run qopt -- docs ingest     # fetch + chunk the tuning-related PG manual (+ embeddings with a key)
npm run dev                     # API on :8787 and UI on http://localhost:5173
```

### Extensions (Homebrew path)

```bash
PGC=$(brew --prefix postgresql@17)/bin/pg_config
git clone --depth 1 --branch 1.4.3 https://github.com/HypoPG/hypopg.git && (cd hypopg && make PG_CONFIG=$PGC install)
git clone --depth 1 --branch v0.8.6 https://github.com/pgvector/pgvector.git && (cd pgvector && make PG_CONFIG=$PGC install)
```

### Gemini free tier

The free tier caps requests **per model per day**. The client:
- falls back through `GEMINI_FALLBACK_MODELS` when a model is overloaded (503) or rate-limited (429);
- skips models whose daily quota is spent;
- honours the server's `retryDelay` for per-minute limits;
- caches every answer on disk.

`qopt eval` shares one set of answers between "no validation" and "+ validation", and saves after each configuration; use `--merge` to finish a run after the quota resets (midnight Pacific). Older models (1.5, 2.5) are no longer offered to new API keys.

## Using it

### CLI

```bash
npm run qopt -- db status                         # connectivity, extensions, Gemini
npm run qopt -- capture                           # slowest statements, with/without auto_explain samples
npm run qopt -- analyze --top 3                   # analyse the 3 worst captured statements
npm run qopt -- analyze --queryid <id> --plan     # one captured statement, print the plan
npm run qopt -- analyze "SELECT … "               # ad-hoc SQL
npm run qopt -- analyze --workload W09 --engine llm   # a demo query, LLM only
npm run qopt -- docs search "work_mem sort spill"
npm run qopt -- eval                              # ablation study (see below)
npm run qopt -- shadow sync                       # refresh the shadow from the target via pg_dump | psql
```

`--engine heuristic|llm|both`, `--no-rag`, `--no-validate` and `--retries N` control the pipeline.

### Web UI

`npm run dev`, then open http://localhost:5173.

- **Analyze:** captured slow queries and demo queries, a SQL box, and engine/RAG/validation toggles.
- **Run view:** baseline, the best verified fix, ranked recommendations with measured before/after, copyable DDL, and "plan with this change". It also shows findings linked to the plan nodes, rejected candidates with the reasons, the schema context and the retrieved docs.
- **Evaluation:** runs the ablation study and compares configurations.

## Evaluation

`qopt eval` analyses a 15-query e-commerce workload where each query has a **known correct fix**: B-tree, expression, partial, GIN, trigram, BRIN, extended statistics, `work_mem`, and two that need rewrites. Each configuration's top recommendations are applied together on the shadow, the whole workload is re-timed, and everything is rolled back.

| Configuration | Found known fix | Precision | Hallucinated | Wrong results | Workload time | Speedup | New indexes |
|---|---|---|---|---|---|---|---|
| Heuristic advisor (no LLM) | 87% | 77% | 0% | 0 | 1,097 → 214 ms | 5.1× | 140 MB |
| LLM, no validation | 80% | 68% | 0% | 0 | 1,088 → 844 ms | **1.3×** | 172 MB |
| LLM + validation | 87% | 64% | 0% | 0 | 1,088 → 208 ms | 5.2× | 232 MB |
| LLM + validation + RAG | 87% | 70% | 0% | 0 | 1,086 → 190 ms | **5.7×** | 256 MB |

*PostgreSQL 17.11, scale 1 (600k orders, 1.8M order items). All LLM rows use `gemini-3.5-flash-lite`: the free tier's daily quota for the full Flash models was used up during development. Re-run with `npm run qopt -- eval --model gemini-3.8-flash` for a stronger model.*

What the numbers say:

- **Validation is the difference between 1.3× and 5.2×.** "LLM, no validation" and "LLM + validation" are scored on the *same* first answers from the model. Applied blindly, those answers included `SET work_mem = '64MB'` for W13, the heaviest query, which measured **slower** (707 → 749 ms). In an earlier run, blind application also shipped a W10 rewrite that hard-coded a `+00` offset, while `date(created_at)` uses the session time zone, so it returned different rows. Validation rejects both kinds of mistake, and the rejection reasons fed back to the model produce the fix it missed. For W13, the second attempt proposed the `(product_id, order_id)` index (704 → 149 ms). In an earlier run, W07's trigram index was first rejected because the model bundled a `CREATE EXTENSION` with it; the revision dropped that and was accepted (93.8 → 0.94 ms).
- **RAG's effect is within noise here.** Precision went from 64% to 70% and the speedup from 5.2× to 5.7×, and the RAG run happened to produce a correct W10 rewrite. But the docs retrieved for W10 were about covering and multicolumn indexes, not time zones or expression indexes, so that fix can't be credited to retrieval. With 15 queries and one sample per configuration, telling RAG apart from sampling variation would need repeated runs (for example with different `--seed` values, which change the query parameters and so the prompts).
- **The LLM's value shows up on queries that need a rewrite.** Without RAG, Gemini produced the `NOT EXISTS` rewrite for W09 (25.8 → 0.04 ms). The RAG run produced a time-zone-correct range rewrite for W10 (20.1 → 0.10 ms). The rule-based advisor can fix neither. Model output varies from run to run, though: each configuration solved one of the two, not both. On the standard index cases the lite model only matches the heuristic, and it proposes larger indexes (for example GIN without `jsonb_path_ops`).
- **No hallucinated columns or tables** from the lite model on this schema. The checks exist, and the integration tests prove they work, but this workload didn't trigger them.
- **Changes interact.** In W11, extended statistics fix the row estimate (14× → about 2× off), which changes the join plan the planner picks. W12 got fast in the LLM rows even though no W12 fix was accepted, because the `(product_id, order_id)` index recommended for W13 also serves W12's join. That is why the eval measures all recommendations together, not only one at a time.
- **The cost gate can reject real wins.** An index on `customers (country, city)` for W11 was rejected because HypoPG estimated only a 14.5% cost drop (the gate is 20%). Applied blindly, it measured 47% faster (28.1 → 15.0 ms). The HypoPG pre-filter trades some recall for speed; lowering `QOPT_MIN_COST_GAIN` lets more candidates through to real timing.

Metrics:
- **Found known fix:** the top recommendation matches the ground truth, and doesn't error or return different rows.
- **Precision:** share of proposed candidates that survive validation.
- **Hallucinated:** a candidate references a missing column or table, or doesn't parse.
- **Wrong results:** a recommended rewrite returns different rows.

## Project layout

```
packages/core/src
  capture/       pg_stat_statements + auto_explain jsonlog samples (joined by queryid)
  plan/          EXPLAIN normalisation (self time, q-error), findings, measurement
  sql/           libpg-query (the real Postgres parser, WASM): AST, query shape, safety checks
  context/       catalog + pg_stats introspection for the tables in the plan
  advisor/       heuristic (Dexter-style) baseline advisor
  llm/           provider interface, Gemini client, prompts, structured output, disk cache
  rag/           manual ingestion (chunking by section), hybrid FTS + pgvector retrieval (RRF)
  validate/      HypoPG, shadow sandbox, result-equivalence checks, scoring
  eval/          ablation harness
  workload/      demo schema, deterministic seed, 15 queries with ground truth
  pipeline.ts    orchestration: baseline → findings → context → docs → candidates → validate → revise
apps/cli         commander CLI
apps/api         Fastify API (runs experiments one at a time so timings don't interfere)
apps/web         React + Vite UI
docker/          postgres:17 + hypopg + pgvector image
scripts/         local Homebrew clusters
```

## Safety model

- **Target:** read-only sessions (`default_transaction_read_only`) with a `statement_timeout`. qopt only reads the catalog, `pg_stat_statements` and logs, and runs plain `EXPLAIN` plus HypoPG, which is session-local and writes nothing. It never runs `EXPLAIN ANALYZE` on the target. Every qopt statement is tagged `/*qopt*/` so capture ignores it.
- **Shadow:** every experiment runs in a transaction that is always rolled back. DML baselines run inside savepoints. Rewrites run under `transaction_read_only = on`.
- **Static checks before any database sees LLM output:** the real Postgres parser confirms each statement is what it claims. For example, an "index" must be exactly one `CREATE INDEX` and never `UNIQUE`. Rewrites must be a single `SELECT` with no data-modifying CTEs, `SELECT INTO`, row locks, or blocked functions (`pg_sleep`, `pg_terminate_backend`, `dblink`, …).
- DDL is never applied for you. Recommendations are printed with `CREATE INDEX CONCURRENTLY`.
- `QOPT_REDACT_VALUES=true` keeps `most_common_vals` (which can contain real user data) out of LLM prompts. Keep it on for real databases, especially on Gemini's free tier.

## Testing

```bash
npm run test:unit         # parser/shape/safety, plan findings on real EXPLAIN fixtures, heuristic rules, log parsing, chunking
npm test                  # + integration tests against the local databases (HypoPG, shadow, equivalence, LLM feedback loop)
npm run typecheck
```

The LLM feedback loop is integration-tested with a scripted model. A hallucinated column, an unused index and a disguised `DROP INDEX` are all rejected, their reasons appear in the second prompt, and the revised candidate is the one recommended.

## Limitations

- **Equivalence is tested on data, not proven.** Two queries can agree on this data and differ on other data. The shadow's data is what gives the check its power.
- **Timing noise.** Medians and a 15% threshold absorb most of it, but a busy machine can still flip borderline verdicts.
- **HypoPG only estimates cost,** so indexes are also timed on the shadow whenever one is configured.
- **Parameterized statements with no `auto_explain` sample** get `GENERIC_PLAN` cost checks only. There are no values to time with.
- **Changes are validated one at a time.** Combined effects can differ. In the eval, W11's extended statistics fix the row estimate, which changes the plan the planner picks alongside the new index.
- **The shadow is only as good as its copy.** Its data and statistics must resemble production for timings to transfer.

## Against your own database

Point `TARGET_URL` at the database and `SHADOW_URL` at a restored copy or a branch (`qopt shadow sync` works for small databases). The target needs:

- `shared_preload_libraries = 'pg_stat_statements,auto_explain'` and `compute_query_id = on`;
- `auto_explain.log_format = json` with `log_destination = jsonlog`;
- `CREATE EXTENSION hypopg`.

Reading the logs over SQL needs superuser, or `pg_read_server_files` + `pg_monitor`. Raise `auto_explain.log_min_duration` well above the demo's 5ms.
