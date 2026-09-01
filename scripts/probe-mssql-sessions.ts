import { loadConfig, openEngine, probeForeign, sampleForeignSessions, summarizeSessions } from '@buho/core';

async function main() {
  const cfg = await loadConfig();
  const inst = cfg.instances.find((i) => i.alias === 'mssql-test')!;
  const client = await openEngine(inst, { statementTimeoutMs: 120_000, connectTimeoutMs: 5000 });
  const caps = await probeForeign(client);

  // Segunda conexión con una consulta larga, para que la primera la vea.
  const worker = await openEngine(inst, { statementTimeoutMs: 120_000, connectTimeoutMs: 5000 });
  const running = worker.query(`WAITFOR DELAY '00:00:45'; SELECT 1 AS ok`);

  await new Promise((r) => setTimeout(r, 2000));
  for (let i = 0; i < 3; i += 1) {
    const samples = await sampleForeignSessions(client, caps);
    const foto = summarizeSessions(samples);
    console.log(JSON.stringify({ i, samples: samples.length, waits: foto.waits, first: samples[0] ?? null }));
    await new Promise((r) => setTimeout(r, 3000));
  }

  await running.catch(() => undefined);
  await worker.close();
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
