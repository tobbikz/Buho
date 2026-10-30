/**
 * Deep smoke of Admin dropdown routes.
 *   npx tsx scripts/qa-admin.mjs
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
  '/admin/targets',
  '/admin/alerts',
  '/admin/discovery',
  '/admin/users',
  '/admin/retention',
  '/admin/audit',
  '/admin/instances',
];

const ES =
  /\b(Encontradas|Rangos|Puertos|Administradores|guardado|Sin registros|monitoreada|ignorada|Bases encontradas|Ya existe|aproximadas|Escanear una red)\b/;
const FATAL = /Something went wrong|Internal Server Error/i;

let fail = 0;
let warn = 0;
let ok = 0;

for (const route of ROUTES) {
  const res = await fetch(`${BASE}${route}`, { headers: { cookie }, redirect: 'manual' });
  const loc = res.headers.get('location') || '';
  if (route === '/admin/instances' && res.status >= 300 && res.status < 400 && /\/admin\/targets/.test(loc)) {
    console.log(`OK\t${route}\tredirect→${loc}`);
    ok += 1;
    continue;
  }
  const html = await res.text();
  const title = (html.match(/<title>([^<]*)/) || [])[1] || '';
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  if (res.status >= 500 || FATAL.test(html) || res.status === 404) {
    console.log(`FAIL\t${route}\t${res.status}\t${title}`);
    fail += 1;
  } else if (ES.test(text)) {
    console.log(`WARN\t${route}\tcopy`);
    warn += 1;
  } else {
    console.log(`OK\t${route}\t${res.status}\t${title}`);
    ok += 1;
  }
}

console.log(`SUMMARY\tOK=${ok}\tWARN=${warn}\tFAIL=${fail}`);
