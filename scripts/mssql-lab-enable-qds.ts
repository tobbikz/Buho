/**
 * Create buho_lab + enable Query Store (master/tempdb cannot host QDS).
 * Usage: npx tsx scripts/mssql-lab-enable-qds.ts
 */
import { openEngine } from '@buho/core';
import { readFileSync } from 'node:fs';

const configPath = process.env.BUHO_CONFIG ?? 'config.lab-core.json';

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
  const mssql = config.instances.find((i) => i.alias === 'mssql-lab' || i.engine === 'mssql');
  if (!mssql) throw new Error('mssql-lab missing from config');

  const client = await openEngine(
    {
      alias: mssql.alias,
      engine: 'mssql',
      host: mssql.host,
      port: mssql.port,
      database: 'master',
      user: mssql.user,
      password: mssql.password,
      ssl: mssql.ssl,
    },
    { statementTimeoutMs: 60_000, connectTimeoutMs: 15_000 },
  );

  try {
    await client.query(`
      if db_id(N'buho_lab') is null
        create database buho_lab`);
    await client.query(`
      alter database buho_lab set query_store = on
        (operation_mode = read_write,
         max_storage_size_mb = 200,
         cleanup_policy = (stale_query_threshold_days = 30),
         data_flush_interval_seconds = 60,
         interval_length_minutes = 15)`);
    await client.query(`
      alter database buho_lab set query_store clear all`);

    // Seed durable statements so QDS + dm_exec have something to attribute.
    const lab = await openEngine(
      {
        alias: `${mssql.alias}-labdb`,
        engine: 'mssql',
        host: mssql.host,
        port: mssql.port,
        database: 'buho_lab',
        user: mssql.user,
        password: mssql.password,
        ssl: mssql.ssl,
      },
      { statementTimeoutMs: 30_000, connectTimeoutMs: 15_000 },
    );
    try {
      await lab.query(`
        if object_id(N'dbo.probe', N'U') is null
          create table dbo.probe (id int not null primary key, note nvarchar(100) null)`);
      await lab.query(`
        if not exists (select 1 from dbo.probe where id = 1)
          insert into dbo.probe (id, note) values (1, N'qds-seed')
        else
          update dbo.probe set note = N'qds-seed' where id = 1`);
      for (let i = 0; i < 5; i++) {
        await lab.query(`select id, note from dbo.probe where id = 1`);
        await lab.query(`select count(*) as n from dbo.probe`);
      }
    } finally {
      await lab.close();
    }

    const rows = await client.query(`
      select name, database_id, is_query_store_on
        from sys.databases
       where name = N'buho_lab'`);
    const on = Number(rows[0]?.['is_query_store_on'] ?? 0) === 1;
    console.log(JSON.stringify({ ok: on, buho_lab: rows[0] ?? null }, null, 2));
    if (!on) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
