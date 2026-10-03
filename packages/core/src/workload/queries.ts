import { EMAIL_DOMAINS, sizesFor } from './seed.ts';

// The demo workload. Each query has a known best fix (`expected`), which is the ground truth the
// eval harness scores advisors against.

export type Rng = () => number;

/** mulberry32: tiny deterministic PRNG so eval runs use identical parameters every time. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export type Expectation =
  | { kind: 'index'; table: string; column: string; method?: string }
  | { kind: 'statistics'; table: string; columns: string[] }
  | { kind: 'config'; setting: string }
  | { kind: 'rewrite' };

export interface WorkloadQuery {
  id: string;
  title: string;
  /** What a good advisor should find; any one of these counts as a hit. */
  expected: Expectation[];
  expectedLabel: string;
  sql: (r: Rng, scale: number) => string;
}

function isoDay(offsetDays: number): string {
  const d = new Date(Date.UTC(2026, 5, 30) - offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export const WORKLOAD: WorkloadQuery[] = [
  {
    id: 'W01',
    title: 'Customer order history',
    expected: [{ kind: 'index', table: 'orders', column: 'customer_id' }],
    expectedLabel: 'btree on orders (customer_id, created_at)',
    sql: (r, s) =>
      `SELECT id, status, total, created_at FROM orders WHERE customer_id = ${int(r, 1, sizesFor(s).customers)} ORDER BY created_at DESC LIMIT 20`,
  },
  {
    id: 'W02',
    title: 'Order line items',
    expected: [{ kind: 'index', table: 'order_items', column: 'order_id' }],
    expectedLabel: 'btree on order_items (order_id)',
    sql: (r, s) => `SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = ${int(r, 1, sizesFor(s).orders)}`,
  },
  {
    id: 'W03',
    title: 'Login by email (case-insensitive)',
    expected: [{ kind: 'index', table: 'customers', column: 'lower(email)' }],
    expectedLabel: 'expression index on customers (lower(email))',
    sql: (r, s) => {
      const id = int(r, 1, sizesFor(s).customers);
      return `SELECT id, full_name, tier FROM customers WHERE lower(email) = lower('user${id}@${EMAIL_DOMAINS[id % 3].toLowerCase()}')`;
    },
  },
  {
    id: 'W04',
    title: 'Recent pending orders',
    expected: [
      { kind: 'index', table: 'orders', column: 'status' },
      { kind: 'index', table: 'orders', column: 'created_at' },
    ],
    expectedLabel: 'btree on orders (status, created_at) or partial index WHERE status = pending',
    sql: (r) => `SELECT id, customer_id, total FROM orders WHERE status = 'pending' AND created_at >= '${isoDay(int(r, 1, 3))}' ORDER BY created_at`,
  },
  {
    id: 'W05',
    title: 'Limited-edition products (array containment)',
    expected: [{ kind: 'index', table: 'products', column: 'tags', method: 'gin' }],
    expectedLabel: 'GIN on products (tags)',
    sql: () => `SELECT id, name, price FROM products WHERE tags @> ARRAY['limited']`,
  },
  {
    id: 'W06',
    title: 'Products by JSON attribute',
    expected: [{ kind: 'index', table: 'products', column: 'attributes', method: 'gin' }],
    expectedLabel: 'GIN on products (attributes jsonb_path_ops)',
    sql: () => `SELECT id, name FROM products WHERE attributes @> '{"color": "teal"}'`,
  },
  {
    id: 'W07',
    title: 'Review text search (leading wildcard)',
    expected: [{ kind: 'index', table: 'reviews', column: 'body', method: 'gin' }],
    expectedLabel: 'GIN on reviews (body gin_trgm_ops)',
    sql: () => `SELECT id, product_id, rating FROM reviews WHERE body ILIKE '%overheat%'`,
  },
  {
    id: 'W08',
    title: 'Event counts in a time window',
    expected: [{ kind: 'index', table: 'events', column: 'created_at' }],
    expectedLabel: 'BRIN or btree on events (created_at)',
    sql: (r) => {
      const day = isoDay(int(r, 1, 80));
      const hour = String(int(r, 0, 20)).padStart(2, '0');
      return `SELECT type, count(*) FROM events WHERE created_at >= '${day} ${hour}:00+00' AND created_at < timestamptz '${day} ${hour}:00+00' + interval '2 hours' GROUP BY type`;
    },
  },
  {
    id: 'W09',
    title: 'Customers without recent orders (NOT IN)',
    expected: [{ kind: 'rewrite' }, { kind: 'index', table: 'orders', column: 'customer_id' }],
    expectedLabel: 'NOT EXISTS rewrite (+ index on orders.customer_id)',
    sql: (r) =>
      `SELECT id, email FROM customers WHERE id NOT IN (SELECT customer_id FROM orders WHERE created_at >= '${isoDay(int(r, 20, 40))}') ORDER BY id LIMIT 100`,
  },
  {
    id: 'W10',
    title: 'Daily revenue via date() on a timestamptz',
    expected: [{ kind: 'rewrite' }],
    expectedLabel: 'sargable range rewrite + btree on orders (created_at)',
    sql: (r) => `SELECT count(*), sum(total) FROM orders WHERE date(created_at) = '${isoDay(int(r, 5, 600))}'`,
  },
  {
    id: 'W11',
    title: 'Orders from Auckland customers (correlated columns)',
    expected: [
      { kind: 'statistics', table: 'customers', columns: ['country', 'city'] },
      { kind: 'index', table: 'orders', column: 'customer_id' },
    ],
    expectedLabel: 'CREATE STATISTICS on customers (country, city) + btree on orders (customer_id)',
    sql: () =>
      `SELECT c.id, count(o.id) AS orders FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.country = 'NZ' AND c.city = 'Auckland' GROUP BY c.id`,
  },
  {
    id: 'W12',
    title: 'Revenue for premium electronics',
    expected: [{ kind: 'index', table: 'order_items', column: 'product_id' }],
    expectedLabel: 'btree on order_items (product_id)',
    sql: (r) =>
      `SELECT p.category, sum(oi.quantity * oi.unit_price) AS revenue, count(*) AS items FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE p.category = 'electronics' AND p.price > ${int(r, 1380, 1450)} GROUP BY p.category`,
  },
  {
    id: 'W13',
    title: 'Top products by distinct orders (sort spill)',
    expected: [
      { kind: 'index', table: 'order_items', column: 'product_id' },
      { kind: 'config', setting: 'work_mem' },
      { kind: 'rewrite' },
    ],
    expectedLabel: 'btree on order_items (product_id, order_id) for a sort-free index-only scan',
    sql: () => `SELECT product_id, count(DISTINCT order_id) AS orders FROM order_items GROUP BY product_id ORDER BY orders DESC LIMIT 10`,
  },
  {
    id: 'W14',
    title: 'Deep OFFSET pagination',
    expected: [{ kind: 'index', table: 'orders', column: 'created_at' }],
    expectedLabel: 'btree on orders (created_at); keyset pagination in the app',
    sql: (r) => `SELECT id, created_at, total FROM orders ORDER BY created_at DESC OFFSET ${int(r, 40, 60) * 1000} LIMIT 50`,
  },
  {
    id: 'W15',
    title: 'Lookup by email OR phone',
    expected: [
      { kind: 'index', table: 'customers', column: 'email' },
      { kind: 'index', table: 'customers', column: 'phone' },
      { kind: 'rewrite' },
    ],
    expectedLabel: 'btree on customers (email) and (phone) for a BitmapOr, or UNION rewrite',
    sql: (r, s) => {
      const a = int(r, 1, sizesFor(s).customers);
      const b = int(r, 1, sizesFor(s).customers);
      const phone = `+1-555-${String((b * 7919) % 10_000_000).padStart(7, '0')}`;
      return `SELECT id, full_name FROM customers WHERE email = 'User${a}@${EMAIL_DOMAINS[a % 3]}' OR phone = '${phone}'`;
    },
  },
];

export function workloadQuery(id: string): WorkloadQuery | undefined {
  return WORKLOAD.find((w) => w.id.toLowerCase() === id.toLowerCase());
}
