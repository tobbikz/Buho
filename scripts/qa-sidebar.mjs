/**
 * SUPER DEEP smoke of global navbar + admin + observability entry points.
 *   npx tsx scripts/qa-sidebar.mjs
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
  '/observability',
  '/observability/hosts',
  '/observability/services',
  '/observability/apm',
  '/observability/logs',
  '/security',
  '/get-started',
  '/admin/targets',
  '/admin/instances',
  '/admin/users',
  '/admin/alerts',
  '/admin/discovery',
  '/admin/retention',
  '/admin/audit',
];

const ES =
  /\b(está apagado|consultas lentas|sólo existe|Tareas programadas|ver todas|Instancia #|does not expose per-table row counters like)\b/i;
const FATAL = /Something went wrong|Failed to load chunk|Internal Server Error/i;
const WRONG = /\bFor SQL Server, grant access to msdb\b/i;

let fail = 0;
let warn = 0;
let ok = 0;

for (const route of ROUTES) {
  const res = await fetch(`${BASE}${route}`, { headers: { cookie } });
  const html = await res.text();
  const title = (html.match(/<title>([^<]*)/) || [])[1] || '';
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  if (res.status >= 500 || FATAL.test(html) || res.status === 404) {
    console.log(`FAIL\t${route}\t${res.status}\t${title}`);
    fail += 1;
  } else if (ES.test(text) || WRONG.test(text)) {
    console.log(`WARN\t${route}\tcopy`);
    warn += 1;
  } else if (/Sign in · Búho/i.test(title)) {
    console.log(`FAIL\t${route}\tlogin wall`);
    fail += 1;
  } else {
    console.log(`OK\t${route}\t${res.status}`);
    ok += 1;
  }
}

console.log(`SUMMARY\tOK=${ok}\tWARN=${warn}\tFAIL=${fail}`);
process.exit(fail ? 1 : 0);
