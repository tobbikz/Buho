import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
try {
  for (const line of readFileSync(resolve('apps/web/.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
const { issueSession, SESSION_COOKIE } = await import('../apps/web/src/lib/auth.ts');
const admin = await issueSession('demo-dba', 'admin');
const ca = `${SESSION_COOKIE}=${admin.value}`;
const h = await (await fetch('http://127.0.0.1:3100/instances/166/backups', { headers: { cookie: ca } })).text();
console.log('oracle Archivelog', /\bArchivelog\b/.test(h), 'WAL archive', /\bWAL archive\b/.test(h));
const viewer = await issueSession('demo-dba-ro', 'viewer');
const cv = `${SESSION_COOKIE}=${viewer.value}`;
const fleet = await (await fetch('http://127.0.0.1:3100/', { headers: { cookie: cv } })).text();
console.log('viewer Add database', /Add database/.test(fleet));
const flow = await (await fetch('http://127.0.0.1:3100/flow', { headers: { cookie: ca } })).text();
console.log('flow weight=', /[?&]weight=/.test(flow) || /weight=/.test(flow), 'peso=', /\bpeso=/.test(flow));
