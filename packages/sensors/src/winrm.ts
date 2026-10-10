import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Sample, WinrmSensorConfig } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Windows host metrics via WinRM (pwsh/winrm) or SSH+PowerShell.
 *
 * Prefer transport "ssh" from Linux collectors (OpenSSH on Windows).
 * transport "winrm" requires `pwsh` with WinRM remoting on the collector host.
 */
export async function runWinrmSensor(opts: {
  targetId: string;
  host: string;
  sensor: WinrmSensorConfig;
}): Promise<Sample> {
  const started = Date.now();
  const ts = nowIso();
  const port =
    opts.sensor.port ??
    (opts.sensor.transport === "ssh" ? (opts.sensor.sshPort ?? 22) : 5985);
  const endpoint = endpointKey(opts.host, port);
  const timeoutMs = opts.sensor.timeoutMs ?? 15_000;
  const query = opts.sensor.query ?? "cpu_mem";

  const psScript =
    query === "process"
      ? [
          `$n='${(opts.sensor.processName ?? "Idle").replace(/'/g, "''")}'`,
          `$p=Get-Process -Name $n -ErrorAction SilentlyContinue`,
          `if(-not $p){ Write-Output 'COUNT=0'; exit 0 }`,
          `$c=@($p).Count; $w=($p|Measure-Object WorkingSet64 -Sum).Sum`,
          `Write-Output \"COUNT=$c\"; Write-Output \"WS=$w\"`,
        ].join("; ")
      : [
          `$os=Get-CimInstance Win32_OperatingSystem`,
          `$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average`,
          `$total=[double]$os.TotalVisibleMemorySize`,
          `$free=[double]$os.FreePhysicalMemory`,
          `$mem= if($total -gt 0){ [math]::Round((($total-$free)/$total)*100,1) } else { 0 }`,
          `Write-Output \"CPU=$cpu\"; Write-Output \"MEM=$mem\"`,
        ].join("; ");

  try {
    let stdout: string;
    const transport = opts.sensor.transport ?? "ssh";

    if (transport === "ssh") {
      if (!opts.sensor.user) {
        throw new Error('winrm transport=ssh requires sensor.user');
      }
      const sshPort = opts.sensor.sshPort ?? 22;
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
          String(sshPort),
          `${opts.sensor.user}@${opts.host}`,
          "powershell",
          "-NoProfile",
          "-Command",
          psScript,
        ],
        { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      );
      stdout = r.stdout;
    } else {
      // WinRM via pwsh Invoke-Command (collector must have WinRM client + creds).
      if (!opts.sensor.user || !opts.sensor.password) {
        throw new Error(
          "winrm transport=winrm requires sensor.user and sensor.password (or use transport=ssh)",
        );
      }
      const useSsl = opts.sensor.useSsl ?? false;
      const auth = opts.sensor.password.replace(/'/g, "''");
      const user = opts.sensor.user.replace(/'/g, "''");
      const wrap = [
        `$sec=ConvertTo-SecureString '${auth}' -AsPlainText -Force`,
        `$cred=New-Object PSCredential('${user}',$sec)`,
        `$s=New-PSSession -ComputerName '${opts.host}' -Port ${port} -Credential $cred ${
          useSsl ? "-UseSSL" : ""
        } -ErrorAction Stop`,
        `try { Invoke-Command -Session $s -ScriptBlock { ${psScript} } } finally { Remove-PSSession $s }`,
      ].join("; ");
      const r = await execFileAsync("pwsh", ["-NoProfile", "-Command", wrap], {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      });
      stdout = r.stdout;
    }

    const metrics: Record<string, number | string | boolean | null> = {
      transport: opts.sensor.transport ?? "ssh",
      query,
    };
    let ok = true;
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^([A-Z]+)=(.+)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1]!;
      const raw = m[2]!;
      const num = Number(raw);
      if (key === "CPU") metrics.cpuPct = Number.isFinite(num) ? num : null;
      if (key === "MEM") metrics.memUsedPct = Number.isFinite(num) ? num : null;
      if (key === "COUNT") {
        metrics.processCount = Number.isFinite(num) ? num : 0;
        ok = (metrics.processCount as number) >= 1;
      }
      if (key === "WS") {
        metrics.workingSetMb = Number.isFinite(num)
          ? Math.round((num / (1024 * 1024)) * 10) / 10
          : null;
      }
    }

    if (query === "cpu_mem" && metrics.cpuPct == null && metrics.memUsedPct == null) {
      ok = false;
      throw new Error("WinRM/SSH PowerShell returned no CPU/MEM fields");
    }

    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "winrm",
      endpoint,
      ts,
      ok,
      durationMs: Date.now() - started,
      metrics,
      error: ok ? undefined : "Windows query failed thresholds",
    };
  } catch (err) {
    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "winrm",
      endpoint,
      ts,
      ok: false,
      durationMs: Date.now() - started,
      metrics: { transport: opts.sensor.transport ?? "ssh", query },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
