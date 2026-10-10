/**
 * Machine-to-machine OTLP ingest auth.
 *
 * Policy (fail closed off-loopback):
 * - Loopback Host (127.0.0.1 / localhost / ::1) and no non-loopback XFF → open
 *   unless BUHO_OTLP_TOKEN is set or BUHO_OTLP_REQUIRE_AUTH=true.
 * - Any non-loopback Host / X-Forwarded-For / X-Real-IP → token required.
 *   Missing BUHO_OTLP_TOKEN → 503 (do not accept anonymous remote ingest).
 *
 * Exporters: `Authorization: Bearer <token>` or `X-Buho-Otlp-Token: <token>`.
 */

export function otlpTokenConfigured(): string | null {
  const value = process.env['BUHO_OTLP_TOKEN']?.trim();
  return value || null;
}

function hostOnly(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end > 0 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(':')[0] ?? trimmed;
}

export function isLoopbackAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  const host = hostOnly(value);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1';
}

/** True only when Host and forwarded client IPs (if present) are loopback. */
export function isLoopbackRequest(request: Request): boolean {
  const host = request.headers.get('host');
  if (!isLoopbackAddress(host)) return false;

  const xf = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (xf && !isLoopbackAddress(xf)) return false;

  const xr = request.headers.get('x-real-ip')?.trim();
  if (xr && !isLoopbackAddress(xr)) return false;

  return true;
}

export function otlpAuthRequired(request?: Request): boolean {
  if (process.env['BUHO_OTLP_REQUIRE_AUTH'] === 'true') return true;
  if (otlpTokenConfigured() !== null) return true;
  if (request && !isLoopbackRequest(request)) return true;
  return false;
}

export function otlpRequestAuthorized(
  request: Request,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!otlpAuthRequired(request)) return { ok: true };

  const expected = otlpTokenConfigured();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error:
        'OTLP is reachable off-loopback (or auth is forced) but BUHO_OTLP_TOKEN is empty. Set a token before accepting remote ingest.',
    };
  }

  const header = request.headers.get('x-buho-otlp-token')?.trim();
  const auth = request.headers.get('authorization');
  const bearer =
    auth && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  const candidate = header || bearer;
  if (!candidate || candidate !== expected) {
    return {
      ok: false,
      status: 401,
      error: 'OTLP auth required · send Authorization: Bearer <BUHO_OTLP_TOKEN> or X-Buho-Otlp-Token',
    };
  }
  return { ok: true };
}
