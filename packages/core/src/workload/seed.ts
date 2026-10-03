// Synthetic e-commerce schema with deliberately missing secondary indexes. Seeding is
// deterministic (setseed + single-threaded generate_series), so target and shadow get identical
// data and identical statistics without needing pg_dump.

export const ANCHOR = '2026-06-30 00:00:00+00';

const GEO: [country: string, city: string, weight: number][] = [
  ['US', 'New York', 0.11],
  ['US', 'San Francisco', 0.06],
  ['US', 'Chicago', 0.06],
  ['US', 'Austin', 0.04],
  ['DE', 'Berlin', 0.07],
  ['DE', 'Munich', 0.04],
  ['DE', 'Hamburg', 0.03],
  ['IN', 'Bangalore', 0.08],
  ['IN', 'Mumbai', 0.07],
  ['IN', 'Delhi', 0.06],
  ['GB', 'London', 0.09],
  ['GB', 'Manchester', 0.03],
  ['FR', 'Paris', 0.07],
  ['FR', 'Lyon', 0.02],
  ['JP', 'Tokyo', 0.07],
  ['JP', 'Osaka', 0.02],
  ['BR', 'São Paulo', 0.04],
  // Auckland determines NZ: independent-column estimates are ~25x too low for country+city.
  ['NZ', 'Auckland', 0.035],
  ['NZ', 'Wellington', 0.005],
];

export const CATEGORIES = ['electronics', 'books', 'home', 'garden', 'toys', 'sports', 'beauty', 'grocery', 'fashion', 'automotive', 'music', 'office'];
export const EMAIL_DOMAINS = ['Example.com', 'Mail.test', 'Inbox.dev'];

const WORDS = [
  'great', 'terrible', 'fast', 'slow', 'shipping', 'quality', 'price', 'value', 'battery', 'screen', 'sturdy', 'flimsy',
  'recommend', 'returned', 'gift', 'perfect', 'broke', 'week', 'month', 'daily', 'comfortable', 'noisy', 'quiet',
  'bright', 'color', 'size', 'fits', 'small', 'large', 'packaging', 'arrived', 'damaged', 'works', 'easy', 'setup',
  'instructions', 'customer', 'service', 'refund', 'love', 'hate', 'okay', 'cheap', 'expensive', 'durable', 'light',
  'heavy', 'smell', 'soft', 'hard', 'kids', 'office', 'kitchen', 'garden', 'travel', 'charging', 'cable', 'sound', 'bass', 'warm',
];

const sqlArray = (xs: (string | number)[]) =>
  `ARRAY[${xs.map((x) => (typeof x === 'number' ? String(x) : `'${x.replace(/'/g, "''")}'`)).join(',')}]`;

export interface ScaleSizes {
  customers: number;
  products: number;
  orders: number;
  itemsPerOrder: number;
  events: number;
  reviews: number;
}

export function sizesFor(scale: number): ScaleSizes {
  const s = (n: number) => Math.max(100, Math.round(n * scale));
  return { customers: s(100_000), products: s(30_000), orders: s(600_000), itemsPerOrder: 3, events: s(1_500_000), reviews: s(150_000) };
}

