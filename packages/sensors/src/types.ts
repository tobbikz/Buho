/** Canonical correlation key across IKZ suite (Búho, Halcón, Centinela). */
export type EndpointKey = {
  host: string;
  port: number | null;
};

export type Severity = "info" | "warn" | "crit" | "ok";

/** Device class — UI grouping (PRTG-style device tree). */
export type TargetRole =
  | "server"
  | "switch"
  | "firewall"
  | "router"
  | "endpoint"
  | "ups"
  | "other";

export type SensorType =
  | "host"
  | "icmp"
  | "tcp"
  | "udp"
  | "http"
  | "tls_cert"
  | "dns"
  | "snmp"
  | "process"
  | "winrm";

export type SensorConfig =
  | HostSensorConfig
  | IcmpSensorConfig
  | TcpSensorConfig
  | UdpSensorConfig
  | HttpSensorConfig
  | TlsCertSensorConfig
  | DnsSensorConfig
  | SnmpSensorConfig
  | ProcessSensorConfig
  | WinrmSensorConfig;

export type HostSensorConfig = {
  type: "host";
  id: string;
  /** If set, probe via SSH; otherwise local /proc. */
  ssh?: { user: string; port?: number };
};

export type IcmpSensorConfig = {
  type: "icmp";
  id: string;
  count?: number;
  timeoutMs?: number;
};

export type TcpSensorConfig = {
  type: "tcp";
  id: string;
  port: number;
  timeoutMs?: number;
};

/** UDP reachability (open|filtered vs closed). Useful for DNS/VPN/syslog ports. */
export type UdpSensorConfig = {
  type: "udp";
  id: string;
  port: number;
  timeoutMs?: number;
  /** Optional payload (utf8). Empty datagram by default. */
  payload?: string;
};

export type HttpSensorConfig = {
  type: "http";
  id: string;
  url: string;
  method?: string;
  expectStatus?: number[];
  /** Substring must appear in the response body. */
  expectBodyIncludes?: string;
  /** Body must match this JS regex (without slashes), e.g. `"ok"\\s*:\\s*true`. */
  expectBodyRegex?: string;
  /**
   * Simple JSON path (`$.status` or `data.ok`). If set, the resolved value
   * must exist; with `expectJsonEquals`, it must equal that value (stringified).
   */
  expectJsonPath?: string;
  expectJsonEquals?: string | number | boolean;
  /** Soft latency warning threshold (ms) — check layer. Default 5000. */
  warnMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

export type TlsCertSensorConfig = {
  type: "tls_cert";
  id: string;
  host: string;
  port?: number;
  warnDays?: number;
  critDays?: number;
  servername?: string;
};

export type DnsSensorConfig = {
  type: "dns";
  id: string;
  name: string;
  recordType?: "A" | "AAAA";
  /** Optional resolver (e.g. 8.8.8.8); system default if omitted. */
  server?: string;
  timeoutMs?: number;
  expectIncludes?: string;
};

/**
 * SNMP — unlocks switches, firewalls, routers, UPS (PRTG moat).
 * `preset` maps to common IF-MIB / SNMPv2-MIB OIDs; `oids` for custom.
 */
export type SnmpPreset = "device" | "uptime" | "interface" | "custom";

export type SnmpSensorConfig = {
  type: "snmp";
  id: string;
  community?: string;
  port?: number;
  timeoutMs?: number;
  retries?: number;
  preset?: SnmpPreset;
  /** Required for preset "interface" — ifIndex from IF-MIB. */
  ifIndex?: number;
  /** Custom OID list (dotted). Used when preset is "custom" or merged with preset. */
  oids?: string[];
  /** If true (default for interface), operStatus must be up(1). */
  expectOperUp?: boolean;
};

/** Linux process match (local ps or SSH). */
export type ProcessSensorConfig = {
  type: "process";
  id: string;
  /** JS regex matched against ps args/comm lines. */
  match: string;
  minCount?: number;
  timeoutMs?: number;
  ssh?: { user: string; port?: number };
};

/**
 * Windows metrics via SSH+PowerShell (preferred from Linux) or WinRM (pwsh Invoke-Command).
 */
export type WinrmSensorConfig = {
  type: "winrm";
  id: string;
  transport?: "ssh" | "winrm";
  user?: string;
  password?: string;
  /** WinRM HTTP(S) port; default 5985. */
  port?: number;
  sshPort?: number;
  useSsl?: boolean;
  query?: "cpu_mem" | "process";
  processName?: string;
  timeoutMs?: number;
};

export type TargetConfig = {
  id: string;
  host: string;
  label?: string;
  role?: TargetRole;
  /** Skip in probes when false (templates / WIP devices). Default true. */
  enabled?: boolean;
  sensors: SensorConfig[];
};

export type InfraConfig = {
  intervalSec?: number;
  targets: TargetConfig[];
};

/** @deprecated alias — Halcón naming */
export type HalconConfig = InfraConfig;

/** One measurement from a sensor run. */
export type Sample = {
  source: "buho";
  targetId: string;
  sensorId: string;
  sensorType: SensorType;
  endpoint: EndpointKey;
  ts: string;
  ok: boolean;
  durationMs: number;
  metrics: Record<string, number | string | boolean | null>;
  error?: string;
};

/** Opinionated finding — Centinela-compatible shape. */
export type Finding = {
  source: "buho";
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  remediation?: string;
  endpoint: EndpointKey;
  targetId: string;
  sensorId: string;
  sensorType: SensorType;
  ts: string;
  metrics?: Record<string, number | string | boolean | null>;
};

export type ProbeResult = {
  sample: Sample;
  findings: Finding[];
};

export function endpointKey(host: string, port: number | null = null): EndpointKey {
  return { host: host.toLowerCase(), port };
}

export function nowIso(): string {
  return new Date().toISOString();
}
