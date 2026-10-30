import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

const execFileAsync = promisify(execFile);

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

async function sampleLinuxLocal(): Promise<{
  memUsedPct: number | null;
  swapUsedPct: number | null;
  load1: number;
  load5: number;
  load15: number;
  cpuIdlePct: number | null;
  diskUsedPct: number | null;
}> {
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

  let diskUsedPct: number | null = null;
  try {
    const { stdout } = await execFileAsync("df", ["-P", "/"], { timeout: 3000 });
    const lines = stdout.trim().split("\n");
    const data = lines[1]?.split(/\s+/) ?? [];
    const pct = data[4]?.replace("%", "");
    diskUsedPct = pct != null ? Number(pct) : null;
  } catch {
    diskUsedPct = null;
  }

  return {
    memUsedPct,
    swapUsedPct,
    load1: load.load1,
    load5: load.load5,
    load15: load.load15,
    cpuIdlePct: idlePct,
    diskUsedPct,
  };
}

async function sampleWindowsLocal(): Promise<{
  memUsedPct: number | null;
  swapUsedPct: number | null;
  load1: number;
  load5: number;
  load15: number;
  cpuIdlePct: number | null;
  diskUsedPct: number | null;
}> {
  const ps = `
$os = Get-CimInstance Win32_OperatingSystem
$memUsed = [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 1)
$swapTotal = [double]$os.TotalVirtualMemorySize
$swapFree = [double]$os.FreeVirtualMemory
$swapUsed = if ($swapTotal -gt 0) { [math]::Round((($swapTotal - $swapFree) / $swapTotal) * 100, 1) } else { 0 }
$cpu = Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average
$cpuIdle = if ($null -ne $cpu.Average) { [math]::Round(100 - [double]$cpu.Average, 1) } else { $null }
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$diskUsed = if ($disk -and $disk.Size -gt 0) { [math]::Round((($disk.Size - $disk.FreeSpace) / $disk.Size) * 100, 1) } else { $null }
Write-Output ("MEM={0};SWAP={1};CPUIDLE={2};DISK={3}" -f $memUsed, $swapUsed, $cpuIdle, $diskUsed)
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { timeout: 15_000, windowsHide: true },
  );
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const get = (key: string): number | null => {
    const m = line.match(new RegExp(`${key}=([^;]+)`));
    if (!m?.[1] || m[1] === "") return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  return {
    memUsedPct: get("MEM"),
    swapUsedPct: get("SWAP") ?? 0,
    load1: 0,
    load5: 0,
    load15: 0,
    cpuIdlePct: get("CPUIDLE"),
    diskUsedPct: get("DISK"),
  };
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
    const metrics =
      process.platform === "win32" ? await sampleWindowsLocal() : await sampleLinuxLocal();

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
        memUsedPct: metrics.memUsedPct,
        swapUsedPct: metrics.swapUsedPct,
        load1: metrics.load1,
        load5: metrics.load5,
        load15: metrics.load15,
        cpuIdlePct: metrics.cpuIdlePct,
        diskUsedPct: metrics.diskUsedPct,
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
