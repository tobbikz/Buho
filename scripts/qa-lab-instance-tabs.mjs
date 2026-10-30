/**
 * Deep re-QA for lab SQL engines (instance tabs only).
 *   node scripts/qa-lab-instance-tabs.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

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

const TARGETS = ['maria-lab', 'mssql-lab', 'oracle-lab', 'pg-lab'];

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
};

const ES_RE =
  /\b(está apagado|consultas lentas|sólo existe|no se pudo leer|deadlock detectado|hacer falte|volver a|quitar filtro|Tiempo total|Actividad por|sesiones bloqueadas|bytes de WAL)\b/i;
const FATAL_RE = /Something went wrong|Failed to load chunk|Application error|Internal Server Error/i;
/** WAL on non-PG instance pages (replication page may legitimately mention WAL on PG only). */
const WAL_LEAK_RE =
  /\b(WAL \/ s|WAL generated|WAL buffers|WAL records|WAL not applied|WAL retained|replaying WAL|pg_wal|archive_mode)\b/i;

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
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    if (loc) {
      const u = loc.startsWith('http') ? new URL(loc) : new URL(loc, BASE);
      return fetchPage(u.pathname + u.search);
    }
  }
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const title = (html.match(/<title>([^<]*)/) || [])[1] ?? '';
  const hasEmpty = /class="empty"|empty-state|No .* yet/i.test(html);
  const hasChart = /recharts|chart-card|metric-card|sparkline|MiniChart|OpsPulse/i.test(html);
  const hasTableData = /<tbody>[\s\S]*?<tr/i.test(html) && !/No .* yet/i.test(html.slice(html.indexOf('<tbody'), html.indexOf('<tbody') + 800));
  return {
    status: res.status,
    html,
    text,
    title,
    fatal: FATAL_RE.test(html) || FATAL_RE.test(text),
    spanish: ES_RE.test(text),
    login: /Sign in · Búho/i.test(title) || /\/login\?error=/i.test(html),
    hasEmpty,
    hasChart,
    hasTableData,
    walLeak: WAL_LEAK_RE.test(text),
  };
}

async function login() {
  const { issueSession, SESSION_COOKIE } = await import('../apps/web/src/lib/auth.ts');
  const session = await issueSession(user || 'demo-dba', 'admin');
  jar.set(SESSION_COOKIE, session.value);
}

