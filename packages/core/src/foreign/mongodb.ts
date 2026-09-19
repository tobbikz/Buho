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
 * Alcance: disponibilidad, conexiones, opcounters, memoria, WT cache/tickets,
 * asserts, document metrics, currentOp gauges, top namespaces, replica set.
 * Sesiones/bloqueos viven en mongodb-ops.ts (currentOp).
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
  const concurrent =
    (wiredTiger['concurrentTransactions'] as Record<string, unknown> | undefined) ?? {};
  const readTickets = (concurrent['read'] as Record<string, unknown> | undefined) ?? {};
  const writeTickets = (concurrent['write'] as Record<string, unknown> | undefined) ?? {};
  const globalLock = (doc['globalLock'] as Record<string, unknown> | undefined) ?? {};
  const currentQueue = (globalLock['currentQueue'] as Record<string, unknown> | undefined) ?? {};
  const activeClients = (globalLock['activeClients'] as Record<string, unknown> | undefined) ?? {};

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
    { metric: 'mongo_global_lock_queue', value: num(currentQueue['total']) },
    { metric: 'mongo_global_lock_readers', value: num(currentQueue['readers']) },
    { metric: 'mongo_global_lock_writers', value: num(currentQueue['writers']) },
    { metric: 'mongo_active_clients', value: num(activeClients['total']) },
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

  const cacheMax = num(cache['maximum bytes configured']);
  const cacheUsed = num(cache['bytes currently in the cache']);
  if (cacheMax > 0) {
    samples.push({ metric: 'mongo_wt_cache_max_bytes', value: cacheMax });
    samples.push({ metric: 'mongo_wt_cache_used_bytes', value: cacheUsed });
    samples.push({
      metric: 'mongo_wt_cache_used_pct',
      value: (cacheUsed / cacheMax) * 100,
    });
  }

  // Tickets: available/out/total — out alto = saturación de concurrencia WT.
  const readOut = num(readTickets['out']);
  const readTotal = num(readTickets['total']);
  const writeOut = num(writeTickets['out']);
  const writeTotal = num(writeTickets['total']);
  if (readTotal > 0 || writeTotal > 0) {
    samples.push({ metric: 'mongo_tickets_read_out', value: readOut });
    samples.push({ metric: 'mongo_tickets_read_available', value: num(readTickets['available']) });
    samples.push({ metric: 'mongo_tickets_write_out', value: writeOut });
    samples.push({ metric: 'mongo_tickets_write_available', value: num(writeTickets['available']) });
    if (readTotal > 0) {
      samples.push({
        metric: 'mongo_tickets_read_used_pct',
        value: (readOut / readTotal) * 100,
      });
    }
    if (writeTotal > 0) {
      samples.push({
        metric: 'mongo_tickets_write_used_pct',
        value: (writeOut / writeTotal) * 100,
      });
    }
  }

  // Asserts + document metrics (Superset Mongo intent).
  const asserts = (doc['asserts'] as Record<string, unknown> | undefined) ?? {};
  samples.push({ metric: 'mongo_asserts_regular', value: num(asserts['regular']), counter: true });
  samples.push({ metric: 'mongo_asserts_warning', value: num(asserts['warning']), counter: true });
  samples.push({ metric: 'mongo_asserts_msg', value: num(asserts['msg']), counter: true });
  samples.push({ metric: 'mongo_asserts_user', value: num(asserts['user']), counter: true });

  const document = (metrics['document'] as Record<string, unknown> | undefined) ?? {};
  samples.push({ metric: 'db_tup_inserted', value: num(document['inserted']), counter: true });
  samples.push({ metric: 'db_tup_updated', value: num(document['updated']), counter: true });
  samples.push({ metric: 'db_tup_deleted', value: num(document['deleted']), counter: true });
  samples.push({ metric: 'db_tup_fetched', value: num(document['returned']), counter: true });

  const queryExecutor = (metrics['queryExecutor'] as Record<string, unknown> | undefined) ?? {};
  samples.push({
    metric: 'mongo_scanned_objects',
    value: num(queryExecutor['scannedObjects']),
    counter: true,
  });
  samples.push({
    metric: 'mongo_scanned_keys',
    value: num(queryExecutor['scanned']),
    counter: true,
  });

  const opLatencies = (doc['opLatencies'] as Record<string, unknown> | undefined) ?? {};
  for (const kind of ['reads', 'writes', 'commands'] as const) {
    const bucket = (opLatencies[kind] as Record<string, unknown> | undefined) ?? {};
    const latency = num(bucket['latency']);
    const ops = num(bucket['ops']);
    if (ops > 0) {
      samples.push({
        metric: `mongo_op_latency_${kind}_us`,
        value: latency / ops,
      });
    }
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
  appliesTo: (caps) => caps.features.alwaysOn,
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

const currentOpGauge: ForeignCollector = {
  id: 'mongo_current_op',
  tier: 'fast',
  description: 'Active / waiting / slow ops from currentOp',
  command: () => ({ currentOp: 1, active: true }),
  toSamples: (rows) => {
    const doc = rows[0] ?? {};
    const inprog = Array.isArray(doc['inprog']) ? (doc['inprog'] as Record<string, unknown>[]) : [];
    let active = 0;
    let waiting = 0;
    let slow = 0;
    let longestSec = 0;
    for (const op of inprog) {
      if (str(op['op'], '') === 'none' && !op['waitingForLock']) continue;
      active += 1;
      if (op['waitingForLock'] === true) waiting += 1;
      const secs = num(op['secs_running']);
      if (secs >= 1) slow += 1;
      if (secs > longestSec) longestSec = secs;
    }
    return [
      { metric: 'mongo_ops_active', value: active },
      { metric: 'mongo_ops_waiting_lock', value: waiting },
      { metric: 'mongo_ops_slow', value: slow },
      { metric: 'mongo_ops_longest_seconds', value: longestSec },
      { metric: 'blocked_sessions', value: waiting },
    ];
  },
};

const topNamespaces: ForeignCollector = {
  id: 'mongo_top',
  tier: 'normal',
  description: 'Hot namespaces from top command',
  command: () => ({ top: 1 }),
  toSamples: (rows) => {
    const doc = rows[0] ?? {};
    const totals = (doc['totals'] as Record<string, unknown> | undefined) ?? {};
    const samples: Sample[] = [];
    const scored: { ns: string; total: number; read: number; write: number }[] = [];
    for (const [ns, raw] of Object.entries(totals)) {
      if (ns === 'note' || typeof raw !== 'object' || !raw) continue;
      const row = raw as Record<string, unknown>;
      const total = num((row['total'] as Record<string, unknown> | undefined)?.['time']);
      const read = num((row['readLock'] as Record<string, unknown> | undefined)?.['time']);
      const write = num((row['writeLock'] as Record<string, unknown> | undefined)?.['time']);
      if (total <= 0 && read <= 0 && write <= 0) continue;
      scored.push({ ns, total: total || read + write, read, write });
    }
    scored.sort((a, b) => b.total - a.total);
    for (const row of scored.slice(0, 20)) {
      const dot = row.ns.indexOf('.');
      const database = dot >= 0 ? row.ns.slice(0, dot) : row.ns;
      const collection = dot >= 0 ? row.ns.slice(dot + 1) : '(db)';
      const labels = { schema: database, table: collection, database };
      samples.push({ metric: 'mongo_ns_total_time', value: row.total, labels, counter: true });
      samples.push({ metric: 'mongo_ns_read_time', value: row.read, labels, counter: true });
      samples.push({ metric: 'mongo_ns_write_time', value: row.write, labels, counter: true });
    }
    return samples;
  },
};

const allDbSizes: ForeignCollector = {
  id: 'mongo_list_databases',
  tier: 'slow',
  description: 'Size of every database (listDatabases)',
  command: () => ({ listDatabases: 1 }),
  toSamples: (rows) => {
    const listed = rows[0] ?? {};
    const raw = Array.isArray(listed['databases'])
      ? (listed['databases'] as Record<string, unknown>[])
      : [];
    return raw.map((db) => ({
      metric: 'database_size_bytes',
      value: num(db['sizeOnDisk']),
      labels: { database: str(db['name'], '(unnamed)') },
    }));
  },
};

export const MONGODB_COLLECTORS: ForeignCollector[] = [
  serverStatus,
  dbStats,
  replStatus,
  currentOpGauge,
  topNamespaces,
  allDbSizes,
];
