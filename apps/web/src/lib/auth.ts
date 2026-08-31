/**
 * Autenticación y sesión de la consola.
 *
 * Dos roles: **admin** puede cambiar cosas (cuentas, retención, descubrimiento);
 * **viewer** sólo mira. Un modelo por recurso es lo que convierte una
 * herramienta interna en un proyecto de administración de accesos, y la pregunta
 * real de un equipo de base de datos es más simple que eso.
 *
 * La sesión **no vive en base de datos**: la cookie lleva usuario, rol y
 * expiración, firmados con HMAC. Así verificar cada request no cuesta una
 * consulta, el reinicio de la web no cierra sesiones y el middleware —que corre
 * en el runtime edge, sin acceso al store— puede decidir por sí solo. La contra
 * es que un cambio de rol no surte efecto hasta que la sesión expira o el
 * usuario vuelve a entrar; para forzarlo, se deshabilita la cuenta y se rota el
 * secreto.
 *
 * Se usa Web Crypto y no node:crypto justamente porque este módulo corre en el
 * middleware. Todo lo que toca el store o hashea contraseñas vive en `users.ts`.
 */

export const SESSION_COOKIE = 'buho_session';
const SESSION_HOURS = 12;

export type Role = 'admin' | 'viewer';

export interface Session {
  username: string;
  role: Role;
  expiresAt: number;
}

function password(): string | null {
  const value = process.env['BUHO_AUTH_PASSWORD'];
  return value && value.length > 0 ? value : null;
}

function secret(): string | null {
  const explicit = process.env['BUHO_AUTH_SECRET'];
  if (explicit && explicit.length > 0) return explicit;
  const shared = password();
  return shared ? `buho:${shared}` : null;
}

/**
 * Hay con qué firmar una sesión.
 *
 * Basta `BUHO_AUTH_SECRET` **o** `BUHO_AUTH_PASSWORD`: el primero es lo correcto
 * cuando ya hay cuentas de usuario, el segundo mantiene funcionando las
 * instalaciones que hoy sólo tienen la contraseña compartida.
 */
export function authConfigured(): boolean {
  return secret() !== null;
}

/** La contraseña compartida sigue sirviendo mientras no haya cuentas creadas. */
export function sharedPasswordConfigured(): boolean {
  return password() !== null;
}

/**
 * En producción sin secreto la consola no sirve páginas: es la única forma de
 * que un despliegue no quede abierto por olvido. En desarrollo se permite, con
 * un aviso visible en la interfaz.
 */
export function authRequired(): boolean {
  return process.env.NODE_ENV === 'production';
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret() ?? ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Los bytes crudos: sirven para verificar la firma. */
function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

/**
 * El texto, interpretando los bytes como UTF-8.
 *
 * `atob` devuelve un byte por carácter, así que leer el payload directamente de
 * ahí parte cualquier letra acentuada en dos: un usuario llamado «José» entraba
 * y la consola lo saludaba como «JosÃ©». La firma se sigue verificando sobre los
 * bytes, que es lo que se firmó.
 */
function textFromBase64Url(value: string): string {
  const bytes = Uint8Array.from(fromBase64Url(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function issueSession(
  username: string,
  role: Role,
  now = Date.now(),
): Promise<{ value: string; maxAge: number }> {
  const payload = JSON.stringify({ u: username, r: role, e: now + SESSION_HOURS * 3_600_000 });
  const encoded = toBase64Url(new TextEncoder().encode(payload));
  const signature = await crypto.subtle.sign('HMAC', await key(), new TextEncoder().encode(encoded));
  return { value: `${encoded}.${toBase64Url(signature)}`, maxAge: SESSION_HOURS * 3_600 };
}

/**
 * Devuelve la sesión si la firma y la vigencia son válidas, o null.
 *
 * Se verifica la firma **antes** de interpretar el contenido: leer el rol de un
 * payload sin validar sería confiar en algo que el cliente controla.
 */
export async function readSession(
  token: string | undefined,
  now = Date.now(),
): Promise<Session | null> {
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const valid = await crypto.subtle.verify(
    'HMAC',
    await key(),
    Uint8Array.from(fromBase64Url(signature), (character) => character.charCodeAt(0)),
    new TextEncoder().encode(encoded),
  );
  if (!valid) return null;

  try {
    const payload = JSON.parse(textFromBase64Url(encoded)) as { u?: string; r?: string; e?: number };
    const expiresAt = Number(payload.e);
    if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
    const role: Role = payload.r === 'admin' ? 'admin' : 'viewer';
    return { username: String(payload.u ?? '?'), role, expiresAt };
  } catch {
    return null;
  }
}

/** Comparación de tiempo constante: la contraseña sí la controla quien ataca. */
export function sharedPasswordMatches(candidate: string): boolean {
  const expected = password();
  if (!expected) return false;

  const a = new TextEncoder().encode(candidate);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Rutas que exigen rol admin. El middleware las bloquea antes de renderizar. */
export function requiresAdmin(pathname: string): boolean {
  return pathname.startsWith('/admin');
}
