# Búho

**On-prem database monitoring for DBAs and platform teams.**

One collector, one PostgreSQL store, one console. No Prometheus. No Grafana. No agent on the database host.

Búho does not only chart metrics — it runs an opinionated check catalog and tells you **what is wrong and how to fix it**.

| | |
|---|---|
| **Engines** | PostgreSQL · SQL Server · MariaDB / MySQL · Oracle |
| **Deploy** | Docker Compose · images on GHCR · `./install.sh --pull` |
| **License** | [Business Source License 1.1](LICENSE) |
| **Latest** | [`v1.7.2`](https://github.com/tobbikz/buho-monitor/releases/tag/v1.7.2) |

---

## Why teams pick Búho

| Pain | What Búho does |
|------|----------------|
| Redgate / SolarWinds list at **$1k+/server/year** | Pro at **$899/server/year** — same product class, on-prem ([`PRICING.md`](PRICING.md)) |
| PMM skips SQL Server and drags Prometheus/Grafana | Four SQL engines in one console; no metrics stack to operate |
| Dashboards without a next step | Checks with severity, evidence, and remediation |
| 3am alerts scattered across tools | Native channels: Slack, Teams, Discord, PagerDuty, SMTP, webhooks, … |
| Weekly status for management | Markdown weekly report you can email or archive |

**Who it is for:** DBAs (core), DevOps / SRE / platform (strong).  
**Who it is not:** a SIEM, a backup product, or a hosted SaaS that sends your metrics off-network.

---

## Quick start (customer host)

Requires Docker + Compose v2 and pull access to `ghcr.io` (or an air-gapped load — see [`EXTERNAL_INSTALL.md`](EXTERNAL_INSTALL.md)).

```bash
git clone https://github.com/tobbikz/buho-monitor.git
cd buho-monitor
git checkout v1.7.2
./install.sh --pull
```

Then open the console → **Get started** → add a database → wait for a health score → add an alert channel and press **Test**.

Full first-customer checklist: [`GO_LIVE.md`](GO_LIVE.md) · operator guide: [`INSTALL.md`](INSTALL.md) · pilot terms: [`PILOT_AGREEMENT.md`](PILOT_AGREEMENT.md).

### Images

| Image | Tag |
|-------|-----|
| `ghcr.io/tobbikz/buho-monitor/collector` | `1.7.2` / `latest` |
| `ghcr.io/tobbikz/buho-monitor/web` | `1.7.2` / `latest` |

Published automatically when a `v*` tag is pushed.

### Free health check (no store)

```bash
npm install
npm run check -- 'postgres://monitor@host:5432/db'
```

Exit codes: `0` clean · `1` warnings · `2` critical · `3` connection error. Same check logic as the collector — useful in cron or CI.

---

## What you get

### Databases (DBA surface)

- **Fleet overview** — health score, live vs posture, freshness per instance
- **Instance deep dive** — sessions, locks, queries (analytical + live), replication, backups / RPO, capacity, indexes, vacuum / maintenance, host metrics, topology, blame
- **Estate** — multi-engine inventory: backups, disk, jobs, replication, configuration, licensing, versions, RPO
- **Checks & findings** — catalog with remediation; parity gate across PG / MSSQL / MariaDB / Oracle
- **Security posture** — authentication, privileges, encryption, surface, audit (read-only; “not verifiable” is a first-class state)
- **Weekly report** — Markdown export for the Monday email

### Observability (platform surface)

- **Probes** — HTTP / TCP / ICMP / TLS / journey (sequential HTTP steps)
- **APM** — OTLP traces, service map, dependencies, setup wizard
- **App logs** — OTLP logs intake
- **Hosts** — PRTG-style device → sensors (SNMP, process, WinRM, traps, discovery map)
- **Unified alerts** — DB checks and observability signals in one plane

### Operations

- Least-privilege monitor users (`sql/monitor-user*.sql`)
- Store retention controls; host-level backups of the store
- Auth: bootstrap password → admin / viewer accounts
- Console never connects to monitored databases — only the collector does

---

## Architecture (short)

```
Monitored DBs ──(SQL / optional SSH)──► Collector ──► PostgreSQL store ◄── Web console
                                              ▲
                   OTLP traces / logs / probes ─┘
```

- **Agentless** on the DB host for SQL monitoring (optional SSH/`/proc` for host CPU/RAM).
- **Capability probe** per engine/version so collectors do not break on PG 13–18 view moves.
- **Partitioned store** + rollups — no TimescaleDB dependency for on-prem installs.
- Collector and web are separate processes; restarting the console does not stop scraping.

---

## Pricing (summary)

| Plan | Price |
|------|-------|
| **Free** | $0 — 1 instance, 7-day retention, CLI checks |
| **Pilot** | $0 for 30 days — up to 3 servers, full Pro |
| **Pro** | **$899 / server / year** |
| **Fleet** | **$799 / server / year** (5+ servers on one contract) |

A **server** = one host+port, regardless of how many databases you monitor on it.

Details and competitor anchors: [`PRICING.md`](PRICING.md).

---

## Repository layout

```
apps/collector   24/7 scrape + alert reconcile
apps/web         Next.js console
apps/cli         buho-check (free lead-gen health report)
packages/core    collectors, inventory, security, discovery
packages/checks  check catalog + remediation
packages/store   schema, partitions, rollups
packages/sensors Host / SNMP / process sensors
sql/             least-privilege monitor users
deploy/          optional OTEL / lab helpers
```

---

## Development (contributors)

```bash
cp config.example.json config.json   # edit targets
docker compose up -d                 # store + collector (+ web)
# console: http://127.0.0.1:3100
# store:   127.0.0.1:55432
```

Production console requires `BUHO_AUTH_PASSWORD` (and a strong store password). Without it, the UI refuses to serve pages.

Useful gates:

```bash
npm run verify:v1
npx tsx scripts/assert-check-parity.ts
npm run test:sensors
```

---

## Documentation map

| Doc | Audience |
|-----|----------|
| [`GO_LIVE.md`](GO_LIVE.md) | First production / pilot cutover |
| [`INSTALL.md`](INSTALL.md) | Full install, TLS proxy, backups, troubleshooting |
| [`EXTERNAL_INSTALL.md`](EXTERNAL_INSTALL.md) | Foreign host + air-gapped GHCR |
| [`PRICING.md`](PRICING.md) | Commercial plans |
| [`PILOT_AGREEMENT.md`](PILOT_AGREEMENT.md) | Pilot contract template |
| [`landing/index.html`](landing/index.html) | Static pitch page |

---

## License & contact

Production use is under **Business Source License 1.1** — see [`LICENSE`](LICENSE).  
Offering Búho as a competing hosted monitoring SaaS needs a separate commercial agreement with **IKZ Technologies**.

Issues and pilot interest: [github.com/tobbikz/buho-monitor](https://github.com/tobbikz/buho-monitor).
