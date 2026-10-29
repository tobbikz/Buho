/**
 * Normalizes DDL audit payloads (event trigger, pgaudit, or collector hook) into
 * a single store-friendly shape.
 */

export interface NormalizedDdlEvent {
  at: Date;
  commandTag: string;
  object: string;
  sql: string;
}

/** Loose inputs from pg_event_trigger_ddl_commands(), logs, or custom hooks. */
export interface RawDdlEvent {
  ts?: string | Date | number;
  at?: string | Date | number;
  command_tag?: string;
  commandTag?: string;
  object_identity?: string;
  object?: string;
  schema_name?: string;
  object_type?: string;
  query?: string;
  sql?: string;
  ddl?: string;
  statement?: string;
}

function pickString(...candidates: unknown[]): string {
  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function parseAt(raw: RawDdlEvent): Date {
  const candidate = raw.at ?? raw.ts;
  if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) return candidate;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    const ms = candidate > 1e12 ? candidate : candidate * 1000;
    return new Date(ms);
  }
  if (typeof candidate === 'string' && candidate.trim()) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function buildObject(raw: RawDdlEvent): string {
  const identity = pickString(raw.object_identity, raw.object);
  if (identity) return identity;
  const schema = pickString(raw.schema_name);
  const type = pickString(raw.object_type);
  if (schema && type) return `${schema}.${type}`;
  return schema || type || '(unknown object)';
}

/**
 * Returns null when the payload lacks enough signal to persist (no SQL and no command tag).
 */
export function captureDdlEvent(raw: RawDdlEvent): NormalizedDdlEvent | null {
  const commandTag = pickString(raw.commandTag, raw.command_tag).toUpperCase();
  const sql = pickString(raw.sql, raw.ddl, raw.query, raw.statement);
  if (!commandTag && !sql) return null;

  return {
    at: parseAt(raw),
    commandTag: commandTag || 'UNKNOWN',
    object: buildObject(raw),
    sql: sql || commandTag,
  };
}

export function captureDdlEvents(rawEvents: RawDdlEvent[]): NormalizedDdlEvent[] {
  const out: NormalizedDdlEvent[] = [];
  for (const raw of rawEvents) {
    const normalized = captureDdlEvent(raw);
    if (normalized) out.push(normalized);
  }
  return out;
}
