# Búho

**On-prem database monitoring for DBAs and platform teams.**

One collector, one PostgreSQL store, one console. No Prometheus. No Grafana. No agent on the database host.

Búho does not only chart metrics — it runs an opinionated check catalog and tells you **what is wrong and how to fix it**.

| | |
|---|---|
| **Engines** | PostgreSQL · SQL Server · MariaDB / MySQL · Oracle · plus Redis, MongoDB, ES, Cassandra, Kafka/CDC, Airflow |
| **Deploy** | Docker Compose · images on GHCR · `./install.sh --pull` |
| **License** | [Apache License 2.0](LICENSE) |
| **Latest** | [`v1.8.0`](https://github.com/tobbikz/buho/releases) (see tags) |

---

## Why Búho

| Pain | What Búho does |
|------|----------------|
| Expensive per-server monitoring suites | Open-source core you run on your network |
| PMM skips SQL Server and drags Prometheus/Grafana | Multi-engine SQL (+ platform) in one console |
| Dashboards without a next step | Checks with severity, evidence, and remediation |
| Alerts scattered across tools | Native channels: Slack, Teams, Discord, PagerDuty, SMTP, webhooks, … |
| Weekly status for management | Markdown weekly report you can email or archive |

**Who it is for:** DBAs (core), DevOps / SRE / platform.  
**Who it is not:** a SIEM, a backup product, or a hosted SaaS that sends your metrics off-network.

---

## Quick start

### From source (developers)

```bash
git clone https://github.com/tobbikz/buho.git
cd buho
cp config.example.json config.json
cp .env.example .env
npm install
docker compose up -d          # PostgreSQL store
npm run migrate
npm run collector             # terminal 1
npm run web:dev               # terminal 2 → http://127.0.0.1:3100
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for gates and layout.

### Customer host (images)

Requires Docker + Compose v2 and pull access to `ghcr.io` (or air-gapped load — [`EXTERNAL_INSTALL.md`](EXTERNAL_INSTALL.md)).

```bash
git clone https://github.com/tobbikz/buho.git
cd buho
./install.sh --pull
```

Then open the console → **Get started** → add a database → wait for a health score → add an alert channel and press **Test**.

Checklist: [`GO_LIVE.md`](GO_LIVE.md) · operator guide: [`INSTALL.md`](INSTALL.md).

### Images

| Image | Tag |
|-------|-----|
| `ghcr.io/tobbikz/buho/collector` | `1.8.0` / `latest` *(also published historically under `…/buho-monitor/…`)* |
| `ghcr.io/tobbikz/buho/web` | `1.8.0` / `latest` |

### Free health check (no store)

```bash
npm install
npm run check -- 'postgres://monitor@host:5432/db'
```

Exit codes: `0` clean · `1` warnings · `2` critical · `3` connection error.

---

## What you get

### Databases

- **Fleet overview** — health score, live vs posture, freshness
- **Instance deep dive** — sessions, locks, queries, replication, backups / RPO, capacity, indexes, vacuum, host, topology, blame
- **Estate** — multi-engine inventory (backups, disk, jobs, replication, configuration, licensing, versions, RPO)
- **Checks & findings** — catalog with remediation; parity across PG / MSSQL / MariaDB / Oracle
- **Security posture** — authentication, privileges, encryption, surface, audit
- **Weekly report** — Markdown export

### Observability

- **Probes** — HTTP / TCP / ICMP / TLS / journey
- **APM** — OTLP traces, service map, dependencies
- **App logs** — OTLP logs
- **Hosts** — PRTG-style sensors (SNMP, process, ICMP, …)
- **Unified alerts** — DB + observability in one plane

### Deep Platform

Kafka / CDC, Airflow, DPA-depth waits, gated actions, backup drills, CIS packs — see [`DEEP_PLATFORM.md`](DEEP_PLATFORM.md).

---

## Architecture

```
Monitored DBs ──(SQL / optional SSH)──► Collector ──► PostgreSQL store ◄── Web console
                                              ▲
                   OTLP traces / logs / probes ─┘
```

- **Agentless** on the DB host for SQL monitoring.
- **Capability probe** per engine/version.
- **Partitioned store** + rollups (no TimescaleDB required).
- Collector and web are separate processes.

---

## Repository layout

```
apps/collector   24/7 scrape + alert reconcile
apps/web         Next.js console
apps/cli         buho-check (one-off PostgreSQL health report)
apps/mcp         MCP server for agents
packages/core    collectors, inventory, security, discovery
packages/checks  check catalog + remediation
packages/store   schema, partitions, rollups
packages/sensors Host / SNMP / process sensors
sql/             least-privilege monitor users
lab/             optional lab compose / SNMP helpers
deploy/          optional OpenTelemetry collector
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
npm run ensayo:instalacion    # clean-room install on this machine, then tear down
```

---

## Documentation map

| Doc | Audience |
|-----|----------|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contributors |
| [`SECURITY.md`](SECURITY.md) | Vulnerability reporting |
| [`GO_LIVE.md`](GO_LIVE.md) | First production / pilot cutover |
| [`INSTALL.md`](INSTALL.md) | Full install, TLS proxy, backups |
| [`EXTERNAL_INSTALL.md`](EXTERNAL_INSTALL.md) | Foreign host + air-gapped GHCR |
| [`DEEP_PLATFORM.md`](DEEP_PLATFORM.md) | Kafka / Airflow / DPA / CIS |
| [`PRICING.md`](PRICING.md) | Optional commercial support (core is Apache 2.0) |

---

## License & contact

**Apache License 2.0** — see [`LICENSE`](LICENSE).

Optional paid support / pilots: see [`PRICING.md`](PRICING.md) and [`PILOT_AGREEMENT.md`](PILOT_AGREEMENT.md).

Issues: [github.com/tobbikz/buho](https://github.com/tobbikz/buho).
