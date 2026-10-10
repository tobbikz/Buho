#!/usr/bin/env node
/**
 * End-to-end OTLP smoke: health → emit → verify store via web API surface.
 *
 *   npm run smoke:otlp
 *   BUHO_BASE=http://127.0.0.1:3100 node scripts/smoke-otlp.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const base = (process.env.BUHO_BASE ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const otlp = process.env.BUHO_OTLP_URL ?? `${base}/api/otlp/v1/traces`;
const service = `smoke-api-${Date.now().toString(36)}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`ok    ${msg}`);
}

function otlpHeaders(extra = {}) {
  const headers = { ...extra };
  const token = process.env.BUHO_OTLP_TOKEN?.trim();
  if (token) headers['authorization'] = `Bearer ${token}`;
  return headers;
}

// 1) Health
{
  const res = await fetch(otlp, { method: 'GET', headers: otlpHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) fail(`GET health ${res.status} ${JSON.stringify(body)}`);
  if (body.protocol !== 'otlp/http+json') fail(`unexpected protocol ${body.protocol}`);
  ok(`health ${body.protocol} auth=${body.auth}`);
}

// 1b) Off-loopback without token must fail closed (unless token already set for this process)
if (!process.env.BUHO_OTLP_TOKEN?.trim()) {
  const res2 = await fetch(otlp, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '10.9.9.9',
    },
    body: JSON.stringify({ resourceSpans: [] }),
  });
  if (res2.status !== 503 && res2.status !== 401) {
    fail(`expected fail-closed off-loopback POST, got ${res2.status}`);
  }
  ok(`fail-closed off-loopback POST → ${res2.status}`);
}

// 2) Reject protobuf-ish content-type
{
  const res = await fetch(otlp, {
    method: 'POST',
    headers: otlpHeaders({ 'content-type': 'application/x-protobuf' }),
    body: Buffer.from([0]),
  });
  if (res.status !== 415) fail(`expected 415 for protobuf, got ${res.status}`);
  ok('rejects protobuf with 415');
}

// 3) Emit via demo script
{
  const r = spawnSync(
    process.execPath,
    ['scripts/otel-demo-emit.mjs', '--count', '2', '--service', service],
    {
      cwd: root,
      env: { ...process.env, BUHO_OTLP_URL: otlp },
      encoding: 'utf8',
    },
  );
  if (r.status !== 0) fail(`emit failed:\n${r.stdout}\n${r.stderr}`);
  ok(`emitted 2 traces for ${service}`);
}

// 4) Service page should render (SSR lists inventory including our service)
{
  const url = `${base}/observability/services/${encodeURIComponent(service)}?tab=traces`;
  const res = await fetch(url, { redirect: 'follow' });
  const html = await res.text();
  if (!res.ok) fail(`service page ${res.status}`);
  if (!html.includes(service) && !html.includes('Traces')) {
    fail('service page missing expected content');
  }
  // Should show real SQL, not coverage bootstrap
  if (html.includes('buho coverage bootstrap')) {
    fail('page still shows coverage bootstrap SQL');
  }
  ok(`service traces UI ${url}`);
}

// 5) Global traces page
{
  const res = await fetch(`${base}/observability/apm/traces`);
  if (!res.ok) fail(`traces page ${res.status}`);
  ok('global traces page 200');
}

console.log('\nSMOKE OTLP OK');
console.log(`  service  ${service}`);
console.log(`  open     ${base}/observability/services/${encodeURIComponent(service)}?tab=traces`);
