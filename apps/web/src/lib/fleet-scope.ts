import { query } from './db';

export interface ScopeChoice {
  alias: string;
  engine: string;
}

/** Connections the fleet filters can offer. Falls back if `retired` is not migrated yet. */
export async function listScopeChoices(): Promise<ScopeChoice[]> {
  const sql = (retired: boolean) =>
    `select alias, coalesce(engine, 'postgres') as engine
       from buho.instances
      ${retired ? 'where coalesce(retired, false) = false' : ''}
      order by alias`;
  try {
    const rows = await query<{ alias: string; engine: string }>(sql(true));
    return rows.map((row) => ({ alias: row.alias, engine: row.engine }));
  } catch (error) {
    if (!String(error).includes('retired')) throw error;
    const rows = await query<{ alias: string; engine: string }>(sql(false));
    return rows.map((row) => ({ alias: row.alias, engine: row.engine }));
  }
}

export function scopeEngines(choices: ScopeChoice[]): string[] {
  return [...new Set(choices.map((row) => row.engine))].sort();
}

export function matchesScope(
  row: { alias: string; engine: string },
  engine: string,
  conn: string,
): boolean {
  if (engine && row.engine !== engine) return false;
  if (conn && row.alias !== conn) return false;
  return true;
}
