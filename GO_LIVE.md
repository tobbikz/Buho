# Go-live checklist

Use this before the first pilot or paid install. Pin **`v1.8.0`**. Pricing: [`PRICING.md`](PRICING.md). Contract template: [`PILOT_AGREEMENT.md`](PILOT_AGREEMENT.md). Install: [`INSTALL.md`](INSTALL.md).

Images: `ghcr.io/tobbikz/buho/collector:1.8.0` and `ghcr.io/tobbikz/buho/web:1.8.0`. The customer host pulls them with `./install.sh --pull`, or loads a saved tarball ([`EXTERNAL_INSTALL.md`](EXTERNAL_INSTALL.md)).

## 1. Access and secrets

- [ ] The customer host can pull `ghcr.io/tobbikz/buho/collector:1.8.0` and `ghcr.io/tobbikz/buho/web:1.8.0`, or those images were loaded from a tarball.
- [ ] `BUHO_AUTH_PASSWORD` is set, strong, and unique. The console refuses to serve without it.
- [ ] `BUHO_AUTH_SECRET` is set. Rotate it if `.env` was shared.
- [ ] Store password is not the default `buho` on any reachable network.
- [ ] Console listens on `127.0.0.1`, with TLS or a VPN in front.
- [ ] At least one **admin** user exists (Admin → Users). Add viewers as needed.

## 2. First five minutes

On the console, as admin:

1. Open **Get started** (`/get-started`).
2. **Add database** → test the connection → save. Engines: PostgreSQL, SQL Server, MariaDB / MySQL, Oracle.
3. Wait for a health score (the collector cycle is about 30 seconds).
4. Add a notification channel and press **Test**.
5. Confirm the message arrived.

Admin → Databases and Admin → Alerts are there when you need more than the wizard.

## 3. Monitor logins

| Engine | Script |
| --- | --- |
| PostgreSQL | `sql/monitor-user.sql` (`pg_monitor`) |
| MariaDB / MySQL | `sql/monitor-user-mariadb.sql` |
| SQL Server | `sql/monitor-user-mssql.sql` |
| Oracle | `sql/monitor-user-oracle.sql` |

- [ ] Credentials live only in `config.json` or Admin → Databases. They are not in git.
- [ ] The session is visible on the target as the Búho user.
- [ ] The first collector cycle is green under Instance → Events.

## 4. Alert channels

- [ ] Global defaults and the system pack are reviewed, including `pack.rpo_exposure`.
- [ ] At least one channel is enabled and **Test** succeeded.
- [ ] Someone knows how to silence alerts during maintenance.
- [ ] Optional: instance tags `rpo_seconds` or `rpo_hours` when the estate RPO target is not the default.

## 5. Store durability

- [ ] `BUHO_BACKUP_DIR` is a **host** path, not only a Docker volume.
- [ ] The backup service is running and the last dump is visible in collector events.
- [ ] One restore drill: `pg_restore` into an empty store.
- [ ] Retention reviewed (Admin → Retention).

## 6. Updates

- [ ] The host is pinned to tag `v1.8.0` and upgrades with `./install.sh --pull`.
- [ ] Air-gapped hosts use the save/load steps in [`EXTERNAL_INSTALL.md`](EXTERNAL_INSTALL.md).
- [ ] If OTLP is reachable beyond loopback, `BUHO_OTLP_TOKEN` is set. Exporters send `Authorization: Bearer` or `X-Buho-Otlp-Token`.
- [ ] It is written down who may update or recreate containers.
- [ ] Optional, once: `npm run alerts:import` for the SQL alert catalog.

## 7. Smoke after cutover

Walk these in the console:

- Databases: Fleet → instance overview → Blame → Estate RPO → Alerts
- Observability: Services (All / APM / PROBES) → Probes → Traces → TLS

- [ ] A health score is present. A score near 0 because backups or HA are missing is **posture**; the UI says so. It is not a failed install.
- [ ] Host metrics are on if they were promised.
- [ ] Blame reads as two lanes: pain now, and DBA risk.
- [ ] Estate RPO lists the four engines. Tags override the target when set.
- [ ] The customer knows Búho is a read-only monitor plus alerts. It is not a backup product and not a SIEM.

## 8. Commercial

- [ ] Pilot signed ([`PILOT_AGREEMENT.md`](PILOT_AGREEMENT.md)) or a Pro/Fleet order per [`PRICING.md`](PRICING.md).
- [ ] Server count agreed. One server is one host and port, however many databases sit on it.
