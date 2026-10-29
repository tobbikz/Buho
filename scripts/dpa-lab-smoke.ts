/**
 * One-shot DPA smoke: generate mild PG load, capture auto-plan fingerprint, assert store rows.
 * Usage: BUHO_STORE_URL=... npx tsx scripts/dpa-lab-smoke.ts
 */
import { createPool, fingerprintPlan, runExplain, statementKind } from '@buho/core';
import { Store } from '@buho/store';
import { readFileSync } from 'node:fs';

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
  const pg = config.instances.find((i) => i.alias === 'pg-lab' && i.engine === 'postgres');
  if (!pg) throw new Error('pg-lab missing from config');

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
    { statementTimeoutMs: 30_000, connectTimeoutMs: 8_000 },
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
      ssl: pg.ssl,
      environment: 'lab',
    });

    // Mild load so sessions + statements have something to see.
    await pool.query(`select count(*) from pg_class`);
    await pool.query(`select pg_sleep(0.2)`);

    const sql = `select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pg_catalog' limit 50`;
    if (statementKind(sql) === 'utilitaria') throw new Error('unexpected kind');

    const report = await runExplain(pool, sql, { analyze: false, timeoutMs: 15_000 });
    const fingerprint = fingerprintPlan(report.root);
    // Synthetic queryid for smoke (stable hash-ish).
    const queryid = 424242;

    await store.savePlanFingerprint({
      instanceId,
      queryid,
      fingerprint,
      planText: report.text.slice(0, 32_000),
      totalCost: report.totalCost,
    });
    await store.recordAutoPlan({
      instanceId,
      queryid,
      sql,
      mode: 'estimate',
      plan: report.root,
      planText: report.text,
      totalCost: report.totalCost ?? null,
    });

    // Second capture with a different SQL to simulate regression surface.
    const sql2 = `select 1 as x`;
    const report2 = await runExplain(pool, sql2, { analyze: false, timeoutMs: 10_000 });
    await store.savePlanFingerprint({
      instanceId,
      queryid,
      fingerprint: fingerprintPlan(report2.root),
      planText: report2.text.slice(0, 32_000),
      totalCost: report2.totalCost,
    });

    const fps = await store.listPlanFingerprints(instanceId, queryid, 5);
    const blame = await store.listWaitSqlBlame(instanceId, 60);
    const share = await store.listWaitClassShare(instanceId, 120);
    const timeline = await store.listWaitClassTimeline(instanceId, 120);

    console.log(
      JSON.stringify(
        {
          ok: true,
          instanceId,
          fingerprints: fps.length,
          shapes: new Set(fps.map((f) => f.fingerprint)).size,
          blameRows: blame.length,
          waitClasses: share.length,
          timelineBuckets: new Set(timeline.map((t) => t.bucket.getTime())).size,
          note: 'MSSQL lab container not in compose — code path covered by unit typecheck only',
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
    await store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
