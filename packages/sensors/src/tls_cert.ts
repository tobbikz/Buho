import tls from "node:tls";
import type { TlsCertSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

function cnString(cn: string | string[] | undefined): string | null {
  if (cn == null) return null;
  return Array.isArray(cn) ? (cn[0] ?? null) : cn;
}

export async function runTlsCertSensor(opts: {
  targetId: string;
  host: string;
  sensor: TlsCertSensorConfig;
}): Promise<Sample> {
  const started = Date.now();
  const ts = nowIso();
  const port = opts.sensor.port ?? 443;
  const servername = opts.sensor.servername ?? opts.sensor.host;
  const endpoint = endpointKey(opts.sensor.host, port);

  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: opts.sensor.host,
        port,
        servername,
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          resolve({
            source: "buho",
            targetId: opts.targetId,
            sensorId: opts.sensor.id,
            sensorType: "tls_cert",
            endpoint,
            ts,
            ok: false,
            durationMs: Date.now() - started,
            metrics: {},
            error: "no peer certificate",
          });
          return;
        }
        const validTo = new Date(cert.valid_to);
        const daysLeft =
          Math.floor((validTo.getTime() - Date.now()) / (24 * 3600 * 1000));
        resolve({
          source: "buho",
          targetId: opts.targetId,
          sensorId: opts.sensor.id,
          sensorType: "tls_cert",
          endpoint,
          ts,
          ok: daysLeft >= 0,
          durationMs: Date.now() - started,
          metrics: {
            daysLeft,
            validTo: validTo.toISOString(),
            subject: cnString(cert.subject?.CN),
            issuer: cnString(cert.issuer?.CN),
          },
          error: daysLeft < 0 ? "certificate expired" : undefined,
        });
      },
    );

    socket.setTimeout(opts.sensor.warnDays ? 10000 : 10000);
    socket.once("timeout", () => {
      socket.destroy();
      resolve({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "tls_cert",
        endpoint,
        ts,
        ok: false,
        durationMs: Date.now() - started,
        metrics: {},
        error: "tls handshake timeout",
      });
    });
    socket.once("error", (err) => {
      resolve({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "tls_cert",
        endpoint,
        ts,
        ok: false,
        durationMs: Date.now() - started,
        metrics: {},
        error: err.message,
      });
    });
  });
}
