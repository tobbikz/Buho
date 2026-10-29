import { timingSafeEqual } from 'node:crypto';

/**
 * Machine-to-machine auth for `/api/v1/*`.
 * Set `BUHO_API_TOKEN` (long random string). Clients send `Authorization: Bearer <token>`.
 */
export function apiTokenConfigured(): boolean {
  const t = process.env['BUHO_API_TOKEN']?.trim();
  return Boolean(t && t.length >= 16);
}

export function verifyApiBearer(header: string | null): boolean {
  const expected = process.env['BUHO_API_TOKEN']?.trim();
  if (!expected || expected.length < 16) return false;
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m?.[1]) return false;
  const got = m[1].trim();
  try {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function unauthorizedJson(message = 'Unauthorized') {
  return Response.json({ error: message }, { status: 401 });
}
