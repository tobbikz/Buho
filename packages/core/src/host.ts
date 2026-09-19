import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Sample } from './types';

const run = promisify(execFile);

/**
 * De dónde salen CPU, memoria y disco del **host**.
 *
 * PostgreSQL no expone ninguna de las tres: no hay vista de sistema operativo,
 * y todo lo que se puede deducir desde SQL son aproximaciones (clases de
 * espera, cache hit). El dato real vive en `/proc`, así que hay que ir a
 * buscarlo ahí y decirlo de frente.
 *
 * - `none` (por defecto): no se recoge nada. La UI explica cómo activarlo.
 * - `local`: Búho corre en el mismo host que la base (despliegue chico o
 *   contenedor con `/proc` del host montado).
 * - `ssh`: se ejecuta un comando de lectura por SSH. Sigue siendo *sin agente*:
 *   no se instala nada en el servidor vigilado, sólo se leen archivos.
 * - `docker`: `docker exec` into a sibling container (lab / compose). Requires
 *   the Docker CLI + socket on the collector.
 */
export type HostSourceKind = 'none' | 'local' | 'ssh' | 'docker';

export interface HostConfig {
  source?: HostSourceKind;
  /** `usuario@servidor` para SSH. */
  target?: string;
  identityFile?: string;
  /** Contenedor Docker (nombre o id) cuando `source=docker`. */
  container?: string;
  /** Directorio a medir con `df`; por defecto el data directory típico. */
  dataDirectory?: string;
}

export interface HostSnapshot {
  /** Jiffies acumulados de /proc/stat. Sólo sirven por diferencia. */
  cpu: { total: number; idle: number; iowait: number; steal: number };
  cores: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
  load1: number;
  disk: { mount: string; totalBytes: number; freeBytes: number } | null;
}

/**
 * Un solo comando, con marcadores, para no pagar cuatro viajes de SSH por
 * ciclo. `sh` sin bashismos: los servidores de base de datos viejos traen ash o
 * dash, no siempre bash.
 */
function script(dataDirectory: string): string {
  return [
    "echo '##cpu'",
    "grep '^cpu ' /proc/stat",
    "echo '##cores'",
    'nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo',
    "echo '##mem'",
    "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
    "echo '##load'",
    'cut -d" " -f1 /proc/loadavg',
    "echo '##disk'",
    // El data directory es 700 y propiedad de postgres, así que `df` sobre él
    // falla con un usuario de sólo lectura. Se sube al ancestro accesible: es
    // el mismo filesystem, que es justo lo que se quiere medir.
    `d='${dataDirectory}'; while [ "$d" != "/" ] && ! df -kP "$d" >/dev/null 2>&1; do d=$(dirname "$d"); done; df -kP "$d" 2>/dev/null | tail -1 || true`,
  ].join('; ');
}

/**
 * El directorio entra en una línea de shell, así que se valida en vez de
 * escaparse: una ruta con comillas o `$(...)` no es un descuido de tipeo.
 */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

function dataDirectoryOf(config: HostConfig): string {
  const raw = config.dataDirectory ?? '/var/lib/postgresql';
  if (!SAFE_PATH.test(raw)) {
    throw new Error(`Ruta de host inválida: ${raw}. Se permiten letras, números, ".", "_", "-" y "/".`);
  }
  return raw;
}

const SAFE_TARGET = /^[A-Za-z0-9._@-]+$/;
const SAFE_CONTAINER = /^[A-Za-z0-9._/-]+$/;

export async function readHostSnapshot(config: HostConfig, timeoutMs = 10_000): Promise<HostSnapshot> {
  const body = script(dataDirectoryOf(config));

  let stdout: string;
  if (config.source === 'ssh') {
    const target = config.target ?? '';
    if (!SAFE_TARGET.test(target)) {
      throw new Error('host.target debe ser usuario@servidor sin caracteres especiales.');
    }
    const args = [
      '-o',
      'BatchMode=yes', // nunca pedir contraseña: un colector no tiene a quién preguntarle
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=accept-new',
      ...(config.identityFile ? ['-i', config.identityFile] : []),
      target,
      body,
    ];
    ({ stdout } = await run('ssh', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }));
  } else if (config.source === 'docker') {
    const container = config.container ?? '';
    if (!SAFE_CONTAINER.test(container)) {
      throw new Error('host.container must be a Docker name/id (letters, digits, . _ - /).');
    }
    ({ stdout } = await run(
      'docker',
      ['exec', container, 'sh', '-c', body],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 },
    ));
  } else {
    ({ stdout } = await run('sh', ['-c', body], { timeout: timeoutMs, maxBuffer: 64 * 1024 }));
  }

  return parseSnapshot(stdout);
}

function sections(output: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('##')) {
      current = line.slice(2).trim();
      result.set(current, []);
      continue;
    }
    if (!current || line.trim() === '') continue;
    result.get(current)?.push(line);
  }
  return result;
}

