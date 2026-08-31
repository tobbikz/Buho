import { createConnection, isIPv4, type Socket } from 'node:net';
import type { EngineKind } from './engine';

/**
 * Descubrimiento de bases de datos en una red.
 *
 * La parte interesante es que **identifica el motor y casi siempre la versión
 * sin credenciales**, hablando el saludo inicial de cada protocolo. No es un
 * escáner de puertos que reporta "algo escucha en el 3306": eso lo hace nmap y
 * no distingue un MariaDB real de cualquier cosa puesta en ese puerto.
 *
 * - **MariaDB/MySQL** manda su paquete de saludo en cuanto se abre la conexión,
 *   con la versión en texto. Es el más generoso de los tres.
 * - **SQL Server** responde al PRELOGIN de TDS con un token de versión binario:
 *   major, minor y build, antes de cualquier autenticación.
 * - **PostgreSQL** no dice su versión sin autenticar, pero su respuesta al
 *   SSLRequest ('S' o 'N', un solo byte) lo identifica sin margen de duda.
 *
 * Nada de esto inicia sesión ni manda credenciales: la conexión se cierra en
 * cuanto se leyó el saludo. Para PostgreSQL la versión queda en null y se
 * reporta así, en vez de adivinarla por el puerto.
 */

export interface DiscoveryTarget {
  host: string;
  port: number;
}

export interface Discovered extends DiscoveryTarget {
  engine: EngineKind | 'desconocido';
  versionText: string | null;
  /** Texto crudo del saludo, cuando lo hay. Sirve para lo que no se supo leer. */
  banner: string | null;
  latencyMs: number;
}

export interface DiscoveryOptions {
  ports?: number[];
  /** Por sonda. Corto a propósito: en una /24 la mayoría no responde. */
  timeoutMs?: number;
  concurrency?: number;
  /** Tope de direcciones para que un /8 por error no lance un millón de sondas. */
  maxHosts?: number;
  /**
   * Redes públicas. Apagado por omisión: una herramienta de monitoreo que
   * escanea internet desde el servidor del cliente es un problema legal, no una
   * función. Se enciende explícitamente y queda en la bitácora.
   */
  allowPublic?: boolean;
}

export const DEFAULT_PORTS = [5432, 3306, 1433];

const DEFAULTS = {
  timeoutMs: 1_200,
  concurrency: 96,
  maxHosts: 1_024,
};

/** ------------------------------------------------------- rangos de red */

function ipToInt(ip: string): number {
  return ip.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
}

function intToIp(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/**
 * `10.0.0.0/24`, `10.0.0.5-10.0.0.40` o una sola dirección.
 *
 * En un /24 o mayor se descartan la dirección de red y la de broadcast: no
 * responden nunca y sólo gastan dos sondas por rango.
 */
export function expandRange(spec: string, maxHosts = DEFAULTS.maxHosts): string[] {
  const trimmed = spec.trim();

  if (trimmed.includes('/')) {
    const [address, bitsRaw] = trimmed.split('/');
    const bits = Number(bitsRaw);
    if (!address || !isIPv4(address) || !Number.isInteger(bits) || bits < 8 || bits > 32) {
      throw new Error(`Rango inválido: "${spec}". Se espera algo como 192.168.1.0/24.`);
    }

    const size = 2 ** (32 - bits);
    if (size > maxHosts) {
      throw new Error(
        `El rango ${spec} tiene ${size.toLocaleString('es')} direcciones y el tope es ${maxHosts.toLocaleString('es')}. ` +
          'Escanear de a pedazos es más rápido y no deja la red llena de intentos de conexión.',
      );
    }

    const network = ipToInt(address) & (size === 2 ** 32 ? 0 : ~(size - 1) >>> 0);
    const skipEdges = size >= 4;
    const hosts: string[] = [];
    for (let offset = skipEdges ? 1 : 0; offset < size - (skipEdges ? 1 : 0); offset += 1) {
      hosts.push(intToIp(network + offset));
    }
    return hosts;
  }

  if (trimmed.includes('-')) {
    const [fromRaw, toRaw] = trimmed.split('-').map((part) => part.trim());
    if (!fromRaw || !toRaw || !isIPv4(fromRaw) || !isIPv4(toRaw)) {
      throw new Error(`Rango inválido: "${spec}". Se espera algo como 10.0.0.5-10.0.0.40.`);
    }
    const from = ipToInt(fromRaw);
    const to = ipToInt(toRaw);
    if (to < from) throw new Error(`El rango "${spec}" termina antes de empezar.`);
    if (to - from + 1 > maxHosts) {
      throw new Error(`El rango ${spec} supera el tope de ${maxHosts.toLocaleString('es')} direcciones.`);
    }
    return Array.from({ length: to - from + 1 }, (_, index) => intToIp(from + index));
  }

  if (!isIPv4(trimmed)) {
    // Un nombre de host suelto es válido: se resuelve al conectar.
    if (/^[a-z0-9.-]+$/i.test(trimmed)) return [trimmed];
    throw new Error(`Rango inválido: "${spec}".`);
  }
  return [trimmed];
}

/** Privadas (RFC 1918), loopback y enlace local. */
export function isPrivateAddress(host: string): boolean {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number) as [number, number];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** ------------------------------------------------------ sondas por protocolo */

function connect(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once('connect', () => resolve(socket));
    socket.once('timeout', () => fail(new Error('timeout')));
    socket.once('error', fail);
  });
}

