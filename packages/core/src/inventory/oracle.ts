import type { EngineClient } from '../engine';
import type { InventoryNote, InventorySnapshot } from './types';
import { eolFor } from './eol';

/**
 * Oracle inventory: version, SGA/PGA, tablespaces, Data Guard posture.
 */
export async function collectOracle(client: EngineClient): Promise<InventorySnapshot> {
  const notes: InventoryNote[] = [];

  const [inst] = await client.query(`
    select i.instance_name, i.host_name, i.version, i.version_full,
           i.startup_time, i.status, i.database_status,
           d.name as db_name, d.database_role, d.open_mode, d.log_mode
      from v$instance i
      cross join v$database d`);

  const versionText = String(inst?.['version_full'] ?? inst?.['version'] ?? 'desconocida');
  const versionNum = (() => {
    const m = /(\d+)\.(\d+)/.exec(versionText);
    if (!m) return null;
    return Number(m[1]) * 10_000 + Number(m[2]) * 100;
  })();

  let sgaBytes: number | null = null;
  try {
    const [sga] = await client.query(`select sum(value) as sga from v$sga`);
    sgaBytes = sga?.['sga'] != null ? Number(sga['sga']) : null;
  } catch (error) {
    notes.push({
      domain: 'engine',
      level: 'warn',
      message: `v$sga: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  let disks: InventorySnapshot['disks'] = [];
  try {
    const rows = await client.query(`
      select tablespace_name as name, sum(bytes) as size_bytes
        from dba_data_files
       group by tablespace_name`);
    disks = rows.map((r) => ({
      kind: 'tablespace' as const,
      name: String(r['name']),
      sizeBytes: Number(r['size_bytes'] ?? 0),
      usedBytes: Number(r['size_bytes'] ?? 0),
    }));
  } catch (error) {
    notes.push({
      domain: 'disk',
      level: 'warn',
      message: `dba_data_files: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const roleRaw = String(inst?.['database_role'] ?? 'PRIMARY');
  const replication = [];
  if (roleRaw !== 'PRIMARY') {
    replication.push({
      role: 'replica' as const,
      peer: String(inst?.['db_name'] ?? ''),
      state: roleRaw,
      detail: { open_mode: inst?.['open_mode'] },
    });
  } else {
    notes.push({
      domain: 'replication',
      level: 'info',
      message: 'Primary (or no Data Guard role reported).',
    });
  }

  notes.push({
    domain: 'engine',
    level: 'info',
    message:
      'Oracle: V$ views for sessions/waits/sysstat/SGA; tablespaces via DBA_*. Data Guard lag when configured.',
  });

  const startedAt = inst?.['startup_time'];
  return {
    engine: {
      engine: 'oracle',
      versionNum,
      versionText,
      edition: String(inst?.['status'] ?? null),
      startedAt:
        startedAt instanceof Date
          ? startedAt
          : startedAt
            ? new Date(String(startedAt))
            : null,
      cores: null,
      memoryBytes: sgaBytes,
      eolDate: eolFor('oracle', versionText),
    },
    settings: [
      {
        name: 'instance_name',
        value: String(inst?.['instance_name'] ?? ''),
        category: 'instance',
      },
      { name: 'db_name', value: String(inst?.['db_name'] ?? ''), category: 'instance' },
      { name: 'log_mode', value: String(inst?.['log_mode'] ?? ''), category: 'recovery' },
      {
        name: 'database_role',
        value: roleRaw,
        category: 'replication',
      },
    ],
    disks,
    replication,
    backups: [],
    jobs: [],
    licensing: {
      edition: 'Oracle Database',
      productionOk: true,
      note: 'Licensing depends on edition (XE/Free vs SE/EE). Monitor user needs SELECT on V$/DBA views.',
    },
    notes,
  };
}
