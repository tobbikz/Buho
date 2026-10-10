#!/usr/bin/env node
/**
 * Emit realistic OTLP/HTTP JSON traces into Búho (not coverage bootstrap).
 *
 *   node scripts/otel-demo-emit.mjs
 *   node scripts/otel-demo-emit.mjs --count 5 --service checkout-api
 *   BUHO_OTLP_URL=http://127.0.0.1:3100/api/otlp/v1/traces node scripts/otel-demo-emit.mjs
 *
 * Each emit = HTTP SERVER → CLIENT db → SQL span (waterfall).
 */
const endpoint =
  process.env.BUHO_OTLP_URL ?? 'http://127.0.0.1:3100/api/otlp/v1/traces';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return fallback;
}
const count = Math.max(1, Number(arg('--count', '3')) || 3);
const service = arg('--service', process.env.OTEL_SERVICE_NAME ?? 'orders-api');

const ROUTES = [
  {
    name: 'GET /api/orders',
    route: '/api/orders',
    sql: "SELECT id, status FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50",
    ms: 420,
  },
  {
    name: 'POST /api/orders',
    route: '/api/orders',
    sql: 'INSERT INTO orders (customer_id, status, total) VALUES ($1, $2, $3) RETURNING id',
    ms: 180,
  },
  {
    name: 'GET /api/orders/:id',
    route: '/api/orders/:id',
    sql: 'SELECT o.*, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1',
    ms: 95,
  },
  {
    name: 'GET /api/v1/inventory',
    route: '/api/v1/inventory',
    sql: 'SELECT sku, qty FROM inventory WHERE warehouse_id = $1 AND qty < reorder_level',
    ms: 240,
  },
];

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function randId(n) {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return hex(buf);
}

function buildTrace(route, offsetMs) {
  const now = BigInt(Date.now() - offsetMs) * 1_000_000n;
  const duration = BigInt(route.ms) * 1_000_000n;
  const traceId = randId(16);
  const rootId = randId(8);
  const clientId = randId(8);
  const sqlId = randId(8);
  const status = Math.random() < 0.08 ? 500 : 200;
  const statusCode = status >= 500 ? 2 : 1;

  return {
    traceId,
    body: {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: service } },
              { key: 'deployment.environment', value: { stringValue: 'lab' } },
              { key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'buho-otel-demo', version: '1.0.0' },
              spans: [
                {
                  traceId,
                  spanId: rootId,
                  name: route.name,
                  kind: 2,
                  startTimeUnixNano: String(now),
                  endTimeUnixNano: String(now + duration),
                  status: { code: statusCode },
                  attributes: [
                    { key: 'http.method', value: { stringValue: route.name.split(' ')[0] } },
                    { key: 'http.route', value: { stringValue: route.route } },
                    { key: 'http.status_code', value: { intValue: status } },
                    {
                      key: 'url.full',
                      value: { stringValue: `http://${service}.lab${route.route}` },
                    },
                  ],
                },
                {
                  traceId,
                  spanId: clientId,
                  parentSpanId: rootId,
                  name: 'pg.query',
                  kind: 3,
                  startTimeUnixNano: String(now + duration / 10n),
                  endTimeUnixNano: String(now + (duration * 9n) / 10n),
                  status: { code: 1 },
                  attributes: [
                    { key: 'db.system', value: { stringValue: 'postgresql' } },
                    { key: 'db.name', value: { stringValue: 'datalake' } },
                    { key: 'db.statement', value: { stringValue: route.sql } },
                  ],
                },
                {
                  traceId,
                  spanId: sqlId,
                  parentSpanId: clientId,
                  name: 'SELECT',
                  kind: 3,
                  startTimeUnixNano: String(now + duration / 8n),
                  endTimeUnixNano: String(now + (duration * 85n) / 100n),
                  status: { code: 1 },
                  attributes: [
                    { key: 'db.query.text', value: { stringValue: route.sql } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

const health = await fetch(endpoint, { method: 'GET' }).catch(() => null);
if (!health?.ok) {
  console.error(`OTLP endpoint not healthy: GET ${endpoint}`);
  if (health) console.error(health.status, await health.text());
  process.exit(1);
}

const accepted = [];
for (let i = 0; i < count; i++) {
  const route = ROUTES[i % ROUTES.length];
  const { traceId, body } = buildTrace(route, i * 45_000);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(res.status, text);
    process.exit(1);
  }
  accepted.push({ traceId, route: route.name, res: text });
  console.log(`ok  ${route.name.padEnd(22)}  ${traceId}`);
}

console.log(`\n${accepted.length} traces → ${service} @ ${endpoint}`);
console.log(`UI: http://127.0.0.1:3100/observability/services/${encodeURIComponent(service)}?tab=traces`);
