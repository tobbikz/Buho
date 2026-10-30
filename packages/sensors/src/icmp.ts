import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IcmpSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

const execFileAsync = promisify(execFile);

function pingArgs(host: string, count: number, timeoutMs: number): string[] {
  if (process.platform === "win32") {
    // Windows: -n count, -w timeout per-reply in milliseconds
    return ["-n", String(count), "-w", String(Math.max(1, timeoutMs)), host];
  }
  const deadlineSec = Math.max(1, Math.ceil((timeoutMs * count) / 1000) + 1);
  return [
    "-c",
    String(count),
    "-W",
    String(Math.ceil(timeoutMs / 1000)),
    "-w",
    String(deadlineSec),
    host,
  ];
}

function parsePing(stdout: string, count: number): {
  lossPct: number;
  rttAvgMs: number | null;
  rttMinMs: number | null;
  rttMaxMs: number | null;
} {
  const lossMatch =
    stdout.match(/(\d+(?:\.\d+)?)%\s+packet loss/i) ||
    stdout.match(/\((\d+(?:\.\d+)?)%\s+loss\)/i) ||
    stdout.match(/Lost\s*=\s*\d+\s*\((\d+)%\s+loss\)/i);
  const linuxRtt = stdout.match(
    /rtt min\/avg\/max\/(?:mdev|stddev) = ([\d.]+)\/([\d.]+)\/([\d.]+)/,
  );
  const winRtt = stdout.match(
    /Minimum\s*=\s*([\d.]+)ms,\s*Maximum\s*=\s*([\d.]+)ms,\s*Average\s*=\s*([\d.]+)ms/i,
  );
  const lossPct = lossMatch?.[1] != null ? Number(lossMatch[1]) : 100;
  if (linuxRtt) {
    return {
      lossPct,
      rttMinMs: Number(linuxRtt[1]),
      rttAvgMs: Number(linuxRtt[2]),
      rttMaxMs: Number(linuxRtt[3]),
    };
  }
  if (winRtt) {
    return {
      lossPct,
      rttMinMs: Number(winRtt[1]),
      rttMaxMs: Number(winRtt[2]),
      rttAvgMs: Number(winRtt[3]),
    };
  }
  // Windows success with a single reply sometimes omits the summary block.
  const one = stdout.match(/time[=<]([\d.]+)ms/i);
  if (one && lossPct < 100) {
    const ms = Number(one[1]);
    return { lossPct, rttAvgMs: ms, rttMinMs: ms, rttMaxMs: ms };
  }
  void count;
  return { lossPct, rttAvgMs: null, rttMinMs: null, rttMaxMs: null };
}

/**
 * ICMP via system `ping` (Linux / Windows flags).
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
  const endpoint = endpointKey(opts.host, null);
  const deadlineSec = Math.max(1, Math.ceil((timeoutMs * count) / 1000) + 1);

  try {
    const { stdout } = await execFileAsync("ping", pingArgs(opts.host, count, timeoutMs), {
      timeout: deadlineSec * 1000 + 2000,
      windowsHide: true,
    });

    const parsed = parsePing(stdout, count);
    const ok = parsed.lossPct < 100;

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
        lossPct: parsed.lossPct,
        rttAvgMs: parsed.rttAvgMs,
        rttMinMs: parsed.rttMinMs,
        rttMaxMs: parsed.rttMaxMs,
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
    const parsed = parsePing(out, count);

    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "icmp",
      endpoint,
      ts,
      ok: false,
      durationMs: Date.now() - started,
      metrics: { lossPct: parsed.lossPct, count },
      error: msg.includes("ENOENT")
        ? "ping binary not found"
        : msg.slice(0, 200),
    };
  }
}
