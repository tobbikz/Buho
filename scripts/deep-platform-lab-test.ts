/**
 * Full Deep Platform + multi-engine lab harness.
 *
 *   npx tsx scripts/deep-platform-lab-test.ts
 *   npx tsx scripts/deep-platform-lab-test.ts --engine postgres
 *   npx tsx scripts/deep-platform-lab-test.ts --engine all
 */
import {
  openEngine,
  probeForeign,
  foreignCollectorsFor,
  runForeignCollectors,
  collectorsFor,
  runCollectors,
  createPool,
  probeCapabilities,
  waitClassOf,
  correlateWaitsWithSql,
  evaluateRpo,
  runRestoreDrill,
  runRestoreDrillStub,
  emitInstanceToDatahub,
  runAction,
  engineOf,
  type InstanceConfig,
} from '../packages/core/src/index';
import {
  runChecks,
  runForeignChecks,
  runCompliancePack,
  KAFKA_CHECKS,
  AIRFLOW_CHECKS,
  CDC_CHECKS,
} from '../packages/checks/src/index';
import { createServer } from 'node:http';
import { Store } from '../packages/store/src/index';

const args = process.argv.slice(2);
const engineFilter = (() => {
  const i = args.indexOf('--engine');
  return i >= 0 ? args[i + 1] : 'all';
})();

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function pass(name: string, detail = 'ok') {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name} — ${detail}`);
}
function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail });
  console.log(`  ✗ ${name} — ${detail}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

const STORE_URL = process.env.BUHO_STORE_URL ?? 'postgres://buho:buho@127.0.0.1:55432/buho';

const INSTANCES: Record<string, InstanceConfig> = {
  postgres: {
    alias: 'pg-lab',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 5435,
    database: 'datalake',
    user: 'buho_lab',
    password: 'Buho_Lab_Pg1!',
    actions: { enabled: true, allowKillSession: true, allowCancelQuery: true },
    backup: { rpoSeconds: 86_400 },
  },
  mariadb: {
    alias: 'maria-lab',
    engine: 'mariadb',
    host: '127.0.0.1',
    port: 3307,
    database: 'tienda',
    user: 'root',
    password: 'Buho_Maria_Root1!',
  },
  redis: {
    alias: 'redis-lab',
    engine: 'redis',
    host: '127.0.0.1',
    port: 6380,
    database: '0',
    user: '',
    password: 'Buho_Redis_Lab1!',
  },
  mongodb: {
    alias: 'mongo-lab',
    engine: 'mongodb',
    host: '127.0.0.1',
    port: 27018,
    database: 'admin',
    user: 'buho',
    password: 'Buho_Mongo_Lab1!',
  },
  kafka: {
    alias: 'kafka-lab',
    engine: 'kafka',
    host: '127.0.0.1',
    port: 19092,
    database: '',
    user: '',
    kafka: { brokers: ['127.0.0.1:19092'], consumerGroups: [] },
  },
  cdc: {
    alias: 'cdc-lab',
    engine: 'cdc',
    host: '127.0.0.1',
    port: 19092,
    database: '',
    user: '',
    cdc: {
      kafka: { brokers: ['127.0.0.1:19092'] },
      datasyncHealthUrl: 'http://127.0.0.1:18999/health',
      maxApplyLagSeconds: 60,
    },
  },
  airflow: {
    alias: 'airflow-mock',
    engine: 'airflow',
    host: '127.0.0.1',
    port: 18998,
    database: '',
    user: 'admin',
    password: 'admin',
    airflow: { baseUrl: 'http://127.0.0.1:18998', apiVersion: 'v1' },
    actions: { enabled: true, allowAirflowDagPause: true },
  },
  elasticsearch: {
    alias: 'es-lab',
    engine: 'elasticsearch',
    host: '127.0.0.1',
    port: 9200,
    database: '',
    user: '',
    password: '',
  },
  cassandra: {
    alias: 'cass-lab',
    engine: 'cassandra',
    host: '127.0.0.1',
    port: 9042,
    database: '',
    user: '',
    password: '',
    tags: { datacenter: 'datacenter1' },
  },
};

