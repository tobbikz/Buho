import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const snmp = require("net-snmp") as {
  createReceiver: (
    options: { port: number; disableAuthorization?: boolean; transport?: string; address?: string },
    callback: (error: Error | null, receiver: TrapReceiverHandle) => void,
  ) => TrapReceiverHandle;
  isVarbindError: (vb: { type?: number }) => boolean;
};

export type SnmpTrapEvent = {
  receivedAt: string;
  sourceAddress: string;
  sourcePort: number;
  community: string | null;
  pduType: string | null;
  oid: string | null;
  varbinds: Array<{ oid: string; value: string }>;
  raw: Record<string, unknown>;
};

type TrapReceiverHandle = {
  getAuthorizer: () => { addCommunity: (c: string) => void };
  on: (event: "trap" | "inform" | "close" | "error", cb: (...args: unknown[]) => void) => void;
  close: () => void;
};

export type TrapListener = {
  port: number;
  close: () => void;
};

/**
 * UDP SNMP trap/inform listener (non-root ports recommended, e.g. 1162).
 */
export function startTrapListener(opts: {
  port: number;
  address?: string;
  communities?: string[];
  onTrap: (event: SnmpTrapEvent) => void | Promise<void>;
  onError?: (err: Error) => void;
}): Promise<TrapListener> {
  const communities = opts.communities ?? ["public"];
  return new Promise((resolve, reject) => {
    const receiver = snmp.createReceiver(
      {
        port: opts.port,
        disableAuthorization: false,
        transport: "udp4",
        address: opts.address ?? "0.0.0.0",
      },
      (error, _recv) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const authorizer = receiver.getAuthorizer();
          for (const c of communities) authorizer.addCommunity(c);
        } catch {
          /* ignore */
        }

        const handlePdu = (pdu: Record<string, unknown>, rinfo: { address?: string; port?: number }) => {
          const varbindsRaw = (pdu["varbinds"] as Array<{ oid: string; value: unknown; type?: number }>) ?? [];
          const varbinds = varbindsRaw
            .filter((vb) => !snmp.isVarbindError(vb))
            .map((vb) => ({
              oid: String(vb.oid),
              value: vb.value == null ? "" : String(vb.value),
            }));
          const event: SnmpTrapEvent = {
            receivedAt: new Date().toISOString(),
            sourceAddress: String(rinfo.address ?? ""),
            sourcePort: Number(rinfo.port ?? 0),
            community: pdu["community"] != null ? String(pdu["community"]) : null,
            pduType: pdu["type"] != null ? String(pdu["type"]) : null,
            oid: varbinds[0]?.oid ?? null,
            varbinds,
            raw: {
              enterprise: pdu["enterprise"] != null ? String(pdu["enterprise"]) : null,
              generic: pdu["generic"] ?? null,
              specific: pdu["specific"] ?? null,
            },
          };
          void Promise.resolve(opts.onTrap(event)).catch((err) => {
            opts.onError?.(err instanceof Error ? err : new Error(String(err)));
          });
        };

        receiver.on("trap", (pdu, rinfo) => {
          handlePdu(pdu as Record<string, unknown>, (rinfo ?? {}) as { address?: string; port?: number });
        });
        receiver.on("inform", (pdu, rinfo) => {
          handlePdu(pdu as Record<string, unknown>, (rinfo ?? {}) as { address?: string; port?: number });
        });
        receiver.on("error", (err) => {
          opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        });

        resolve({
          port: opts.port,
          close: () => {
            try {
              receiver.close();
            } catch {
              /* ignore */
            }
          },
        });
        void _recv;
        void (0 as unknown as AddressInfo);
      },
    );
  });
}
