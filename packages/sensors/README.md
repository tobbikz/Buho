# `@buho/sensors`

Infra sensors for Observability → Hosts. One device, many sensors. Samples land in `buho.metric_samples` with labels `sensor_id` and `sensor_type` on `engine: infra` targets.

## Sensor types

`host` · `icmp` · `tcp` · `udp` · `http` · `tls_cert` · `dns` · `snmp` · `process` · `winrm`

Helpers: `discoverHosts()` · `startTrapListener()`

## Usage

```ts
import { probeTarget, enrichSnmpBandwidth } from '@buho/sensors';

const samples = await probeTarget({
  id: 'edge-sw',
  host: '10.0.0.8',
  role: 'switch',
  sensors: [
    { type: 'icmp', id: 'ping' },
    { type: 'snmp', id: 'if1', port: 161, community: 'public', preset: 'interface', ifIndex: 1 },
  ],
});
```

Declare the device in the console or in `config.json` as `engine: "infra"` with `infra.sensors[]`. The collector scrapes it on its normal cycle.

Lab agents and a sample fragment: [`lab/infra/README.md`](../../lab/infra/README.md).
