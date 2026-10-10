import dgram from "node:dgram";
import type { UdpSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

/**
 * UDP probe: send datagram, wait for reply or ICMP-style failure.
 * - reply → open
 * - ECONNREFUSED → closed
 * - timeout → open|filtered (counted as ok for "listening" ports that don't reply)
 */
export async function runUdpSensor(opts: {
  targetId: string;
  host: string;
  sensor: UdpSensorConfig;
}): Promise<Sample> {
  const started = Date.now();
  const ts = nowIso();
  const timeoutMs = opts.sensor.timeoutMs ?? 2000;
  const endpoint = endpointKey(opts.host, opts.sensor.port);
  const payload = Buffer.from(opts.sensor.payload ?? "");

  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;

    const finish = (sample: Sample) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(sample);
    };

    const timer = setTimeout(() => {
      finish({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "udp",
        endpoint,
        ts,
        ok: true,
        durationMs: Date.now() - started,
        metrics: {
          port: opts.sensor.port,
          state: "open|filtered",
          note: "no reply (typical for firewalled/silent UDP)",
        },
      });
    }, timeoutMs);

    socket.on("message", () => {
      clearTimeout(timer);
      finish({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "udp",
        endpoint,
        ts,
        ok: true,
        durationMs: Date.now() - started,
        metrics: {
          port: opts.sensor.port,
          state: "open",
        },
      });
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      const closed =
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ECONNREFUSED";
      finish({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "udp",
        endpoint,
        ts,
        ok: !closed,
        durationMs: Date.now() - started,
        metrics: {
          port: opts.sensor.port,
          state: closed ? "closed" : "error",
        },
        error: err.message,
      });
    });

    try {
      socket.connect(opts.sensor.port, opts.host, () => {
        socket.send(payload, (err) => {
          if (err) {
            clearTimeout(timer);
            finish({
              source: "buho",
              targetId: opts.targetId,
              sensorId: opts.sensor.id,
              sensorType: "udp",
              endpoint,
              ts,
              ok: false,
              durationMs: Date.now() - started,
              metrics: { port: opts.sensor.port, state: "error" },
              error: err.message,
            });
          }
        });
      });
    } catch (err) {
      clearTimeout(timer);
      finish({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "udp",
        endpoint,
        ts,
        ok: false,
        durationMs: Date.now() - started,
        metrics: { port: opts.sensor.port, state: "error" },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