function startAirflowMock(): Promise<() => void> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');
      if (url.startsWith('/api/v1/health') || url === '/health') {
        res.end(JSON.stringify({ metadatabase: { status: 'healthy' }, scheduler: { status: 'healthy' } }));
        return;
      }
      if (url.startsWith('/api/v1/dags')) {
        res.end(
          JSON.stringify({
            dags: [
              { dag_id: 'demo', is_paused: false, has_import_errors: false },
              { dag_id: 'broken', is_paused: true, has_import_errors: true },
            ],
            total_entries: 2,
          }),
        );
        return;
      }
      if (url.startsWith('/api/v1/importErrors')) {
        res.end(JSON.stringify({ import_errors: [{ filename: 'x.py' }], total_entries: 1 }));
        return;
      }
      if (url.startsWith('/api/v1/pools')) {
        res.end(
          JSON.stringify({
            pools: [{ name: 'default', slots: 128, open_slots: 10, occupied_slots: 118 }],
          }),
        );
        return;
      }
      if (req.method === 'PATCH' && url.includes('/dags/')) {
        res.end(JSON.stringify({ is_paused: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: 'not found' }));
    });
    server.listen(18998, '127.0.0.1', () => {
      resolve(() => server.close());
    });
  });
}

function startDatasyncMock(): Promise<() => void> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
    });
    server.listen(18999, '127.0.0.1', () => resolve(() => server.close()));
  });
}

async function testStoreDeepTables() {
  console.log('\n== Store migrate + deep tables ==');
  const store = new Store(STORE_URL);
  const { Pool } = await import('pg');
  const probe = new Pool({ connectionString: STORE_URL, max: 1 });
  try {
    await store.migrate();
    pass('migrate', 'schema applied');
    for (const t of [
      'wait_class_samples',
      'plan_fingerprints',
      'action_audit',
      'backup_jobs',
      'backup_artifacts',
      'restore_drills',
      'compliance_runs',
      'lineage_sync_state',
    ]) {
      const r = await probe.query(`select to_regclass('buho.${t}') as reg`);
      if (r.rows[0]?.reg) pass(`table buho.${t}`);
      else fail(`table buho.${t}`, 'missing');
    }

    await store.recordActionAudit({
      alias: 'pg-lab',
      kind: 'lab_selftest',
      actor: 'deep-platform-lab-test',
      reason: 'harness',
      ok: true,
      message: 'audit insert ok',
    });
    pass('action_audit insert');

    const drill = await runRestoreDrill({
      instanceAlias: 'pg-lab',
      scratchDatabase: 'buho_drill',
      engine: 'postgres',
    });
    if (drill.ok) pass('restore drill agent', drill.message);
    else fail('restore drill agent', drill.message);
    // Keep stub export alive for callers that still import it.
    void runRestoreDrillStub;
  } catch (e) {
    fail('store deep', e instanceof Error ? e.message : String(e));
  } finally {
    await probe.end();
    await store.close();
  }
}

async function testPostgres() {
  console.log('\n== PostgreSQL (pg-lab :5435) ==');
  const instance = INSTANCES.postgres!;
  const pool = createPool(instance, { statementTimeoutMs: 15_000, connectTimeoutMs: 8_000 });
  try {
    const caps = await withTimeout(probeCapabilities(pool), 20_000, 'probeCapabilities');
    pass('probeCapabilities', caps.versionText);

    const collectors = collectorsFor(caps, 'normal');
    const collected = await withTimeout(
      runCollectors(pool, caps, collectors),
      30_000,
      'runCollectors',
    );
    pass(
      'collectors normal',
      `${collected.samples.length} samples, ${collected.errors.length} errors`,
    );
    if (collected.errors.length > 5) {
      fail('collector error budget', collected.errors.map((e) => e.collectorId).join(','));
    }

    const checks = await withTimeout(runChecks(pool, caps), 60_000, 'runChecks');
    pass(
      'runChecks',
      `score=${checks.healthScore} findings=${checks.results.length} errors=${checks.errors.length}`,
    );

    const cls = waitClassOf('postgres', 'IO', 'DataFileRead');
    if (cls === 'IO') pass('wait taxonomy', cls);
    else fail('wait taxonomy', cls);

    const blame = correlateWaitsWithSql(
      [{ waitType: 'Lock', sessions: 2 }],
      [{ queryid: 42, waitType: 'Lock' }],
      'postgres',
    );
    if (blame[0]?.queryid === 42) pass('wait/sql correlation');
    else fail('wait/sql correlation', JSON.stringify(blame));

    const rpo = evaluateRpo(
      [{ kind: 'full', finishedAt: new Date(), status: 'ok' }],
      86_400,
    );
    if (rpo.status === 'met') pass('evaluateRpo', rpo.message);
    else fail('evaluateRpo', rpo.message);

    const compliance = await withTimeout(
      runCompliancePack(
        { kind: 'postgres', query: async (sql) => (await pool.query(sql)).rows, close: async () => {} },
        'cis-postgres',
      ),
      30_000,
      'compliance',
    );
    pass('CIS postgres pack', `score=${compliance.score} controls=${compliance.controls.length}`);

    // cancel_query on a non-existent pid should return false without crashing
    const cancel = await runAction(
      {
        kind: 'cancel_query',
        instance,
        actor: 'lab',
        reason: 'deep-platform self-test',
        pid: 1,
      },
      pool,
    );
    pass('cancel_query action', cancel.message);

    const emit = await emitInstanceToDatahub({ ...instance, datahub: { emit: false } });
    if (!emit.attempted) pass('datahub emit disabled path');
    else fail('datahub emit disabled path', emit.message);
  } catch (e) {
    fail('postgres suite', e instanceof Error ? e.message : String(e));
  } finally {
    await pool.end();
  }
}

