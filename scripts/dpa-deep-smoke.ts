/**
 * Smoke after collector restart: PG drills + Maria digest EXPLAIN + MSSQL Query Store.
 * Usage: BUHO_STORE_URL=... BUHO_CONFIG=config.lab-core.json npx tsx scripts/dpa-deep-smoke.ts
 */
import { readFileSync } from 'node:fs';
import {
  createPool,
  openEngine,
  runFailoverDrill,
  runPhysicalRestoreDrill,
  fingerprintPlan,
  rewriteMariadbPlaceholders,
  runExplain,
  runMariadbExplain,
  tagged,
} from '@buho/core';
import {
  INTEGRITY_PROBE_SQL,
  fkCatalogRowsToProbes,
  fkOrphanProbeSql,
  integrityCheckResults,
} from '@buho/checks';
import { Store } from '@buho/store';

const storeUrl = process.env.BUHO_STORE_URL ?? 'postgres://buho:buho@127.0.0.1:55432/buho';
const configPath = process.env.BUHO_CONFIG ?? 'config.json';

type Inst = {
  alias: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
};

async function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { instances: Inst[] };
  const pg = config.instances.find((i) => i.alias === 'pg-lab');
  const maria = config.instances.find((i) => i.alias === 'maria-lab');
  const mssql = config.instances.find((i) => i.alias === 'mssql-lab');
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

    let mariaExplain: { ok: boolean; mode?: string; error?: string } = { ok: false };
    if (maria) {
      const rewritten = rewriteMariadbPlaceholders(
        'select `variable_value` from `information_schema` . `global_variables` where `variable_name` = ? limit ?',
      );
      const client = await openEngine(
        {
          alias: maria.alias,
          engine: 'mariadb',
          host: maria.host,
          port: maria.port,
          database: maria.database,
          user: maria.user,
          password: maria.password,
          ssl: maria.ssl,
        },
        { statementTimeoutMs: 15_000, connectTimeoutMs: 8_000 },
      );
      try {
        const m = await runMariadbExplain(
          client,
          'select 1 as x where ? is null limit ?',
          { analyze: false },
        );
        mariaExplain = {
          ok: m.mode === 'generic' && Boolean(m.root),
          mode: m.mode,
        };
        if (!rewritten.includes('LIMIT 1') || !rewritten.includes('NULL')) {
          mariaExplain = { ok: false, error: `rewrite failed: ${rewritten}` };
        }
      } catch (e) {
        mariaExplain = { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        await client.close();
      }
    }

    let mssqlQds: { ok: boolean; count?: number; error?: string } = { ok: false };
    if (mssql) {
      const client = await openEngine(
        {
          alias: mssql.alias,
          engine: 'mssql',
          host: mssql.host,
          port: mssql.port,
          database: mssql.database,
          user: mssql.user,
          password: mssql.password,
          ssl: mssql.ssl,
        },
        { statementTimeoutMs: 15_000, connectTimeoutMs: 8_000 },
      );
      try {
        const rows = await client.query(`
          select count(*) as n
            from sys.databases
           where is_query_store_on = 1 and database_id > 4`);
        const count = Number(rows[0]?.['n'] ?? 0);
        mssqlQds = { ok: count > 0, count };
      } catch (e) {
        mssqlQds = { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        await client.close();
      }
    }

    const ok = phys.ok && (!maria || mariaExplain.ok) && (!mssql || mssqlQds.ok);
    console.log(
      JSON.stringify(
        {
          ok,
          physical: phys.message,
          failover: { ok: failover.ok, message: failover.message },
          fkProbesTried: probes.length,
          orphanFindings,
          waitClasses30m: waits.length,
          fingerprints: fps.length,
          mariaExplain,
          mssqlQds,
        },
        null,
        2,
      ),
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await pool.end();
    await store.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
