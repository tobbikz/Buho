import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  authConfigured,
  issueSession,
  sharedPasswordConfigured,
  sharedPasswordMatches,
  SESSION_COOKIE,
} from '@/lib/auth';
import { findUser, recordLogin, userCount, verifyPassword, logConsoleEvent } from '@/lib/users';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in · Búho' };

/** Ruta interna válida: evita que ?next= sirva para redirigir a otro sitio. */
function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

/**
 * Modo de arranque: mientras no exista ninguna cuenta, la contraseña compartida
 * entra como administrador.
 *
 * Sin esto, agregar usuarios dejaría fuera a toda instalación existente y no
 * habría forma de crear el primer administrador desde la consola. En cuanto hay
 * una cuenta, la contraseña compartida deja de funcionar: si siguiera valiendo
 * sería una puerta trasera permanente que ignora los roles.
 */
async function enter(formData: FormData) {
  'use server';

  const username = String(formData.get('username') ?? '').trim();
  const candidate = String(formData.get('password') ?? '');
  const next = safeNext(String(formData.get('next') ?? '/'));

  const fail = () => {
    // Freno simple a la fuerza bruta: medio segundo por intento la vuelve
    // inviable sin necesidad de estado compartido.
    redirect(`/login?error=1${next !== '/' ? `&next=${encodeURIComponent(next)}` : ''}`);
  };

  const accounts = await userCount().catch(() => 0);
  let session: { value: string; maxAge: number };

  if (accounts === 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!sharedPasswordMatches(candidate)) fail();
    session = await issueSession('contraseña-compartida', 'admin');
  } else {
    const user = username ? await findUser(username) : null;
    // Se hace la espera igual exista o no la cuenta: si sólo se demorara con
    // usuario válido, el tiempo de respuesta revelaría qué nombres existen.
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!user || user.disabled || !verifyPassword(candidate, user.passwordHash)) fail();

    await recordLogin(user!.userId);
    await logConsoleEvent(user!.username, 'signed in');
    session = await issueSession(user!.username, user!.role);
  }

  (await cookies()).set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: 'lax',
    // Sin `secure` fijo: muchas instalaciones on-prem quedan detrás de un proxy
    // que termina TLS, y otras corren en una red interna sin certificado. Con
    // secure incondicional la cookie no viajaría y nadie podría entrar.
    secure: process.env['BUHO_AUTH_COOKIE_SECURE'] === 'true',
    path: '/',
    maxAge: session.maxAge,
  });

  redirect(next);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  if (!authConfigured()) {
    return (
      <div className="mx-auto max-w-[46rem] p-8">
        <h1 className="text-[18px] font-semibold">Console without authentication</h1>
        <p className="mt-2 text-[13px] text-foreground-secondary">
          The console will not start in production without authentication: anyone who can reach the port would see the state of
          every instance, including query text.
        </p>
        <pre className="mt-4 border border-border bg-surface-muted p-3 font-mono text-[11.5px]">
          {`# docker compose o systemd
BUHO_AUTH_SECRET='una-cadena-larga-generada'   # signs sessions
BUHO_AUTH_PASSWORD='otra-cadena-larga'         # signs in as admin while no accounts exist
# optional, if the console serves HTTPS directly
BUHO_AUTH_COOKIE_SECURE=true`}
        </pre>
        <p className="mt-3 text-[12.5px] text-foreground-secondary">
          To generate them: <span className="font-mono">openssl rand -base64 24</span>. With the shared password you
          sign in as administrator and create accounts from there; once the first account exists, the shared
          password stops working.
        </p>
      </div>
    );
  }

  const accounts = await userCount().catch(() => 0);
  const bootstrap = accounts === 0;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-[22rem] flex-col justify-center p-6">
      <div className="mb-4 flex items-baseline gap-2">
        <span className="text-[17px] font-semibold">Búho</span>
        <span className="tag tag--muted">v1.6.1</span>
      </div>

      <form action={enter} className="panel">
        <div className="panel-body">
          {bootstrap ? (
            <p className="mb-3 text-[11.5px] text-foreground-muted">
              No accounts yet: sign in with the shared password and create them under Admin.
            </p>
          ) : (
            <>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                Username
              </label>
              <input
                type="text"
                name="username"
                autoFocus
                autoComplete="username"
                className="mb-3 mt-1 w-full border border-border bg-surface px-2 py-1.5 font-mono text-[13px] outline-none focus:border-accent"
              />
            </>
          )}

          <label className="block text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            Password
          </label>
          <input
            type="password"
            name="password"
            autoFocus={bootstrap}
            autoComplete="current-password"
            className="mt-1 w-full border border-border bg-surface px-2 py-1.5 font-mono text-[13px] outline-none focus:border-accent"
          />
          <input type="hidden" name="next" value={safeNext(next)} />

          {error ? (
            <p className="mt-2 text-[12px] text-error">
              {bootstrap ? 'Incorrect password.' : 'Incorrect username or password.'}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary mt-3 w-full justify-center">
            Sign in
          </button>
        </div>
      </form>

      <p className="mt-3 text-[11px] text-foreground-muted">
        The session lasts 12 hours. Búho is not meant to expose this console to the internet: put it behind an internal network or a
        TLS proxy.
      </p>
    </div>
  );
}
