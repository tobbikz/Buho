# `@buho/sensors`

PRTG-class infra sensors ported from archived Halcón into Búho Observability → Hosts.

ADR: `buho-infra-prtg-sensors-2026-10-10`

## Types

`host` · `icmp` · `tcp` · `udp` · `http` · `tls_cert` · `dns` · `snmp`

## Usage

```ts
import { probeTarget, enrichSnmpBandwidth } from '@buho/sensors';

const samples = await probeTarget({
  id: 'lab-sw',
  host: '127.0.0.1',
  role: 'switch',
  sensors: [
    { type: 'icmp', id: 'ping' },
    { type: 'snmp', id: 'if1', port: 1161, community: 'public', preset: 'interface', ifIndex: 1 },
  ],
});
```

Collector maps these to `buho.metric_samples` with labels `sensor_id` / `sensor_type` for `engine: infra` instances.
