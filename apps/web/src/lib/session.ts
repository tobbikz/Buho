import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE, authConfigured, type Role, type Session } from './auth';

/**
 * Sesión actual para server components y server actions.
 *
 * Aparte de `auth.ts` porque usa `next/headers`, que no existe en el middleware.
 */

/** Identidad del modo sin autenticación (desarrollo). Ver `authRequired`. */
const ANONYMOUS: Session = { username: 'sin-autenticación', role: 'admin', expiresAt: 0 };

export async function currentSession(): Promise<Session> {
  if (!authConfigured()) return ANONYMOUS;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return (await readSession(token)) ?? { username: 'anónimo', role: 'viewer', expiresAt: 0 };
}

export async function currentRole(): Promise<Role> {
  return (await currentSession()).role;
}

/**
 * Puerta de toda acción que escribe.
 *
 * El middleware ya bloquea `/admin`, pero una server action se puede invocar
 * desde cualquier parte: su URL no depende de la página que la dibujó. Sin esta
 * verificación, un viewer podría lanzar un descubrimiento o borrar una cuenta
 * con una sola petición hecha a mano. Ocultar el botón no es autorización.
 */
export async function requireAdmin(): Promise<Session> {
  const session = await currentSession();
  if (session.role !== 'admin') {
    throw new Error('Esta acción requiere rol de administrador.');
  }
  return session;
}
