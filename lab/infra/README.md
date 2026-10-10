# Lab · Infra sensors (PRTG-class)

ADR: `buho-infra-prtg-sensors-2026-10-10`

## Quick start

```bash
# From buho repo root (needs net-snmp from @buho/sensors)
node lab/infra/fake-snmp-agent.mjs   # UDP 1161 / 1162

# Merge instances from config.infra.lab.json into your config.json instances[],
# or point BUHO_CONFIG at a composed file, then:
npm run collector
```

Open **Observability → Hosts** → drill into `127.0.0.1`.

## Sensors covered

| Type | Lab target |
|------|------------|
| host | local /proc |
| icmp | 127.0.0.1 |
| tcp | 1.1.1.1:53 |
| dns | cloudflare |
| http | https://example.com |
| snmp | fake agent :1161 interface ifIndex=1 |