export function seedStatements(scale: number): string[] {
  const n = sizesFor(scale);
  const cum: number[] = [];
  GEO.reduce((acc, [, , w]) => {
    const next = acc + w;
    cum.push(Number(next.toFixed(4)));
    return next;
  }, 0);
  cum[cum.length - 1] = 1.0001;

  return [
    'SELECT setseed(0.4242)',
    'DROP TABLE IF EXISTS reviews, events, order_items, orders, products, customers CASCADE',
    `CREATE OR REPLACE FUNCTION pg_temp.pick(cum float8[], r float8) RETURNS int LANGUAGE sql IMMUTABLE AS
       $$ SELECT min(i) FROM generate_subscripts(cum, 1) i WHERE r < cum[i] $$`,

    `CREATE TABLE customers (
       id bigint PRIMARY KEY,
       email text NOT NULL,
       full_name text NOT NULL,
       phone text NOT NULL,
       country text NOT NULL,
       city text NOT NULL,
       tier text NOT NULL,
       created_at timestamptz NOT NULL
     )`,
    `INSERT INTO customers
     SELECT g,
            'User' || g || '@' || (${sqlArray(EMAIL_DOMAINS)})[1 + g % 3],
            initcap((${sqlArray(['alex', 'sam', 'priya', 'kenji', 'maria', 'lena', 'omar', 'chen', 'ana', 'noah'])})[1 + floor(r2 * 10)::int]) || ' ' ||
              initcap((${sqlArray(['smith', 'patel', 'garcia', 'müller', 'tanaka', 'silva', 'martin', 'kim', 'brown', 'nguyen'])})[1 + floor(r3 * 10)::int]),
            '+1-555-' || lpad(((g::bigint * 7919) % 10000000)::text, 7, '0'),
            (${sqlArray(GEO.map((g) => g[0]))})[k],
            (${sqlArray(GEO.map((g) => g[1]))})[k],
            CASE WHEN r4 < 0.70 THEN 'free' WHEN r4 < 0.95 THEN 'plus' ELSE 'pro' END,
            timestamptz '${ANCHOR}' - (r5 * interval '730 days')
     FROM (SELECT g, pg_temp.pick('{${cum.join(',')}}', random()) AS k,
                  random() AS r2, random() AS r3, random() AS r4, random() AS r5
           FROM generate_series(1, ${n.customers}) g) s`,

    `CREATE TABLE products (
       id bigint PRIMARY KEY,
       sku text NOT NULL,
       name text NOT NULL,
       category text NOT NULL,
       price numeric(10,2) NOT NULL,
       attributes jsonb NOT NULL,
       tags text[] NOT NULL,
       created_at timestamptz NOT NULL
     )`,
    `INSERT INTO products
     SELECT g,
            'SKU-' || lpad(g::text, 7, '0'),
            (${sqlArray(['Smart', 'Classic', 'Ultra', 'Mini', 'Pro', 'Eco', 'Deluxe', 'Compact', 'Wireless', 'Vintage'])})[1 + floor(random() * 10)::int] || ' ' ||
              (${sqlArray(['Speaker', 'Lamp', 'Backpack', 'Blender', 'Novel', 'Drone', 'Jacket', 'Kettle', 'Monitor', 'Chair', 'Puzzle', 'Headphones'])})[1 + floor(random() * 12)::int],
            (${sqlArray(CATEGORIES)})[1 + floor(random() * ${CATEGORIES.length})::int],
            round((5 + power(random(), 3) * 1500)::numeric, 2),
            jsonb_build_object(
              'color', CASE WHEN random() < 0.01 THEN 'teal' ELSE (${sqlArray(['black', 'white', 'red', 'blue', 'green', 'grey', 'silver'])})[1 + floor(random() * 7)::int] END,
              'size', (${sqlArray(['S', 'M', 'L', 'XL'])})[1 + floor(random() * 4)::int],
              'brand', 'brand' || floor(random() * 200)::int,
              'warranty_months', (${sqlArray([0, 6, 12, 24])})[1 + floor(random() * 4)::int]),
            ARRAY(SELECT t FROM unnest(${sqlArray(['eco', 'sale', 'new', 'premium', 'refurbished', 'bundle', 'gift'])}) t WHERE random() < 0.15 AND g > 0)
              || CASE WHEN random() < 0.004 THEN ARRAY['limited'] ELSE ARRAY[]::text[] END,
            timestamptz '${ANCHOR}' - (random() * interval '1000 days')
     FROM generate_series(1, ${n.products}) g`,

    `CREATE TABLE orders (
       id bigint PRIMARY KEY,
       customer_id bigint NOT NULL,
       status text NOT NULL,
       created_at timestamptz NOT NULL,
       total numeric(12,2) NOT NULL,
       shipping_country text NOT NULL
     )`,
    // Orders are appended in time order (created_at correlates with physical order), like a real table.
    `INSERT INTO orders
     SELECT g,
            1 + floor(random() * ${n.customers})::bigint,
            CASE WHEN ts > timestamptz '${ANCHOR}' - interval '3 days'
                   THEN (${sqlArray(['pending', 'pending', 'shipped', 'shipped', 'delivered'])})[1 + floor(r * 5)::int]
                 WHEN r < 0.001 THEN 'pending'
                 WHEN r < 0.93 THEN 'delivered'
                 WHEN r < 0.98 THEN 'cancelled'
                 ELSE 'returned' END,
            ts,
            round((10 + random() * 490)::numeric, 2),
            (${sqlArray([...new Set(GEO.map((x) => x[0]))])})[1 + floor(random() * 8)::int]
     FROM (SELECT g, random() AS r,
                  timestamptz '${ANCHOR}' - ((1 - g::float8 / ${n.orders}) * interval '730 days') + (random() * interval '10 minutes') AS ts
           FROM generate_series(1, ${n.orders}) g) s`,

    `CREATE TABLE order_items (
       id bigint PRIMARY KEY,
       order_id bigint NOT NULL,
       product_id bigint NOT NULL,
       quantity int NOT NULL,
       unit_price numeric(10,2) NOT NULL
     )`,
    `INSERT INTO order_items
     SELECT g,
            1 + (g - 1) / ${n.itemsPerOrder},
            1 + floor(power(random(), 2) * ${n.products})::bigint,
            1 + floor(random() * 4)::int,
            round((5 + random() * 300)::numeric, 2)
     FROM generate_series(1, ${n.orders * n.itemsPerOrder}) g`,

    `CREATE TABLE events (
       id bigint PRIMARY KEY,
       customer_id bigint NOT NULL,
       type text NOT NULL,
       created_at timestamptz NOT NULL,
       payload jsonb NOT NULL
     )`,
    `INSERT INTO events
     SELECT g,
            1 + floor(random() * ${n.customers})::bigint,
            CASE WHEN r < 0.70 THEN 'page_view' WHEN r < 0.85 THEN 'add_to_cart' WHEN r < 0.93 THEN 'checkout' ELSE 'search' END,
            timestamptz '${ANCHOR}' - ((1 - g::float8 / ${n.events}) * interval '90 days'),
            jsonb_build_object('path', '/p/' || floor(random() * ${n.products})::int, 'ms', floor(random() * 3000)::int)
     FROM (SELECT g, random() AS r FROM generate_series(1, ${n.events}) g) s`,

    `CREATE TABLE reviews (
       id bigint PRIMARY KEY,
       product_id bigint NOT NULL,
       customer_id bigint NOT NULL,
       rating int NOT NULL,
       body text NOT NULL,
       created_at timestamptz NOT NULL
     )`,
    `INSERT INTO reviews
     SELECT g,
            1 + floor(power(random(), 2) * ${n.products})::bigint,
            1 + floor(random() * ${n.customers})::bigint,
            1 + floor(random() * 5)::int,
            initcap(array_to_string(ARRAY(SELECT (${sqlArray(WORDS)})[1 + floor(random() * ${WORDS.length})::int]
                                          FROM generate_series(1, 8 + g % 9)), ' '))
              || CASE WHEN random() < 0.003 THEN ', it overheats after an hour' ELSE '.' END,
            timestamptz '${ANCHOR}' - (random() * interval '700 days')
     FROM generate_series(1, ${n.reviews}) g`,

    'ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)',
    'ALTER TABLE order_items ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)',
    'ALTER TABLE order_items ADD CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products (id)',
    'ALTER TABLE events ADD CONSTRAINT events_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)',
    'ALTER TABLE reviews ADD CONSTRAINT reviews_product_fk FOREIGN KEY (product_id) REFERENCES products (id)',
    'ALTER TABLE reviews ADD CONSTRAINT reviews_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)',
  ];
}

/** Run outside a transaction, after seeding. */
export const POST_SEED = ['VACUUM (ANALYZE) customers', 'VACUUM (ANALYZE) products', 'VACUUM (ANALYZE) orders', 'VACUUM (ANALYZE) order_items', 'VACUUM (ANALYZE) events', 'VACUUM (ANALYZE) reviews'];

/** Cheap fingerprint of the data, to confirm target and shadow were seeded identically. */
export const CHECKSUM_SQL = `
  SELECT md5(string_agg(t || ':' || c || ':' || h, ',' ORDER BY t)) AS checksum FROM (
    SELECT 'customers' t, count(*) c, sum(hashtext(email || city))::text h FROM customers
    UNION ALL SELECT 'orders', count(*), sum(customer_id + extract(epoch FROM created_at)::bigint)::text FROM orders
    UNION ALL SELECT 'order_items', count(*), sum(product_id * quantity)::text FROM order_items
    UNION ALL SELECT 'products', count(*), sum(hashtext(name || attributes::text))::text FROM products
    UNION ALL SELECT 'events', count(*), sum(customer_id)::text FROM events
    UNION ALL SELECT 'reviews', count(*), sum(hashtext(body))::text FROM reviews
  ) x`;
