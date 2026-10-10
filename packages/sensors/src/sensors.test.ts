import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTcpSensor } from "./tcp.js";
import { readJsonPath, runHttpSensor } from "./http.js";
import { deltaCounter32, enrichSnmpBandwidth } from "./snmp_rates.js";
import type { Sample } from "./types.js";

describe("tcp sensor", () => {
  it("connects to a known open port or fails cleanly", async () => {
    const sample = await runTcpSensor({
      targetId: "t",
      host: "1.1.1.1",
      sensor: { type: "tcp", id: "t1", port: 53, timeoutMs: 5000 },
    });
    assert.equal(sample.sensorType, "tcp");
    assert.equal(typeof sample.ok, "boolean");
    assert.ok(sample.durationMs >= 0);
  });
});

describe("http sensor", () => {
  it("fetches example.com with phase metrics shape", async () => {
    const sample = await runHttpSensor({
      targetId: "t",
      host: "example.com",
      sensor: {
        type: "http",
        id: "h1",
        url: "https://example.com/",
        expectStatus: [200],
        timeoutMs: 15000,
      },
    });
    assert.equal(sample.sensorType, "http");
    assert.ok("ok" in sample);
    assert.ok(sample.metrics);
    if (sample.ok) {
      assert.equal(typeof sample.metrics.totalMs, "number");
      assert.ok("ttfbMs" in sample.metrics);
      assert.ok("dnsMs" in sample.metrics || sample.metrics.dnsMs === null);
    }
  });

  it("readJsonPath resolves dotted paths", () => {
    const doc = { slideshow: { author: "Yours Truly", title: "Sample" } };
    assert.equal(readJsonPath(doc, "$.slideshow.author"), "Yours Truly");
    assert.equal(readJsonPath(doc, "slideshow.title"), "Sample");
    assert.equal(readJsonPath(doc, "$.missing"), undefined);
  });
});

describe("snmp bandwidth deltas", () => {
  it("handles Counter32 wrap", () => {
    assert.equal(deltaCounter32(0xfffffffe, 1), 3);
    assert.equal(deltaCounter32(100, 250), 150);
  });

  it("enrichSnmpBandwidth computes bps from prior sample", () => {
    const prevTs = new Date(Date.now() - 10_000).toISOString();
    const nextTs = new Date().toISOString();
    const store = {
      lastSample() {
        return {
          ts: prevTs,
          targetId: "sw",
          sensorId: "if1",
          sensorType: "snmp",
          host: "1.1.1.1",
          port: 161,
          ok: true,
          durationMs: 10,
          metrics: { ifInOctets: 1000, ifOutOctets: 2000 },
          error: null,
        };
      },
    };

    const samples: Sample[] = [
      {
        source: "buho",
        targetId: "sw",
        sensorId: "if1",
        sensorType: "snmp",
        endpoint: { host: "1.1.1.1", port: 161 },
        ts: nextTs,
        ok: true,
        durationMs: 12,
        metrics: { ifInOctets: 2250, ifOutOctets: 3250 },
      },
    ];

    const enriched = enrichSnmpBandwidth(samples, store as never);
    const m = enriched[0]!.metrics;
    assert.ok(typeof m.ifInBps === "number");
    assert.ok(typeof m.ifOutBps === "number");
    assert.ok(Number(m.ifInBps) > 0);
    assert.ok(Number(m.ifOutBps) > 0);
    assert.ok(typeof m.rateWindowSec === "number");
  });
});
