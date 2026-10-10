/**
 * Seed demo console users for multi-role demos (DBA / SRE / Sec).
 * Roles remain admin|viewer — org is a username/tag convention for demos.
 *
 *   npx tsx scripts/seed-demo-users.ts
 *
 * Default password: demo-buho-pass (override with BUHO_DEMO_PASSWORD).
 */
import { query } from '../apps/web/src/lib/db.ts';
import { hashPassword } from '../apps/web/src/lib/users.ts';

const password = process.env.BUHO_DEMO_PASSWORD?.trim() || 'demo-buho-pass';
const hash = hashPassword(password);

const users: Array<{ username: string; role: 'admin' | 'viewer'; org: string }> = [
  { username: 'demo-dba', role: 'admin', org: 'dba' },
  { username: 'demo-dba-ro', role: 'viewer', org: 'dba' },
  { username: 'demo-sre', role: 'admin', org: 'sre' },
  { username: 'demo-sre-ro', role: 'viewer', org: 'sre' },
  { username: 'demo-sec', role: 'admin', org: 'sec' },
  { username: 'demo-sec-ro', role: 'viewer', org: 'sec' },
];

for (const u of users) {
  const existing = await query<{ username: string }>(
    'select username from buho.users where username = $1',
    [u.username],
  );
  if (existing[0]) {
    await query(
      `update buho.users
          set password_hash = $1, disabled = false, role = $2
        where username = $3`,
      [hash, u.role, u.username],
    );
  } else {
    await query(
      `insert into buho.users (username, password_hash, role, disabled)
            values ($1, $2, $3, false)`,
      [u.username, hash, u.role],
    );
  }
  console.log('ready', u.username, u.role, `org=${u.org}`);
}

console.log('\nLogin with password:', password);
console.log('Org tags are naming convention only — ACL is still admin|viewer for all instances.');
console.log('Real multi-tenant instance ACL is a later product change.');
