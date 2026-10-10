import dns from "node:dns/promises";
import { Resolver } from "node:dns";
import type { DnsSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function runDnsSensor(opts: {
  targetId: string;
  host: string;
  sensor: DnsSensorConfig;
}): Promise<Sample> {
  const started = Date.now();
  const ts = nowIso();
  const recordType = opts.sensor.recordType ?? "A";
  const timeoutMs = opts.sensor.timeoutMs ?? 5000;
  const endpoint = endpointKey(opts.sensor.server ?? opts.host, 53);

  try {
    let addresses: string[];
    if (opts.sensor.server) {
      const resolver = new Resolver();
      resolver.setServers([opts.sensor.server]);
      const resolveFn =
        recordType === "AAAA"
          ? () =>
              new Promise<string[]>((resolve, reject) =>
                resolver.resolve6(opts.sensor.name, (err, r) =>
                  err ? reject(err) : resolve(r),
                ),
              )
          : () =>
              new Promise<string[]>((resolve, reject) =>
                resolver.resolve4(opts.sensor.name, (err, r) =>
                  err ? reject(err) : resolve(r),
                ),
              );
      addresses = await withTimeout(resolveFn(), timeoutMs);
    } else {
      addresses = await withTimeout(
        recordType === "AAAA"
          ? dns.resolve6(opts.sensor.name)
          : dns.resolve4(opts.sensor.name),
        timeoutMs,
      );
    }

    const joined = addresses.join(",");
    let expectOk = true;
    if (opts.sensor.expectIncludes) {
      expectOk = addresses.some((a) => a.includes(opts.sensor.expectIncludes!));
    }

    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "dns",
      endpoint,
      ts,
      ok: addresses.length > 0 && expectOk,
      durationMs: Date.now() - started,
      metrics: {
        name: opts.sensor.name,
        recordType,
        count: addresses.length,
        addresses: joined.slice(0, 200),
        resolveMs: Date.now() - started,
      },
      error: expectOk
        ? undefined
        : `resolved but missing ${opts.sensor.expectIncludes}`,
    };
  } catch (err) {
    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "dns",
      endpoint,
      ts,
      ok: false,
      durationMs: Date.now() - started,
      metrics: {
        name: opts.sensor.name,
        recordType,
      },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
