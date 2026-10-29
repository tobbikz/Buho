import type { EngineClient } from '../engine';
import type { PlanFinding, PlanNode, PlanReport } from '../explain';
import { isReadOnly } from '../explain';
import type { IndexObject, IndexSnapshot, IndexStatus } from '../indexes';
import { digestToQueryid } from './statements';
import type { ForeignCaps } from './types';
import { num, str } from './types';

export interface StatementSlowEvent {
  queryid: string;
  database: string | null;
  username: string | null;
  query: string;
  truncated: boolean;
  durationSec: number;
  rowsSent: number;
  rowsExamined: number;
  source: 'digest' | 'slow_log' | 'processlist';
}

const SLOW_DIGEST_SEC = 1;

/**
 * Digests whose max latency crossed the slow threshold since the last sample.
 * Tracks max_timer per digest so we emit an event when a new slow peak appears,
 * mirroring MSSQL procedure_slow_events (last_elapsed ≥ 1s).
 */
export class MariadbSlowEventTracker {
  private readonly maxMs = new Map<string, number>();

  fromDigestRows(rows: Record<string, unknown>[]): StatementSlowEvent[] {
    const events: StatementSlowEvent[] = [];
    for (const row of rows) {
      const digest = str(row['digest'], '');
      if (!digest) continue;
      const maxMs = num(row['max_ms']);
      const avgMs = num(row['avg_ms']);
      const peakMs = Math.max(maxMs, avgMs);
      if (peakMs < SLOW_DIGEST_SEC * 1000) continue;

      const queryid = digestToQueryid(digest);
      const prev = this.maxMs.get(queryid) ?? 0;
      // Emit when we see a new peak or first observation of a slow digest.
      if (prev > 0 && maxMs <= prev + 1) continue;
      this.maxMs.set(queryid, Math.max(prev, maxMs));

      events.push({
        queryid,
        database: (row['db'] as string | null) ?? null,
        username: null,
        query: str(row['query'], '').trim(),
        truncated: row['truncated'] === true || row['truncated'] === 1,
        durationSec: peakMs / 1000,
        rowsSent: num(row['rows_sent']),
        rowsExamined: num(row['rows_examined']),
        source: 'digest',
      });
    }
    return events;
  }

  fromProcesslist(rows: Record<string, unknown>[]): StatementSlowEvent[] {
    const events: StatementSlowEvent[] = [];
    for (const row of rows) {
      const info = str(row['info'], '').trim();
      if (!info) continue;
      const timeSec = num(row['time']);
      if (timeSec < SLOW_DIGEST_SEC) continue;
      const digest = fingerprint(info);
      const queryid = digestToQueryid(digest);
      events.push({
        queryid,
        database: (row['db'] as string | null) ?? null,
        username: (row['user'] as string | null) ?? null,
        query: info.slice(0, 4000),
        truncated: info.length >= 4000,
        durationSec: timeSec,
        rowsSent: 0,
        rowsExamined: 0,
        source: 'processlist',
      });
    }
    return events;
  }
}

function fingerprint(sql: string): string {
  const normalized = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'([^']|'')*'/g, '?')
    .replace(/"[^"]*"/g, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 500);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= BigInt(normalized.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** mysql.slow_log.query_time is TIME — drivers may return "00:00:01.234" or a number of seconds. */
function timeToSeconds(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value).trim();
  if (!text) return 0;
  const asNum = Number(text);
  if (Number.isFinite(asNum)) return asNum;
  const match = /^(-?)(?:(\d+):)?(?:(\d+):)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const parts = [match[2], match[3], match[4]].filter((p) => p !== undefined).map(Number);
  let sec = 0;
  if (parts.length === 3) sec = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  else if (parts.length === 2) sec = parts[0]! * 60 + parts[1]!;
  else sec = parts[0] ?? 0;
  const frac = match[5] ? Number(`0.${match[5]}`) : 0;
  return sign * (sec + frac);
}

/** Recent rows from mysql.slow_log when log_output includes TABLE. */
export async function sampleMariadbSlowLog(
  client: EngineClient,
  since: Date,
): Promise<StatementSlowEvent[]> {
  try {
    // EngineClient has no bind params — format UTC timestamp safely.
    const sinceSql = since.toISOString().slice(0, 19).replace('T', ' ');
    const rows = await client.query(
      `select start_time, user_host, db, query_time, rows_sent, rows_examined,
              left(sql_text, 4000) as sql_text
         from mysql.slow_log
        where start_time > '${sinceSql}'
        order by start_time desc
        limit 100`,
    );
    return rows.map((row) => {
      const sql = str(row['sql_text'], '').trim();
      const digest = fingerprint(sql || 'empty');
      return {
        queryid: digestToQueryid(digest),
        database: (row['db'] as string | null) ?? null,
        username: str(row['user_host'], '').split('[')[0]?.trim() || null,
        query: sql,
        truncated: sql.length >= 4000,
        durationSec: timeToSeconds(row['query_time']),
        rowsSent: num(row['rows_sent']),
        rowsExamined: num(row['rows_examined']),
        source: 'slow_log' as const,
      };
    });
  } catch {
    return [];
  }
}

