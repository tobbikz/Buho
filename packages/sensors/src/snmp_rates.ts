import type { Sample } from "./types.js";

/** Minimal prior-sample lookup — implemented by HalconStore. */
export type SampleHistory = {
  lastSample(
    targetId: string,
    sensorId: string,
  ): {
    ts: string;
    metrics: Record<string, number | string | boolean | null>;
  } | null;
};

/** 32-bit counter delta with wrap handling (IF-MIB Counter32). */
export function deltaCounter32(prev: number, next: number): number {
  if (next >= prev) return next - prev;
  return next + (0xffffffff - prev) + 1;
}

/**
 * Enrich SNMP interface samples with bit/s rates from the previous probe.
 * Must run before inserting the new samples into the store.
 */
export function enrichSnmpBandwidth(
  samples: Sample[],
  store: SampleHistory,
): Sample[] {
  return samples.map((sample) => {
    if (sample.sensorType !== "snmp") return sample;
    const inOct = sample.metrics.ifInOctets;
    const outOct = sample.metrics.ifOutOctets;
    if (typeof inOct !== "number" || typeof outOct !== "number") return sample;

    const prev = store.lastSample(sample.targetId, sample.sensorId);
    if (!prev) return sample;
    const prevIn = prev.metrics.ifInOctets;
    const prevOut = prev.metrics.ifOutOctets;
    if (typeof prevIn !== "number" || typeof prevOut !== "number") return sample;

    const dtSec = (Date.parse(sample.ts) - Date.parse(prev.ts)) / 1000;
    if (!(dtSec > 0) || dtSec > 3600) return sample;

    const din = deltaCounter32(prevIn, inOct);
    const dout = deltaCounter32(prevOut, outOct);

    return {
      ...sample,
      metrics: {
        ...sample.metrics,
        ifInOctetsPerSec: Math.round((din / dtSec) * 100) / 100,
        ifOutOctetsPerSec: Math.round((dout / dtSec) * 100) / 100,
        ifInBps: Math.round(((din * 8) / dtSec) * 100) / 100,
        ifOutBps: Math.round(((dout * 8) / dtSec) * 100) / 100,
        rateWindowSec: Math.round(dtSec * 10) / 10,
      },
    };
  });
}
