#!/usr/bin/env node
/**
 * Lab SNMP agents — simulan switch + firewall con IF-MIB counters vivos.
 * Puertos no privilegiados (1161 / 1162) para no necesitar root.
 *
 * Usage: node lab/fake-snmp-agent.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const snmp = require("net-snmp");

const here = dirname(fileURLToPath(import.meta.url));
// Repo root node_modules (npm workspaces hoist net-snmp).
const mibDir = join(here, "../../node_modules/net-snmp/lib/mibs");

/** @typedef {{ port: number; sysName: string; sysDescr: string; sysLocation: string; ifaces: Array<{ index: number; descr: string; speed: number; inBps: number; outBps: number; oper: number; inErrors?: number; outErrors?: number }> }} DeviceSpec */

/** @type {DeviceSpec[]} */
const DEVICES = [
  {
    port: 1161,
    sysName: "lab-core-sw01",
    sysDescr: "Búho lab switch (IF-MIB simulator)",
    sysLocation: "lab-rack-A",
    ifaces: [
      {
        index: 1,
        descr: "Gi0/1-uplink",
        speed: 1_000_000_000,
        inBps: 12_500_000,
        outBps: 8_000_000,
        oper: 1,
      },
      {
        index: 2,
        descr: "Gi0/2-access",
        speed: 1_000_000_000,
        inBps: 2_000_000,
        outBps: 1_500_000,
        oper: 1,
      },
    ],
  },
  {
    port: 1162,
    sysName: "lab-edge-fw01",
    sysDescr: "Búho lab firewall (IF-MIB simulator)",
    sysLocation: "lab-dmz",
    ifaces: [
      {
        index: 1,
        descr: "wan0",
        speed: 100_000_000,
        inBps: 40_000_000,
        outBps: 15_000_000,
        oper: 1,
      },
      {
        index: 2,
        descr: "lan0",
        speed: 1_000_000_000,
        inBps: 5_000_000,
        outBps: 6_000_000,
        oper: 1,
        inErrors: 3,
        outErrors: 0,
      },
    ],
  },
];

function bootDevice(spec) {
  const store = snmp.createModuleStore();
  store.loadFromFile(join(mibDir, "IANAifType-MIB.mib"));
  store.loadFromFile(join(mibDir, "IF-MIB.mib"));

  const agent = snmp.createAgent(
    { port: spec.port, disableAuthorization: true, address: "127.0.0.1" },
    (error) => {
      if (error) console.error(`[${spec.sysName}]`, error.message ?? error);
    },
  );

  try {
    const authorizer = agent.getAuthorizer();
    authorizer.addCommunity("public");
  } catch {
    /* disableAuthorization may omit authorizer */
  }

  const mib = agent.getMib();
  mib.registerProviders(store.getProvidersForModule("SNMPv2-MIB"));
  mib.registerProviders(store.getProvidersForModule("IF-MIB"));

  mib.setScalarValue("sysDescr", spec.sysDescr);
  mib.setScalarValue("sysObjectID", "1.3.6.1.4.1.8072.3.2.10");
  mib.setScalarValue("sysContact", "halcon-lab@local");
  mib.setScalarValue("sysName", spec.sysName);
  mib.setScalarValue("sysLocation", spec.sysLocation);
  mib.setScalarValue("sysServices", 72);
  mib.setScalarValue("ifNumber", spec.ifaces.length);

  /** @type {Map<number, { inOctets: number; outOctets: number; inBps: number; outBps: number }>} */
  const counters = new Map();

  for (const iface of spec.ifaces) {
    const inOctets = Math.floor(Math.random() * 1_000_000);
    const outOctets = Math.floor(Math.random() * 1_000_000);
    counters.set(iface.index, {
      inOctets,
      outOctets,
      inBps: iface.inBps,
      outBps: iface.outBps,
    });

    // ifEntry columns per IF-MIB / example mib-parser.js
    mib.addTableRow("ifEntry", [
      iface.index,
      iface.descr,
      6, // ethernetCsmacd
      1500,
      iface.speed,
      "",
      1, // admin up
      iface.oper,
      0,
      inOctets,
      0,
      0,
      0,
      iface.inErrors ?? 0,
      0,
      outOctets,
      0,
      0,
      0,
      iface.outErrors ?? 0,
      0,
      "0.0",
    ]);
  }

  // Tick ~ every 1s: bump octets by (bps/8) so Búho deltas → realistic Bps
  setInterval(() => {
    for (const iface of spec.ifaces) {
      const c = counters.get(iface.index);
      if (!c) continue;
      c.inOctets = (c.inOctets + Math.round(c.inBps / 8)) >>> 0;
      c.outOctets = (c.outOctets + Math.round(c.outBps / 8)) >>> 0;
      mib.setTableSingleCell("ifEntry", 10, [iface.index], c.inOctets);
      mib.setTableSingleCell("ifEntry", 16, [iface.index], c.outOctets);
    }
  }, 1000);

  console.error(
    `[lab-snmp] ${spec.sysName} UDP ${spec.port}/127.0.0.1 community=public ifaces=${spec.ifaces.map((i) => i.descr).join(",")}`,
  );
  return agent;
}

for (const d of DEVICES) bootDevice(d);
console.error("[lab-snmp] ready — Ctrl+C to stop");
