# Go-live checklist (first production customer / pilot)

Use before the first paid or pilot install. Pin **`v1.7.1+`**. Pricing: `PRICING.md`. Contract template: `PILOT_AGREEMENT.md`.

Lab console (dev): http://127.0.0.1:3100 · store `:55432`.

## 0. Ship the bits

- [ ] `git push origin main` and `git push origin v1.7.0` (GHCR publish runs on the tag)
- [ ] Confirm images: `ghcr.io/tobbikz/buho-monitor/collector:1.7.1` and `…/web:1.7.1`
- [ ] Customer host can `docker pull` those tags (or use `./install.sh --pull`)

## 1. Access & secrets

- [ ] `BUHO_AUTH_PASSWORD` set (strong, unique); console refuses to serve without it in production
- [ ] `BUHO_AUTH_SECRET` set (or derived); rotate if anyone shared `.env`
- [ ] `BUHO_STORE_URL` / store password not default `buho` on a reachable network
- [ ] Console bound to `127.0.0.1` + reverse proxy TLS, or VPN only
- [ ] At least one **admin** console user; viewers as needed (Admin → Users)

## 2. First 5 minutes (in-product)

On the console (admin session):

1. Open **Get started** (`/get-started`)
2. **Add database** → Test connections → save (PG / MSSQL / Maria / Oracle only)
3. Wait until a **health score** appears (collector ~30s)
4. Add a notification **channel** → press **Test**
5. Confirm the message arrived

Optional: Admin → Databases / Admin → Alerts for advanced config.

## 3. Monitor logins on each DB (least privilege)

| Engine | Script |
|--------|--------|
| PostgreSQL | `sql/monitor-user.sql` (`pg_monitor`) |
| MariaDB / MySQL | `sql/monitor-user-mariadb.sql` |
| SQL Server | `sql/monitor-user-mssql.sql` |
| Oracle | grant SELECT on V$/DBA views used by inventory (see Oracle inventory notes) |

- [ ] Credentials only in `config.json` or Admin → Databases (never in git)
- [ ] Session visible as Búho on the target
- [ ] Probe / first collector cycle green in Instance → Events

## 4. Alert channels (real destinations)

- [ ] Global defaults + system pack thresholds reviewed (includes `pack.rpo_exposure`)
- [ ] ≥1 channel enabled and **Test** succeeded
- [ ] Silences procedure known for maintenance windows
- [ ] Optional: instance tags `rpo_seconds` / `rpo_hours` for RPO targets

## 5. Store durability

- [ ] `BUHO_BACKUP_DIR` on the **host** (not only a Docker volume)
- [ ] Backup service running; last dump age visible / events clean
- [ ] Restore drill once: `pg_restore` into empty store
- [ ] Retention reviewed (Admin → Retention)

## 6. Update path

- [ ] Pin tag (`v1.7.1+`) and `./install.sh --pull`
- [ ] Air-gapped path: `EXTERNAL_INSTALL.md` § Air-gapped (docker save/load) when no GHCR
- [ ] If OTLP is reachable beyond loopback: set `BUHO_OTLP_TOKEN` (exporters send Bearer / `X-Buho-Otlp-Token`)
- [ ] Document who may update / recreate containers
- [ ] Optional: `npm run alerts:import` once for SQL catalog templates

## 7. Smoke after cutover

```bash
npm run verify:v1          # UI routes (lab)
# Databases: Fleet → Instance Overview → Blame → Estate RPO → Alerts
# Observability: Services → Probes → Add APM → Traces → TLS
```

- [ ] Health score present; if near 0 from missing backups/HA, treat as **posture** (UI explains this) until backups exist
- [ ] Host metrics on if promised
- [ ] Blame dual-lane readable (Pain now ≠ DBA risk)
- [ ] Estate RPO shows four engines; tags override target when set
- [ ] Observability Services lenses All / APM / PROBES work
- [ ] Customer knows: Búho is read-only monitor + alerts; not a backup product

## 8. Commercial

- [ ] Pilot signed (`PILOT_AGREEMENT.md`) or Pro/Fleet order per `PRICING.md`
- [ ] Server count agreed (host+port = one server)

## Out of scope (human / later)

- DBA interviews (F3 agenda) — see Obsidian [[Búho — Demo + entrevista prep 2026-10-09]]
- Marketing posts
- Mobile/tablet console polish
- Multi-source suite (**Centinela**)
