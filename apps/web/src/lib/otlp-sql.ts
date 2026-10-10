/** Beyla often names SQL spans `SELECT foo` without db.statement → empty sql_text. */

const SQL_NAME =
  /^(SELECT|INSERT|UPDATE|DELETE|WITH|MERGE|CALL|EXEC|CREATE|ALTER|DROP|TRUNCATE|BEGIN|COMMIT|ROLLBACK)\b/i;

export function looksLikeSqlName(name: string | null | undefined): boolean {
  return SQL_NAME.test((name ?? '').trim());
}

/** Prefer stored statement; fall back to Beyla-style span name. */
export function resolveSqlText(
  sqlText: string | null | undefined,
  spanName: string | null | undefined,
): string | null {
  const stored = sqlText?.trim();
  if (stored) return stored;
  const name = spanName?.trim();
  if (name && looksLikeSqlName(name)) return name;
  return null;
}
