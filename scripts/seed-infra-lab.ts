/**
 * One-shot: probe lab/infra devices and write samples to the store.
 * Start SNMP fake agents first: npm run lab:infra:snmp
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '@buho/core';
import type { InstanceConfig } from '@buho/core';
import {
  enrichSnmpBandwidth,
  probeTarget,
  sensorSamplesToBuho,
  type Sample,
  type SampleHistory,
  type SensorConfig,
  type TargetConfig,
} from '@buho/sensors';
import { Store } from '@buho/store';

async function main(): Promise<void> {
  const labPath = resolve('lab/infra/config.infra.lab.json');
  const lab = JSON.parse(readFileSync(labPath, 'utf8')) as {
    instances: Array<{
      alias: string;
      host: string;
      port?: number;
      infra: { role?: string; sensors: SensorConfig[] };
    }>;
  };

  const config = await loadConfig();
  const store = new Store(config.store.url);
  await store.migrate();

  const last = new Map<string, Sample>();
  const history: SampleHistory = {
    lastSample(tid, sid) {
      const hit = last.get(`${tid}/${sid}`);
      return hit ? { ts: hit.ts, metrics: hit.metrics } : null;
    },
  };

  for (const inst of lab.instances) {
    const instance: InstanceConfig = {
      alias: inst.alias,
      engine: 'infra',
      host: inst.host,
      port: inst.port ?? 0,
      database: '',
      user: '',
      infra: {
        role: inst.infra.role ?? 'server',
        sensors: inst.infra.sensors as InstanceConfig['infra'] extends { sensors: infer S }
          ? S
          : never,
      },
    };
    const id = await store.upsertInstance(instance);
    const target: TargetConfig = {
      id: inst.alias,
      host: inst.host,
      role: (inst.infra.role as TargetConfig['role']) ?? 'server',
      sensors: inst.infra.sensors,
    };

    let samples = await probeTarget(target);
    samples = enrichSnmpBandwidth(samples, history);
    for (const s of samples) last.set(`${s.targetId}/${s.sensorId}`, s);

    // Second pass so SNMP bandwidth deltas can populate.
    await new Promise((r) => setTimeout(r, 1100));
    samples = await probeTarget(target);
    samples = enrichSnmpBandwidth(samples, history);
    for (const s of samples) last.set(`${s.targetId}/${s.sensorId}`, s);

    const written = await store.insertSamples(id, sensorSamplesToBuho(samples));
    const up = samples.filter((s) => s.ok).length;
    console.log(
      `${inst.alias}: instance=${id} written=${written} up=${up}/${samples.length} · ${samples
        .map((s) => `${s.sensorId}:${s.ok ? 'ok' : s.error ?? 'fail'}`)
        .join(', ')}`,
    );
  }

  await store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