/** Primer bloque de datos que llegue, o vacío si el servidor no habla primero. */
function readFirst(socket: Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => resolve(Buffer.concat(chunks));
    const timer = setTimeout(done, timeoutMs);
    socket.once('data', (chunk: Buffer) => {
      chunks.push(chunk);
      clearTimeout(timer);
      // Un saludo puede venir en más de un segmento; se espera un instante más.
      setTimeout(done, 60);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      done();
    });
    socket.once('close', () => {
      clearTimeout(timer);
      done();
    });
  });
}

/**
 * MySQL/MariaDB: cabecera de 4 bytes, versión del protocolo (10) y la versión
 * del servidor en una cadena terminada en cero.
 *
 * Un paquete de error también identifica al motor: "Host … is not allowed to
 * connect" significa MariaDB con una regla de acceso, no otro servicio.
 */
function parseMysql(data: Buffer): { versionText: string | null; banner: string | null } | null {
  if (data.length < 5) return null;

  if (data[4] === 0xff) {
    const message = data.subarray(7, Math.min(data.length, 160)).toString('latin1');
    return { versionText: null, banner: message.replace(/\0/g, '').trim() };
  }
  if (data[4] !== 10) return null;

  const end = data.indexOf(0, 5);
  if (end < 0) return null;
  const version = data.subarray(5, end).toString('latin1');
  return { versionText: version, banner: version };
}

/**
 * SQL Server: PRELOGIN de TDS.
 *
 * Cabecera de 8 bytes (tipo 0x12, estado EOM) y una tabla de opciones. La
 * opción 0x00 es VERSION y sus datos son major, minor y build en big endian.
 */
function preloginPacket(): Buffer {
  const payload = Buffer.from([
    0x00, 0x00, 0x06, 0x00, 0x06, // VERSION: offset 6, longitud 6
    0xff, // TERMINATOR
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // datos de versión del cliente
  ]);
  const header = Buffer.alloc(8);
  header[0] = 0x12; // PRELOGIN
  header[1] = 0x01; // EOM
  header.writeUInt16BE(8 + payload.length, 2);
  header[6] = 1; // packet id
  return Buffer.concat([header, payload]);
}

function parseTds(data: Buffer): { versionText: string | null; banner: string | null } | null {
  if (data.length < 9 || data[0] !== 0x04) return null; // 0x04 = respuesta tabular

  const payload = data.subarray(8);
  let cursor = 0;
  while (cursor + 5 <= payload.length) {
    const token = payload[cursor];
    if (token === 0xff) break;
    const offset = payload.readUInt16BE(cursor + 1);
    const length = payload.readUInt16BE(cursor + 3);

    if (token === 0x00 && offset + 4 <= payload.length && length >= 4) {
      const major = payload[offset];
      const minor = payload[offset + 1];
      const build = payload.readUInt16BE(offset + 2);
      return { versionText: `${major}.${minor}.${build}`, banner: null };
    }
    cursor += 5;
  }
  // Respondió TDS pero sin token de versión: sigue siendo SQL Server.
  return { versionText: null, banner: null };
}

/** PostgreSQL: SSLRequest. La respuesta es un byte, 'S' o 'N'. */
function sslRequestPacket(): Buffer {
  const packet = Buffer.alloc(8);
  packet.writeInt32BE(8, 0);
  packet.writeInt32BE(80877103, 4); // 1234 << 16 | 5679
  return packet;
}

