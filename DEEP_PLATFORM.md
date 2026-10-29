# Búho Deep Platform

Expands Búho beyond SQL + probes into **Kafka/CDC**, **Airflow**, **DPA-depth waits**, **gated actions**, **backup monitor→drills→storage**, **CIS compliance**, and **DataHub** hooks.

## New engines

| Engine | Port default | Config extras |
|--------|--------------|---------------|
| `kafka` | 9092 | `kafka.brokers`, `kafka.consumerGroups`, optional SASL |
| `cdc` | 9092 | `cdc.topics`, `cdc.applyGroups`, `cdc.datasyncHealthUrl` |
| `airflow` | 8080 | `airflow.baseUrl`, `airflow.username/password`, API v2→v1 fallback |

Example (file-based lab instance):

```json
{
  "alias": "kafka-prod",
  "engine": "kafka",
  "host": "kafka.example",
  "port": 9092,
  "database": "",
  "user": "",
  "kafka": {
    "brokers": ["kafka.example:9092"],
    "consumerGroups": ["datasync-apply"]
  }
}
```

```json
{
  "alias": "airflow-prod",
  "engine": "airflow",
  "host": "airflow.example",
  "port": 8080,
  "database": "",
  "user": "monitor",
  "password": "…",
  "airflow": { "baseUrl": "https://airflow.example", "apiVersion": "v2" }
}
```

## MSSQL lab

Local SQL Server 2022 for DPA depth, CIS `cis-mssql`, and collector smoke tests. Requires the external Docker network `buho_default` (create once: `docker network create buho_default`).

```bash
docker compose -f docker-compose.mssql-lab.yml up -d
```

Optional SA password override (must meet SQL Server complexity rules):

```bash
set MSSQL_SA_PASSWORD=Your_Strong_Password!
docker compose -f docker-compose.mssql-lab.yml up -d
```

Add a file-based target in `config.json` (host-native collector) or **Admin → Databases** in the console. Use the same password as `MSSQL_SA_PASSWORD` (compose default `Buho_Mssql_Lab1!`):

```json
{
  "alias": "mssql-lab",
  "engine": "mssql",
  "host": "127.0.0.1",
  "port": 1433,
  "database": "master",
  "user": "sa",
  "password": "Buho_Mssql_Lab1!"
}
```

If the **collector container** reaches the lab over Docker DNS, set `"host": "mssql-lab"` instead of `127.0.0.1`. For production-style privileges, run `sql/monitor-user-mssql.sql` and point the target at that login instead of `sa`.

**Windows / Docker:** use Docker Desktop with the **WSL2** backend and **Linux** containers; allocate at least ~2 GiB RAM to Docker. Port **1433** on `127.0.0.1` conflicts with a local SQL Server instance—stop the Windows service or change the host port mapping. Healthcheck uses `/opt/mssql-tools18/bin/sqlcmd` with `-C` (trust server cert). First boot can take 1–2 minutes before `healthy`.

## Light platform lab (W1/W2)

Redpanda (Kafka-compatible) + HTTP mocks for Airflow REST and DataSync health — no full Airflow/Kafka cluster.

```bash
docker network create buho_default   # once
docker compose -f docker-compose.platform-lab.yml up -d
npx tsx scripts/platform-lab-mocks.ts          # :18998 Airflow, :18999 DataSync health
BUHO_CONFIG=config.platform-lab.json npx tsx scripts/platform-w12-smoke.ts
```

Collector: include those three instances in `BUHO_CONFIG` (or merge with `config.lab-core.json`). Kafka + CDC on the same brokers are both started (dedupe key is `engine:alias`).

## Console routes

- `/platform/kafka` — Kafka/CDC fleet lag & under-replicated
- `/platform/airflow` — DAG / health / import errors
- `/platform/compliance` — latest CIS pack scores
- `POST /api/actions` — gated kill/cancel/pause DAG (requires `actions.enabled`)
- `POST /api/compliance/run` — `{ "alias", "pack": "cis-postgres"|"cis-mssql" }`

## Machine API + MCP (agents)

