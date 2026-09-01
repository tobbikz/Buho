import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { query } from './db';

/**
 * Usuarios de la consola. **Sólo corre en el runtime de Node**, never en el
 * middleware: usa node:crypto y consulta el store.
 *
 * La división con `auth.ts` es deliberada. Verificar una sesión en cada request
 * tiene que ser barato y sin base de datos, así que la cookie se valida con HMAC
 * y lleva el rol dentro. Este módulo se toca sólo al iniciar sesión y al
 * administrar cuentas.
 */

export type Role = 'admin' | 'viewer';

export interface User {
  userId: number;
  username: string;
  role: Role;
  disabled: boolean;
  createdAt: Date;
  createdBy: string | null;
  lastLoginAt: Date | null;
}

/**
 * scrypt con los parámetros recomendados por el propio Node (N=16384, r=8, p=1).
 *
 * No se usa bcrypt ni argon2 porque son dependencias nativas: en un despliegue
 * on-prem, cada módulo que hay que compilar es una instalación que falla en la
 * máquina del cliente. scrypt viene en la biblioteca estándar y es resistente a
 * hardware dedicado, que es exactamente lo que se necesita acá.
 */
const SCRYPT = { N: 16_384, r: 8, p: 1, keyLength: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT.keyLength, SCRYPT);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, expectedHex] = stored.split(':');
  if (!saltHex || !expectedHex) return false;

  const expected = Buffer.from(expectedHex, 'hex');
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  // timingSafeEqual exige longitudes iguales, y las tiene por construcción.
  return timingSafeEqual(derived, expected);
}

function toUser(row: Record<string, unknown>): User {
  return {
    userId: Number(row['user_id']),
    username: String(row['username']),
    role: String(row['role']) as Role,
    disabled: row['disabled'] === true,
    createdAt: new Date(row['created_at'] as string),
    createdBy: row['created_by'] ? String(row['created_by']) : null,
    lastLoginAt: row['last_login_at'] ? new Date(row['last_login_at'] as string) : null,
  };
}

export async function listUsers(): Promise<User[]> {
  const rows = await query(
    `select user_id, username, role, disabled, created_at, created_by, last_login_at
       from buho.users order by role, username`,
  );
  return rows.map(toUser);
}

/**
 * Cuántas cuentas hay. Si es cero, la consola sigue en modo contraseña única:
 * ver `authenticate`.
 */
export async function userCount(): Promise<number> {
  const rows = await query('select count(*)::int as total from buho.users');
  return Number(rows[0]?.['total'] ?? 0);
}

export async function findUser(username: string): Promise<(User & { passwordHash: string }) | null> {
  const rows = await query(
    `select user_id, username, role, disabled, created_at, created_by, last_login_at, password_hash
       from buho.users where lower(username) = lower($1)`,
    [username],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...toUser(row), passwordHash: String(row['password_hash']) };
}

export async function createUser(
  username: string,
  password: string,
  role: Role,
  createdBy: string,
): Promise<void> {
  await query(
    `insert into buho.users (username, password_hash, role, created_by)
          values ($1, $2, $3, $4)`,
    [username.trim(), hashPassword(password), role, createdBy],
  );
}

export async function setPassword(userId: number, password: string): Promise<void> {
  await query('update buho.users set password_hash = $2 where user_id = $1', [
    userId,
    hashPassword(password),
  ]);
}

export async function setRole(userId: number, role: Role): Promise<void> {
  await query('update buho.users set role = $2 where user_id = $1', [userId, role]);
}

export async function setDisabled(userId: number, disabled: boolean): Promise<void> {
  await query('update buho.users set disabled = $2 where user_id = $1', [userId, disabled]);
}

export async function deleteUser(userId: number): Promise<void> {
  await query('delete from buho.users where user_id = $1', [userId]);
}

/** Cuántos administradores activos quedan; nadie puede dejar la consola sin uno. */
export async function activeAdmins(): Promise<number> {
  const rows = await query(
    "select count(*)::int as total from buho.users where role = 'admin' and not disabled",
  );
  return Number(rows[0]?.['total'] ?? 0);
}

export async function recordLogin(userId: number): Promise<void> {
  await query('update buho.users set last_login_at = now() where user_id = $1', [userId]);
}

export async function logConsoleEvent(
  username: string,
  action: string,
  detail = '',
): Promise<void> {
  await query('insert into buho.console_events (username, action, detail) values ($1, $2, $3)', [
    username,
    action,
    detail,
  ]);
}

export interface ConsoleEvent {
  at: Date;
  username: string;
  action: string;
  detail: string;
}

export async function listConsoleEvents(limit = 50): Promise<ConsoleEvent[]> {
  const rows = await query(
    'select at, username, action, detail from buho.console_events order by at desc limit $1',
    [limit],
  );
  return rows.map((row) => ({
    at: new Date(row['at'] as string),
    username: String(row['username']),
    action: String(row['action']),
    detail: String(row['detail'] ?? ''),
  }));
}
