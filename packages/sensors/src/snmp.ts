import { createRequire } from "node:module";
import type { SnmpSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

const require = createRequire(import.meta.url);
const snmp = require("net-snmp") as {
  Version2c: number;
  createSession: (
    target: string,
    community: string,
    options?: Record<string, unknown>,
  ) => {
    get: (
      oids: string[],
      cb: (error: Error | null, varbinds: Varbind[]) => void,
    ) => void;
    close: () => void;
  };
  isVarbindError: (vb: Varbind) => boolean;
  varbindError: (vb: Varbind) => string;
};

type Varbind = {
  oid: string;
  type: number;
  value: string | number | Buffer;
};

const OID = {
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  sysName: "1.3.6.1.2.1.1.5.0",
  sysLocation: "1.3.6.1.2.1.1.6.0",
  ifDescr: (i: number) => `1.3.6.1.2.1.2.2.1.2.${i}`,
  ifSpeed: (i: number) => `1.3.6.1.2.1.2.2.1.5.${i}`,
  ifOperStatus: (i: number) => `1.3.6.1.2.1.2.2.1.8.${i}`,
  ifInOctets: (i: number) => `1.3.6.1.2.1.2.2.1.10.${i}`,
  ifOutOctets: (i: number) => `1.3.6.1.2.1.2.2.1.16.${i}`,
  ifInErrors: (i: number) => `1.3.6.1.2.1.2.2.1.14.${i}`,
  ifOutErrors: (i: number) => `1.3.6.1.2.1.2.2.1.20.${i}`,
} as const;

const OPER_STATUS: Record<number, string> = {
  1: "up",
  2: "down",
  3: "testing",
  4: "unknown",
  5: "dormant",
  6: "notPresent",
  7: "lowerLayerDown",
};

function resolveOids(sensor: SnmpSensorConfig): string[] {
  const preset = sensor.preset ?? (sensor.oids?.length ? "custom" : "device");
  const extra = sensor.oids ?? [];
  switch (preset) {
    case "device":
      return [OID.sysDescr, OID.sysUpTime, OID.sysName, OID.sysLocation, ...extra];
    case "uptime":
      return [OID.sysUpTime, OID.sysName, ...extra];
    case "interface": {
      const idx = sensor.ifIndex ?? 1;
      return [
        OID.ifDescr(idx),
        OID.ifOperStatus(idx),
        OID.ifSpeed(idx),
        OID.ifInOctets(idx),
        OID.ifOutOctets(idx),
        OID.ifInErrors(idx),
        OID.ifOutErrors(idx),
        ...extra,
      ];
    }
    case "custom":
      return extra.length ? extra : [OID.sysUpTime];
    default:
      return extra;
  }
}

function vbValue(vb: Varbind): string | number | null {
  if (snmp.isVarbindError(vb)) return null;
  if (Buffer.isBuffer(vb.value)) return vb.value.toString("utf8");
  if (typeof vb.value === "number") return vb.value;
  return String(vb.value);
}

function ticksToSeconds(ticks: number): number {
  return Math.floor(ticks / 100);
}

export async function runSnmpSensor(opts: {
  targetId: string;
  host: string;
  sensor: SnmpSensorConfig;
}): Promise<Sample> {
  const started = Date.now();
  const ts = nowIso();
  const community = opts.sensor.community ?? "public";
  const port = opts.sensor.port ?? 161;
  const timeoutMs = opts.sensor.timeoutMs ?? 3000;
  const retries = opts.sensor.retries ?? 1;
  const endpoint = endpointKey(opts.host, port);
  const oids = resolveOids(opts.sensor);
  const preset =
    opts.sensor.preset ?? (opts.sensor.oids?.length ? "custom" : "device");

  if (!oids.length) {
    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "snmp",
      endpoint,
      ts,
      ok: false,
      durationMs: 0,
      metrics: { preset },
      error: "no OIDs configured",
    };
  }

  return new Promise((resolve) => {
    let session: ReturnType<typeof snmp.createSession>;
    try {
      session = snmp.createSession(opts.host, community, {
        port,
        timeout: timeoutMs,
        retries,
        version: snmp.Version2c,
      });
    } catch (err) {
      resolve({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "snmp",
        endpoint,
        ts,
        ok: false,
        durationMs: Date.now() - started,
        metrics: { preset },
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    session.get(oids, (error, varbinds) => {
      try {
        session.close();
      } catch {
        /* ignore */
      }

      if (error) {
        resolve({
          source: "buho",
          targetId: opts.targetId,
          sensorId: opts.sensor.id,
          sensorType: "snmp",
          endpoint,
          ts,
          ok: false,
          durationMs: Date.now() - started,
          metrics: { preset },
          error: error.message,
        });
        return;
      }

      const metrics: Record<string, string | number | boolean | null> = {
        preset,
        oidCount: varbinds.length,
      };
      const ifIndex = opts.sensor.ifIndex;

      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) {
          metrics[`err:${vb.oid}`] = snmp.varbindError(vb);
          continue;
        }
        const val = vbValue(vb);
        if (vb.oid === OID.sysDescr) {
          metrics.sysDescr = String(val).slice(0, 120);
        } else if (vb.oid === OID.sysName) {
          metrics.sysName = String(val);
        } else if (vb.oid === OID.sysLocation) {
          metrics.sysLocation = String(val);
        } else if (vb.oid === OID.sysUpTime) {
          const ticks = typeof val === "number" ? val : Number(val);
          metrics.sysUpTimeTicks = ticks;
          metrics.sysUpTimeSec = ticksToSeconds(ticks);
          metrics.sysUpTimeDays =
            Math.round((ticksToSeconds(ticks) / 86400) * 10) / 10;
        } else if (ifIndex != null && vb.oid === OID.ifDescr(ifIndex)) {
          metrics.ifDescr = String(val);
        } else if (ifIndex != null && vb.oid === OID.ifOperStatus(ifIndex)) {
          const code = typeof val === "number" ? val : Number(val);
          metrics.ifOperStatus = code;
          metrics.ifOperStatusText = OPER_STATUS[code] ?? String(code);
        } else if (ifIndex != null && vb.oid === OID.ifSpeed(ifIndex)) {
          metrics.ifSpeedBps = typeof val === "number" ? val : Number(val);
        } else if (ifIndex != null && vb.oid === OID.ifInOctets(ifIndex)) {
          metrics.ifInOctets = typeof val === "number" ? val : Number(val);
        } else if (ifIndex != null && vb.oid === OID.ifOutOctets(ifIndex)) {
          metrics.ifOutOctets = typeof val === "number" ? val : Number(val);
        } else if (ifIndex != null && vb.oid === OID.ifInErrors(ifIndex)) {
          metrics.ifInErrors = typeof val === "number" ? val : Number(val);
        } else if (ifIndex != null && vb.oid === OID.ifOutErrors(ifIndex)) {
          metrics.ifOutErrors = typeof val === "number" ? val : Number(val);
        } else {
          metrics[`oid:${vb.oid}`] =
            typeof val === "number" ? val : String(val).slice(0, 80);
        }
      }

      const expectOperUp = opts.sensor.expectOperUp ?? preset === "interface";
      let ok = true;
      let errorMsg: string | undefined;
      if (expectOperUp && metrics.ifOperStatus != null) {
        ok = Number(metrics.ifOperStatus) === 1;
        if (!ok) {
          errorMsg = `interface ${metrics.ifOperStatusText ?? metrics.ifOperStatus} (want up)`;
        }
      }

      resolve({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "snmp",
        endpoint,
        ts,
        ok,
        durationMs: Date.now() - started,
        metrics,
        error: errorMsg,
      });
    });
  });
}
