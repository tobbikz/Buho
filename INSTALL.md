# Installing Búho

Operator guide for a new host. About fifteen minutes, most of it creating a read-only monitor login on each database.

Customer path: `./install.sh --pull`, then [First login](#first-login). First production cutover: [`GO_LIVE.md`](GO_LIVE.md).

---

## What you are installing

Three containers:

| Process | Role | Talks to |
| --- | --- | --- |
| **store** | PostgreSQL that holds Búho’s own history | nothing else |
| **collector** | connects to each monitored database, samples, runs checks | monitored databases and the store |
| **web** | the console | **only** the store |

The console never opens a connection to a customer database. Credentials for monitored instances live in the collector (and in `config.json` or Admin → Databases).

Búho is **agentless**. It connects as a normal client, with a read-only user. Nothing is installed on the database host. Host CPU and memory are optional and use SSH or local `/proc`.

Engines: **PostgreSQL, SQL Server, MariaDB / MySQL, Oracle**.

---

## Requirements

- Linux with Docker and the Compose plugin (`docker compose version`)
- About 2 GB of RAM and 10 GB of free disk to start; the store grows with retention and fleet size
- Network path from the Búho host to each database
- `openssl` (the installer generates secrets on first run)

Node.js and a host PostgreSQL are not required. Both run inside containers when you use `./install.sh --pull`.

---

## 1. Monitor user, one per server

Búho does not need to write. Scripts in `sql/` create a least-privilege user that can read the engine’s own statistics. Each script says why a grant exists. Change the password in the script before you run it, and use that same password in the console or in `config.json`.

```bash
# PostgreSQL — pg_monitor, no table data
psql   -h YOUR_SERVER -U postgres -f sql/monitor-user.sql

# MariaDB / MySQL — PROCESS, REPLICATION CLIENT, SLAVE MONITOR
mariadb -h YOUR_SERVER -u root < sql/monitor-user-mariadb.sql

# SQL Server — VIEW SERVER STATE, VIEW ANY DEFINITION, msdb read
sqlcmd -S YOUR_SERVER -U sa -i sql/monitor-user-mssql.sql

# Oracle — session + catalog views (run as SYS/SYSTEM in the PDB you monitor)
sqlplus sys@host:1521/ORCLPDB as sysdba @sql/monitor-user-oracle.sql
```

A user created this way cannot read table rows, write, change configuration, or see passwords. It can see object names, normalized statement text, and execution plans. Decide whether that is acceptable before you install.

### Optional PostgreSQL extras

Búho runs without these. You lose the query and measured-bloat views.

```sql
-- Top statements, plans, and per-query analysis.
-- shared_preload_libraries is not reloadable: this needs a restart.
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
ALTER SYSTEM SET track_io_timing = on;
-- restart, then in each database:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Measured bloat for the vacuum screen “measure” action.
-- Without it, bloat stays an estimate.
CREATE EXTENSION IF NOT EXISTS pgstattuple;
GRANT pg_stat_scan_tables TO buho_monitor;
```

### Optional MariaDB extras

Without `performance_schema` the queries screen stays empty and says so. Turning it on needs a restart and costs roughly 5% CPU. Without `log_bin` there are no binlog or replication metrics.

```ini
[mysqld]
performance_schema = ON
slow_query_log     = ON
long_query_time    = 0.1
log_output         = TABLE
```

### Optional SQL Server extras

Statements come from the plan cache, which clears on service restart and under memory pressure. Query Store keeps them, per database:

```sql
ALTER DATABASE [YourDb] SET QUERY_STORE = ON;
GRANT EXECUTE ON sys.xp_readerrorlog TO buho_monitor;
```

Full deadlocks already come from the `system_health` session, which is on by default.

---

## 2. Configuration

```bash
git clone https://github.com/tobbikz/buho.git
cd buho
git checkout v1.8.0
./install.sh --pull
```

The first run writes `.env` with random secrets and does not rewrite it later. Regenerating `BUHO_AUTH_SECRET` signs everyone out.

Prefer **Admin → Databases** in the console for production targets. They are stored in the store volume. `config.json` remains supported. `config.example.json` lists the fields.

```json
{
  "instances": [
    {
      "alias": "sales-prod",
      "engine": "postgres",
      "environment": "prod",
      "host": "10.0.0.10",
      "port": 5432,
      "database": "sales",
      "user": "buho_monitor",
      "password": "the-password-from-the-script",
      "tags": { "grupo": "prod-cr", "equipo": "data" }
    }
  ]
}
```

| Field | Use |
| --- | --- |
| `alias` | name in the console; unique |
| `engine` | `postgres` (default), `mariadb`, `mssql`, or `oracle` |
| `tags` | fleet filters; `grupo` is the one the sidebar uses |
| `hostMetrics` | host CPU, memory, and disk. Not exposed by PostgreSQL; read from `/proc`, locally or over SSH |
| `logs` | PostgreSQL log: full deadlocks and application errors |
| `collector.retention` | how many days each resolution is kept |

Default retention in `config.example.json`: 7 days raw, 90 days at 5 minutes, 400 days at 1 hour. Change it later under **Admin → Retention** without a restart.

### Host metrics (optional)

Without this, Búho cannot tell a slow database from a busy server.

```json
"hostMetrics": {
  "source": "ssh",
  "target": "buho@10.0.0.10",
  "identityFile": "/etc/buho/id_ed25519",
  "dataDirectory": "/var/lib/postgresql/18/main"
}
```

The remote user only needs to read `/proc` and run `df`. If Búho runs on the same machine, use `"source": "local"`.

### PostgreSQL log (optional)

```json
"logs": { "source": "journal", "access": "ssh", "target": "buho@10.0.0.10", "unit": "postgresql" }
```

or, for files:

```json
"logs": { "source": "file", "access": "local", "path": "/var/log/postgresql/*.log" }
```

On the monitored instance:

```sql
ALTER SYSTEM SET log_lock_waits = on;
ALTER SYSTEM SET deadlock_timeout = '1s';
ALTER SYSTEM SET log_min_duration_statement = '1s';
ALTER SYSTEM SET log_checkpoints = on;
ALTER SYSTEM SET log_destination = 'jsonlog';
SELECT pg_reload_conf();
```

---

## 3. Start

```bash
./install.sh --pull
```

Pulls published images, starts the three containers, waits until the collector has applied the schema, and checks that samples are arriving. It prints the URL and the bootstrap password.

| Command | When |
| --- | --- |
| `./install.sh --pull` | **customer install or upgrade** — pull published images, do not compile |
| `./install.sh` | build on this host (contributors) |
| `./install.sh --actualizar` | rebuild collector and console; **does not recreate the store** |
| `./install.sh --sin-build` | `up -d` with images already on the host |
| `./install.sh --verificar` | check an existing install |

Pin a version:

```bash
export BUHO_COLLECTOR_IMAGE=ghcr.io/tobbikz/buho/collector:1.8.0
export BUHO_WEB_IMAGE=ghcr.io/tobbikz/buho/web:1.8.0
./install.sh --pull
```

Images publish when a `v*` tag is pushed. If GHCR asks for a login: `echo $TOKEN | docker login ghcr.io -u USER --password-stdin`. Air-gapped load: [`EXTERNAL_INSTALL.md`](EXTERNAL_INSTALL.md).

---

## First login

1. Open <http://127.0.0.1:3100>
2. Sign in with the password the installer printed (`BUHO_AUTH_PASSWORD` in `.env`)
3. **Admin → Users**: create your own `admin` account

Once a real account exists, the bootstrap password stops working. Two roles: `admin` changes configuration, users, discovery, and retention; `viewer` is read-only.

The console binds to `127.0.0.1` on purpose. Put TLS or a VPN in front of it. Authentication does not replace either.

```nginx
server {
  listen 443 ssl;
  server_name buho.example.com;
  ssl_certificate     /etc/ssl/certs/buho.pem;
  ssl_certificate_key /etc/ssl/private/buho.key;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

With TLS terminated at the proxy, leave `BUHO_AUTH_COOKIE_SECURE=false`. A `secure` cookie behind a proxy that speaks plain HTTP to Búho locks everyone out.

If OTLP is reachable beyond loopback, set `BUHO_OTLP_TOKEN`. Wiring: [`deploy/otel-collector/README.md`](deploy/otel-collector/README.md).

---

## First day

| Screen | Question it answers |
| --- | --- |
| **Fleet** | which instance is worst right now |
| **Checks** | findings across the fleet, with remediation |
| **Weekly report** | how the week went; download as Markdown |
| **Estate** | versions, configuration, disk, replication, backups, jobs, licensing, RPO |
| **Security** | authentication, privileges, encryption, attack surface, audit |

Hour-of-day baselines need a few days of history. Weekday-versus-weekend shape needs about five weeks.

---

## Operations

```bash
docker compose ps
docker compose logs -f collector
docker compose logs -f web
docker compose restart collector    # reload config.json
docker compose down                 # stop, keep data
```

`config.json` is read when the collector starts. Restart it after edits. Targets added in the console are picked up within about 30 seconds.

### Store backup

Back up the store. Everything else is rebuilt from configuration. The history is what you are keeping.

The backup service is part of Compose. It runs on its own, keeps the latest copies, and writes success or failure to collector events so a failed backup shows up in the console.

In `.env`:

```bash
BUHO_BACKUP_DIR=/var/backups/buho   # host path, not a Docker volume
BUHO_BACKUP_EVERY=86400             # seconds between dumps
BUHO_BACKUP_KEEP=7
```

A dump inside a Docker volume disappears with `docker compose down -v`.

Restore into an empty store:

```bash
docker compose up -d store
docker compose exec -T store pg_restore -U buho -d buho --no-owner < buho-DATE.dump
docker compose up -d
```

The format is `pg_dump -Fc`.

### Upgrade

Customers pull a tag. Contributors on this checkout compile.

```bash
cd buho
git fetch --tags
git checkout v1.8.0
./install.sh --pull
```

Or pin images without changing the checkout:

```bash
export BUHO_COLLECTOR_IMAGE=ghcr.io/tobbikz/buho/collector:1.8.0
export BUHO_WEB_IMAGE=ghcr.io/tobbikz/buho/web:1.8.0
./install.sh --pull
```

On a development checkout:

```bash
git pull
./install.sh --actualizar
```

That rebuilds `collector` and `web` only. It does not recreate the store and does not regenerate `.env`. Plain `docker compose up -d` reuses old images unless you pass `--build`.

The collector migrates the schema on startup. Outside Docker: `BUHO_STORE_URL=... npm run migrate`.

Optional SQL alert catalog, once:

```bash
npm run alerts:import
```

The console shows store size on the fleet summary. **Admin → Retention** changes it without a restart.

---

## When something fails

**The console says it has no authentication.**  
`BUHO_AUTH_SECRET` or `BUHO_AUTH_PASSWORD` is missing in the web container. Check that `.env` exists and that Compose was started after it was written.

**No samples for an instance.**  
`docker compose logs --tail 40 collector` names the failure. Usual causes: credentials, `pg_hba.conf` (or the equivalent) not allowing Búho’s address, or a firewall. The instance **Events** tab records the same probe errors.

**No host CPU or memory.**  
`hostMetrics` is missing, or the SSH user cannot read the data directory. Búho walks parent directories until it finds one it can `df`, but it still needs the SSH login.

**No top statements (PostgreSQL).**  
`pg_stat_statements` is not loaded. Add it to `shared_preload_libraries`, restart, and create the extension in each database. The console says which step is missing.

**The log screen is empty.**  
It shows the source it is reading and the limits it hit. For `journal`, the SSH user must be in `systemd-journal`.

**Backups show as “not verifiable”.**  
Búho reports what the engine itself knows. An external backup tool that leaves no trace in the engine does not appear, and that does not mean the backup is missing. On PostgreSQL, “no recovery” with `archive_mode = off` is real: there is no point-in-time recovery.

---

## Uninstall

```bash
docker compose down -v    # -v also deletes store history
```
