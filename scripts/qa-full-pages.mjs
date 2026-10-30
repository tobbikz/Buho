/**
 * Full console QA (no Playwright): login + crawl every tab + metric smoke.
 *
 *   node scripts/qa-full-pages.mjs
 *   BUHO_URL / BUHO_USER / BUHO_STORE optional.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

// Load console auth env so we can mint a session cookie without Playwright.
try {
  const envPath = resolve('apps/web/.env.local');
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {
  /* optional */
}

const BASE = process.env['BUHO_URL'] ?? 'http://127.0.0.1:3100';
const [user] = (process.env['BUHO_USER'] ?? 'demo-dba:demo-buho-pass').split(':');
const STORE = process.env['BUHO_STORE'] ?? 'postgres://buho:buho@127.0.0.1:55432/buho';

const GLOBAL_ROUTES = [
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
  '/cluster',
  '/cluster/ha',
  '/cluster/growth',
  '/platform/kafka',
  '/platform/cdc',
  '/platform/airflow',
  '/platform/compliance',
  '/observability',
  '/security',
  '/get-started',
];

const TABS = {
  postgres: [
    '',
    '/analysis',
    '/queries',
    '/indexes',
    '/extensions',
    '/flow',
    '/topology',
    '/sessions',
    '/capacity',
    '/host',
    '/backups',
    '/vacuum',
    '/replication',
    '/locks',
    '/logs',
  ],
  mariadb: [
    '',
    '/analysis',
    '/queries',
    '/slow-queries',
    '/indexes',
    '/flow',
    '/topology',
    '/sessions',
    '/capacity',
    '/host',
    '/backups',
    '/replication',
    '/locks',
    '/logs',
    '/inventory',
  ],
  mssql: [
    '',
    '/analysis',
    '/queries',
    '/procedures',
    '/flow',
    '/topology',
    '/sessions',
    '/capacity',
    '/host',
    '/backups',
    '/replication',
    '/locks',
    '/logs',
    '/inventory',
  ],
  oracle: [
    '',
    '/analysis',
    '/queries',
    '/slow-queries',
    '/flow',
    '/topology',
    '/sessions',
    '/capacity',
    '/host',
    '/backups',
    '/replication',
    '/locks',
    '/logs',
    '/inventory',
  ],
  redis: [
    '',
    '/analysis',
    '/queries',
    '/slow-queries',
    '/sessions',
    '/capacity',
    '/host',
    '/backups',
    '/replication',
    '/locks',
    '/inventory',
  ],
  mongodb: [
    '',
    '/analysis',
    '/sessions',
    '/capacity',
    '/host',
    '/backups',
    '/replication',
    '/locks',
    '/inventory',
  ],
  cassandra: [
    '',
    '/analysis',
    '/sessions',
    '/capacity',
    '/host',
    '/backups',
    '/replication',
    '/locks',
    '/inventory',
  ],
  elasticsearch: [
    '',
    '/analysis',
    '/sessions',
    '/capacity',
    '/host',
    '/backups',
    '/replication',
    '/locks',
    '/inventory',
  ],
  kafka: ['', '/analysis', '/sessions', '/capacity', '/host', '/backups', '/replication', '/locks', '/inventory'],
  airflow: ['', '/analysis', '/sessions', '/capacity', '/host', '/backups', '/replication', '/locks', '/inventory'],
  cdc: ['', '/analysis', '/sessions', '/capacity', '/host', '/backups', '/replication', '/locks', '/inventory'],
};

const ES_RE =
  /\b(está apagado|consultas lentas|sólo existe|no se pudo leer|deadlock detectado|hacer falte|volver a|quitar filtro|Tiempo total|Actividad por)\b/i;
const FATAL_RE = /Something went wrong|Failed to load chunk|Application error|Internal Server Error/i;

const jar = new Map();

function storeCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const single = res.headers.get('set-cookie');
  const list = raw.length ? raw : single ? [single] : [];
  for (const line of list) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchPage(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      ...(init.headers ?? {}),
      cookie: cookieHeader(),
      ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
  });
  storeCookies(res);
  // Follow one redirect manually to keep cookies
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    if (loc) {
      const next = loc.startsWith('http') ? loc : new URL(loc, BASE).pathname + new URL(loc, BASE).search;
      return fetchPage(next.startsWith('http') ? new URL(next).pathname + new URL(next).search : next);
    }
  }
  const html = await res.text();
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const title = (html.match(/<title>([^<]*)/) || [])[1] ?? '';
  return {
    status: res.status,
    html,
    text,
    title,
    fatal: FATAL_RE.test(html) || FATAL_RE.test(text),
    spanish: ES_RE.test(text),
    // Only treat as auth wall when the Sign-in page itself is served.
    login: /Sign in · Búho/i.test(title) || /\/login\?error=/i.test(html),
  };
}

async function login() {
  const { issueSession, SESSION_COOKIE } = await import('../apps/web/src/lib/auth.ts');
  const session = await issueSession(user || 'demo-dba', 'admin');
  jar.set(SESSION_COOKIE, session.value);
}

const fail = [];
const warn = [];
const pass = [];

function note(bucket, path, detail) {
  bucket.push({ path, detail });
  const tag = bucket === fail ? 'FAIL' : bucket === warn ? 'WARN' : 'OK';
  console.log(`${tag}\t${path}\t${detail}`);
}

async function loadStore() {
  const client = new pg.Client({ connectionString: STORE });
  await client.connect();
  const { rows } = await client.query(`
    select i.instance_id, i.alias, i.engine,
           (select count(*)::int from buho.metric_samples m
             where m.instance_id = i.instance_id
               and m.ts > now() - interval '15 minutes') as metrics_15m,
           (select count(distinct metric)::int from buho.metric_samples m
             where m.instance_id = i.instance_id
               and m.ts > now() - interval '15 minutes') as distinct_metrics
      from buho.instances i
     where coalesce(i.retired, false) = false
     order by i.engine, i.alias`);
  await client.end();
  return rows;
}

await login();
const home = await fetchPage('/');
if (home.login || home.status === 401) {
  console.error('LOGIN FAILED — check BUHO_USER');
  process.exit(2);
}
note(pass, '/login', `session ok as ${user}`);

console.log(`\n=== Global (${GLOBAL_ROUTES.length}) ===`);
for (const route of GLOBAL_ROUTES) {
  const r = await fetchPage(route);
  if (r.status >= 500 || r.fatal) note(fail, route, `status=${r.status} fatal=${r.fatal}`);
  else if (r.status === 404) note(warn, route, `404 ${r.title}`);
  else if (r.spanish) note(warn, route, `ES residual`);
  else if (r.login) note(fail, route, `redirected to login`);
  else note(pass, route, `${r.status}`);
}

const instances = await loadStore();
console.log(`\n=== Instances (${instances.length}) ===`);
for (const inst of instances) {
  const tabs = TABS[inst.engine] ?? TABS.mongodb;
  console.log(
    `\n--- ${inst.alias} (${inst.engine} #${inst.instance_id}) metrics_15m=${inst.metrics_15m} distinct=${inst.distinct_metrics} ---`,
  );
  if (Number(inst.metrics_15m) === 0) {
    note(warn, `/instances/${inst.instance_id}#metrics`, 'no samples in 15m');
  } else if (Number(inst.distinct_metrics) < 3) {
    note(warn, `/instances/${inst.instance_id}#metrics`, `only ${inst.distinct_metrics} distinct metrics`);
  } else {
    note(pass, `/instances/${inst.instance_id}#metrics`, `${inst.metrics_15m} / ${inst.distinct_metrics} metrics`);
  }

  for (const tab of tabs) {
    const path = `/instances/${inst.instance_id}${tab}`;
    const r = await fetchPage(path);
    if (r.status >= 500 || r.fatal) note(fail, path, `status=${r.status} fatal=${r.fatal}`);
    else if (r.status === 404) note(fail, path, '404');
    else if (r.login) note(fail, path, 'login wall');
    else if (r.spanish) note(warn, path, 'ES residual');
    else note(pass, path, `${r.status}`);
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`OK=${pass.length} WARN=${warn.length} FAIL=${fail.length}`);
if (fail.length) {
  console.log('FAILS:');
  for (const row of fail) console.log(`  ${row.path} — ${row.detail}`);
}
process.exit(fail.length ? 1 : 0);
