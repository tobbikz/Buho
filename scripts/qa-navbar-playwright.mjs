/**
 * Playwright deep navbar QA (hydrated DOM).
 *   npx tsx scripts/qa-navbar-playwright.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
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
const USER = process.env['BUHO_USER']?.split(':')[0] ?? 'demo-dba';
const PASS = process.env['BUHO_USER']?.split(':')[1] ?? 'demo-buho-pass';
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
  /\b(está apagado|consultas lentas|sólo existe|no se pudo|deadlock detectado|hacer falte|volver a|quitar filtro|Tiempo total|Actividad por|Tareas programadas|ver todas las|Instancia #|Sin conexión|No hay datos|Entrar|Contraseña|Usuario)\b/i;
const FATAL_RE = /Something went wrong|Failed to load chunk|Application error|Internal Server Error/i;
const WRONG_RE =
  /\b(For SQL Server, grant access to msdb|does not expose per-table row counters like|MariaDB-specific tuning|PostgreSQL-only extension)\b/i;
const NONSENSE_RE = /\b(NaN%|Infinity%|\bundefined\b|\[object Object\]|null ms)\b/;

const EXPECTED_TITLE = {
  '/': /Fleet · Búho/,
  '/checks': /Checks · Búho/,
  '/alerts': /Alerts · Búho/,
  '/events': /Events · Búho/,
  '/flow': /Estate flow · Búho/,
  '/report': /Weekly report · Búho/,
  '/estate': /Backups · Estate · Búho/,
  '/estate/disk': /Disk · Estate · Búho/,
  '/estate/replication': /HA \/ Replication · Estate · Búho/,
  '/estate/rpo': /RPO · Estate · Búho/,
  '/estate/versions': /Versions · Estate · Búho/,
  '/estate/jobs': /Jobs · Estate · Búho/,
  '/estate/configuration': /Configuration · Estate · Búho/,
  '/estate/licensing': /Licensing · Estate · Búho/,
  '/platform/kafka': /Kafka · Búho/,
  '/platform/cdc': /CDC · Búho/,
  '/platform/airflow': /Airflow · Búho/,
  '/platform/compliance': /Compliance · Búho/,
  '/cluster': /Cluster · Búho/,
  '/cluster/ha': /Cluster · Búho/,
  '/cluster/growth': /Cluster · Búho/,
};

async function storeSnapshot() {
  const client = new pg.Client({ connectionString: STORE });
  await client.connect();
  const tables = await client.query(
    `select tablename from pg_tables where schemaname='buho' order by 1`,
  );
  const names = tables.rows.map((r) => r.tablename);
  const counts = {};
  for (const t of ['instances', 'check_results', 'events', 'metric_samples', 'alerts']) {
    if (names.includes(t)) {
      const { rows } = await client.query(`select count(*)::int as n from buho.${t}`);
      counts[t] = rows[0].n;
    }
  }
  const inst = await client.query(
    `select count(*)::int as n from buho.instances where coalesce(retired,false)=false`,
  );
  counts.active_instances = inst.rows[0].n;
  await client.end();
  return counts;
}

const browser = await chromium.launch(
  process.env['PW_CHROME'] ? { executablePath: process.env['PW_CHROME'] } : {},
);
const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
const page = await context.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e)));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[name="username"]', USER);
await page.fill('input[name="password"]', PASS);
await Promise.all([
  page.waitForURL((u) => new URL(u).pathname !== '/login', { timeout: 20000 }),
  page.click('button[type="submit"]'),
]);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(800);

let storeCounts = {};
try {
  storeCounts = await storeSnapshot();
} catch (e) {
  storeCounts = { error: String(e.message || e) };
}

const results = [];

for (const route of ROUTES) {
  jsErrors.length = 0;
  const resp = await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(1200);
  const http = resp?.status() ?? 0;
  const title = await page.title();
  const mainText = await page.locator('main, [role="main"], .page').first().textContent().catch(async () =>
    page.locator('body').textContent(),
  );
  const text = (mainText ?? '').replace(/\s+/g, ' ').trim();
  const h1 = await page.locator('h1').first().textContent().catch(() => '');
  const tableRows = await page.locator('table tbody tr').count();
  const cards = await page.locator('[class*="card"], .stat, [class*="Stat"]').count();
  const charts = await page.locator('svg.recharts-surface, canvas, .recharts-wrapper').count();
  const emptyVisible = await page
    .locator(':text-matches("No (checks|alerts|events|data|instances|jobs|targets|replication)", "i")')
    .count();

  const issues = [];
  let grade = 'PASS';

  if (http >= 500 || FATAL_RE.test(text)) {
    grade = 'FAIL';
    issues.push(`HTTP ${http} or fatal UI`);
  } else if (http === 404) {
    grade = 'FAIL';
    issues.push('404');
  } else if (/Sign in · Búho/i.test(title)) {
    grade = 'FAIL';
    issues.push('login wall');
  } else {
    const navOnly = text.slice(0, 500);
    const bodyForEs = text.replace(navOnly, '');
    if (ES_RE.test(bodyForEs)) issues.push('Spanish UI leak (main content)');
    if (WRONG_RE.test(text)) issues.push('wrong engine copy');
    if (NONSENSE_RE.test(text)) issues.push('nonsense metric/display');
    if (EXPECTED_TITLE[route] && !EXPECTED_TITLE[route].test(title)) {
      issues.push(`title mismatch: "${title}"`);
    }
    if (jsErrors.length) issues.push(`JS errors: ${jsErrors.slice(0, 2).join(' | ')}`);
    if (issues.length) grade = grade === 'FAIL' ? 'FAIL' : 'WARN';
  }

  let data = 'empty';
  if (tableRows >= 3 || charts >= 2) data = `real (rows=${tableRows}, charts=${charts})`;
  else if (tableRows >= 1 || charts >= 1 || cards >= 4) data = `partial (rows=${tableRows}, charts=${charts}, cards=${cards})`;
  else if (text.length > 600) data = `copy-only (${text.length} chars)`;
  else data = `sparse (${text.length} chars)`;

  if (emptyVisible > 0 && tableRows === 0 && charts === 0) {
    issues.push('empty-state visible, no tables/charts');
    if (grade === 'PASS') grade = 'WARN';
  }

  if (route === '/' && storeCounts.active_instances > 0) {
    const fleetRows = await page.locator('table tbody tr, [data-testid="fleet-row"], .fleet-table tbody tr').count();
    if (fleetRows === 0 && !/instances/i.test(text)) {
      issues.push(`store has ${storeCounts.active_instances} instances but fleet table empty`);
      grade = 'WARN';
    }
  }

  results.push({
    page: route,
    grade,
    http,
    title,
    h1: (h1 ?? '').trim().slice(0, 80),
    data,
    issues: issues.length ? issues.join('; ') : '—',
  });
}

await browser.close();

const fail = results.filter((r) => r.grade === 'FAIL').length;
const warn = results.filter((r) => r.grade === 'WARN').length;
const pass = results.filter((r) => r.grade === 'PASS').length;

console.log('STORE', JSON.stringify(storeCounts));
console.log('\n| Page | Status | Data | Issues |');
console.log('|------|--------|------|--------|');
for (const r of results) {
  console.log(`| ${r.page} | ${r.grade} (${r.http}, ${r.title}) | ${r.data} | ${r.issues} |`);
}
console.log(`\nFAIL=${fail} WARN=${warn} PASS=${pass}`);
console.log('---JSON---');
console.log(JSON.stringify({ results, storeCounts, fail, warn, pass }));
