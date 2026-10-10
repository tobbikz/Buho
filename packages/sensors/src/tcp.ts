import net from "node:net";
import type { TcpSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

export async function runTcpSensor(opts: {
  targetId: string;
  host: string;
  sensor: TcpSensorConfig;
}): Promise<Sample> {
  const started = Date.now();
  const ts = nowIso();
  const timeoutMs = opts.sensor.timeoutMs ?? 3000;
  const endpoint = endpointKey(opts.host, opts.sensor.port);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (sample: Sample) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(sample);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finish({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "tcp",
        endpoint,
        ts,
        ok: true,
        durationMs: Date.now() - started,
        metrics: {
          connectMs: Date.now() - started,
          port: opts.sensor.port,
        },
      });
    });
    socket.once("timeout", () => {
      finish({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "tcp",
        endpoint,
        ts,
        ok: false,
        durationMs: Date.now() - started,
        metrics: { port: opts.sensor.port },
        error: `timeout after ${timeoutMs}ms`,
      });
    });
    socket.once("error", (err) => {
      finish({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "tcp",
        endpoint,
        ts,
        ok: false,
        durationMs: Date.now() - started,
        metrics: { port: opts.sensor.port },
        error: err.message,
      });
    });
    socket.connect(opts.sensor.port, opts.host);
  });
}
