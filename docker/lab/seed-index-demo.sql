-- Demo data for Búho Indexes / Queries screens (run on primary; replicates to standby).
CREATE SCHEMA IF NOT EXISTS buho_demo;

DROP TABLE IF EXISTS buho_demo.orders CASCADE;
CREATE TABLE buho_demo.orders (
  id          bigint PRIMARY KEY,
  customer_id bigint NOT NULL,
  status      text   NOT NULL,
  region      text   NOT NULL,
  amount      numeric(12,2) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO buho_demo.orders (id, customer_id, status, region, amount, created_at)
SELECT
  g,
  (g % 5000) + 1,
  CASE (g % 4) WHEN 0 THEN 'pending' WHEN 1 THEN 'shipped' WHEN 2 THEN 'cancelled' ELSE 'delivered' END,
  CASE (g % 5) WHEN 0 THEN 'west' WHEN 1 THEN 'east' WHEN 2 THEN 'north' WHEN 3 THEN 'south' ELSE 'central' END,
  (random() * 1000)::numeric(12,2),
  now() - ((g % 365) || ' days')::interval
FROM generate_series(1, 80000) g;

-- Indexes: one useful, one redundant prefix, one unused (for check findings).
CREATE INDEX orders_customer_id_idx ON buho_demo.orders (customer_id);
CREATE INDEX orders_status_idx ON buho_demo.orders (status);
CREATE INDEX orders_status_created_idx ON buho_demo.orders (status, created_at);
CREATE INDEX orders_unused_region_only_idx ON buho_demo.orders (region);

ANALYZE buho_demo.orders;
