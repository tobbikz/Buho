import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { upsertApmEbpfBinding } from './apm-bindings';

const execFileAsync = promisify(execFile);

const SAFE_USER_HOST = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/\-]+$/;

export type SshDeployInput = {
  /** App listen host:port (probe / Beyla open port). */
  appHost: string;
  appPort: number;
  service: string;
  /** SSH login host (may differ from appHost DNS). */
  sshHost: string;
  sshUser: string;
  sshPort?: number;
  /** Absolute path to private key (preferred · matches Buho host metrics SSH). */
  identityFile?: string;
  /** One-shot password · never persisted. */
  password?: string;
  /** Reachable from the remote host · not 127.0.0.1 unless same box. */
  otlpEndpoint: string;
};

export type SshDeployResult = {
  ok: boolean;
  error?: string;
  detail?: string;
  bindings?: Awaited<ReturnType<typeof upsertApmEbpfBinding>>;
};

function buildRemoteDocker(input: SshDeployInput): string {
  // One agent per listen port so Enable APM for console ≠ replace orders-api.
  const name = `buho-beyla-${input.appPort}`;
  const image = process.env.BUHO_BEYLA_IMAGE?.trim() || 'grafana/beyla:latest';
  const svc = input.service.replace(/[^a-zA-Z0-9._-]/g, '-');
  const otlp = input.otlpEndpoint.replace(/'/g, `'\"'\"'`);
  const hostLabel = input.appHost.replace(/'/g, '');
  const port = input.appPort;
  const runCmd = [
    'docker run -d',
    `--name ${name}`,
    '--restart unless-stopped',
    '--privileged --pid=host --network=host',
    '-v /sys/fs/bpf:/sys/fs/bpf',
    '-v /sys/kernel/tracing:/sys/kernel/tracing',
    `-e BEYLA_OPEN_PORT=${port}`,
    `-e OTEL_EXPORTER_OTLP_ENDPOINT='${otlp}'`,
    '-e OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    `-e OTEL_SERVICE_NAME='${svc}'`,
    '-l buho.apm=ebpf',
    `-l buho.apm.host='${hostLabel}'`,
    `-l buho.apm.port=${port}`,
    image,
  ].join(' ');
  // Single-line steps; avoid $(...) under set -e (ash ignores failures there).
  // Drop legacy shared name only when it was bound to this same port.
  return [
    `docker rm -f ${name} >/dev/null 2>&1 || true`,
    `if docker inspect buho-beyla >/dev/null 2>&1; then lp=$(docker inspect -f '{{index .Config.Labels "buho.apm.port"}}' buho-beyla 2>/dev/null || true); if [ -z "$lp" ] || [ "$lp" = "${port}" ]; then docker rm -f buho-beyla >/dev/null 2>&1 || true; fi; fi`,
    `docker pull -q ${image} >/dev/null 2>&1 || true`,
    runCmd,
    `docker inspect -f '{{.State.Status}}' ${name}`,
  ].join(' && ');
}

async function sshExec(
  target: string,
  remoteCmd: string,
  opts: { identityFile?: string; password?: string; sshPort: number },
): Promise<{ stdout: string; stderr: string }> {
  const sshArgs = [
    '-p',
    String(opts.sshPort),
    '-o',
    'ConnectTimeout=12',
    '-o',
    'StrictHostKeyChecking=accept-new',
  ];

  if (opts.password?.trim()) {
    if (!existsSync('/usr/bin/sshpass') && !existsSync('/usr/sbin/sshpass')) {
      // try PATH
    }
    sshArgs.push('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no');
    const { stdout, stderr } = await execFileAsync(
      'sshpass',
      ['-e', 'ssh', ...sshArgs, target, remoteCmd],
      {
        env: { ...process.env, SSHPASS: opts.password },
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  }

  sshArgs.push('-o', 'BatchMode=yes');
  if (opts.identityFile?.trim()) {
    const id = opts.identityFile.trim();
    if (!SAFE_PATH.test(id)) {
      throw new Error('identity file must be an absolute path');
    }
    if (!existsSync(id)) {
      throw new Error(`identity file not found: ${id}`);
    }
    sshArgs.push('-i', id);
  }
  const { stdout, stderr } = await execFileAsync('ssh', [...sshArgs, target, remoteCmd], {
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

/**
 * Deploy Grafana Beyla on a remote host over SSH (key or one-shot password).
 * Password is never written to the store.
 */
export async function deployEbpfOverSsh(input: SshDeployInput): Promise<SshDeployResult> {
  const user = input.sshUser.trim();
  const host = input.sshHost.trim();
  const target = `${user}@${host}`;
  if (!SAFE_USER_HOST.test(target)) {
    return { ok: false, error: 'SSH target must be user@host (letters, digits, . _ -)' };
  }
  if (!input.service.trim()) {
    return { ok: false, error: 'service name required' };
  }
  if (!input.otlpEndpoint.trim().startsWith('http')) {
    return { ok: false, error: 'OTLP endpoint must be http(s) URL reachable from the remote host' };
  }
  const sshLocal =
    host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === 'host.docker.internal';
  if (
    !sshLocal &&
    (input.otlpEndpoint.includes('127.0.0.1') || input.otlpEndpoint.includes('localhost'))
  ) {
    return {
      ok: false,
      error:
        'OTLP endpoint cannot be localhost from a remote host — use Buho’s LAN IP (e.g. http://192.168.x.x:4318)',
    };
  }
  if (!input.identityFile?.trim() && !input.password?.trim()) {
    return { ok: false, error: 'provide SSH identity file or password' };
  }

  const sshPort = input.sshPort && input.sshPort > 0 ? input.sshPort : 22;
  const remote = buildRemoteDocker(input);

  try {
    const { stdout, stderr } = await sshExec(target, `sh -lc ${JSON.stringify(remote)}`, {
      identityFile: input.identityFile,
      password: input.password,
      sshPort,
    });
    const bindings = await upsertApmEbpfBinding({
      service: input.service.trim(),
      host: input.appHost.trim(),
      port: input.appPort,
    });
    return {
      ok: true,
      detail: (stdout || stderr || 'deployed').trim().slice(0, 400),
      bindings,
    };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const msg = (e.stderr || e.message || String(err)).trim();
    return { ok: false, error: msg.slice(0, 800) || 'SSH deploy failed' };
  }
}

/** Guess a LAN IP for OTLP tips (best-effort). */
export function guessPublicOtlpHint(port = 4318): string {
  const fromEnv =
    process.env.BUHO_OTEL_COLLECTOR_ENDPOINT?.trim() ||
    process.env.BUHO_PUBLIC_OTLP?.trim();
  if (fromEnv && !fromEnv.includes('127.0.0.1') && !fromEnv.includes('localhost')) {
    return fromEnv;
  }
  const host =
    process.env.BUHO_PUBLIC_HOST?.trim() ||
    process.env.NEXT_PUBLIC_BUHO_HOST?.trim() ||
    '';
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    return `http://${host}:${port}`;
  }
  return `http://192.168.x.x:${port}`;
}
