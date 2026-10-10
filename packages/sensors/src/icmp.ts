import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IcmpSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * ICMP via system `ping`. Requires CAP_NET_RAW or setuid ping (typical on Linux).
 */
export async function runIcmpSensor(opts: {
  targetId: string;
  host: string;
  sensor: IcmpSensorConfig;
}): Promise<Sample> {
  const started = Date.now();
  const ts = nowIso();
  const count = opts.sensor.count ?? 3;
  const timeoutMs = opts.sensor.timeoutMs ?? 2000;
  const deadlineSec = Math.max(1, Math.ceil((timeoutMs * count) / 1000) + 1);
  const endpoint = endpointKey(opts.host, null);

  try {
    const { stdout } = await execFileAsync(
      "ping",
      [
        "-c",
        String(count),
        "-W",
        String(Math.ceil(timeoutMs / 1000)),
        "-w",
        String(deadlineSec),
        opts.host,
      ],
      { timeout: deadlineSec * 1000 + 2000 },
    );

    const lossMatch = stdout.match(/(\d+(?:\.\d+)?)%\s+packet loss/);
    const rttMatch = stdout.match(
      /rtt min\/avg\/max\/(?:mdev|stddev) = ([\d.]+)\/([\d.]+)\/([\d.]+)/,
    );
    const lossPct = lossMatch?.[1] != null ? Number(lossMatch[1]) : 100;
    const rttAvgMs = rttMatch?.[2] != null ? Number(rttMatch[2]) : null;
    const rttMinMs = rttMatch?.[1] != null ? Number(rttMatch[1]) : null;
    const rttMaxMs = rttMatch?.[3] != null ? Number(rttMatch[3]) : null;
    const ok = lossPct < 100;

    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "icmp",
      endpoint,
      ts,
      ok,
      durationMs: Date.now() - started,
      metrics: {
        lossPct,
        rttAvgMs,
        rttMinMs,
        rttMaxMs,
        count,
      },
      error: ok ? undefined : "100% packet loss",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const out =
      err && typeof err === "object" && "stdout" in err
        ? String((err as { stdout?: string }).stdout ?? "")
        : "";
    const lossMatch = out.match(/(\d+(?:\.\d+)?)%\s+packet loss/);
    const lossPct = lossMatch?.[1] != null ? Number(lossMatch[1]) : 100;

    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "icmp",
      endpoint,
      ts,
      ok: false,
      durationMs: Date.now() - started,
      metrics: { lossPct, count },
      error: msg.includes("ENOENT")
        ? "ping binary not found"
        : msg.slice(0, 200),
    };
  }
}
