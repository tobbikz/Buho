import { loadConfig, openEngine, probeForeign, sampleForeignSessions, summarizeSessions } from '@buho/core';

async function main() {
  const cfg = await loadConfig();
  for (const alias of ['mariadb-test', 'mssql-test']) {
    const inst = cfg.instances.find((i) => i.alias === alias)!;
    const client = await openEngine(inst, { statementTimeoutMs: 8000, connectTimeoutMs: 5000 });
    const caps = await probeForeign(client);
    try {
      const samples = await sampleForeignSessions(client, caps);
      const foto = summarizeSessions(samples);
      console.log(
        JSON.stringify({
          alias,
          samples: samples.length,
          waits: foto.waits,
          detail: foto.detail.length,
          first: samples[0] ?? null,
        }),
      );
    } catch (error) {
      console.log(JSON.stringify({ alias, error: error instanceof Error ? error.message : String(error) }));
    }
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