async function probe(host: string, port: number, timeoutMs: number): Promise<Discovered | null> {
  const started = Date.now();
  let socket: Socket;
  try {
    socket = await connect(host, port, timeoutMs);
  } catch {
    return null;
  }

  try {
    // Quien habla primero define la sonda: MySQL saluda solo, los otros dos
    // esperan que el cliente abra la conversación.
    //
    // La espera es corta a propósito. Si fuera el timeout completo, cada
    // PostgreSQL y cada SQL Server costaría ese tiempo entero antes de siquiera
    // empezar su sonda, porque no hay saludo que llegue nunca. MariaDB local
    // contesta en 60 ms, así que un cuarto de segundo cubre de sobra una red
    // interna y recorta el escaneo a un tercio.
    const greeting = await readFirst(socket, Math.min(timeoutMs, 250));

    if (greeting.length > 0) {
      const mysql = parseMysql(greeting);
      if (mysql) {
        return {
          host,
          port,
          engine: 'mariadb',
          versionText: mysql.versionText,
          banner: mysql.banner,
          latencyMs: Date.now() - started,
        };
      }
      return {
        host,
        port,
        engine: 'desconocido',
        versionText: null,
        banner: greeting.subarray(0, 80).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
        latencyMs: Date.now() - started,
      };
    }

    socket.write(sslRequestPacket());
    const pg = await readFirst(socket, Math.min(timeoutMs, 700));
    if (pg.length === 1 && (pg[0] === 0x53 || pg[0] === 0x4e)) {
      return {
        host,
        port,
        engine: 'postgres',
        versionText: null,
        banner: pg[0] === 0x53 ? 'TLS disponible' : 'TLS no disponible',
        latencyMs: Date.now() - started,
      };
    }
  } catch {
    // Cae al intento de TDS.
  } finally {
    socket.destroy();
  }

  // Segunda conexión: el SSLRequest ya dejó el socket en un estado que TDS no
  // entiende, y reusarlo daría un falso negativo en cualquier SQL Server que
  // escuche en un puerto no estándar.
  let tdsSocket: Socket;
  try {
    tdsSocket = await connect(host, port, timeoutMs);
  } catch {
    return null;
  }

  try {
    tdsSocket.write(preloginPacket());
    const tds = await readFirst(tdsSocket, Math.min(timeoutMs, 700));
    const parsed = tds.length > 0 ? parseTds(tds) : null;
    if (parsed) {
      return {
        host,
        port,
        engine: 'mssql',
        versionText: parsed.versionText,
        banner: parsed.banner,
        latencyMs: Date.now() - started,
      };
    }
  } catch {
    // Puerto abierto sin protocolo reconocible.
  } finally {
    tdsSocket.destroy();
  }

  return {
    host,
    port,
    engine: 'desconocido',
    versionText: null,
    banner: 'puerto abierto, protocolo no reconocido',
    latencyMs: Date.now() - started,
  };
}

/**
 * Recorre un rango y devuelve lo que encontró.
 *
 * La concurrencia es un pool simple sobre la lista de (host, puerto): sin esto,
 * un /24 por tres puertos abre 762 conexiones a la vez y el sistema operativo
 * empieza a rechazarlas, lo que se ve igual que "no hay nada ahí".
 */
export async function discover(
  ranges: string[],
  options: DiscoveryOptions = {},
): Promise<{ found: Discovered[]; scanned: number }> {
  const ports = options.ports?.length ? options.ports : DEFAULT_PORTS;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const maxHosts = options.maxHosts ?? DEFAULTS.maxHosts;

  const hosts = [...new Set(ranges.flatMap((range) => expandRange(range, maxHosts)))];
  if (hosts.length > maxHosts) {
    throw new Error(`Los rangos suman ${hosts.length} direcciones y el tope es ${maxHosts}.`);
  }

  if (!options.allowPublic) {
    const public_ = hosts.filter((host) => isIPv4(host) && !isPrivateAddress(host));
    if (public_.length > 0) {
      throw new Error(
        `El rango incluye direcciones públicas (${public_.slice(0, 3).join(', ')}${public_.length > 3 ? '…' : ''}). ` +
          'Escanear fuera de la red privada hay que habilitarlo a propósito.',
      );
    }
  }

  const targets = hosts.flatMap((host) => ports.map((port) => ({ host, port })));
  const found: Discovered[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      if (!target) return;
      const result = await probe(target.host, target.port, timeoutMs).catch(() => null);
      if (result) found.push(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()),
  );

  found.sort((a, b) => a.host.localeCompare(b.host, 'en', { numeric: true }) || a.port - b.port);
  return { found, scanned: targets.length };
}
