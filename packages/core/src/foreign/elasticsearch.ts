import type { Sample } from '../types';
import type { ForeignCollector } from './types';
import { num, str } from './types';

/**
 * Elasticsearch DBA metrics via cluster/nodes/indices APIs (command docs).
 */

function flattenHealth(doc: Record<string, unknown>): Sample[] {
  const status = str(doc['status'], 'unknown');
  const statusCode = status === 'green' ? 0 : status === 'yellow' ? 1 : 2;
  return [
    { metric: 'es_cluster_status', value: statusCode },
    { metric: 'es_number_of_nodes', value: num(doc['number_of_nodes']) },
    { metric: 'es_number_of_data_nodes', value: num(doc['number_of_data_nodes']) },
    { metric: 'es_active_primary_shards', value: num(doc['active_primary_shards']) },
    { metric: 'es_active_shards', value: num(doc['active_shards']) },
    { metric: 'es_relocating_shards', value: num(doc['relocating_shards']) },
    { metric: 'es_initializing_shards', value: num(doc['initializing_shards']) },
    { metric: 'es_unassigned_shards', value: num(doc['unassigned_shards']) },
    { metric: 'es_delayed_unassigned_shards', value: num(doc['delayed_unassigned_shards']) },
    { metric: 'es_active_shards_pct', value: num(doc['active_shards_percent_as_number']) },
    { metric: 'es_task_max_waiting_ms', value: num(doc['task_max_waiting_in_queue_millis']) },
  ];
}

