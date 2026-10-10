/**
 * One-shot infra discovery → buho.infra_discovery.
 * Usage: npx tsx scripts/infra-discover.ts --hosts 127.0.0.1,1.1.1.1
 *        npx tsx scripts/infra-discover.ts --cidr 127.0.0.0/30
 */
import { loadConfig } from '@buho/core';
import { discoverHosts } from '@buho/sensors';
import { Store } from '@buho/store';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

async function main(): Promise<void> {
  const hostsArg = arg('--hosts');
  const cidr = arg('--cidr') ?? undefined;
  const hosts = hostsArg
    ? hostsArg.split(',').map((h) => h.trim()).filter(Boolean)
    : ['127.0.0.1', '1.1.1.1'];

  const config = await loadConfig();
  const store = new Store(config.store.url);
  await store.migrate();

  const hits = await discoverHosts({
    hosts: cidr ? undefined : hosts,
    cidr,
    ports: [22, 53, 80, 443, 1161],
    timeoutMs: 2000,
    concurrency: 16,
  });
  const n = await store.upsertInfraDiscovery(hits);
  console.log(`discovery: ${hits.length} hits, upserted ${n}`);
  for (const h of hits) {
    console.log(
      `  ${h.host} icmp=${h.icmpOk}${h.icmpMs != null ? `/${Math.round(h.icmpMs)}ms` : ''} ports=[${h.openPorts.join(',')}]`,
    );
  }
  await store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
