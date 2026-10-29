/**
 * W1 Kafka/CDC + W2 Airflow smoke against the light platform lab.
 * Prerequisites:
 *   docker compose -f docker-compose.platform-lab.yml up -d
 *   npx tsx scripts/platform-lab-mocks.ts   # separate terminal
 *   BUHO_CONFIG=config.platform-lab.json npx tsx scripts/platform-w12-smoke.ts
 */
import { readFileSync } from 'node:fs';
import {
  openEngine,
  probeForeign,
  foreignCollectorsFor,
  runForeignCollectors,
  runAction,
  type InstanceConfig,
} from '@buho/core';
import { runForeignChecks, KAFKA_CHECKS, AIRFLOW_CHECKS, CDC_CHECKS } from '@buho/checks';
import { Store } from '@buho/store';

const configPath = process.env.BUHO_CONFIG ?? 'config.platform-lab.json';
const storeUrl = process.env.BUHO_STORE_URL ?? 'postgres://buho:buho@127.0.0.1:55432/buho';

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];

function pass(name: string, detail = 'ok') {
  rows.push({ name, ok: true, detail });
  console.log(`  ✓ ${name} — ${detail}`);
}
function fail(name: string, detail: string) {
  rows.push({ name, ok: false, detail });
  console.log(`  ✗ ${name} — ${detail}`);
}

async function seedKafkaTopic(brokers: string[]) {
  const { Kafka } = await import('kafkajs');
  const kafka = new Kafka({ clientId: 'buho-platform-smoke', brokers, connectionTimeout: 8_000 });
  const admin = kafka.admin();
  await admin.connect();
  try {
    const topics = await admin.listTopics();
    if (!topics.includes('buho.lab.events')) {
      await admin.createTopics({
        topics: [{ topic: 'buho.lab.events', numPartitions: 1, replicationFactor: 1 }],
      });
    }
  } finally {
    await admin.disconnect();
  }

  const producer = kafka.producer();
  await producer.connect();
  try {
    await producer.send({
      topic: 'buho.lab.events',
      messages: [{ key: 'smoke', value: JSON.stringify({ t: Date.now() }) }],
    });
  } finally {
    await producer.disconnect();
  }

  const consumer = kafka.consumer({ groupId: 'buho-lab-group' });
  await consumer.connect();
  try {
    await consumer.subscribe({ topic: 'buho.lab.events', fromBeginning: true });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => resolve(), 3_000);
      consumer
        .run({
          eachMessage: async () => {
            clearTimeout(t);
            resolve();
          },
        })
        .catch(reject);
    });
  } finally {
    await consumer.disconnect();
  }
}

async function probeEngine(name: string, instance: InstanceConfig) {
  const client = await openEngine(instance, { statementTimeoutMs: 15_000, connectTimeoutMs: 10_000 });
  try {
    const caps = await probeForeign(client);
    pass(`${name} probe`, `${caps.versionText} / ${caps.flavor}`);
    const collectors = foreignCollectorsFor(caps, 'normal');
    const collected = await runForeignCollectors(client, caps, collectors);
    pass(
      `${name} collectors`,
      `${collected.samples.length} samples / ${collected.errors.length} errors`,
    );
    for (const err of collected.errors.slice(0, 5)) {
      console.log(`    · collector warn ${err.collectorId}: ${err.message}`);
    }
    const checks = await runForeignChecks(client, caps);
    pass(
      `${name} checks`,
      `score=${checks.healthScore} findings=${checks.results.length} errors=${checks.errors.length}`,
    );
    return { samples: collected.samples, checks };
  } finally {
    await client.close();
  }
}

async function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { instances: InstanceConfig[] };
  const kafka = config.instances.find((i) => i.alias === 'kafka-lab');
  const cdc = config.instances.find((i) => i.alias === 'cdc-lab');
  const airflow = config.instances.find((i) => i.alias === 'airflow-mock');
  if (!kafka || !cdc || !airflow) throw new Error('config.platform-lab.json missing kafka/cdc/airflow');

  if (!(KAFKA_CHECKS.length && CDC_CHECKS.length && AIRFLOW_CHECKS.length)) {
    fail('check catalogs', 'missing exports');
  } else {
    pass(
      'check catalogs',
      `kafka=${KAFKA_CHECKS.length} cdc=${CDC_CHECKS.length} airflow=${AIRFLOW_CHECKS.length}`,
    );
  }

  console.log('\n== Seed Kafka topic/group ==');
  try {
    await seedKafkaTopic(kafka.kafka?.brokers ?? ['127.0.0.1:19092']);
    pass('kafka seed', 'buho.lab.events + buho-lab-group');
  } catch (e) {
    fail('kafka seed', e instanceof Error ? e.message : String(e));
  }

  console.log('\n== W1 Kafka ==');
  try {
    await probeEngine('kafka', kafka);
  } catch (e) {
    fail('kafka', e instanceof Error ? e.message : String(e));
  }

  console.log('\n== W1 CDC ==');
  try {
    await probeEngine('cdc', cdc);
  } catch (e) {
    fail('cdc', e instanceof Error ? e.message : String(e));
  }

  console.log('\n== W2 Airflow ==');
  try {
    await probeEngine('airflow', airflow);
    const pause = await runAction({
      kind: 'pause_dag',
      instance: airflow,
      actor: 'platform-w12-smoke',
      reason: 'platform-w12-smoke',
      dagId: 'demo',
    });
    if (pause.ok) pass('airflow pause_dag', pause.message);
    else fail('airflow pause_dag', pause.message);
  } catch (e) {
    fail('airflow', e instanceof Error ? e.message : String(e));
  }

  console.log('\n== Persist to store ==');
  const store = new Store(storeUrl);
  try {
    for (const inst of [kafka, cdc, airflow]) {
      const id = await store.upsertInstance(inst);
      pass(`upsert ${inst.alias}`, `instance_id=${id}`);
    }
  } catch (e) {
    fail('store upsert', e instanceof Error ? e.message : String(e));
  } finally {
    await store.close();
  }

  const failed = rows.filter((r) => !r.ok);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        passed: rows.filter((r) => r.ok).length,
        failed: failed.length,
        failures: failed,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