function tabLabel(suffix) {
  if (!suffix) return 'Overview';
  return suffix.slice(1).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function gradeTab(r, engine, suffix) {
  const issues = [];
  if (r.status >= 500 || r.fatal) issues.push(`crash/status=${r.status}`);
  if (r.status === 404) issues.push('404');
  if (r.login) issues.push('login wall');
  if (r.spanish) issues.push('Spanish UI');
  if (engine !== 'postgres' && r.walLeak) {
    const allowOnReplication = suffix === '/replication' && engine === 'postgres';
    if (!allowOnReplication) issues.push('WAL wording');
  }
  if (issues.length) return { status: issues.some((i) => i.includes('crash') || i.includes('404') || i.includes('login')) ? 'FAIL' : 'WARN', issues };
  if (r.hasEmpty && !r.hasChart && !r.hasTableData) return { status: 'WARN', issues: ['empty-only'] };
  return { status: 'PASS', issues: [] };
}

const SCORE_EXPECT = {
  'maria-lab': { min: 80, max: 92 },
  'mssql-lab': { min: 95, max: 100 },
  'oracle-lab': { min: 95, max: 100 },
  'pg-lab': { min: 0, max: 100 },
};

async function loadInstances(client) {
  const { rows } = await client.query(
    `select i.instance_id, i.alias, i.engine, i.port,
            (select score from buho.health_scores h
              where h.instance_id = i.instance_id order by h.ts desc limit 1) as score,
            (select count(*)::int from buho.metric_samples m
              where m.instance_id = i.instance_id and m.ts > now() - interval '15 minutes') as metrics_15m,
            (select count(*)::int from buho.statement_stats s
              where s.instance_id = i.instance_id and s.ts > now() - interval '24 hours') as stmt_24h,
            (select count(*)::int from buho.backup_state b
              where b.instance_id = i.instance_id) as backup_rows
       from buho.instances i
      where i.alias = any($1::text[])
        and coalesce(i.retired, false) = false
      order by i.alias`,
    [TARGETS],
  );
  return rows;
}

async function loadChecks(client, instanceId) {
  const { rows } = await client.query(
    `select check_id, severity, message
       from buho.check_results
      where instance_id = $1
        and ts = (select max(ts) from buho.check_results where instance_id = $1)
      order by severity, check_id
      limit 20`,
    [instanceId],
  );
  return rows;
}

async function loadBackups(client, instanceId) {
  const { rows } = await client.query(
    `select database, kind, source, finished_at, size_bytes
       from buho.backup_state
      where instance_id = $1
      order by database, kind`,
    [instanceId],
  );
  return rows;
}

await login();
const home = await fetchPage('/');
if (home.login) {
  console.error('LOGIN FAILED');
  process.exit(2);
}

const client = new pg.Client({ connectionString: STORE });
await client.connect();
const instances = await loadInstances(client);

const report = [];

for (const inst of instances) {
  const tabs = TABS[inst.engine] ?? [];
  const tabRows = [];
  for (const suffix of tabs) {
    const path = `/instances/${inst.instance_id}${suffix}`;
    const r = await fetchPage(path);
    const g = gradeTab(r, inst.engine, suffix);
    tabRows.push({
      tab: tabLabel(suffix),
      path,
      http: r.status,
      grade: g.status,
      notes: g.issues.join('; ') || (r.hasEmpty ? 'has empty panel' : 'ok'),
    });
  }

  const checks = await loadChecks(client, inst.instance_id);
  const backups = await loadBackups(client, inst.instance_id);
  const exp = SCORE_EXPECT[inst.alias];
  const score = inst.score != null ? Number(inst.score) : null;
  let engineGrade = 'PASS';
  const engineIssues = [];

  if (score == null) {
    engineIssues.push('no health score in store');
    engineGrade = 'WARN';
  } else if (exp && (score < exp.min || score > exp.max)) {
    engineIssues.push(`score ${score} outside ${exp.min}-${exp.max}`);
    engineGrade = 'WARN';
  }

  if (Number(inst.metrics_15m) === 0) {
    engineIssues.push('no metrics in 15m');
    engineGrade = engineGrade === 'PASS' ? 'WARN' : engineGrade;
  }

  if (inst.alias === 'maria-lab') {
    const buhoUser = checks.some((c) => /buho/i.test(c.message ?? ''));
    if (checks.some((c) => /query store|QDS/i.test(c.message ?? ''))) {
      engineIssues.push('unexpected QDS finding on Maria');
    }
  }

  if (inst.alias === 'mssql-lab') {
    const qTab = tabRows.find((t) => t.tab === 'Queries');
    if (qTab?.grade === 'FAIL') engineGrade = 'FAIL';
    if (Number(inst.stmt_24h) === 0) {
      engineIssues.push('no statement_stats 24h (QDS/dm_exec?)');
      engineGrade = engineGrade === 'PASS' ? 'WARN' : engineGrade;
    }
    const kinds = new Set(backups.map((b) => String(b.kind).toLowerCase()));
    if (!kinds.has('full') || !kinds.has('differential')) {
      engineIssues.push(`backups missing full/differential (have: ${[...kinds].join(',') || 'none'})`);
      engineGrade = engineGrade === 'PASS' ? 'WARN' : engineGrade;
    }
    const buhoLab = backups.filter((b) => /buho_lab/i.test(b.database ?? ''));
    if (buhoLab.length === 0) engineIssues.push('no backup rows for buho_lab');
  }

  if (inst.alias === 'oracle-lab') {
    const arch = checks.find((c) => /archivelog|archive log/i.test(c.message ?? ''));
    if (arch && /off|disabled/i.test(arch.message ?? '')) {
      engineIssues.push('ARCHIVELOG off in checks');
      engineGrade = 'FAIL';
    }
  }

  if (inst.alias === 'pg-lab') {
    const arch = checks.find((c) => /archive_mode/i.test(c.message ?? ''));
    if (arch && /off|false|disabled/i.test(arch.message ?? '')) {
      engineIssues.push('archive_mode off in checks');
      engineGrade = 'FAIL';
    }
  }

  const failTabs = tabRows.filter((t) => t.grade === 'FAIL').length;
  const warnTabs = tabRows.filter((t) => t.grade === 'WARN').length;
  if (failTabs) engineGrade = 'FAIL';
  else if (warnTabs >= 3 && engineGrade === 'PASS') engineGrade = 'WARN';

  report.push({
    alias: inst.alias,
    engine: inst.engine,
    port: inst.port,
    instanceId: inst.instance_id,
    score,
    metrics_15m: inst.metrics_15m,
    stmt_24h: inst.stmt_24h,
    backup_rows: inst.backup_rows,
    engineGrade,
    engineIssues,
    tabRows,
    backups: backups.slice(0, 8),
    topChecks: checks.slice(0, 5),
  });
}

await client.end();

console.log(JSON.stringify(report, null, 2));
