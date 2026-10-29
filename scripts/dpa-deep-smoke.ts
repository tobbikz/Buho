/**
 * Smoke after collector restart: PG waits/locks/fingerprints + physical + failover drills.
 * Usage: BUHO_STORE_URL=... BUHO_CONFIG=config.json npx tsx scripts/dpa-deep-smoke.ts
 */
import { readFileSync } from 'node:fs';
import {
  createPool,
  runFailoverDrill,
  runPhysicalRestoreDrill,
  fingerprintPlan,
  runExplain,
} from '@buho/core';
import {
  INTEGRITY_PROBE_SQL,
  fkCatalogRowsToProbes,
  fkOrphanProbeSql,
  integrityCheckResults,
} from '@buho/checks';
import { Store } from '@buho/store';
import { tagged } from '@buho/core';

const storeUrl = process.env.BUHO_STORE_URL ?? 'postgres://buho:buho@127.0.0.1:55432/buho';
const configPath = process.env.BUHO_CONFIG ?? 'config.json';

async function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    instances: Array<{
      alias: string;
      engine: string;
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      ssl?: boolean;
    }>;
  };
  const pg = config.instances.find((i) => i.alias === 'pg-lab');
  if (!pg) throw new Error('pg-lab missing');

  const store = new Store(storeUrl);
  const pool = createPool(
    {
      alias: pg.alias,
      engine: 'postgres',
      host: pg.host,
      port: pg.port,
      database: pg.database,
      user: pg.user,
      password: pg.password,
      ssl: pg.ssl,
    },
    { statementTimeoutMs: 60_000, connectTimeoutMs: 8_000 },
  );

  try {
    const instanceId = await store.upsertInstance({
      alias: pg.alias,
      engine: 'postgres',
      host: pg.host,
      port: pg.port,
      database: pg.database,
      user: pg.user,
      password: pg.password,
      environment: 'lab',
    });

    const phys = await runPhysicalRestoreDrill({ instanceAlias: pg.alias }, pool);
    const failover = await runFailoverDrill(pool);

    const catalog = await pool.query(tagged(INTEGRITY_PROBE_SQL.fkCatalog));
    const probes = fkCatalogRowsToProbes(catalog.rows as Array<Record<string, unknown>>).slice(0, 5);
    let orphanFindings = 0;
    for (const probe of probes) {
      try {
        const r = await pool.query(tagged(fkOrphanProbeSql(probe)));
        orphanFindings += integrityCheckResults('fk_orphan', r.rows as never).length;
      } catch {
        /* skip inaccessible FKs */
      }
    }

    const report = await runExplain(pool, 'select 1', { analyze: false, timeoutMs: 10_000 });
    await store.savePlanFingerprint({
      instanceId,
      queryid: 9_001,
      fingerprint: fingerprintPlan(report.root),
      planText: report.text,
      totalCost: report.totalCost,
    });

    const waits = await store.listWaitClassShare(instanceId, 30);
    const fps = await store.listPlanFingerprints(instanceId, 9_001, 3);

    const mssql = config.instances.find((i) => i.alias === 'mssql-lab');
    console.log(
      JSON.stringify(
        {
          ok: phys.ok,
          physical: phys.message,
          failover: { ok: failover.ok, message: failover.message },
          fkProbesTried: probes.length,
          orphanFindings,
          waitClasses30m: waits.length,
          fingerprints: fps.length,
          mssqlConfigured: Boolean(mssql),
          note: 'Oracle auto-plans need oracle-lab up + instance in config',
        },
        null,
        2,
      ),
    );
    if (!phys.ok) process.exitCode = 1;
  } finally {
    await pool.end();
    await store.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
