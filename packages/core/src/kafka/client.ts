/**
 * Kafka Admin handle for Búho (kafkajs).
 * Commands are JSON docs: { kafka: "describeCluster"|"listTopics"|"groupLag"|… }.
 */
import type { InstanceConfig } from '../types';

export interface KafkaHandle {
  command(cmd: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

function brokersOf(instance: InstanceConfig): string[] {
  const fromCfg = instance.kafka?.brokers ?? instance.cdc?.kafka?.brokers;
  if (fromCfg && fromCfg.length > 0) return fromCfg;
  return [`${instance.host}:${instance.port || 9092}`];
}

function groupsOf(instance: InstanceConfig): string[] {
  if (instance.engine === 'cdc') {
    return (
      instance.cdc?.applyGroups ??
      instance.cdc?.kafka?.consumerGroups ??
      instance.kafka?.consumerGroups ??
      []
    );
  }
  return instance.kafka?.consumerGroups ?? [];
}

export async function createKafkaHandle(
  instance: InstanceConfig,
  connectTimeoutMs: number,
): Promise<KafkaHandle> {
  const { Kafka } = await import('kafkajs');
  const kcfg = instance.engine === 'cdc' ? instance.cdc?.kafka ?? instance.kafka : instance.kafka;
  const brokers = brokersOf(instance);

  let sasl:
    | { mechanism: 'plain'; username: string; password: string }
    | { mechanism: 'scram-sha-256'; username: string; password: string }
    | { mechanism: 'scram-sha-512'; username: string; password: string }
    | undefined;
  if (kcfg?.sasl) {
    const m = kcfg.sasl.mechanism;
    sasl = { mechanism: m, username: kcfg.sasl.username, password: kcfg.sasl.password } as typeof sasl;
  } else if (instance.user && instance.password) {
    sasl = { mechanism: 'plain', username: instance.user, password: instance.password };
  }

  const kafka = new Kafka({
    clientId: kcfg?.clientId ?? `buho-${instance.alias}`,
    brokers,
    connectionTimeout: connectTimeoutMs,
    ssl: kcfg?.ssl || instance.ssl || undefined,
    sasl,
  });
  const admin = kafka.admin();
  await admin.connect();

  const defaultGroups = groupsOf(instance);
  const topicsFilter = instance.cdc?.topics ?? [];
  const healthUrl = instance.cdc?.datasyncHealthUrl;

  async function runCommand(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    const op = String(cmd['kafka'] ?? cmd['op'] ?? '');
    if (op === 'describeCluster' || op === 'cluster') {
      const desc = await admin.describeCluster();
      return {
        clusterId: desc.clusterId,
        controller: desc.controller,
        brokers: desc.brokers.map((b) => ({
          nodeId: b.nodeId,
          host: b.host,
          port: b.port,
        })),
      };
    }
    if (op === 'listTopics' || op === 'topics') {
      const topics = await admin.listTopics();
      const filtered =
        topicsFilter.length > 0 ? topics.filter((t) => topicsFilter.includes(t)) : topics;
      return { topics: filtered };
    }
    if (op === 'describeTopics') {
      const names =
        (Array.isArray(cmd['topics']) ? (cmd['topics'] as string[]) : null) ??
        (topicsFilter.length > 0 ? topicsFilter : await admin.listTopics());
      const meta = await admin.fetchTopicMetadata({ topics: names.slice(0, 200) });
      const underReplicated: unknown[] = [];
      const partitions: unknown[] = [];
      for (const t of meta.topics) {
        for (const p of t.partitions) {
          partitions.push({
            topic: t.name,
            partition: p.partitionId,
            leader: p.leader,
            replicas: p.replicas,
            isr: p.isr,
          });
          if (p.isr.length < p.replicas.length) {
            underReplicated.push({
              topic: t.name,
              partition: p.partitionId,
              replicas: p.replicas.length,
              isr: p.isr.length,
            });
          }
        }
      }
      return { topics: meta.topics.length, partitions, underReplicated };
    }
    if (op === 'groupLag' || op === 'lag') {
      const groups =
        (Array.isArray(cmd['groups']) ? (cmd['groups'] as string[]) : null) ?? defaultGroups;
      if (groups.length === 0) {
        return { groups: [], note: 'No consumerGroups configured on this instance.' };
      }
      const out: unknown[] = [];
      for (const groupId of groups) {
        try {
          const offsets = await admin.fetchOffsets({ groupId });
          let lagTotal = 0;
          const parts: unknown[] = [];
          for (const topic of offsets) {
            for (const p of topic.partitions) {
              const offset = Number(p.offset);
              const hw = await admin.fetchTopicOffsets(topic.topic);
              const hp = hw.find((x) => x.partition === p.partition);
              const high = hp ? Number(hp.high) : offset;
              const lag = Math.max(0, high - offset);
              lagTotal += lag;
              parts.push({
                topic: topic.topic,
                partition: p.partition,
                offset,
                high,
                lag,
              });
            }
          }
          out.push({ groupId, lagTotal, partitions: parts });
        } catch (err) {
          out.push({
            groupId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { groups: out };
    }
    if (op === 'listGroups') {
      const g = await admin.listGroups();
      return {
        groups: g.groups.map((x) => ({ groupId: x.groupId, protocolType: x.protocolType })),
      };
    }
    if (op === 'datasyncHealth' || op === 'cdcHealth') {
      if (!healthUrl) return { configured: false };
      try {
        const ctrl = AbortSignal.timeout(5_000);
        const res = await fetch(healthUrl, { signal: ctrl });
        const text = await res.text();
        return {
          configured: true,
          ok: res.ok,
          status: res.status,
          body: text.slice(0, 2000),
        };
      } catch (err) {
        return {
          configured: true,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (op === 'snapshot') {
      const cluster = await runCommand({ kafka: 'describeCluster' });
      const topics = await runCommand({ kafka: 'listTopics' });
      const lag = await runCommand({ kafka: 'groupLag' });
      const ur = await runCommand({ kafka: 'describeTopics' });
      const health =
        instance.engine === 'cdc' ? await runCommand({ kafka: 'cdcHealth' }) : {};
      return { cluster, topics, lag, underReplicated: ur['underReplicated'], health };
    }
    throw new Error(`comando Kafka desconocido: ${op}`);
  }

  return {
    command: runCommand,
    async close() {
      await admin.disconnect();
    },
  };
}
