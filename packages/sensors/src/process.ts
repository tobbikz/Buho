import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

const execFileAsync = promisify(execFile);

async function listProcessesLinux(timeoutMs: number): Promise<string> {
  const r = await execFileAsync("ps", ["-eo", "pid=,rss=,comm=,args=", "--no-headers"], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return r.stdout;
}

async function listProcessesWindows(timeoutMs: number): Promise<string> {
  // CSV: Name,ProcessId,WorkingSetSize (bytes)
  const r = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object Name,ProcessId,WorkingSetSize,CommandLine | ConvertTo-Csv -NoTypeInformation",
    ],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  return r.stdout;
}

function matchLinux(stdout: string, pattern: string): { count: number; rssKb: number } {
  const re = new RegExp(pattern, "i");
  let count = 0;
  let rssKb = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!re.test(trimmed)) continue;
    count += 1;
    const parts = trimmed.split(/\s+/);
    const rss = Number(parts[1] ?? 0);
    if (Number.isFinite(rss)) rssKb += rss;
  }
  return { count, rssKb };
}

function matchWindowsCsv(stdout: string, pattern: string): { count: number; rssKb: number } {
  const re = new RegExp(pattern, "i");
  let count = 0;
  let rssKb = 0;
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  // skip header
  for (const line of lines.slice(1)) {
    if (!re.test(line)) continue;
    count += 1;
    // WorkingSetSize is typically the 3rd CSV field; tolerate quoted commas in CommandLine
    const m = line.match(/^"[^"]*","(\d+)","(\d+)"/);
    if (m?.[2]) {
      const bytes = Number(m[2]);
      if (Number.isFinite(bytes)) rssKb += bytes / 1024;
    }
  }
  return { count, rssKb };
}

/**
 * Process match via `ps` (Linux) or Win32_Process (Windows). Local only (or SSH).
 * Metrics: processCount, rssMb, ok when count >= minCount.
 */
export async function runProcessSensor(opts: {
  targetId: string;
  host: string;
  sensor: ProcessSensorConfig;
}): Promise<Sample> {
  const started = Date.now();
  const ts = nowIso();
  const endpoint = endpointKey(opts.host, null);
  const pattern = opts.sensor.match;
  const minCount = opts.sensor.minCount ?? 1;
  const timeoutMs = opts.sensor.timeoutMs ?? 8_000;

  try {
    let stdout: string;
    if (opts.sensor.ssh) {
      const port = opts.sensor.ssh.port ?? 22;
      const user = opts.sensor.ssh.user;
      const remote = `ps -eo pid=,rss=,comm=,args= --no-headers`;
      const r = await execFileAsync(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
          "-p",
          String(port),
          `${user}@${opts.host}`,
          remote,
        ],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      );
      stdout = r.stdout;
    } else if (process.platform === "win32") {
      stdout = await listProcessesWindows(timeoutMs);
    } else {
      stdout = await listProcessesLinux(timeoutMs);
    }

    const { count, rssKb } =
      !opts.sensor.ssh && process.platform === "win32"
        ? matchWindowsCsv(stdout, pattern)
        : matchLinux(stdout, pattern);

    const ok = count >= minCount;
    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "process",
      endpoint,
      ts,
      ok,
      durationMs: Date.now() - started,
      metrics: {
        processCount: count,
        rssMb: Math.round((rssKb / 1024) * 10) / 10,
        minCount,
        match: pattern,
      },
      error: ok ? undefined : `process match "${pattern}" count ${count} < min ${minCount}`,
    };
  } catch (err) {
    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "process",
      endpoint,
      ts,
      ok: false,
      durationMs: Date.now() - started,
      metrics: { processCount: 0, rssMb: 0, minCount, match: pattern },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
