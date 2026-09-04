#!/usr/bin/env npx tsx
/**
 * End-to-end alert smoke: local webhook receiver → channel → delivery flush.
 * Also evaluates the default pack against synthetic metrics.
 *
 *   BUHO_STORE_URL=postgres://... npx tsx scripts/ensayo-alerts.ts
 */
import { createServer } from 'node:http';
import { Pool } from 'pg';
import {
  defaultAlertPack,
  evaluateAlertPack,
} from '../packages/checks/src/alert-pack.ts';
import { Store } from '../packages/store/src/index.ts';

async function main() {
  const url = process.env.BUHO_STORE_URL;
  if (!url) throw new Error('BUHO_STORE_URL required');

  const received: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        received.push(Buffer.concat(chunks).toString('utf8'));
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no listen address');
  const hookUrl = `http://127.0.0.1:${addr.port}/buho`;

  const store = new Store(url);
  await store.migrate();

  // Pack unit check (no store needed)
  const packHits = evaluateAlertPack(
    { host_cpu_pct: 96, connections_used_pct: 92, db_cache_hit_pct: 88 },
    defaultAlertPack(),
  );
  if (packHits.length < 2) throw new Error(`pack expected ≥2 findings, got ${packHits.length}`);
  console.log(`pack ok: ${packHits.map((f) => f.checkId).join(', ')}`);

  const channelId = await store.upsertAlertChannel({
    name: 'ensayo-webhook',
    kind: 'webhook',
    config: { url: hookUrl },
    enabled: true,
  });

  // Pick any instance for a synthetic firing alert
  const pool = new Pool({ connectionString: url, max: 2 });
  const instances = await pool.query<{ instance_id: string; alias: string; engine: string }>(
    `select instance_id::text, alias, engine from buho.instances order by instance_id limit 1`,
  );
  const row = instances.rows[0];
  if (!row) throw new Error('no instances in store — add one first');
  const instanceId = Number(row.instance_id);

  const findings = [
    {
      checkId: 'ensayo.e2e_cpu',
      title: 'Ensayo CPU',
      severity: 'critical' as const,
      object: `ensayo-${Date.now()}`,
      message: 'ensayo: CPU 96% (synthetic)',
      remediation: 'Delete after ensayo-alerts.',
      value: 96,
    },
  ];
  await store.saveCheckResults(instanceId, findings, 80);
  const summary = await store.reconcileAlerts(instanceId, findings);
  console.log(`reconcile: fired=${summary.fired} opened=${summary.opened}`);

  // Force min severity so info sample custom wouldn't matter; ensure deliveries flush
  let flushed = { sent: 0, failed: 0 };
  for (let i = 0; i < 10 && received.length === 0; i++) {
    flushed = await store.flushAlertDeliveries(20);
    await new Promise((r) => setTimeout(r, 200));
  }

  if (received.length === 0) {
    throw new Error(`webhook not received (flush sent=${flushed.sent} failed=${flushed.failed})`);
  }
  const body = received[0] as Record<string, unknown>;
  if (body['source'] !== 'buho' || body['event'] !== 'fired') {
    throw new Error(`unexpected payload: ${JSON.stringify(body)}`);
  }
  console.log(`webhook ok: channel=${channelId} alert_id=${body['alert_id']} check=${body['check_id']}`);

  // cleanup channel only (leave alert history)
  await store.deleteAlertChannel(channelId);
  await store.close();
  await pool.end();
  server.close();
  console.log('ensayo-alerts: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
