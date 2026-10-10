import { runIcmpSensor } from "./icmp.js";
import { runTcpSensor } from "./tcp.js";

export type DiscoveryHit = {
  host: string;
  icmpOk: boolean;
  icmpMs: number | null;
  openPorts: number[];
};

export type DiscoveryOptions = {
  /** Explicit hosts (IPs/hostnames). */
  hosts?: string[];
  /**
   * CIDR like 192.168.1.0/24 — only /24../30 supported (no huge scans).
   * Max 256 hosts.
   */
  cidr?: string;
  /** TCP ports to probe when ICMP fails or always. Default [22, 80, 443, 161]. */
  ports?: number[];
  timeoutMs?: number;
  /** Cap concurrent probes. */
  concurrency?: number;
};

function expandCidr(cidr: string): string[] {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr.trim());
  if (!m) throw new Error(`unsupported CIDR: ${cidr}`);
  const prefix = Number(m[5]);
  if (prefix < 24 || prefix > 32) {
    throw new Error(`CIDR /${prefix} rejected — only /24../32 allowed (max 256 hosts)`);
  }
  const base =
    ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>>
    0;
  const hostBits = 32 - prefix;
  const size = 1 << hostBits;
  const network = (base >>> hostBits) << hostBits;
  const out: string[] = [];
  for (let i = 0; i < size; i++) {
    const ip = (network + i) >>> 0;
    // skip network + broadcast for /24../30
    if (hostBits >= 2 && (i === 0 || i === size - 1)) continue;
    out.push(
      `${(ip >>> 24) & 255}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`,
    );
  }
  return out;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]!);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * Scan hosts/CIDR with ICMP + optional TCP ports. Returns only hosts with any signal.
 */
export async function discoverHosts(opts: DiscoveryOptions): Promise<DiscoveryHit[]> {
  const ports = opts.ports ?? [22, 80, 443, 161];
  const timeoutMs = opts.timeoutMs ?? 1500;
  const concurrency = opts.concurrency ?? 32;

  const hosts = [...(opts.hosts ?? [])];
  if (opts.cidr) hosts.push(...expandCidr(opts.cidr));
  const unique = [...new Set(hosts.map((h) => h.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  if (unique.length > 256) throw new Error(`discovery capped at 256 hosts (got ${unique.length})`);

  const hits = await mapPool(unique, concurrency, async (host) => {
    const icmp = await runIcmpSensor({
      targetId: "discover",
      host,
      sensor: { type: "icmp", id: "ping", count: 1, timeoutMs },
    });
    const openPorts: number[] = [];
    // Probe ports when ICMP fails or always for richer fingerprint.
    for (const port of ports) {
      const tcp = await runTcpSensor({
        targetId: "discover",
        host,
        sensor: { type: "tcp", id: `p${port}`, port, timeoutMs },
      });
      if (tcp.ok) openPorts.push(port);
    }
    const icmpOk = icmp.ok;
    const icmpMs =
      typeof icmp.metrics.rttAvgMs === "number" ? Number(icmp.metrics.rttAvgMs) : null;
    return { host, icmpOk, icmpMs, openPorts };
  });

  return hits.filter((h) => h.icmpOk || h.openPorts.length > 0);
}
