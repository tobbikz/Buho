import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import type { HttpSensorConfig, Sample } from "./types.js";
import { endpointKey, nowIso } from "./types.js";

function portFromUrl(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** Resolve `$.a.b` / `a.b` against a JSON document. */
export function readJsonPath(
  doc: unknown,
  path: string,
): unknown {
  const clean = path.trim().replace(/^\$\.?/, "");
  if (!clean) return doc;
  const parts = clean.split(".").filter(Boolean);
  let cur: unknown = doc;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function assertBody(
  body: string,
  sensor: HttpSensorConfig,
): { bodyOk: boolean; jsonOk: boolean; error?: string } {
  if (sensor.expectBodyIncludes && !body.includes(sensor.expectBodyIncludes)) {
    return { bodyOk: false, jsonOk: true, error: "body missing expected substring" };
  }
  if (sensor.expectBodyRegex) {
    try {
      const re = new RegExp(sensor.expectBodyRegex);
      if (!re.test(body)) {
        return {
          bodyOk: false,
          jsonOk: true,
          error: `body did not match /${sensor.expectBodyRegex}/`,
        };
      }
    } catch {
      return {
        bodyOk: false,
        jsonOk: true,
        error: `invalid expectBodyRegex: ${sensor.expectBodyRegex}`,
      };
    }
  }
  if (sensor.expectJsonPath) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { bodyOk: true, jsonOk: false, error: "body is not JSON" };
    }
    const value = readJsonPath(parsed, sensor.expectJsonPath);
    if (value === undefined) {
      return {
        bodyOk: true,
        jsonOk: false,
        error: `JSON path ${sensor.expectJsonPath} missing`,
      };
    }
    if (sensor.expectJsonEquals !== undefined) {
      const got = typeof value === "string" ? value : JSON.stringify(value);
      const want =
        typeof sensor.expectJsonEquals === "string"
          ? sensor.expectJsonEquals
          : JSON.stringify(sensor.expectJsonEquals);
      if (got !== want) {
        return {
          bodyOk: true,
          jsonOk: false,
          error: `JSON ${sensor.expectJsonPath}=${got} (want ${want})`,
        };
      }
    }
  }
  return { bodyOk: true, jsonOk: true };
}

/**
 * HTTP synthetic with phase timings (dns / connect / tls / ttfb / total)
 * and body / JSON asserts — PRTG-class endpoint probe without an agent.
 */
export async function runHttpSensor(opts: {
  targetId: string;
  host: string;
  sensor: HttpSensorConfig;
}): Promise<Sample> {
  const started = performance.now();
  const ts = nowIso();
  const timeoutMs = opts.sensor.timeoutMs ?? 10000;
  const method = opts.sensor.method ?? "GET";
  const expectStatus = opts.sensor.expectStatus ?? [200];

  let url: URL;
  try {
    url = new URL(opts.sensor.url);
  } catch {
    return {
      source: "buho",
      targetId: opts.targetId,
      sensorId: opts.sensor.id,
      sensorType: "http",
      endpoint: endpointKey(opts.host, null),
      ts,
      ok: false,
      durationMs: 0,
      metrics: {},
      error: `invalid url: ${opts.sensor.url}`,
    };
  }

  const endpoint = endpointKey(url.hostname, portFromUrl(url));
  const lib = url.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    let dnsMs: number | null = null;
    let connectMs: number | null = null;
    let tlsMs: number | null = null;
    let ttfbMs: number | null = null;
    let settled = false;

    const finish = (sample: Sample) => {
      if (settled) return;
      settled = true;
      resolve(sample);
    };

    const req = lib.request(
      url,
      {
        method,
        headers: opts.sensor.headers,
        timeout: timeoutMs,
        servername: url.protocol === "https:" ? url.hostname : undefined,
      },
      (res) => {
        ttfbMs = Math.round(performance.now() - started);
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const totalMs = Math.round(performance.now() - started);
          const body = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          const statusOk = expectStatus.includes(status);
          const bodyAssert = assertBody(body, opts.sensor);
          const ok = statusOk && bodyAssert.bodyOk && bodyAssert.jsonOk;

          finish({
            source: "buho",
            targetId: opts.targetId,
            sensorId: opts.sensor.id,
            sensorType: "http",
            endpoint,
            ts,
            ok,
            durationMs: totalMs,
            metrics: {
              status,
              totalMs,
              dnsMs,
              connectMs,
              tlsMs,
              ttfbMs,
              bodyBytes: Buffer.byteLength(body),
              statusOk,
              bodyOk: bodyAssert.bodyOk,
              jsonOk: bodyAssert.jsonOk,
              redirected: false,
            },
            error: ok
              ? undefined
              : !statusOk
                ? `unexpected status ${status} (want ${expectStatus.join(",")})`
                : bodyAssert.error,
          });
        });
      },
    );

    req.on("socket", (socket) => {
      socket.on("lookup", () => {
        dnsMs = Math.round(performance.now() - started);
      });
      socket.on("connect", () => {
        connectMs = Math.round(performance.now() - started);
      });
      socket.on("secureConnect", () => {
        tlsMs = Math.round(performance.now() - started);
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });

    req.on("error", (err) => {
      const totalMs = Math.round(performance.now() - started);
      finish({
        source: "buho",
        targetId: opts.targetId,
        sensorId: opts.sensor.id,
        sensorType: "http",
        endpoint,
        ts,
        ok: false,
        durationMs: totalMs,
        metrics: {
          totalMs,
          dnsMs,
          connectMs,
          tlsMs,
          ttfbMs,
        },
        error: err.message,
      });
    });

    req.end();
  });
}