Bearer token auth (`BUHO_API_TOKEN`, min 16 chars). Proxy skips cookie login for `/api/v1/*`.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/fleet` | Fleet + scores |
| GET | `/api/v1/instances/:alias` | One instance |
| GET | `/api/v1/instances/:alias/metrics?names=` | Latest samples (15m) |
| GET | `/api/v1/instances/:alias/checks` | Latest checks (24h) |
| GET | `/api/v1/alerts` | Open alerts |
| GET | `/api/v1/compliance/latest` | CIS/STIG scores |
| POST | `/api/v1/compliance/run` | Needs `BUHO_API_ALLOW_WRITE=true` |
| POST | `/api/v1/actions` | Needs write flag + `actions.enabled` |

MCP package `@buho/mcp` (`npm run mcp` / `tsx apps/mcp/src/main.ts`):

- Read (store): `buho_health`, `buho_list_fleet`, `buho_get_instance`, `buho_get_metrics`, `buho_list_alerts`, `buho_latest_checks`, `buho_compliance_latest`, `buho_platform_summary`, `buho_platform_instance`, `buho_backup_status`, `buho_lineage_status`, `buho_wait_blame`, `buho_plan_fingerprints`, `buho_lock_episodes`
- Write (opt-in): `buho_run_compliance`, `buho_run_action` — need `BUHO_MCP_ALLOW_WRITE=true` + `BUHO_WEB_URL` + `BUHO_API_TOKEN`

Cursor `mcp.json` example:

```json
"buho": {
  "command": "C:\\Program Files\\nodejs\\npx.cmd",
  "args": ["tsx", "C:/Users/tomy.b/Documents/buho-monitor/apps/mcp/src/main.ts"],
  "env": {
    "BUHO_STORE_URL": "postgres://buho:buho@127.0.0.1:55432/buho",
    "BUHO_MCP_ALLOW_WRITE": "false"
  }
}
```

## Store tables

`wait_class_samples`, `plan_fingerprints`, `action_audit`, `backup_jobs`, `backup_artifacts`, `restore_drills`, `compliance_runs`, `lineage_sync_state`, `ddl_events`.

Run `npm run migrate` after pull.

## MSSQL lab

```bash
docker compose -f docker-compose.mssql-lab.yml up -d
# add mssql-lab to config.json (see config.example.json); SA password MSSQL_SA_PASSWORD / Buho_Mssql_Lab1!
```

## Full DBA depth (10 aspects)

Vacuum/wraparound SLA · capacity forecast · HA lag/slot SLO · backup RPO + **physical heap filepath drill** · CIS drift · privilege sprawl · invalid indexes + **FK orphan probes** · DDL capture ↔ plan regression · blocking tree · Blame playbooks + MCP DPA tools.

### Deeper drills

- **Failover readiness** (`runFailoverDrill`): primary needs ≥1 streaming standby; standby checks replay pause/lag. Lab single-node correctly fails.
- **Physical restore** (`runPhysicalRestoreDrill` + Pool): creates scratch heap and verifies `pg_relation_filepath`.
- **Oracle auto-plans**: `EXPLAIN PLAN` + `DBMS_XPLAN.DISPLAY` (shape fallback). Lab: `docker compose -f docker-compose.oracle-lab.yml up -d`.
- Smoke: `npx tsx scripts/dpa-deep-smoke.ts`

## Pricing units (Deep Platform)

A **billable server** additionally includes:

- One Kafka **cluster** (bootstrap set), regardless of broker count
- One Airflow **deployment** (one REST base URL)
- One CDC overlay counts as the Kafka cluster it rides on (not double-billed if same brokers)

## Safety

Destructive actions default **off**. Enable per instance:

```json
"actions": {
  "enabled": true,
  "allowKillSession": true,
  "allowCancelQuery": true,
  "allowAirflowDagPause": false
}
```

Use a dedicated action DB role — see `sql/monitor-user-notes-deep-platform.sql`.

## Workstream status

| Stream | Status in tree |
|--------|----------------|
| M0 foundation | EngineKind + schema + stubs |
| W1 Kafka/CDC | Collectors + checks + UI |
| W2 Airflow | Collectors + checks + UI + pause action |
| W3 DPA depth | wait_class **% time** + timeline; dense bursts; auto-plans PG/Maria/MSSQL + regression; Blame: waits→SQL→plan, **Ops playbook** (`lock_waits`, `plan_regression`, `vacuum_risk`, `rpo`), blocking chain (+ cancel/kill), plan history, IndexAdvisorLite, vacuum risk (PG); Queries: **PlanFingerprintDiff**; MCP DPA reads: `buho_wait_blame`, `buho_plan_fingerprints`, `buho_lock_episodes`; MSSQL missing-index DMV; `scripts/dpa-lab-smoke.ts` |
| W4 Actions | `runAction` + `/api/actions` + `action_audit` |
| W5 Backups | RPO + logical/physical restore drills + `backup_jobs` / artifacts; **storage agent** `npm run backup-agent` (local manifest); MCP `buho_backup_status` |
| W6 Compliance | CIS PG/MSSQL packs (expanded controls) + API + UI with per-control detail / re-run |
| W7 DataHub | Platform + dataset ingest; `lineage_sync_state` with URN; MCP `buho_lineage_status` |
| Advisors / baselines | `suggestIndexes` on EXPLAIN **and estimate/generic auto-plans** (`recordAutoPlan`); anomaly loop vs `metric_baselines` p90 |

### DPA deep (collector)

- **Dense waits**: when blocked sessions or query >5s, collector takes 5 extra snapshots ~2s apart (PG + foreign engines).
- **Auto-plans**: top statements → EXPLAIN estimate/generic (PG: `rewriteNormalizedPlaceholders` also fixes `extract($n from)`→epoch and `$n*$m`→numeric; skip `/* buho */`), EXPLAIN JSON (Maria: digest `?`→NULL via `rewriteMariadbPlaceholders`, skip `...`/truncated mid-clause), cached plan XML (MSSQL `dm_exec_query_plan`); fingerprints + optional `plan_requests` rows for the advisor.
- **MSSQL lab QDS**: `npx tsx scripts/mssql-lab-enable-qds.ts` creates `buho_lab` with Query Store ON (`database_id > 4`). Smoke: `BUHO_CONFIG=config.lab-core.json npx tsx scripts/dpa-deep-smoke.ts`.
- **MSSQL**: no `SET SHOWPLAN` on shared pools — cache XML only, shape fingerprint fallback.
