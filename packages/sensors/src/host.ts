import { readFile } from "node:fs/promises";
import type { HostSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

async function readProc(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function parseMeminfo(raw: string): {
  memTotalKb: number;
  memAvailableKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
} {
  const get = (key: string): number => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m?.[1] ? Number(m[1]) : 0;
  };
  return {
    memTotalKb: get("MemTotal"),
    memAvailableKb: get("MemAvailable"),
    swapTotalKb: get("SwapTotal"),
    swapFreeKb: get("SwapFree"),
  };
}

function parseLoadavg(raw: string): {
  load1: number;
  load5: number;
  load15: number;
} {
  const parts = raw.trim().split(/\s+/);
  return {
    load1: Number(parts[0] ?? 0),
    load5: Number(parts[1] ?? 0),
    load15: Number(parts[2] ?? 0),
  };
}

/** First pass CPU idle % from /proc/stat (instantaneous snapshot — not delta). */
function parseCpuIdlePct(raw: string): number | null {
  const line = raw.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const nums = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  if (nums.length < 4) return null;
  const total = nums.reduce((a, b) => a + b, 0);
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
  if (total <= 0) return null;
  return Math.round((idle / total) * 1000) / 10;
}

function parseDiskUsePct(dfLike: string): number | null {
  // Prefer root filesystem line from `df -P /` style if we ever shell; for local
  // we read /proc/mounts + skip. Simple: parse `/` from `df` is done in probe via shell.
  // Here we only expose mem/load; disk filled by optional df in runHostSensor.
  void dfLike;
  return null;
}

export async function runHostSensor(opts: {
  targetId: string;
  host: string;
  sensor: HostSensorConfig;
}): Promise<Sample> {
  const started = Date.now();
  const ts = nowIso();
  const endpoint = endpointKey(opts.host, null);

  if (opts.sensor.ssh) {
    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "host",
      endpoint,
      ts,
      ok: false,
      durationMs: Date.now() - started,
      metrics: {},
      error: "SSH host probes not implemented in v0.1 (use local host or icmp/tcp)",
    };
  }

  try {
    const [memRaw, loadRaw, cpuRaw] = await Promise.all([
      readProc("/proc/meminfo"),
      readProc("/proc/loadavg"),
      readProc("/proc/stat"),
    ]);
    const mem = parseMeminfo(memRaw);
    const load = parseLoadavg(loadRaw);
    const idlePct = parseCpuIdlePct(cpuRaw);
    const memUsedPct =
      mem.memTotalKb > 0
        ? Math.round(
            ((mem.memTotalKb - mem.memAvailableKb) / mem.memTotalKb) * 1000,
          ) / 10
        : null;
    const swapUsedPct =
      mem.swapTotalKb > 0
        ? Math.round(
            ((mem.swapTotalKb - mem.swapFreeKb) / mem.swapTotalKb) * 1000,
          ) / 10
        : 0;

    // Disk via df (portable enough on Linux)
    let diskUsedPct: number | null = null;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync("df", ["-P", "/"], {
        timeout: 3000,
      });
      const lines = stdout.trim().split("\n");
      const data = lines[1]?.split(/\s+/) ?? [];
      const pct = data[4]?.replace("%", "");
      diskUsedPct = pct != null ? Number(pct) : null;
      void parseDiskUsePct;
    } catch {
      diskUsedPct = null;
    }

    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "host",
      endpoint,
      ts,
      ok: true,
      durationMs: Date.now() - started,
      metrics: {
        memUsedPct,
        swapUsedPct,
        load1: load.load1,
        load5: load.load5,
        load15: load.load15,
        cpuIdlePct: idlePct,
        diskUsedPct,
      },
    };
  } catch (err) {
    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "host",
      endpoint,
      ts,
      ok: false,
      durationMs: Date.now() - started,
      metrics: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
