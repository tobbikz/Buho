import { NextResponse, type NextRequest } from 'next/server';
import { authConfigured, authRequired, readSession, requiresAdmin, SESSION_COOKIE } from '@/lib/auth';

/**
 * Puerta única de la consola. Va en middleware y no en cada página porque una
 * ruta nueva no puede quedar abierta por olvidarse de agregar la verificación.
 *
 * También decide el rol: `/admin` exige admin. La verificación se repite dentro
 * de cada server action —ver `requireAdmin` en session.ts— porque una acción se
 * puede invocar sin pasar por la página que la dibuja.
 */

/**
 * El layout raíz necesita saber la ruta para no dibujar el shell de navegación
 * alrededor de la pantalla de login. Un server component no tiene acceso al
 * pathname, así que viaja como header.
 */
function withPath(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-buho-path', request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (!authConfigured()) {
    // Sin secreto definido: en producción sólo se puede ver la pantalla que
    // explica cómo configurarlo; en desarrollo se pasa de largo.
    if (authRequired() && pathname !== '/login') {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.search = '';
      return NextResponse.redirect(url);
    }
    return withPath(request);
  }

  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === '/login') {
    if (session) {
      const url = request.nextUrl.clone();
      url.pathname = '/';
      url.search = '';
      return NextResponse.redirect(url);
    }
    return withPath(request);
  }

  if (!session) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Volver a donde iba después de entrar: si el operador tenía abierta la
    // pantalla de bloqueos, ahí debe regresar.
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (requiresAdmin(pathname) && session.role !== 'admin') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '?denegado=admin';
    return NextResponse.redirect(url);
  }

  return withPath(request);
}

export const config = {
  // Los assets estáticos quedan fuera: no llevan datos y pasar cada uno por la
  // verificación sólo agrega latencia.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon(?:\\.svg)?|apple-icon).*)'],
};
