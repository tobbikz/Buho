import type { Sample } from '../types';
import type { ForeignCollector } from './types';
import { num, str } from './types';

/**
 * Métricas de MongoDB.
 *
 * Mongo no habla SQL: los colectores usan `command` (serverStatus, dbStats,
 * collStats) en vez de `sql`. Los nombres de métrica se alinean con PostgreSQL
 * cuando miden lo mismo (`connections_total`, `uptime_seconds`); lo que no
 * tiene equivalente honesto se queda con nombre de Mongo.
 *
 * Alcance deliberado de la primera entrega: disponibilidad, conexiones,
 * opcounters, memoria y tamaño. Sin query profiler (caro y ruidoso) ni
 * sharding detallado todavía.
 */

function flattenServerStatus(doc: Record<string, unknown>): Sample[] {
  const connections = (doc['connections'] as Record<string, unknown> | undefined) ?? {};
  const opcounters = (doc['opcounters'] as Record<string, unknown> | undefined) ?? {};
  const mem = (doc['mem'] as Record<string, unknown> | undefined) ?? {};
  const network = (doc['network'] as Record<string, unknown> | undefined) ?? {};
  const metrics = (doc['metrics'] as Record<string, unknown> | undefined) ?? {};
  const cursor = (metrics['cursor'] as Record<string, unknown> | undefined) ?? {};
  const open = (cursor['open'] as Record<string, unknown> | undefined) ?? {};
  const wiredTiger = (doc['wiredTiger'] as Record<string, unknown> | undefined) ?? {};
  const cache = (wiredTiger['cache'] as Record<string, unknown> | undefined) ?? {};

  const samples: Sample[] = [
    { metric: 'uptime_seconds', value: num(doc['uptime']) },
    { metric: 'connections_total', value: num(connections['current']) },
    { metric: 'connections_available', value: num(connections['available']) },
    { metric: 'connections_active', value: num(connections['active']) },
    // Contadores: el DeltaEngine deriva _per_sec.
    { metric: 'mongo_op_insert', value: num(opcounters['insert']), counter: true },
    { metric: 'mongo_op_query', value: num(opcounters['query']), counter: true },
    { metric: 'mongo_op_update', value: num(opcounters['update']), counter: true },
    { metric: 'mongo_op_delete', value: num(opcounters['delete']), counter: true },
    { metric: 'mongo_op_getmore', value: num(opcounters['getmore']), counter: true },
    { metric: 'mongo_op_command', value: num(opcounters['command']), counter: true },
    { metric: 'mongo_mem_resident_mb', value: num(mem['resident']) },
    { metric: 'mongo_mem_virtual_mb', value: num(mem['virtual']) },
    { metric: 'mongo_net_in_bytes', value: num(network['bytesIn']), counter: true },
    { metric: 'mongo_net_out_bytes', value: num(network['bytesOut']), counter: true },
    { metric: 'mongo_cursors_open', value: num(open['total']) },
  ];

  const max = num(connections['current']) + num(connections['available']);
  if (max > 0) {
    samples.push({
      metric: 'connections_used_pct',
      value: (num(connections['current']) / max) * 100,
    });
  }

  // Cache hit aproximado de WiredTiger: páginas pedidas vs leídas de disco.
  const pagesRead = num(cache['pages read into cache']);
  const pagesRequested = num(cache['pages requested from the cache']);
  if (pagesRequested > 0) {
    samples.push({
      metric: 'db_cache_hit_pct',
      value: Math.max(0, Math.min(100, (1 - pagesRead / pagesRequested) * 100)),
    });
  }

  return samples;
}

const serverStatus: ForeignCollector = {
  id: 'mongo_server_status',
  tier: 'fast',
  description: 'serverStatus: conexiones, ops, memoria, red',
  command: () => ({
    serverStatus: 1,
    // Recortar secciones pesadas que no usamos.
    repl: 0,
    metrics: 1,
    wiredTiger: 1,
  }),
  toSamples: (rows) => flattenServerStatus(rows[0] ?? {}),
};

const dbStats: ForeignCollector = {
  id: 'mongo_db_stats',
  tier: 'normal',
  description: 'dbStats: tamaño de la base configurada',
  command: () => ({ dbStats: 1, scale: 1 }),
  toSamples: (rows, caps) => {
    const doc = rows[0] ?? {};
    const db = str(doc['db'], caps.serverName);
    return [
      {
        metric: 'database_size_bytes',
        value: num(doc['dataSize']) + num(doc['indexSize']),
        labels: { database: db },
      },
      {
        metric: 'mongo_data_size_bytes',
        value: num(doc['dataSize']),
        labels: { database: db },
      },
      {
        metric: 'mongo_index_size_bytes',
        value: num(doc['indexSize']),
        labels: { database: db },
      },
      {
        metric: 'mongo_collections',
        value: num(doc['collections']),
        labels: { database: db },
      },
      {
        metric: 'mongo_objects',
        value: num(doc['objects']),
        labels: { database: db },
      },
    ];
  },
};

const replStatus: ForeignCollector = {
  id: 'mongo_repl_status',
  tier: 'normal',
  description: 'Estado del replica set, si existe',
  appliesTo: (caps) => caps.features.alwaysOn, // reutilizamos la bandera "hay clúster"
  command: () => ({ replSetGetStatus: 1 }),
  toSamples: (rows) => {
    const doc = rows[0] ?? {};
    const members = Array.isArray(doc['members']) ? (doc['members'] as Record<string, unknown>[]) : [];
    const primary = members.find((m) => num(m['state']) === 1);
    const self = members.find((m) => m['self'] === true) ?? members[0];
    const samples: Sample[] = [
      { metric: 'mongo_repl_members', value: members.length },
    ];
    if (self) {
      samples.push({ metric: 'mongo_repl_state', value: num(self['state']) });
      // Lag aproximado: optimeDate del primario vs self.
      if (primary && self !== primary) {
        const p = primary['optimeDate'] instanceof Date ? primary['optimeDate'].getTime() : 0;
        const s = self['optimeDate'] instanceof Date ? (self['optimeDate'] as Date).getTime() : 0;
        if (p > 0 && s > 0) {
          samples.push({ metric: 'replication_lag_seconds', value: Math.max(0, (p - s) / 1000) });
        }
      }
    }
    return samples;
  },
};

export const MONGODB_COLLECTORS: ForeignCollector[] = [serverStatus, dbStats, replStatus];
