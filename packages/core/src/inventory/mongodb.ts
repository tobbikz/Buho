import type { EngineClient } from '../engine';
import type { InventoryNote, InventorySnapshot } from './types';
import { eolFor } from './eol';

/**
 * Inventario de MongoDB.
 *
 * Preguntas de parque: versión, memoria, bases y tamaño. Sin Agent jobs ni
 * Query Store — no existen. Las notas dejan claro qué falta frente a PG/MSSQL.
 */
export async function collectMongodb(client: EngineClient): Promise<InventorySnapshot> {
  if (!client.command) throw new Error('cliente MongoDB sin command()');

  const notes: InventoryNote[] = [];
  const build = await client.command({ buildInfo: 1 });
  const hello = await client.command({ hello: 1 });
  const status = await client.command({
    serverStatus: 1,
    repl: 0,
    metrics: 0,
    wiredTiger: 0,
  });
  const hostInfo = await client.command({ hostInfo: 1 }).catch(() => null);

  const versionText = String(build['version'] ?? 'desconocida');
  const versionNum = (() => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionText);
    if (!m) return null;
    return Number(m[1]) * 10_000 + Number(m[2]) * 100 + Math.min(Number(m[3]), 99);
  })();

  const mem = (status['mem'] as Record<string, unknown> | undefined) ?? {};
  const connections = (status['connections'] as Record<string, unknown> | undefined) ?? {};
  const system = (hostInfo?.['system'] as Record<string, unknown> | undefined) ?? {};

  let databases: { name: string; sizeBytes: number }[] = [];
  try {
    const listed = await client.command({ listDatabases: 1 });
    const raw = Array.isArray(listed['databases'])
      ? (listed['databases'] as Record<string, unknown>[])
      : [];
    databases = raw.map((db) => ({
      name: String(db['name'] ?? ''),
      sizeBytes: Number(db['sizeOnDisk'] ?? 0),
    }));
  } catch (error) {
    notes.push({
      domain: 'disk',
      level: 'warn',
      message:
        `listDatabases falló: ${error instanceof Error ? error.message : String(error)}. ` +
        'Hace falta rol clusterMonitor o similar.',
    });
  }

  const replication = [];
  if (hello['setName']) {
    replication.push({
      role: (hello['isWritablePrimary'] || hello['ismaster'] ? 'primary' : 'replica') as
        | 'primary'
        | 'replica',
      peer: String(hello['setName']),
      state: String(hello['me'] ?? ''),
      detail: { hosts: hello['hosts'] },
    });
  } else {
    notes.push({
      domain: 'replication',
      level: 'info',
      message: 'No replica set: this MongoDB node is standalone.',
    });
  }

  notes.push({
    domain: 'engine',
    level: 'info',
    message:
      'MongoDB: serverStatus, dbStats, currentOp (Sessions/Locks), top namespaces. ' +
      'No SQL query profiler (by design — use currentOp slow ops and Atlas/profiler externally if needed).',
  });

  return {
    engine: {
      engine: 'mongodb',
      versionNum,
      versionText,
      edition: Array.isArray(build['modules'])
        ? (build['modules'] as string[]).join(',') || null
        : null,
      startedAt:
        Number(status['uptime'] ?? 0) > 0
          ? new Date(Date.now() - Number(status['uptime']) * 1000)
          : null,
      cores: system['numCores'] != null ? Number(system['numCores']) : null,
      memoryBytes: mem['resident'] != null ? Number(mem['resident']) * 1024 * 1024 : null,
      eolDate: eolFor('mongodb', versionText),
    },
    settings: [
      {
        name: 'connections.current',
        value: String(connections['current'] ?? ''),
        category: 'connections',
      },
      {
        name: 'connections.available',
        value: String(connections['available'] ?? ''),
        category: 'connections',
      },
      {
        name: 'storageEngine',
        value: String(
          (status['storageEngine'] as Record<string, unknown> | undefined)?.['name'] ?? 'unknown',
        ),
        category: 'storage',
      },
    ],
    disks: databases.map((db) => ({
      kind: 'database' as const,
      name: db.name,
      sizeBytes: db.sizeBytes,
      usedBytes: db.sizeBytes,
    })),
    replication,
    backups: [],
    jobs: [],
    licensing: {
      edition: 'Community/Enterprise',
      productionOk: true,
      note: 'MongoDB Community es libre; Enterprise se licencia aparte.',
    },
    notes,
  };
}
