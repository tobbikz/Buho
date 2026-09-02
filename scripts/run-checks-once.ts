/**
 * Run health checks once for every instance in config.json and write results to the store.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runChecks } from '@buho/checks';
import { createPool, engineOf, probeCapabilities, type InstanceConfig } from '@buho/core';
import { Store } from '@buho/store';

const configPath = resolve(process.cwd(), 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  store: { url: string };
  instances: InstanceConfig[];
};

const store = new Store(config.store.url);

try {
  await store.migrate();

  for (const instance of config.instances) {
    if (engineOf(instance) !== 'postgres') continue;

    const pool = createPool(instance, {
      statementTimeoutMs: 5000,
      connectTimeoutMs: 5000,
    });

    try {
      const instanceId = await store.upsertInstance(instance);
      const caps = await probeCapabilities(pool);
      await store.saveCapabilities(instanceId, caps);
      const summary = await runChecks(pool, caps);
      await store.saveCheckResults(instanceId, summary.results, summary.healthScore);
      console.log(
        `${instance.alias}: score ${summary.healthScore}/100` +
          ` (${summary.results.filter((r) => r.severity === 'critical').length} critical,` +
          ` ${summary.results.filter((r) => r.severity === 'warning').length} warn,` +
          ` ${summary.results.filter((r) => r.severity === 'info').length} info)`,
      );
    } finally {
      await pool.end();
    }
  }
} finally {
  await store.close();
}
