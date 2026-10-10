/**
 * Inject a lab SNMP trap into the store (and optionally send UDP if listener up).
 * Usage: npx tsx scripts/inject-snmp-trap.ts [--source 127.0.0.1]
 */
import { createRequire } from 'node:module';
import dgram from 'node:dgram';
import { loadConfig } from '@buho/core';
import { Store } from '@buho/store';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const snmp = require('net-snmp') as {
  createSession: (
    host: string,
    community: string,
    opts: { port: number; version: number },
  ) => {
    trap: (oid: string, varbinds: unknown[], cb: (err: Error | null) => void) => void;
    close: () => void;
  };
  ObjectType: { OctetString: number };
  Version2c: number;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

async function main(): Promise<void> {
  const source = arg('--source') ?? '127.0.0.1';
  const port = Number(arg('--port') ?? process.env['BUHO_INFRA_TRAPS_PORT'] ?? 1162);
  const config = await loadConfig();
  const store = new Store(config.store.url);
  await store.migrate();

  const oid = '1.3.6.1.4.1.8072.9999.1';
  const id = await store.insertSnmpTrap({
    sourceAddress: source,
    sourcePort: port,
    community: 'public',
    pduType: 'trap',
    oid,
    varbinds: [{ oid, value: 'buho-lab-trap' }],
    raw: { lab: true },
  });
  console.log(`store trap #${id} source=${source}`);

  // Best-effort UDP send to live listener (ignore failures).
  try {
    await new Promise<void>((resolve) => {
      const session = snmp.createSession('127.0.0.1', 'public', {
        port,
        version: snmp.Version2c,
      });
      const varbinds = [
        { oid, type: snmp.ObjectType.OctetString, value: 'buho-lab-trap' },
      ];
      session.trap(oid, varbinds, (err) => {
        try {
          session.close();
        } catch {
          /* ignore */
        }
        if (err) console.log(`udp trap send: ${err.message} (store row still written)`);
        else console.log(`udp trap sent → 127.0.0.1:${port}`);
        resolve();
      });
    });
  } catch (err) {
    console.log(`udp trap skipped: ${err instanceof Error ? err.message : err}`);
  }

  // Keep dgram import used for typing side-effects in some Node builds.
  void dgram;
  await store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
