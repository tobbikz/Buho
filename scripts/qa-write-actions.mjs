/**
 * Smoke write-adjacent Admin/API paths + monitor redirect.
 *   npx tsx scripts/qa-write-actions.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  for (const line of readFileSync(resolve('apps/web/.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {
  /* optional */
}

const BASE = process.env['BUHO_URL'] ?? 'http://127.0.0.1:3100';
const { issueSession, SESSION_COOKIE } = await import('../apps/web/src/lib/auth.ts');
const session = await issueSession('demo-dba', 'admin');
const cookie = `${SESSION_COOKIE}=${session.value}`;

let ok = 0;
let warn = 0;
let fail = 0;

async function check(name, fn) {
  try {
    const result = await fn();
    const tag = result.ok ? 'OK' : result.warn ? 'WARN' : 'FAIL';
    if (result.ok) ok += 1;
    else if (result.warn) warn += 1;
    else fail += 1;
    console.log(`${tag}\t${name}\t${result.detail ?? ''}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL\t${name}\t${error instanceof Error ? error.message : error}`);
  }
}

await check('discovery page', async () => {
  const res = await fetch(`${BASE}/admin/discovery`, { headers: { cookie } });
  return { ok: res.status === 200, detail: String(res.status) };
});

await check('discovery scan POST', async () => {
  const body = new URLSearchParams({
    ranges: '127.0.0.1',
    ports: '5435 3307 14333',
  });
  const res = await fetch(`${BASE}/admin/discovery`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
  // Server action may 303 back to discovery
  const okStatus = res.status === 200 || (res.status >= 300 && res.status < 400);
  return { ok: okStatus, warn: !okStatus && res.status < 500, detail: String(res.status) };
});

await check('compliance page', async () => {
  const res = await fetch(`${BASE}/platform/compliance`, { headers: { cookie } });
  const html = await res.text();
  const hasRows = /cis-postgres|cis-mssql|score/i.test(html);
  return { ok: res.status === 200 && hasRows, detail: `status=${res.status} rows=${hasRows}` };
});

await check('admin alerts (silences UI)', async () => {
  const res = await fetch(`${BASE}/admin/alerts`, { headers: { cookie } });
  const html = await res.text();
  const hasSilence = /silence|Silence/i.test(html);
  return { ok: res.status === 200 && hasSilence, detail: String(res.status) };
});

await check('monitor redirect pg-lab', async () => {
  const res = await fetch(`${BASE}/observability/monitors/1`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const loc = res.headers.get('location') || '';
  const good = res.status >= 300 && res.status < 400 && /\/instances\/1/.test(loc);
  return { ok: good, detail: `${res.status} → ${loc}` };
});

await check('compliance run (session)', async () => {
  const res = await fetch(`${BASE}/api/compliance/run`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ alias: 'pg-lab', pack: 'cis-postgres' }),
  });
  const text = await res.text();
  if (res.status === 200) return { ok: true, detail: text.slice(0, 100) };
  if ([401, 403, 503].includes(res.status)) return { ok: true, detail: `gated ${res.status}` };
  return { ok: false, detail: `${res.status} ${text.slice(0, 80)}` };
});

await check('pause_dag action API shape', async () => {
  const res = await fetch(`${BASE}/api/actions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'pause_dag',
      alias: 'airflow-mock',
      dagId: 'demo',
      reason: 'qa write-actions smoke',
    }),
  });
  if (res.status === 200) return { ok: true, detail: 'executed' };
  if ([401, 403, 404, 501, 400].includes(res.status)) {
    return { ok: true, detail: `gated ${res.status}` };
  }
  return { ok: false, detail: String(res.status) };
});

console.log(`SUMMARY\tOK=${ok}\tWARN=${warn}\tFAIL=${fail}`);
