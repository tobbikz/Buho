/**
 * QA admin vs viewer role separation.
 *   npx tsx scripts/qa-role-separation.mjs
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

async function cookie(role, user) {
  const s = await issueSession(user, role);
  return `${SESSION_COOKIE}=${s.value}`;
}

function strip(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function get(path, c) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: c }, redirect: 'follow' });
  const html = await res.text();
  return { status: res.status, finalUrl: res.url.replace(BASE, ''), html, text: strip(html) };
}

async function headRedirect(path, c) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: c }, redirect: 'manual' });
  return { status: res.status, loc: res.headers.get('location') || '' };
}

const adminC = await cookie('admin', 'demo-dba');
const viewerC = await cookie('viewer', 'demo-dba-ro');

const rows = [];

function push(route, admin, viewer, issue, verdict) {
  rows.push({ route, admin, viewer, issue, verdict });
}

function normLoc(loc) {
  return loc.replace(/^https?:\/\/[^/]+/, '');
}

const adminRoutes = [
  '/admin/targets',
  '/admin/alerts',
  '/admin/discovery',
  '/admin/users',
  '/admin/retention',
  '/admin/audit',
  '/admin/instances',
];

for (const r of adminRoutes) {
  const aH = await headRedirect(r, adminC);
  const vH = await headRedirect(r, viewerC);
  const aOk =
    aH.status === 200 || (r === '/admin/instances' && aH.status >= 300 && /targets/.test(aH.loc));
  let vOk;
  let issue;
  let verdict;
  if (r === '/admin/alerts') {
    vOk = vH.status === 200;
    issue = vOk ? 'Viewer allowed (requiresAdmin exception)' : 'Viewer blocked unexpectedly';
    verdict = vOk ? 'PASS' : 'FAIL';
  } else {
    const loc = normLoc(vH.loc);
    vOk = vH.status >= 300 && vH.status < 400 && (loc === '/' || loc.startsWith('/?denegado=admin'));
    issue = vOk ? 'Middleware redirect → /?denegado=admin' : `Unexpected: ${vH.status} ${vH.loc}`;
    verdict = vOk ? 'PASS' : 'FAIL';
  }
  const aVerdict = aOk ? 'PASS' : 'FAIL';
  push(
    r,
    aOk ? '200 (or expected redirect)' : String(aH.status),
    vOk ? (r === '/admin/alerts' ? '200 OK' : 'redirect /?denegado=admin') : `${vH.status} ${normLoc(vH.loc)}`,
    issue,
    aVerdict === 'PASS' && verdict === 'PASS' ? 'PASS' : verdict === 'FAIL' || aVerdict === 'FAIL' ? 'FAIL' : 'WARN',
  );
}

const gsA = await get('/get-started', adminC);
const gsV = await get('/get-started', viewerC);
const gsAdminOk = /Get started/i.test(gsA.html) && !/requires an administrator/i.test(gsA.text);
const gsViewerBlocked = /requires an administrator|administrator role/i.test(gsV.text);
push(
  '/get-started',
  gsAdminOk ? 'wizard loads' : 'error/missing wizard',
  gsViewerBlocked ? 'blocked (requireAdmin error)' : 'wizard visible',
  gsViewerBlocked ? 'Page-level requireAdmin' : 'Viewer can use get-started wizard',
  gsAdminOk && gsViewerBlocked ? 'PASS' : 'FAIL',
);

const fleetA = await get('/', adminC);
const fleetV = await get('/', viewerC);
const addDbA = /Add database/i.test(fleetA.html);
const addDbV = /Add database/i.test(fleetV.html);
push(
  '/ (fleet) Add database',
  addDbA ? 'button visible' : 'hidden',
  addDbV ? 'button visible' : 'hidden',
  addDbV ? 'UI leak: viewer sees link to /admin/targets' : 'No fleet add-db CTA for viewer',
  addDbV ? 'WARN' : 'PASS',
);

const instMatch = fleetA.html.match(/href="(\/instances\/[^"?]+)"/);
const instPath = instMatch?.[1] ?? null;
if (instPath) {
  const iA = await get(instPath, adminC);
  const iV = await get(instPath, viewerC);
  const editA = /Edit layout/i.test(iA.html);
  const editV = /Edit layout/i.test(iV.html);
  push(
    `${instPath} edit layout`,
    editA ? 'visible' : 'hidden',
    editV ? 'visible' : 'hidden',
    editV ? 'Viewer sees overview layout editor' : 'canEdit=false hides editor',
    editV ? 'FAIL' : 'PASS',
  );
  const killA = /\bKill\b|Cancel query/i.test(iA.html);
  const killV = /\bKill\b|Cancel query/i.test(iV.html);
  push(
    `${instPath} kill/cancel`,
    killA ? 'buttons in HTML' : 'not rendered',
    killV ? 'buttons in HTML' : 'not rendered',
    killV ? 'Kill/cancel visible to viewer (may still 403 at API)' : 'No session action buttons in HTML',
    killV ? 'WARN' : 'PASS',
  );
} else {
  push('/instances/* edit layout', '—', '—', 'No instances in fleet', 'WARN');
  push('/instances/* kill/cancel', '—', '—', 'No instances in fleet', 'WARN');
}

const alA = await get('/admin/alerts', adminC);
const alV = await get('/admin/alerts', viewerC);
const chanA = /Add channel|Routing rules|Global defaults/i.test(alA.html);
const chanV = /Add channel|Routing rules|Global defaults/i.test(alV.html);
const silA = /Temporary silence|Add silence/i.test(alA.html);
const silV = /Temporary silence|Add silence/i.test(alV.html);
const custV = /Add custom alert/i.test(alV.html);
push(
  '/admin/alerts channels',
  chanA ? 'admin forms' : 'missing',
  chanV ? 'forms visible' : 'hidden',
  chanV ? 'Channel/routing forms exposed to viewer' : 'Channels admin-only in UI',
  chanV ? 'FAIL' : 'PASS',
);
push(
  '/admin/alerts silences',
  silA ? 'silence form' : 'missing',
  silV ? 'silence form' : 'hidden',
  silV ? 'Silence form exposed to viewer' : 'Silence form admin-only',
  silV ? 'FAIL' : 'PASS',
);
push(
  '/admin/alerts custom SQL',
  /Add custom alert/i.test(alA.html) ? 'form' : 'missing',
  custV ? 'form visible' : 'hidden',
  custV ? 'Viewers may edit custom SQL (documented exception)' : 'No custom alert editor',
  custV ? 'PASS' : 'WARN',
);

console.log('Route|admin|viewer|Issue|Verdict');
for (const r of rows) {
  console.log([r.route, r.admin, r.viewer, r.issue, r.verdict].join('|'));
}

const fails = rows.filter((r) => r.verdict === 'FAIL').length;
const warns = rows.filter((r) => r.verdict === 'WARN').length;
console.log(`SUMMARY|PASS=${rows.length - fails - warns}|WARN=${warns}|FAIL=${fails}`);
