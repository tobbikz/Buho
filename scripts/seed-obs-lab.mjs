/**
 * Seed Observability lab: HTTP probes + infra sensor samples.
 *   node scripts/seed-obs-lab.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { probeEndpoint } from '@buho/core';
import { evaluateEndpointSamples, endpointHealthScore } from '@buho/checks';
import { Store } from '@buho/store';

try {
  for (const line of readFileSync(resolve('apps/web/.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {
  /* optional */
}

const STORE_URL = process.env.BUHO_STORE_URL ?? 'postgres://buho:buho@127.0.0.1:55432/buho';

const PROBES = [
  {
    alias: 'web-local',
    baseUrl: 'http://127.0.0.1:3100',
    paths: ['/'],
    host: '127.0.0.1',
    port: 3100,
    ssl: false,
  },
  {
    alias: 'example-https',
    baseUrl: 'https://example.com',
    paths: ['/'],
    host: 'example.com',
    port: 443,
    ssl: true,
  },
];

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function seedProbes() {
  const client = new pg.Client({ connectionString: STORE_URL });
  await client.connect();
  const store = new Store(STORE_URL);

  for (const p of PROBES) {
    const endpoint = {
      baseUrl: p.baseUrl,
      paths: p.paths,
      expectStatus: [200, 204, 301, 302, 303, 307, 308],
      warnMs: 1500,
      tcp: true,
      tlsCert: p.ssl,
    };
    await client.query(
      `insert into buho.monitor_targets
         (alias, engine, host, port, database, username, password, environment, ssl,
          tags, host_metrics, endpoint, enabled, created_by)
       values ($1,'endpoint',$2,$3,'','','','LAB',$4,
               '{}'::jsonb,'{}'::jsonb,$5::jsonb, true, 'seed-obs-lab')
       on conflict (tenant, alias) do update set
         engine = 'endpoint',
         host = excluded.host,
         port = excluded.port,
         ssl = excluded.ssl,
         endpoint = excluded.endpoint,
         enabled = true,
         updated_at = now()`,
      [p.alias, p.host, p.port, p.ssl, JSON.stringify(endpoint)],
    );
    const instanceId = await store.upsertInstance({
      alias: p.alias,
      engine: 'endpoint',
      host: p.host,
      port: p.port,
      database: '',
      user: '',
      password: '',
      environment: 'LAB',
      endpoint,
    });
    const result = await probeEndpoint({
      host: p.host,
      port: p.port,
      ssl: p.ssl,
      probe: {
        baseUrl: p.baseUrl,
        paths: p.paths,
        expectStatus: endpoint.expectStatus,
        warnMs: 1500,
        tcp: true,
        tlsCert: p.ssl,
      },
    });
    await store.insertSamples(instanceId, result.samples);
    const findings = evaluateEndpointSamples(result.samples);
    await store.saveCheckResults(instanceId, findings, endpointHealthScore(findings));
    console.log(`ok  probe ${p.alias} id=${instanceId} samples=${result.samples.length}`);
  }

  await store.close();
  await client.end();
}

async function seedInfra() {
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const snmp = spawn(process.execPath, [resolve(root, 'lab/infra/fake-snmp-agent.mjs')], {
    cwd: root,
    stdio: 'ignore',
    detached: true,
  });
  snmp.unref();
  await wait(1000);
  const r = spawn(
    process.execPath,
    [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, 'scripts/seed-infra-lab.ts')],
    { cwd: root, stdio: 'inherit', env: process.env },
  );
  await new Promise((resolveP, reject) => {
    r.on('exit', (code) => (code === 0 ? resolveP() : reject(new Error(`infra seed exit ${code}`))));
  });
}

await seedProbes();
try {
  await seedInfra();
  console.log('ok  infra seed');
} catch (e) {
  console.warn('WARN infra seed:', e?.message || e);
}
console.log('SEED OBS LAB DONE');
