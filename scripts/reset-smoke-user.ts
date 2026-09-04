import { query } from '../apps/web/src/lib/db.ts';
import { hashPassword, verifyPassword } from '../apps/web/src/lib/users.ts';

const password = 'smoke-test-pass';
const fresh = hashPassword(password);

const existing = await query<{ username: string; password_hash: string }>(
  'select username, password_hash from buho.users where username = $1',
  ['smoke'],
);

if (existing[0]) {
  await query('update buho.users set password_hash = $1, disabled = false, role = $2 where username = $3', [
    fresh,
    'admin',
    'smoke',
  ]);
} else {
  await query(
    `insert into buho.users (username, password_hash, role, disabled)
          values ($1, $2, 'admin', false)`,
    ['smoke', fresh],
  );
}

console.log('smoke ready', verifyPassword(password, fresh));
