import type {
  ProbeResult,
  Sample,
  SensorConfig,
  TargetConfig,
} from "./types.js";
import { runHostSensor } from "./host.js";
import { runIcmpSensor } from "./icmp.js";
import { runTcpSensor } from "./tcp.js";
import { runUdpSensor } from "./udp.js";
import { runHttpSensor } from "./http.js";
import { runTlsCertSensor } from "./tls_cert.js";
import { runDnsSensor } from "./dns.js";
import { runSnmpSensor } from "./snmp.js";
import { runProcessSensor } from "./process.js";
import { runWinrmSensor } from "./winrm.js";

export { runHostSensor } from "./host.js";
export { runIcmpSensor } from "./icmp.js";
export { runTcpSensor } from "./tcp.js";
export { runUdpSensor } from "./udp.js";
export { runHttpSensor, readJsonPath } from "./http.js";
export { runTlsCertSensor } from "./tls_cert.js";
export { runDnsSensor } from "./dns.js";
export { runSnmpSensor } from "./snmp.js";
export { runProcessSensor } from "./process.js";
export { runWinrmSensor } from "./winrm.js";
export { discoverHosts } from "./discovery.js";
export type { DiscoveryHit, DiscoveryOptions } from "./discovery.js";
export { startTrapListener } from "./traps.js";
export type { SnmpTrapEvent, TrapListener } from "./traps.js";
export { enrichSnmpBandwidth, deltaCounter32 } from "./snmp_rates.js";
export type { SampleHistory } from "./snmp_rates.js";
export { sensorSampleToBuho, sensorSamplesToBuho } from "./to-buho-samples.js";
export type { BuhoMetricSample } from "./to-buho-samples.js";
export type * from "./types.js";

export async function runSensor(
  target: TargetConfig,
  sensor: SensorConfig,
): Promise<Sample> {
  switch (sensor.type) {
    case "host":
      return runHostSensor({
        targetId: target.id,
        host: target.host,
        sensor,
      });
    case "icmp":
      return runIcmpSensor({
        targetId: target.id,
        host: target.host,
        sensor,
      });
    case "tcp":
      return runTcpSensor({
        targetId: target.id,
        host: target.host,
        sensor,
      });
    case "udp":
      return runUdpSensor({
        targetId: target.id,
        host: target.host,
        sensor,
      });
    case "http":
      return runHttpSensor({
        targetId: target.id,
        host: target.host,
        sensor,
      });
    case "tls_cert":
      return runTlsCertSensor({
        targetId: target.id,
        host: target.host,
        sensor,
      });
    case "dns":
      return runDnsSensor({
        targetId: target.id,
        host: target.host,
        sensor,
      });
    case "snmp":
      return runSnmpSensor({
        targetId: target.id,
        host: target.host,
        sensor,
      });
    case "process":
      return runProcessSensor({
        targetId: target.id,
        host: target.host,
        sensor,
      });
    case "winrm":
      return runWinrmSensor({
        targetId: target.id,
        host: target.host,
        sensor,
      });
    default: {
      const _exhaustive: never = sensor;
      void _exhaustive;
      throw new Error("unknown sensor type");
    }
  }
}

export async function probeTarget(
  target: TargetConfig,
  filterType?: string,
): Promise<Sample[]> {
  if (target.enabled === false) return [];
  const sensors = filterType
    ? target.sensors.filter((s) => s.type === filterType)
    : target.sensors;
  const out: Sample[] = [];
  for (const sensor of sensors) {
    out.push(await runSensor(target, sensor));
  }
  return out;
}

export type { ProbeResult };
