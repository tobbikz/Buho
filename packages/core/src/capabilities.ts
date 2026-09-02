import { tagged } from './tag';
import type { Pool } from 'pg';
import type { Capabilities } from './types';

const PROBE_SQL = `
select current_setting('server_version_num')::int          as version_num,
       version()                                            as version_text,
       pg_is_in_recovery()                                   as in_recovery,
       pg_has_role(current_user, 'pg_monitor', 'member')      as has_pg_monitor,
       coalesce((select rolsuper from pg_roles
                  where rolname = current_user), false)       as is_superuser,
       pg_postmaster_start_time()                             as started_at,
       current_setting('track_io_timing')                     as track_io_timing,
       current_setting('shared_preload_libraries')            as preload_libraries
`;

const EXTENSIONS_SQL = `select extname, extversion from pg_extension`;

/**
 * Interroga la instancia antes de monitorearla. Sin esto el colector se rompe
 * al cambiar de versión: PG18 eliminó wal_write/wal_sync de pg_stat_wal y PG17
 * movió las estadísticas de checkpoint de pg_stat_bgwriter a pg_stat_checkpointer.
 */
export async function probeCapabilities(pool: Pool): Promise<Capabilities> {
  const [probe, extensions] = await Promise.all([
    pool.query(tagged(PROBE_SQL)),
    pool.query<{ extname: string; extversion: string }>(tagged(EXTENSIONS_SQL)),
  ]);

  const row = probe.rows[0] as {
    version_num: number;
    version_text: string;
    in_recovery: boolean;
    has_pg_monitor: boolean;
    is_superuser: boolean;
    started_at: Date;
    track_io_timing: string;
    preload_libraries: string;
  };

  const installed: Record<string, string> = {};
  for (const ext of extensions.rows) installed[ext.extname] = ext.extversion;

  const preloaded = row.preload_libraries
    .split(',')
    .map((entry) => entry.trim())
    .includes('pg_stat_statements');

  const statStatements = installed['pg_stat_statements']
    ? 'active'
    : preloaded
      ? 'preloaded_not_created'
      : 'not_preloaded';

  const versionNum = row.version_num;

  return {
    versionNum,
    versionText: row.version_text,
    inRecovery: row.in_recovery,
    isSuperuser: row.is_superuser,
    hasPgMonitor: row.has_pg_monitor,
    startedAt: row.started_at,
    trackIoTiming: row.track_io_timing === 'on',
    statStatements,
    extensions: installed,
    hasStatIo: versionNum >= 160000,
    hasStatCheckpointer: versionNum >= 170000,
    hasStatWal: versionNum >= 140000,
    hasWaitEventsCatalog: versionNum >= 170000,
    hasLastScanColumns: versionNum >= 160000,
  };
}

/** Motivos por los que una instancia no se puede monitorear bien. */
export function capabilityWarnings(caps: Capabilities): string[] {
  const warnings: string[] = [];
  if (caps.versionNum < 130000) {
    warnings.push(`PostgreSQL ${caps.versionText} is below the minimum supported version (13).`);
  }
  if (!caps.hasPgMonitor && !caps.isSuperuser) {
    warnings.push(
      'User is not in pg_monitor: several metrics will be empty. Remediation: GRANT pg_monitor TO <user>.',
    );
  }
  // track_io_timing y pg_stat_statements no se avisan aquí: son hallazgos del
  // catálogo de checks, con su remediación. Duplicarlos ensucia el informe.
  return warnings;
}
