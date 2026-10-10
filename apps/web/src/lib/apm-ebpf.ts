import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type EbpfStatus = {
  running: boolean;
  container?: string;
  state?: string;
  host?: string;
  port?: string;
  service?: string;
  otlp?: string;
};

export type EbpfEnableResult = {
  ok: boolean;
  mode?: 'local' | 'remote';
  error?: string;
  command?: string;
  running?: boolean;
  container?: string;
  state?: string;
  host?: string;
  port?: string;
  service?: string;
  otlp?: string;
};

function repoRoot(): string {
  // Keep paths statically scoped so Next/Turbopack does not trace the whole tree.
  const fromWeb = path.join(/* turbopackIgnore: true */ process.cwd(), '..', '..');
  if (existsSync(path.join(fromWeb, 'scripts', 'apm-ebpf.sh'))) return fromWeb;
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'scripts', 'apm-ebpf.sh'))) return cwd;
  return fromWeb;
}

function scriptPath(): string {
  return path.join(repoRoot(), 'scripts/apm-ebpf.sh');
}

async function runScript(
  args: string[],
  otlpEndpoint?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const otlp =
    otlpEndpoint?.trim() ||
    process.env.BUHO_OTEL_COLLECTOR_ENDPOINT?.trim() ||
    'http://127.0.0.1:4318';
  try {
    const { stdout, stderr } = await execFileAsync('bash', [scriptPath(), ...args], {
      cwd: repoRoot(),
      env: {
        ...process.env,
        BUHO_OTEL_COLLECTOR_ENDPOINT: otlp,
      },
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message ?? '').trim(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/** True when Beyla can be started on this Buho host (loopback / docker desktop). */
export function isLocalEbpfHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h === 'host.docker.internal'
  );
}

export function parseHostPort(raw: string): { host: string; port: number } | { error: string } {
  const t = raw.trim();
  if (!t) return { error: 'host required' };

  // [ipv6]:port
  if (t.startsWith('[')) {
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(t);
    if (!m) return { error: 'use [ipv6]:port' };
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'valid port required' };
    return { host: m[1], port };
  }

  // host:port (last colon — IPv4 or hostname)
  const idx = t.lastIndexOf(':');
  if (idx <= 0) return { error: 'use IP:port (e.g. 127.0.0.1:8080)' };
  const host = t.slice(0, idx).trim();
  const port = Number(t.slice(idx + 1).trim());
  if (!host) return { error: 'host required' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'valid port required' };
  // reject accidental bare IPv6 without brackets
  if (host.includes(':')) return { error: 'use [ipv6]:port' };
  return { host, port };
}

export async function ebpfStatus(): Promise<EbpfStatus> {
  const { stdout, code } = await runScript(['status']);
  if (!stdout) return { running: false };
  try {
    return JSON.parse(stdout) as EbpfStatus;
  } catch {
    return { running: false, state: code === 0 ? undefined : 'error' };
  }
}

export async function ebpfEnable(
  host: string,
  port: number,
  service?: string,
  otlpEndpoint?: string,
): Promise<EbpfEnableResult> {
  const args = ['start', host, String(port)];
  if (service?.trim()) args.push(service.trim());
  const { stdout, stderr, code } = await runScript(args, otlpEndpoint);
  const raw = stdout || stderr;
  try {
    const parsed = JSON.parse(raw) as EbpfEnableResult;
    if (code === 2 && parsed.mode === 'remote') return parsed;
    if (code !== 0 && !parsed.ok) {
      return { ok: false, error: parsed.error || stderr || 'failed to start eBPF agent' };
    }
    return parsed;
  } catch {
    return { ok: false, error: stderr || stdout || 'failed to start eBPF agent' };
  }
}

export async function ebpfStop(): Promise<{ ok: boolean; stopped?: boolean; error?: string }> {
  const { stdout, stderr, code } = await runScript(['stop']);
  try {
    return JSON.parse(stdout || '{}') as { ok: boolean; stopped?: boolean };
  } catch {
    return { ok: code === 0, error: stderr || 'stop failed' };
  }
}

export async function ebpfRemoteCommand(
  host: string,
  port: number,
  service?: string,
  otlpEndpoint?: string,
): Promise<string> {
  const args = ['command', host, String(port)];
  if (service?.trim()) args.push(service.trim());
  const { stdout, stderr, code } = await runScript(args, otlpEndpoint);
  if (code !== 0) throw new Error(stderr || 'command failed');
  return stdout;
}
