# Búho pricing (optional commercial support)

The **software is Apache License 2.0** — you can run, modify, and redistribute the core freely ([`LICENSE`](LICENSE)).

The table below is **optional paid support / SLAs** from IKZ Technologies (not a license fee for the open-source core). Self-support via GitHub Issues is always available.

Anchored to **Redgate Monitor** list pricing (~**USD 1,150 / server / year** for small fleets) for teams that want a comparable commercial envelope.

Currency: **USD**. Billing: annual preferred (monthly available for Pro).

| Plan | Price | What you get |
|------|-------|----------------|
| **Free** | **$0** | 1 monitored instance · 7-day retention · full checks on that instance · CLI `buho-check` · community docs |
| **Pro** | **$899 / server / year** (~**$89 / server / month**) | Unlimited retention defaults (13 months) · multi-instance · native alerts (pack + custom SQL + channels) · weekly report · Estate / Security / Analysis · email support in Spanish or English |
| **Fleet** | **$799 / server / year** | Same as Pro when you license **5+ servers** on one contract |
| **Pilot** | **$0 for 30 days** (up to **3 servers**) | Full Pro features · ends automatically unless you convert to Pro/Fleet · see `PILOT_AGREEMENT.md` |

## Positioning

Same product class as Redgate Monitor, lower sticker:

- Redgate ≈ **$1,150**/server/year → Búho Pro **$899** (~**22% less**)
- Fleet (5+) **$799** (~**30% less** than Redgate)
- Below Datadog DBM once infra hosts are added

## What “server” means

One **database host** (host+port), regardless of how many databases Búho monitors on it. Two aliases on the same PostgreSQL cluster count as **one** server for licensing.

**Deep Platform units** (same Pro/Fleet price per unit):

| Unit | Counts as |
|------|-----------|
| SQL engine host+port | 1 server |
| Kafka **cluster** (one bootstrap set) | 1 server |
| Airflow **deployment** (one REST base URL) | 1 server |
| CDC overlay on an already-licensed Kafka cluster | **0** extra (same brokers) |
| Endpoint / infra probe hosts | unchanged (existing probe rules) |

## License vs support

- **License:** Apache 2.0 — see [`LICENSE`](LICENSE).
- **Support contracts / pilots:** contact IKZ Technologies; templates in [`PILOT_AGREEMENT.md`](PILOT_AGREEMENT.md).

Contact: sales via the GitHub org / IKZ — attach `PILOT_AGREEMENT.md` for pilots.

## Competitor snapshot (anchor only)

| Product | Rough list | Note |
|---------|------------|------|
| Redgate Monitor | ~$1,150 / server / year | Primary anchor |
| SolarWinds DPA | ~$1,300+ / instance / year | Quote-based |
| Datadog DBM | ~$70+ / host / month + infra | SaaS; data leaves the network |
| Percona PMM | $0 | No SQL Server; you operate Prometheus/Grafana |
