/** Re-run cis-postgres for pg-lab to refresh drift baseline. */
import { openEngine, type InstanceConfig } from '@buho/core';
import { runCompliancePack } from '@buho/checks';
import { Store } from '@buho/store';

const storeUrl = process.env.BUHO_STORE_URL ?? 'postgres://buho:buho@127.0.0.1:55432/buho';
const store = new Store(storeUrl);

const targets = await store.listMonitorTargets();
const target = targets.find((t) => t.alias === 'pg-lab' && t.enabled);
if (!target) throw new Error('pg-lab missing');

const instance: InstanceConfig = {
  alias: target.alias,
  engine: 'postgres',
  host: target.host,
  port: target.port,
  database: target.database,
  user: target.username,
  password: target.password,
  ssl: target.ssl,
};

const instanceId = await store.upsertInstance(instance);
const client = await openEngine(instance);
try {
  const result = await runCompliancePack(client, 'cis-postgres');
  await store.saveComplianceRun(instanceId, 'cis-postgres', result.score, result.controls);
  console.log(`cis-postgres score=${result.score} controls=${result.controls.length}`);
} finally {
  await client.close();
  await store.close();
}
