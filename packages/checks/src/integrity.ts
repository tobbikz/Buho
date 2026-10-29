import type { Finding } from './types';

export const INTEGRITY_INVALID_INDEX = 'integrity_invalid_index';
export const INTEGRITY_FK_ORPHAN = 'integrity_fk_orphan';

/** Read-only probes; collector runs these and passes rows to the builders. */
export const INTEGRITY_PROBE_SQL = {
  invalidIndexes: `
    select n.nspname  as schema_name,
           c.relname  as table_name,
           i.relname  as index_name,
           pg_relation_size(i.oid) as size_bytes
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class c on c.oid = x.indrelid
      join pg_namespace n on n.oid = c.relnamespace
     where not x.indisvalid
       and n.nspname not in ('pg_catalog', 'information_schema')
     order by pg_relation_size(i.oid) desc nulls last
     limit 50`,
} as const;

export interface FkOrphanProbe {
  /** Stable id for correlating probe results (e.g. constraint name). */
  constraintName: string;
  schemaName: string;
  tableName: string;
  columnNames: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Builds a bounded orphan-count probe for one FK. Collector executes the SQL later.
 */
export function fkOrphanProbeSql(probe: FkOrphanProbe): string {
  const childCols = probe.columnNames.map(quoteIdent).join(', ');
  const parentCols = probe.referencedColumns.map(quoteIdent).join(', ');
  const child = qualified(probe.schemaName, probe.tableName);
  const parent = qualified(probe.referencedSchema, probe.referencedTable);

  const join =
    probe.columnNames.length === 1
      ? `c.${quoteIdent(probe.columnNames[0]!)} = p.${quoteIdent(probe.referencedColumns[0]!)}`
      : probe.columnNames
          .map((col, index) => `c.${quoteIdent(col)} = p.${quoteIdent(probe.referencedColumns[index]!)}`)
          .join(' and ');

  const nullChild = probe.columnNames.map((col) => `c.${quoteIdent(col)} is not null`).join(' or ');

  const parentMissing =
    probe.referencedColumns.length === 1
      ? `p.${quoteIdent(probe.referencedColumns[0]!)} is null`
      : `(${probe.referencedColumns.map((col) => `p.${quoteIdent(col)} is null`).join(' and ')})`;

  return `
    select '${probe.constraintName.replace(/'/g, "''")}' as constraint_name,
           count(*)::bigint as orphan_count
      from ${child} c
      left join ${parent} p on ${join}
     where (${nullChild})
       and ${parentMissing}`.trim();
}

export interface IntegrityProbeRow {
  schema_name?: string;
  table_name?: string;
  index_name?: string;
  size_bytes?: number;
  constraint_name?: string;
  orphan_count?: number;
}

function text(value: unknown, fallback = '(unknown)'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildInvalidIndexFindings(rows: IntegrityProbeRow[]): Finding[] {
  return rows.map((row) => ({
    severity: 'critical' as const,
    object: `${text(row.schema_name)}.${text(row.index_name)}`,
    message: `Invalid index on ${text(row.schema_name)}.${text(row.table_name)} (${text(row.index_name)}).`,
    remediation:
      'REINDEX the index (CONCURRENTLY when supported) or DROP and recreate it. Invalid indexes break writes and may hide planner regressions.',
    value: num(row.size_bytes),
  }));
}

export function buildFkOrphanFindings(rows: IntegrityProbeRow[]): Finding[] {
  return rows
    .filter((row) => num(row.orphan_count) > 0)
    .map((row) => ({
      severity: num(row.orphan_count) > 10_000 ? ('critical' as const) : ('warning' as const),
      object: text(row.constraint_name),
      message: `FK ${text(row.constraint_name)} has ${num(row.orphan_count).toLocaleString('en-US')} orphan row(s).`,
      remediation:
        'Repair or delete orphan child rows, then VALIDATE CONSTRAINT or recreate the foreign key.',
      value: num(row.orphan_count),
    }));
}

export function integrityCheckResults(kind: 'invalid_index' | 'fk_orphan', rows: IntegrityProbeRow[]) {
  const builders =
    kind === 'invalid_index'
      ? { findings: buildInvalidIndexFindings(rows), checkId: INTEGRITY_INVALID_INDEX, title: 'Invalid index' }
      : { findings: buildFkOrphanFindings(rows), checkId: INTEGRITY_FK_ORPHAN, title: 'FK orphan rows' };

  return builders.findings.map((finding) => ({
    ...finding,
    checkId: builders.checkId,
    title: builders.title,
  }));
}
