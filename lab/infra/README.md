# Lab · infra sensors

Not part of a customer install. Use this to exercise Observability → Hosts on the local machine.

```bash
# From the repo root
node lab/infra/fake-snmp-agent.mjs   # UDP 1161 / 1162

# Merge instances from config.infra.lab.json into config.json,
# or point BUHO_CONFIG at a composed file, then:
npm run collector
```

Open **Observability → Hosts** and drill into `127.0.0.1`.

| Type | Lab target |
| --- | --- |
| host | local `/proc` |
| icmp | 127.0.0.1 |
| tcp | 1.1.1.1:53 |
| dns | Cloudflare |
| http | https://example.com |
| snmp | fake agent :1161, interface ifIndex=1 |

Other lab commands: `npm run lab:infra:seed`, `npm run lab:infra:discover`, `npm run lab:infra:trap`, `npm run test:sensors`.
