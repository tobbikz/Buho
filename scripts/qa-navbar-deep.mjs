/**
 * Deep navbar QA — session mint + HTML heuristics + store cross-check.
 *   npx tsx scripts/qa-navbar-deep.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

try {
  for (const line of readFileSync(resolve('apps/web/.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {
  /* optional */
}

const BASE = process.env['BUHO_URL'] ?? 'http://127.0.0.1:3100';
const STORE = process.env['BUHO_STORE'] ?? 'postgres://buho:buho@127.0.0.1:55432/buho';

const ROUTES = [
  '/',
  '/checks',
  '/alerts',
  '/events',
  '/flow',
  '/report',
  '/estate',
  '/estate/disk',
  '/estate/replication',
  '/estate/rpo',
  '/estate/versions',
  '/estate/jobs',
  '/estate/configuration',
  '/estate/licensing',
  '/platform/kafka',
  '/platform/cdc',
  '/platform/airflow',
  '/platform/compliance',
  '/cluster',
  '/cluster/ha',
  '/cluster/growth',
];

const ES_RE =
  /\b(está apagado|están|consultas lentas|sólo existe|no se pudo|deadlock detectado|hacer falte|volver a|quitar filtro|Tiempo total|Actividad por|Tareas programadas|ver todas las|Instancia #|Configuración de|licencias activas|Replicación en|Sin conexión|No hay datos)\b/i;
const FATAL_RE = /Something went wrong|Failed to load chunk|Application error|Internal Server Error/i;
const EMPTY_RE =
  /\b(No (checks|alerts|events|data|instances|jobs|targets|replication|platform targets)|Nothing to show|No metrics yet|empty fleet|0 active alerts)\b/i;
const WRONG_RE =
  /\b(For SQL Server, grant access to msdb|does not expose per-table row counters like|MariaDB-specific tuning|PostgreSQL-only extension)\b/i;
const NONSENSE_RE = /\b(NaN%|Infinity%|\bundefined\b|\[object Object\]|—%|null ms)\b/;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadStoreCounts() {
  const client = new pg.Client({ connectionString: STORE });
  await client.connect();
  const q = await client.query(`
    select
      (select count(*)::int from buho.instances where coalesce(retired,false)=false) as instances,
      (select count(*)::int from buho.check_results where ts > now() - interval '24 hours') as checks_24h,
      (select count(*)::int from buho.alerts where last_seen_at > now() - interval '7 days') as alerts_7d,
      (select count(*)::int from buho.collector_events where ts > now() - interval '7 days') as events_7d,
      (select count(*)::int from buho.metric_samples where ts > now() - interval '15 minutes') as metrics_15m
  `);
  await client.end();
  return q.rows[0];
}

const { issueSession, SESSION_COOKIE } = await import('../apps/web/src/lib/auth.ts');
const session = await issueSession('demo-dba', 'admin');
const cookie = `${SESSION_COOKIE}=${session.value}`;

let storeCounts = null;
try {
  storeCounts = await loadStoreCounts();
} catch (e) {
  storeCounts = { error: String(e.message || e) };
}

const results = [];

for (const route of ROUTES) {
  const res = await fetch(`${BASE}${route}`, { headers: { cookie }, redirect: 'follow' });
  const html = await res.text();
  const title = (html.match(/<title>([^<]*)/) || [])[1] ?? '';
  const text = stripHtml(html);
  const issues = [];

  let grade = 'PASS';

  if (res.status >= 500 || FATAL_RE.test(html)) {
    grade = 'FAIL';
    issues.push(`HTTP ${res.status} or fatal error UI`);
  } else if (res.status === 404) {
    grade = 'FAIL';
    issues.push('404');
  } else if (/Sign in · Búho/i.test(title)) {
    grade = 'FAIL';
    issues.push('login wall');
  } else {
    if (ES_RE.test(text)) issues.push('Spanish UI leak');
    if (WRONG_RE.test(text)) issues.push('wrong engine copy');
    if (NONSENSE_RE.test(text)) issues.push('nonsense metric/display');
    if (EMPTY_RE.test(text)) issues.push('empty-state copy in SSR');
    if (!title || title.length < 5) issues.push('weak/missing title');
    if (issues.length) grade = 'WARN';
  }

  let data = 'thin SSR';
  if (text.length > 4000) data = 'rich SSR';
  else if (text.length > 1200) data = 'moderate SSR';
  else if (text.length > 400) data = 'thin SSR';
  else data = 'shell/minimal SSR';

  // Route-specific store expectations
  if (storeCounts && !storeCounts.error) {
    if (route === '/checks' && storeCounts.checks_24h > 0 && /No checks/i.test(text)) {
      issues.push('shows empty checks but store has data');
      grade = grade === 'FAIL' ? 'FAIL' : 'WARN';
    }
    if (route === '/alerts' && storeCounts.alerts_7d > 0 && /No alerts/i.test(text)) {
      issues.push('shows empty alerts but store has events');
      grade = grade === 'FAIL' ? 'FAIL' : 'WARN';
    }
    if (route === '/' && storeCounts.instances > 0 && /0 instances|empty fleet/i.test(text)) {
      issues.push('home empty despite fleet in store');
      grade = 'FAIL';
    }
  }

  results.push({
    page: route,
    grade,
    http: res.status,
    title,
    data,
    issues: issues.length ? issues.join('; ') : '—',
  });
}

const fail = results.filter((r) => r.grade === 'FAIL').length;
const warn = results.filter((r) => r.grade === 'WARN').length;
const pass = results.filter((r) => r.grade === 'PASS').length;

console.log('STORE', JSON.stringify(storeCounts));
console.log('\n| Page | Status | Data | Issues |');
console.log('|------|--------|------|--------|');
for (const r of results) {
  const status = `${r.grade} (${r.http}, ${r.title})`;
  console.log(`| ${r.page} | ${status} | ${r.data} | ${r.issues} |`);
}
console.log(`\nFAIL=${fail} WARN=${warn} PASS=${pass}`);
console.log(JSON.stringify({ results, storeCounts, fail, warn, pass }));