async function testForeign(name: string, instance: InstanceConfig) {
  console.log(`\n== ${name} (${instance.alias}) ==`);
  try {
    const client = await withTimeout(
      openEngine(instance, { statementTimeoutMs: 15_000, connectTimeoutMs: 8_000 }),
      25_000,
      `openEngine ${name}`,
    );
    try {
      const caps = await withTimeout(probeForeign(client), 20_000, `probe ${name}`);
      pass(`${name} probe`, `${caps.versionText} / ${caps.flavor}`);

      const collectors = foreignCollectorsFor(caps, 'normal');
      if (collectors.length > 0) {
        const result = await withTimeout(
          runForeignCollectors(client, caps, collectors),
          45_000,
          `collect ${name}`,
        );
        pass(
          `${name} collectors`,
          `${result.samples.length} samples / ${result.errors.length} errors`,
        );
        for (const err of result.errors.slice(0, 5)) {
          console.log(`    · collector warn ${err.collectorId}: ${err.message}`);
        }
      } else {
        pass(`${name} collectors`, 'none for normal tier');
      }

      const checks = await withTimeout(runForeignChecks(client, caps), 60_000, `checks ${name}`);
      pass(
        `${name} checks`,
        `score=${checks.healthScore} findings=${checks.results.length} errors=${checks.errors.length}`,
      );
    } finally {
      await client.close();
    }
  } catch (e) {
    fail(`${name} suite`, e instanceof Error ? e.message : String(e));
  }
}

async function testAirflowMock() {
  await testForeign('airflow', INSTANCES.airflow!);
  // pause action
  try {
    const r = await runAction({
      kind: 'pause_dag',
      instance: INSTANCES.airflow!,
      actor: 'lab',
      reason: 'deep-platform self-test',
      dagId: 'demo',
    });
    if (r.ok) pass('airflow pause_dag action', r.message);
    else fail('airflow pause_dag action', r.message);
  } catch (e) {
    fail('airflow pause_dag action', e instanceof Error ? e.message : String(e));
  }
}

async function testKafkaIfUp() {
  try {
    await testForeign('kafka', INSTANCES.kafka!);
    // CDC with health mock
    await testForeign('cdc', INSTANCES.cdc!);
    // ensure check catalogs export
    if (KAFKA_CHECKS.length && CDC_CHECKS.length && AIRFLOW_CHECKS.length) {
      pass('check catalogs exported', `kafka=${KAFKA_CHECKS.length} cdc=${CDC_CHECKS.length} airflow=${AIRFLOW_CHECKS.length}`);
    }
  } catch (e) {
    fail('kafka/cdc', e instanceof Error ? e.message : String(e));
  }
}

async function main() {
  console.log('Búho Deep Platform lab harness');
  console.log(`filter=${engineFilter} store=${STORE_URL}`);

  const stopAirflow = await startAirflowMock();
  const stopDs = await startDatasyncMock();

  try {
    await testStoreDeepTables();

    const want = (e: string) => engineFilter === 'all' || engineFilter === e;

    if (want('postgres')) await testPostgres();
    if (want('mariadb')) await testForeign('mariadb', INSTANCES.mariadb!);
    if (want('redis')) await testForeign('redis', INSTANCES.redis!);
    if (want('mongodb')) await testForeign('mongodb', INSTANCES.mongodb!);
    if (want('elasticsearch')) await testForeign('elasticsearch', INSTANCES.elasticsearch!);
    if (want('cassandra')) await testForeign('cassandra', INSTANCES.cassandra!);
    if (want('airflow') || engineFilter === 'all') await testAirflowMock();
    if (want('kafka') || want('cdc') || engineFilter === 'all') await testKafkaIfUp();

    // sanity: engineOf
    if (engineOf(INSTANCES.postgres!) === 'postgres') pass('engineOf postgres');
  } finally {
    stopAirflow();
    stopDs();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== SUMMARY ${results.length - failed.length}/${results.length} passed ====`);
  for (const f of failed) console.log(`FAIL ${f.name}: ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