export function parseSnapshot(output: string): HostSnapshot {
  const parts = sections(output);

  const cpuFields = (parts.get('cpu')?.[0] ?? '').trim().split(/\s+/).slice(1).map(Number);
  if (cpuFields.length < 5 || cpuFields.some((value) => !Number.isFinite(value))) {
    throw new Error('No se pudo leer /proc/stat en el host.');
  }
  // user nice system idle iowait irq softirq steal ...
  const total = cpuFields.reduce((sum, value) => sum + value, 0);

  const mem = new Map<string, number>();
  for (const line of parts.get('mem') ?? []) {
    const [key, value] = line.split(':');
    if (key && value) mem.set(key.trim(), Number(value.trim().split(/\s+/)[0]) * 1024);
  }

  const diskLine = (parts.get('disk')?.[0] ?? '').trim().split(/\s+/);
  const disk =
    diskLine.length >= 6
      ? {
          mount: String(diskLine[5]),
          totalBytes: Number(diskLine[1]) * 1024,
          freeBytes: Number(diskLine[3]) * 1024,
        }
      : null;

  return {
    cpu: {
      total,
      idle: cpuFields[3] ?? 0,
      iowait: cpuFields[4] ?? 0,
      steal: cpuFields[7] ?? 0,
    },
    cores: Math.max(1, Number(parts.get('cores')?.[0] ?? 1)),
    memTotalBytes: mem.get('MemTotal') ?? 0,
    memAvailableBytes: mem.get('MemAvailable') ?? 0,
    swapTotalBytes: mem.get('SwapTotal') ?? 0,
    swapFreeBytes: mem.get('SwapFree') ?? 0,
    load1: Number(parts.get('load')?.[0] ?? 0),
    disk: disk && Number.isFinite(disk.totalBytes) && disk.totalBytes > 0 ? disk : null,
  };
}

/**
 * Convierte snapshots en muestras. La CPU **exige** dos lecturas: /proc/stat da
 * jiffies acumulados desde el arranque, así que el primer ciclo no publica
 * porcentaje de CPU (publicar el promedio histórico del host sería mentir).
 */
export class HostTracker {
  private previous: HostSnapshot['cpu'] | null = null;

  samples(snapshot: HostSnapshot): Sample[] {
    const samples: Sample[] = [];

    const previous = this.previous;
    this.previous = snapshot.cpu;

    if (previous) {
      const totalDelta = snapshot.cpu.total - previous.total;
      // Un delta no positivo significa reinicio del host o reloj corrido.
      if (totalDelta > 0) {
        const idleDelta = Math.max(0, snapshot.cpu.idle - previous.idle);
        const iowaitDelta = Math.max(0, snapshot.cpu.iowait - previous.iowait);
        const stealDelta = Math.max(0, snapshot.cpu.steal - previous.steal);
        samples.push(
          { metric: 'host_cpu_pct', value: Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)) },
          { metric: 'host_cpu_iowait_pct', value: Math.min(100, (iowaitDelta / totalDelta) * 100) },
          // steal delata una VM con vecinos ruidosos: la base "está lenta" y
          // ninguna métrica de PostgreSQL lo explica.
          { metric: 'host_cpu_steal_pct', value: Math.min(100, (stealDelta / totalDelta) * 100) },
        );
      }
    }

    if (snapshot.memTotalBytes > 0) {
      const used = snapshot.memTotalBytes - snapshot.memAvailableBytes;
      samples.push(
        { metric: 'host_mem_used_pct', value: (used / snapshot.memTotalBytes) * 100 },
        { metric: 'host_mem_available_bytes', value: snapshot.memAvailableBytes },
        { metric: 'host_mem_total_bytes', value: snapshot.memTotalBytes },
      );
    }
    if (snapshot.swapTotalBytes > 0) {
      const usedSwap = snapshot.swapTotalBytes - snapshot.swapFreeBytes;
      samples.push({ metric: 'host_swap_used_pct', value: (usedSwap / snapshot.swapTotalBytes) * 100 });
    }

    // Normalizada por núcleo: "load 8" no dice nada sin saber si son 2 o 64.
    samples.push(
      { metric: 'host_load1_per_core', value: snapshot.load1 / snapshot.cores },
      { metric: 'host_cores', value: snapshot.cores },
    );

    if (snapshot.disk) {
      const usedBytes = snapshot.disk.totalBytes - snapshot.disk.freeBytes;
      const labels = { mount: snapshot.disk.mount };
      samples.push(
        { metric: 'host_disk_used_pct', value: (usedBytes / snapshot.disk.totalBytes) * 100, labels },
        { metric: 'host_disk_free_bytes', value: snapshot.disk.freeBytes, labels },
      );
    }

    return samples;
  }
}