export async function sampleMariadbSlowEvents(
  client: EngineClient,
  caps: ForeignCaps,
  tracker: MariadbSlowEventTracker,
  digestRows: Record<string, unknown>[],
  slowLogSince: Date,
): Promise<StatementSlowEvent[]> {
  if (caps.engine !== 'mariadb') return [];

  const events: StatementSlowEvent[] = [];
  if (caps.features.statementDigests) {
    events.push(...tracker.fromDigestRows(digestRows));
  } else {
    try {
      const pl = await client.query(`
        select id, user, db, command, time, state, info
          from information_schema.processlist
         where info is not null and info <> ''
           and command not in ('Sleep', 'Binlog Dump', 'Binlog Dump GTID', 'Daemon')
           and time >= ${SLOW_DIGEST_SEC}
         limit 50`);
      events.push(...tracker.fromProcesslist(pl));
    } catch {
      /* ignore */
    }
  }

  if (caps.features.slowLog) {
    events.push(...(await sampleMariadbSlowLog(client, slowLogSince)));
  }

  return events;
}

/**
 * Index inventory for MariaDB — information_schema.statistics + optional P_S
 * table_io waits (unused when count_read stays 0 with P_S on).
 */
export async function sampleMariadbIndexes(client: EngineClient, caps: ForeignCaps): Promise<IndexSnapshot> {
  const stats = await client.query(`
    select s.table_schema as schema_name,
           s.table_name,
           s.index_name,
           s.non_unique,
           s.seq_in_index,
           s.column_name,
           s.index_type,
           coalesce(t.data_length + t.index_length, 0) as table_bytes,
           coalesce(t.index_length, 0) as index_bytes_approx,
           coalesce(t.table_rows, 0) as table_rows
      from information_schema.statistics s
      left join information_schema.tables t
        on t.table_schema = s.table_schema and t.table_name = s.table_name
     where s.table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys')
     order by s.table_schema, s.table_name, s.index_name, s.seq_in_index`);

  type Acc = {
    schema: string;
    table: string;
    name: string;
    columns: string[];
    isUnique: boolean;
    isPrimary: boolean;
    indexType: string;
    tableBytes: number;
    indexBytes: number;
  };
  const byKey = new Map<string, Acc>();
  for (const row of stats) {
    const schema = str(row['schema_name']);
    const table = str(row['table_name']);
    const name = str(row['index_name']);
    const key = `${schema}.${table}.${name}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        schema,
        table,
        name,
        columns: [],
        isUnique: num(row['non_unique']) === 0,
        isPrimary: name.toUpperCase() === 'PRIMARY',
        indexType: str(row['index_type'], 'BTREE'),
        tableBytes: num(row['table_bytes']),
        indexBytes: num(row['index_bytes_approx']),
      };
      byKey.set(key, acc);
    }
    const col = str(row['column_name']);
    if (col) acc.columns.push(col);
  }

  const ioByIndex = new Map<string, number>();
  if (caps.features.statementDigests) {
    try {
      const io = await client.query(`
        select object_schema, object_name, index_name, count_read
          from performance_schema.table_io_waits_summary_by_index_usage
         where object_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys')
           and index_name is not null`);
      for (const row of io) {
        const key = `${str(row['object_schema'])}.${str(row['object_name'])}.${str(row['index_name'])}`;
        ioByIndex.set(key, num(row['count_read']));
      }
    } catch {
      /* P_S table may be empty / missing */
    }
  }

  const indexes: IndexObject[] = [];
  const perTable = new Map<string, Acc[]>();
  for (const acc of byKey.values()) {
    const tkey = `${acc.schema}.${acc.table}`;
    const list = perTable.get(tkey) ?? [];
    list.push(acc);
    perTable.set(tkey, list);
  }

  for (const acc of byKey.values()) {
    const key = `${acc.schema}.${acc.table}.${acc.name}`;
    const scans = ioByIndex.get(key);
    let status: IndexStatus = 'ok';
    let coveredBy: string | null = null;

    if (scans === 0 && !acc.isPrimary && caps.features.statementDigests) {
      status = 'unused';
    }

    // Prefix redundancy: shorter unique=false index covered by longer on same cols.
    const siblings = perTable.get(`${acc.schema}.${acc.table}`) ?? [];
    for (const other of siblings) {
      if (other.name === acc.name) continue;
      if (acc.isPrimary || acc.isUnique) continue;
      if (
        other.columns.length >= acc.columns.length &&
        acc.columns.every((col, index) => other.columns[index] === col) &&
        other.columns.length > acc.columns.length
      ) {
        status = 'redundant';
        coveredBy = other.name;
        break;
      }
    }

    const sizeShare =
      siblings.length > 0 ? Math.max(1024, Math.floor(acc.indexBytes / siblings.length)) : acc.indexBytes;

    indexes.push({
      schema: acc.schema,
      table: acc.table,
      name: acc.name,
      sizeBytes: sizeShare,
      idxScan: scans ?? 0,
      idxTupRead: 0,
      idxTupFetch: 0,
      isPrimary: acc.isPrimary,
      isUnique: acc.isUnique,
      isValid: true,
      isPartial: false,
      hasExpression: false,
      columns: acc.columns,
      definition: `${acc.indexType} (${acc.columns.join(', ')})`,
      status,
      coveredBy,
    });
  }

  indexes.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { indexes };
}

function emptyNode(partial: Partial<PlanNode> & { type: string; label: string }): PlanNode {
  return {
    nodeId: partial.nodeId ?? '0',
    type: partial.type,
    relation: partial.relation ?? null,
    label: partial.label,
    startupCost: partial.startupCost ?? 0,
    totalCost: partial.totalCost ?? 0,
    planRows: partial.planRows ?? 0,
    planWidth: partial.planWidth ?? 0,
    actualRows: partial.actualRows ?? null,
    actualLoops: partial.actualLoops ?? null,
    actualTotalMs: partial.actualTotalMs ?? null,
    selfMs: partial.selfMs ?? null,
    share: partial.share ?? 1,
    indexCond: partial.indexCond ?? null,
    filter: partial.filter ?? null,
    rowsRemovedByFilter: partial.rowsRemovedByFilter ?? null,
    joinType: partial.joinType ?? null,
    sortMethod: partial.sortMethod ?? null,
    sortSpaceKb: partial.sortSpaceKb ?? null,
    sortSpaceType: partial.sortSpaceType ?? null,
    hashBatches: partial.hashBatches ?? null,
    heapBlocksLossy: partial.heapBlocksLossy ?? null,
    parallelWorkers: partial.parallelWorkers ?? null,
    children: partial.children ?? [],
  };
}

function parseMariadbTable(raw: Record<string, unknown>, path: number[]): PlanNode {
  const access = str(raw['access_type'], 'ALL');
  const table = (raw['table_name'] as string | null) ?? (raw['table'] as string | null) ?? null;
  const rows = num(raw['rows']);
  const filtered = num(raw['filtered']);
  const key = (raw['key'] as string | null) ?? null;
  const using = Array.isArray(raw['possible_keys'])
    ? (raw['possible_keys'] as unknown[]).map(String).join(', ')
    : raw['possible_keys']
      ? String(raw['possible_keys'])
      : null;
  const label = table ? `${access} · ${table}` : access;
  const children: PlanNode[] = [];
  const nested = raw['table'];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    children.push(parseMariadbTable(nested as Record<string, unknown>, [...path, 0]));
  }
  if (Array.isArray(raw['nested_loop'])) {
    (raw['nested_loop'] as Record<string, unknown>[]).forEach((child, index) => {
      const tableChild = child['table'];
      if (tableChild && typeof tableChild === 'object') {
        children.push(parseMariadbTable(tableChild as Record<string, unknown>, [...path, index]));
      }
    });
  }
  return emptyNode({
    nodeId: path.join('.') || '0',
    type: access,
    relation: table,
    label,
    planRows: rows,
    totalCost: rows,
    indexCond: key ? `key=${key}` : using ? `possible=${using}` : null,
    filter: filtered > 0 && filtered < 100 ? `filtered ${filtered}%` : null,
    children,
  });
}

function parseMariadbJson(raw: unknown): PlanNode {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const block = (root['query_block'] ?? root) as Record<string, unknown>;
  const children: PlanNode[] = [];
  if (block['table'] && typeof block['table'] === 'object') {
    children.push(parseMariadbTable(block['table'] as Record<string, unknown>, [0]));
  }
  if (Array.isArray(block['nested_loop'])) {
    (block['nested_loop'] as Record<string, unknown>[]).forEach((child, index) => {
      const tableChild = child['table'];
      if (tableChild && typeof tableChild === 'object') {
        children.push(parseMariadbTable(tableChild as Record<string, unknown>, [index]));
      }
    });
  }
  if (children.length === 0) {
    return emptyNode({ type: 'query_block', label: 'query_block', planRows: num(block['rows']) });
  }
  if (children.length === 1) return children[0]!;
  return emptyNode({
    type: 'query_block',
    label: 'query_block',
    children,
    planRows: children.reduce((sum, child) => sum + child.planRows, 0),
    totalCost: children.reduce((sum, child) => sum + child.totalCost, 0),
  });
}

function mariadbFindings(root: PlanNode): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const walk = (node: PlanNode, ancestors: PlanNode[]) => {
    const path = [...ancestors.map((a) => a.label), node.label].join(' → ');
    if (node.type === 'ALL' && node.relation) {
      findings.push({
        path,
        nodeId: node.nodeId,
        severity: 'alta',
        title: 'Full table scan',
        detail: `Access type ALL on ${node.relation} — every row is read.`,
        remediation: 'Add or use an index that matches the WHERE/JOIN predicates.',
        evidence: { rows: node.planRows, access_type: node.type },
      });
    }
    if (node.filter?.includes('filtered') && node.planRows > 1000) {
      findings.push({
        path,
        nodeId: node.nodeId,
        severity: 'media',
        title: 'Low filter selectivity',
        detail: node.filter,
        remediation: 'Tighten the predicate or add a covering index so fewer rows survive the filter.',
        evidence: { rows: node.planRows },
      });
    }
    for (const child of node.children) walk(child, [...ancestors, node]);
  };
  walk(root, []);
  return findings;
}

/**
 * performance_schema digests replace literals with `?`. MariaDB EXPLAIN rejects
 * those tokens (unlike PG GENERIC_PLAN). Rewrite to parseable estimate SQL:
 * LIMIT/OFFSET get 1/0; remaining `?` → NULL. Skips `?` inside quotes/backticks.
 */
export function rewriteMariadbPlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let quote: "'" | '"' | '`' | null = null;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (quote) {
      out += ch;
      if (ch === '\\' && quote !== '`') {
        i += 1;
        if (i < sql.length) out += sql[i]!;
      } else if (ch === quote) {
        // Maria '' / "" escape inside strings
        if ((quote === "'" || quote === '"') && sql[i + 1] === quote) {
          out += sql[i + 1]!;
          i += 1;
        } else {
          quote = null;
        }
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += 'NULL';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  // LIMIT/OFFSET NULL is invalid — force small integers after the NULL pass.
  return out
    .replace(/\bLIMIT\s+NULL\b/gi, 'LIMIT 1')
    .replace(/\bOFFSET\s+NULL\b/gi, 'OFFSET 0');
}

/**
 * MariaDB EXPLAIN lite — FORMAT=JSON tree + text. ANALYZE runs the statement
 * (admin-only in the UI); estimate is plan-only.
 */
export async function runMariadbExplain(
  client: EngineClient,
  sql: string,
  options: { analyze?: boolean; timeoutMs?: number } = {},
): Promise<PlanReport> {
  const analyze = options.analyze === true;
  if (analyze && !isReadOnly(sql)) {
    throw new Error(
      'ANALYZE only runs on read-only statements. Use the estimated plan for writes.',
    );
  }

  if (analyze && sql.includes('?')) {
    throw new Error(
      'ANALYZE needs concrete literals. Estimated EXPLAIN rewrites digest `?` to NULL.',
    );
  }

  let clean = sql.replace(/;\s*$/, '').trim();
  let mode: PlanReport['mode'] = analyze ? 'analyze' : 'estimate';
  if (!analyze && clean.includes('?')) {
    clean = rewriteMariadbPlaceholders(clean);
    mode = 'generic';
  }
  const prefix = analyze ? 'ANALYZE FORMAT=JSON' : 'EXPLAIN FORMAT=JSON';
  const textPrefix = analyze ? 'ANALYZE' : 'EXPLAIN';

  const jsonRows = await client.query(`${prefix} ${clean}`);
  const textRows = await client.query(`${textPrefix} ${clean}`);

  // Drivers return the JSON plan in the first column under various names.
  const first = jsonRows[0] ?? {};
  const rawJson =
    first['EXPLAIN'] ??
    first['ANALYZE'] ??
    first['JSON'] ??
    Object.values(first)[0];
  let parsed: unknown = rawJson;
  if (typeof rawJson === 'string') {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = {};
    }
  }

  const root = parseMariadbJson(parsed);
  const text = textRows
    .map((row) =>
      Object.entries(row)
        .map(([key, value]) => `${key}: ${value}`)
        .join(' | '),
    )
    .join('\n');

  return {
    mode,
    planningMs: null,
    executionMs: null,
    totalCost: root.totalCost,
    root,
    findings: mariadbFindings(root),
    text: text || JSON.stringify(parsed, null, 2),
    raw: parsed,
    triggers: [],
  };
}
