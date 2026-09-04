# Go-live checklist (first production customer)

Use this before the first paid / pilot install. Interviews are out of scope here.

## 1. Access & secrets

- [ ] `BUHO_AUTH_PASSWORD` set (strong, unique); consola refuses to serve without it in production
- [ ] `BUHO_AUTH_SECRET` set (or derived); rotate if anyone shared `.env`
- [ ] `BUHO_STORE_URL` / store password not default `buho` on a reachable network
- [ ] Consola bound to `127.0.0.1` + reverse proxy TLS, or VPN only
- [ ] At least one **admin** console user; viewers as needed (Admin → Users)

## 2. Monitor logins on each DB (least privilege)

| Engine | Script |
|--------|--------|
| PostgreSQL | `sql/monitor-user.sql` (`pg_monitor`) |
| MariaDB / MySQL | `sql/monitor-user-mariadb.sql` |
| SQL Server | `sql/monitor-user-mssql.sql` |

- [ ] Credentials only in `config.json` or Admin → Databases (never in git)
- [ ] `application_name` / session visible as Búho on the target
- [ ] Probe / first collector cycle green in Instance → Events

## 3. Alert channels (real destinations)

Admin → Alerts:

- [ ] Global defaults + system pack thresholds reviewed
- [ ] ≥1 channel enabled (Slack / Teams / Discord / Google Chat / Mattermost / Telegram / Rocket.Chat / PagerDuty / SMTP / webhook)
- [ ] Test fire (or `npm run ensayo:alerts` in lab) and **resolve** notification confirmed
- [ ] Silences procedure known for maintenance windows

## 4. Store durability

- [ ] `BUHO_BACKUP_DIR` on the **host** (not only a Docker volume)
- [ ] Backup service running; last dump age visible / events clean
- [ ] Restore drill once: `pg_restore` into empty store
- [ ] Retention reviewed (Admin → Retention); defaults OK for most pilots

## 5. Update path

- [ ] Pin tag (`v1.1.1`+) and `./install.sh --pull`
- [ ] Document who may `git checkout` / recreate containers
- [ ] Optional: `npm run alerts:import` once for SQL catalog templates

## 6. Smoke after cutover

```bash
npm run verify:v1          # UI routes (lab)
# or manually:
# Fleet → instance Overview → Alerts → Estate backups → Admin Alerts channel
```

- [ ] Health score and findings present for each prod instance
- [ ] Host metrics on if promised (local `/proc` or SSH)
- [ ] Customer knows: Búho is read-only monitor + alerts; not a backup product

## Out of scope (human / later)

- DBA interviews (F3 agenda)
- Marketing posts
- Multi-source suite product (**Centinela** — separate repo scaffold)