function flattenNodeStats(doc: Record<string, unknown>): Sample[] {
  const nodes = (doc['nodes'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const samples: Sample[] = [];
  let jvmHeapUsed = 0;
  let jvmHeapMax = 0;
  let docsCount = 0;
  let storeBytes = 0;
  let searchQuery = 0;
  let indexingIndex = 0;
  let httpCurrent = 0;
  let cpu = 0;
  let nodeCount = 0;

  for (const [nodeId, node] of Object.entries(nodes)) {
    nodeCount += 1;
    const name = str(node['name'], nodeId).slice(0, 40);
    const labels = { node: name };
    const jvm = (node['jvm'] as Record<string, unknown> | undefined) ?? {};
    const mem = (jvm['mem'] as Record<string, unknown> | undefined) ?? {};
    const heapUsed = num(mem['heap_used_in_bytes']);
    const heapMax = num(mem['heap_max_in_bytes']);
    jvmHeapUsed += heapUsed;
    jvmHeapMax += heapMax;
    samples.push({ metric: 'es_jvm_heap_used_bytes', value: heapUsed, labels });
    if (heapMax > 0) {
      samples.push({
        metric: 'es_jvm_heap_used_pct',
        value: (heapUsed / heapMax) * 100,
        labels,
      });
    }

    const indices = (node['indices'] as Record<string, unknown> | undefined) ?? {};
    const docs = (indices['docs'] as Record<string, unknown> | undefined) ?? {};
    const store = (indices['store'] as Record<string, unknown> | undefined) ?? {};
    const search = (indices['search'] as Record<string, unknown> | undefined) ?? {};
    const indexing = (indices['indexing'] as Record<string, unknown> | undefined) ?? {};
    docsCount += num(docs['count']);
    storeBytes += num(store['size_in_bytes']);
    searchQuery += num(search['query_total']);
    indexingIndex += num(indexing['index_total']);

    const os = (node['os'] as Record<string, unknown> | undefined) ?? {};
    const cpuObj = (os['cpu'] as Record<string, unknown> | undefined) ?? {};
    cpu += num(cpuObj['percent']);

    const http = (node['http'] as Record<string, unknown> | undefined) ?? {};
    httpCurrent += num(http['current_open']);

    const fs = (node['fs'] as Record<string, unknown> | undefined) ?? {};
    const fsTotal = (fs['total'] as Record<string, unknown> | undefined) ?? {};
    const total = num(fsTotal['total_in_bytes']);
    const available = num(fsTotal['available_in_bytes']);
    if (total > 0) {
      samples.push({
        metric: 'es_fs_used_pct',
        value: ((total - available) / total) * 100,
        labels,
      });
    }
  }

  samples.push({ metric: 'es_docs_count', value: docsCount });
  samples.push({ metric: 'database_size_bytes', value: storeBytes, labels: { database: 'elasticsearch' } });
  samples.push({ metric: 'es_store_bytes', value: storeBytes });
  samples.push({ metric: 'es_search_query_total', value: searchQuery, counter: true });
  samples.push({ metric: 'es_indexing_index_total', value: indexingIndex, counter: true });
  samples.push({ metric: 'connections_total', value: httpCurrent });
  samples.push({ metric: 'connections_active', value: httpCurrent });
  samples.push({ metric: 'es_http_current_open', value: httpCurrent });
  if (jvmHeapMax > 0) {
    samples.push({ metric: 'es_jvm_heap_used_bytes_total', value: jvmHeapUsed });
    samples.push({
      metric: 'es_jvm_heap_used_pct_avg',
      value: (jvmHeapUsed / jvmHeapMax) * 100,
    });
  }
  if (nodeCount > 0) {
    samples.push({ metric: 'es_os_cpu_pct_avg', value: cpu / nodeCount });
  }
  return samples;
}

const health: ForeignCollector = {
  id: 'es_cluster_health',
  tier: 'fast',
  description: 'cluster.health',
  command: () => ({ es: 'cluster.health' }),
  toSamples: (rows) => flattenHealth(rows[0] ?? {}),
};

const nodeStats: ForeignCollector = {
  id: 'es_nodes_stats',
  tier: 'fast',
  description: 'nodes.stats jvm/indices/os/fs/http',
  command: () => ({ es: 'nodes.stats' }),
  toSamples: (rows) => flattenNodeStats(rows[0] ?? {}),
};

const clusterStats: ForeignCollector = {
  id: 'es_cluster_stats',
  tier: 'normal',
  description: 'cluster.stats aggregate',
  command: () => ({ es: 'cluster.stats' }),
  toSamples: (rows) => {
    const doc = rows[0] ?? {};
    const indices = (doc['indices'] as Record<string, unknown> | undefined) ?? {};
    const count = (indices['count'] as number | undefined) ?? num(indices['count']);
    const docs = (indices['docs'] as Record<string, unknown> | undefined) ?? {};
    const store = (indices['store'] as Record<string, unknown> | undefined) ?? {};
    const shards = (indices['shards'] as Record<string, unknown> | undefined) ?? {};
    return [
      { metric: 'es_indices_count', value: num(count) },
      { metric: 'es_docs_count', value: num(docs['count']) },
      { metric: 'es_store_bytes', value: num(store['size_in_bytes']) },
      { metric: 'es_shards_total', value: num(shards['total']) },
      { metric: 'es_shards_primaries', value: num(shards['primaries']) },
      {
        metric: 'database_size_bytes',
        value: num(store['size_in_bytes']),
        labels: { database: 'elasticsearch' },
      },
    ];
  },
};

const indices: ForeignCollector = {
  id: 'es_cat_indices',
  tier: 'slow',
  description: 'Per-index docs and store size',
  command: () => ({ es: 'cat.indices' }),
  toSamples: (rows) => {
    const list = Array.isArray(rows[0]?.['indices'])
      ? (rows[0]!['indices'] as Record<string, unknown>[])
      : [];
    return list.slice(0, 40).map((idx) => ({
      metric: 'database_size_bytes',
      value: num(idx['store_bytes'] ?? idx['store.size']),
      labels: { database: str(idx['index'], '(index)') },
    }));
  },
};

const pendingTasks: ForeignCollector = {
  id: 'es_pending_tasks',
  tier: 'fast',
  description: 'cluster pending tasks',
  command: () => ({ es: 'cluster.pending_tasks' }),
  toSamples: (rows) => {
    const tasks = Array.isArray(rows[0]?.['tasks']) ? (rows[0]!['tasks'] as unknown[]) : [];
    return [{ metric: 'es_pending_tasks', value: tasks.length }];
  },
};

export const ELASTICSEARCH_COLLECTORS: ForeignCollector[] = [
  health,
  nodeStats,
  clusterStats,
  indices,
  pendingTasks,
];
