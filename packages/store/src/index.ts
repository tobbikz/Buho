import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type {
  BloatMeasurement,
  LogEntry,
  VacuumSnapshot,
  IndexSnapshot,
  CatalogSnapshot,
  BlockedSession,
  Capabilities,
  InstanceConfig,
  InventorySnapshot,
  Sample,
  SecurityAudit,
  StatementDelta,
} from '@buho/core';
import type {
  AlertPackConfig,
  CheckResult,
  CustomAlertDefinition,
  CustomThresholdType,
} from '@buho/checks';
import {
  alertPackMetricNames,
  customCheckId,
  mergeAlertPack,
} from '@buho/checks';
import {
  ALERT_CHANNEL_KINDS,
  ALERT_CHANNEL_KINDS_SQL,
  ALERT_SETTINGS_DEFAULTS,
  actionableFindings,
  alertDedupeKey,
  isAlertChannelKind,
  pickAlertRule,
  resolveChannelDelivery,
  smtpMailContent,
  type AlertChannelKind,
  type AlertChannelRow,
  type AlertDeliveryJob,
  type AlertNotifyPayload,
  type AlertReconcileSummary,
  type AlertRow,
  type AlertRuleRow,
  type AlertSettings,
  type AlertSeverity,
  type AlertStatus,
} from './alerts';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export interface BloatRequestJob {
  requestId: number;
  schema: string;
  table: string;
  mode: 'exacto' | 'aproximado';
  requestedBy: string;
}

export interface PlanRequestJob {
  requestId: number;
  sql: string;
  mode: 'estimate' | 'generic' | 'analyze';
  requestedBy: string;
}

export interface PlanResult {
  plan: unknown;
  planText: string;
  findings: unknown;
  planningMs: number | null;
  executionMs: number | null;
  totalCost: number;
}

export interface DiscoveredRow {
  host: string;
  port: number;
  engine: string;
  versionText: string | null;
  banner: string | null;
  latencyMs: number;
}

export interface RetentionConfig {
  rawDays: number;
  rollup5mDays: number;
  rollup1hDays: number;
  lockEpisodeDays: number;
  statementDays: number;
  planDays: number;
  logDays: number;
  /** Historical check findings (not partitioned). */
  checkResultDays: number;
  collectorEventDays: number;
  healthScoreDays: number;
  /** Minutes without samples before the instance is treated as unreachable. */
  unreachableAfterMinutes: number;
}

/**
 * Zona horaria de las sesiones contra el store.
 *
 * Las líneas base se agrupan por hora del día y día de la semana, y esa hora
 * tiene que ser la del operador: si el store queda en UTC y la consola en
 * UTC-6, la banda sale corrida seis horas y no se parece a nada. Se fija la
 * misma zona en el colector y en la web para que "martes a las 3pm" signifique
 * lo mismo en los dos lados.
 */
export function storeTimeZone(): string {
  const declarada = process.env['BUHO_TZ']?.trim();
  return declarada || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export class Store {
  private readonly pool: Pool;

  constructor(url: string) {
    // Collector fans out many loops (samples, checks, plans, inventory, security).
    // max:4 starved maintenance for hours when DELETE/rollup held a slot.
    const poolMax = Number(process.env['BUHO_STORE_POOL_MAX'] ?? 24);
    this.pool = new Pool({
      connectionString: url,
      application_name: 'buho_store',
      max: Number.isFinite(poolMax) && poolMax >= 8 ? Math.floor(poolMax) : 24,
      connectionTimeoutMillis: 10_000,
      options: `-c timezone=${storeTimeZone()}`,
    });
  }

  async migrate(): Promise<void> {
    const schema = await readFile(SCHEMA_PATH, 'utf8');
    await this.pool.query(schema);
    await this.pool.query(
      `select buho.ensure_partitions('metric_samples', $1),
              buho.ensure_partitions('metric_rollup_5m', $1),
              buho.ensure_partitions('statement_stats', $1),
              buho.ensure_partitions('procedure_stats', $1),
              buho.ensure_partitions('log_events', $1)`,
      [3],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertInstance(instance: InstanceConfig): Promise<number> {
    const result = await this.pool.query<{ instance_id: string }>(
      `insert into buho.instances (tenant, alias, host, port, database, environment, engine, last_seen_at)
            values ($1, $2, $3, $4, $5, $6, $7, null)
       on conflict (tenant, alias) do update
              set host         = excluded.host,
                  port         = excluded.port,
                  database     = excluded.database,
                  environment  = excluded.environment,
                  engine       = excluded.engine
                  -- last_seen_at is only refreshed when samples land, so
                  -- unreachable detection stays honest if the probe fails.
        returning instance_id`,
      [
        instance.tenant ?? 'default',
        instance.alias,
        instance.host,
        instance.port,
        instance.database,
        instance.environment ?? 'prod',
        instance.engine ?? 'postgres',
      ],
    );
    const instanceId = Number(result.rows[0]?.instance_id);
    await this.saveTags(instanceId, instance.tags ?? {});
    return instanceId;
  }

  /**
   * Guarda el inventario del parque como **reemplazo**, no como serie.
   *
   * Cada dominio hace upsert de lo que vino y borra lo que ya no está: si se
   * eliminó una base de datos o se quitó un job, la fila tiene que desaparecer.
   * Un inventario que acumula objetos borrados deja de ser un inventario.
   *
   * Todo va en una transacción por instancia: media lectura guardada es peor
   * que ninguna, porque no se distingue de un parque que cambió de verdad.
   */
  async saveInventory(instanceId: number, snapshot: InventorySnapshot): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const engine = snapshot.engine;
      await client.query(
        `insert into buho.engine_info
              (instance_id, engine, version_num, version_text, edition, product_level,
               update_level, server_collation, started_at, cores, memory_bytes, eol_date, captured_at)
              values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         on conflict (instance_id) do update
                set engine = excluded.engine, version_num = excluded.version_num,
                    version_text = excluded.version_text, edition = excluded.edition,
                    product_level = excluded.product_level, update_level = excluded.update_level,
                    server_collation = excluded.server_collation, started_at = excluded.started_at,
                    cores = excluded.cores, memory_bytes = excluded.memory_bytes,
                    eol_date = excluded.eol_date, captured_at = now()`,
        [
          instanceId,
          engine.engine,
          engine.versionNum,
          engine.versionText,
          engine.edition ?? null,
          engine.productLevel ?? null,
          engine.updateLevel ?? null,
          engine.collation ?? null,
          engine.startedAt ?? null,
          engine.cores ?? null,
          engine.memoryBytes ?? null,
          engine.eolDate ?? null,
        ],
      );

      for (const row of snapshot.settings) {
        await client.query(
          `insert into buho.server_settings
                (instance_id, name, value, unit, category, is_default, requires_restart, captured_at)
                values ($1,$2,$3,$4,$5,$6,$7, now())
           on conflict (instance_id, name) do update
                  set value = excluded.value, unit = excluded.unit, category = excluded.category,
                      is_default = excluded.is_default, requires_restart = excluded.requires_restart,
                      captured_at = now()`,
          [
            instanceId,
            row.name,
            row.value,
            row.unit ?? null,
            row.category ?? null,
            row.isDefault ?? null,
            row.requiresRestart ?? null,
          ],
        );
      }

      for (const row of snapshot.disks) {
        await client.query(
          `insert into buho.disk_objects
                (instance_id, kind, name, container, size_bytes, used_bytes, free_bytes,
                 max_bytes, location, detail, captured_at)
                values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           on conflict (instance_id, kind, container, name) do update
                  set size_bytes = excluded.size_bytes, used_bytes = excluded.used_bytes,
                      free_bytes = excluded.free_bytes, max_bytes = excluded.max_bytes,
                      location = excluded.location, detail = excluded.detail, captured_at = now()`,
          [
            instanceId,
            row.kind,
            row.name,
            row.container ?? '',
            row.sizeBytes ?? null,
            row.usedBytes ?? null,
            row.freeBytes ?? null,
            row.maxBytes ?? null,
            row.location ?? null,
            JSON.stringify(row.detail ?? {}),
          ],
        );
      }

      for (const row of snapshot.replication) {
        await client.query(
          `insert into buho.replication_state
                (instance_id, role, peer, state, lag_bytes, lag_seconds, detail, captured_at)
                values ($1,$2,$3,$4,$5,$6,$7, now())
           on conflict (instance_id, role, peer) do update
                  set state = excluded.state, lag_bytes = excluded.lag_bytes,
                      lag_seconds = excluded.lag_seconds, detail = excluded.detail, captured_at = now()`,
          [
            instanceId,
            row.role,
            row.peer ?? '',
            row.state ?? null,
            row.lagBytes ?? null,
            row.lagSeconds ?? null,
            JSON.stringify(row.detail ?? {}),
          ],
        );
      }

      for (const row of snapshot.backups) {
        await client.query(
          `insert into buho.backup_state
                (instance_id, database, kind, finished_at, size_bytes, source, detail, captured_at)
                values ($1,$2,$3,$4,$5,$6,$7, now())
           on conflict (instance_id, database, kind) do update
                  set finished_at = excluded.finished_at, size_bytes = excluded.size_bytes,
                      source = excluded.source, detail = excluded.detail, captured_at = now()`,
          [
            instanceId,
            row.database,
            row.kind,
            row.finishedAt ?? null,
            row.sizeBytes ?? null,
            row.source,
            JSON.stringify(row.detail ?? {}),
          ],
        );
      }

      for (const row of snapshot.jobs) {
        await client.query(
          `insert into buho.jobs
                (instance_id, scope, name, enabled, last_run_at, last_status,
                 last_duration_ms, next_run_at, detail, captured_at)
                values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
           on conflict (instance_id, scope, name) do update
                  set enabled = excluded.enabled, last_run_at = excluded.last_run_at,
                      last_status = excluded.last_status, last_duration_ms = excluded.last_duration_ms,
                      next_run_at = excluded.next_run_at, detail = excluded.detail, captured_at = now()`,
          [
            instanceId,
            row.scope ?? '',
            row.name,
            row.enabled ?? null,
            row.lastRunAt ?? null,
            row.lastStatus ?? null,
            row.lastDurationMs ?? null,
            row.nextRunAt ?? null,
            JSON.stringify(row.detail ?? {}),
          ],
        );
      }

      const licensing = snapshot.licensing;
      if (licensing) {
        await client.query(
          `insert into buho.licensing
                (instance_id, edition, license_model, cores, cores_limit, memory_bytes,
                 memory_limit_bytes, production_ok, note, detail, captured_at)
                values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           on conflict (instance_id) do update
                  set edition = excluded.edition, license_model = excluded.license_model,
                      cores = excluded.cores, cores_limit = excluded.cores_limit,
                      memory_bytes = excluded.memory_bytes,
                      memory_limit_bytes = excluded.memory_limit_bytes,
                      production_ok = excluded.production_ok, note = excluded.note,
                      detail = excluded.detail, captured_at = now()`,
          [
            instanceId,
            licensing.edition ?? null,
            licensing.licenseModel ?? null,
            licensing.cores ?? null,
            licensing.coresLimit ?? null,
            licensing.memoryBytes ?? null,
            licensing.memoryLimitBytes ?? null,
            licensing.productionOk ?? null,
            licensing.note ?? null,
            JSON.stringify(licensing.detail ?? {}),
          ],
        );
      }

      for (const note of snapshot.notes) {
        await client.query(
          `insert into buho.inventory_notes (instance_id, domain, level, message, captured_at)
                values ($1,$2,$3,$4, now())
           on conflict (instance_id, domain, message) do update
                  set level = excluded.level, captured_at = now()`,
          [instanceId, note.domain, note.level, note.message],
        );
      }

      // Borrado de lo que no vino en esta lectura.
      //
      // `now()` es constante durante toda la transacción, así que las filas que
      // se acaban de escribir tienen captured_at *igual* a now() y las de la
      // lectura anterior son estrictamente menores. El corte es exacto y no
      // necesita un margen de tolerancia que habría que adivinar.
      const stale = `delete from buho.%I where instance_id = $1 and captured_at < now()`;
      for (const table of [
        'server_settings',
        'disk_objects',
        'replication_state',
        'backup_state',
        'jobs',
        'inventory_notes',
      ]) {
        await client.query(stale.replace('%I', table), [instanceId]);
      }

      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Toma el siguiente encargo de EXPLAIN de una instancia y lo marca como en
   * curso.
   *
   * `for update skip locked` es lo que permite que varios colectores —o el
   * mismo colector con una instancia por bucle— compitan por la cola sin
   * ejecutar dos veces el mismo plan ni bloquearse entre ellos.
   */
  async claimPlanRequest(instanceId: number): Promise<PlanRequestJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query<{
        request_id: string;
        sql: string;
        mode: 'estimate' | 'generic' | 'analyze';
        requested_by: string;
      }>(
        `select request_id, sql, mode, requested_by
           from buho.plan_requests
          where instance_id = $1 and state = 'pendiente'
          order by requested_at
          limit 1
            for update skip locked`,
        [instanceId],
      );

      const row = result.rows[0];
      if (!row) {
        await client.query('commit');
        return null;
      }

      await client.query(
        `update buho.plan_requests set state = 'corriendo', started_at = now() where request_id = $1`,
        [row.request_id],
      );
      await client.query('commit');

      return {
        requestId: Number(row.request_id),
        sql: row.sql,
        mode: row.mode,
        requestedBy: row.requested_by,
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Toma la siguiente medición de bloat pendiente. Mismo patrón que la cola de
   * planes: `for update skip locked` para que dos ciclos no midan la misma
   * tabla, y de a una porque cada medición es un escaneo completo.
   */
  async claimBloatRequest(instanceId: number): Promise<BloatRequestJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query<{
        request_id: string;
        schema_name: string;
        table_name: string;
        mode: 'exacto' | 'aproximado';
        requested_by: string;
      }>(
        `select request_id, schema_name, table_name, mode, requested_by
           from buho.bloat_requests
          where instance_id = $1 and state = 'pendiente'
          order by requested_at
          limit 1
            for update skip locked`,
        [instanceId],
      );

      const row = result.rows[0];
      if (!row) {
        await client.query('commit');
        return null;
      }

      await client.query(
        `update buho.bloat_requests set state = 'corriendo', started_at = now() where request_id = $1`,
        [row.request_id],
      );
      await client.query('commit');

      return {
        requestId: Number(row.request_id),
        schema: row.schema_name,
        table: row.table_name,
        mode: row.mode,
        requestedBy: row.requested_by,
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async finishBloatRequest(requestId: number, measurement: BloatMeasurement): Promise<void> {
    await this.pool.query(
      `update buho.bloat_requests
          set state = 'listo', finished_at = now(), error = null,
              table_bytes = $2, tuple_count = $3, tuple_bytes = $4,
              dead_count = $5, dead_bytes = $6, free_bytes = $7,
              free_pct = $8, dead_pct = $9
        where request_id = $1`,
      [
        requestId,
        measurement.tableBytes,
        measurement.tupleCount,
        measurement.tupleBytes,
        measurement.deadCount,
        measurement.deadBytes,
        measurement.freeBytes,
        measurement.freePct,
        measurement.deadPct,
      ],
    );
  }

  async failBloatRequest(requestId: number, message: string): Promise<void> {
    await this.pool.query(
      `update buho.bloat_requests
          set state = 'error', finished_at = now(), error = $2
        where request_id = $1`,
      [requestId, message],
    );
  }

  async finishPlanRequest(requestId: number, result: PlanResult): Promise<void> {
    await this.pool.query(
      `update buho.plan_requests
          set state = 'listo', finished_at = now(), plan = $2, plan_text = $3,
              findings = $4, planning_ms = $5, execution_ms = $6, total_cost = $7,
              error = null
        where request_id = $1`,
      [
        requestId,
        JSON.stringify(result.plan),
        result.planText,
        JSON.stringify(result.findings),
        result.planningMs,
        result.executionMs,
        result.totalCost,
      ],
    );
  }

  async failPlanRequest(requestId: number, message: string): Promise<void> {
    await this.pool.query(
      `update buho.plan_requests
          set state = 'error', finished_at = now(), error = $2
        where request_id = $1`,
      [requestId, message],
    );
  }

  /**
   * Encargos que quedaron en 'corriendo' porque el colector se cayó a mitad.
   *
   * Sin esto la consola muestra "ejecutando" para siempre y el operador no sabe
   * si esperar o volver a pedirlo.
   */
  async releaseStalePlanRequests(olderThanSeconds = 120): Promise<number> {
    const result = await this.pool.query(
      `update buho.plan_requests
          set state = 'error', finished_at = now(),
              error = 'El colector se detuvo antes de terminar de explicar la consulta.'
        where state = 'corriendo'
          and started_at < now() - ($1 || ' seconds')::interval`,
      [olderThanSeconds],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Etiquetas declaradas en config.json.
   *
   * Reemplaza el conjunto completo: quitar una etiqueta del archivo tiene que
   * hacerla desaparecer de la consola, no dejarla huérfana para siempre.
   */
  async saveTags(instanceId: number, tags: Record<string, string>): Promise<void> {
    const entries = Object.entries(tags);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const [key, value] of entries) {
        await client.query(
          `insert into buho.instance_tags (instance_id, key, value, captured_at)
                values ($1, $2, $3, now())
           on conflict (instance_id, key) do update
                  set value = excluded.value, captured_at = now()`,
          [instanceId, key, value],
        );
      }
      await client.query(
        'delete from buho.instance_tags where instance_id = $1 and captured_at < now()',
        [instanceId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retención efectiva: la de la consola si existe, la del config si no.
   *
   * El colector la consulta en cada ciclo de mantenimiento en vez de leerla una
   * vez al arrancar, para que un cambio en la interfaz surta efecto sin
   * reiniciar el proceso.
   */
  async effectiveRetention(fallback: RetentionConfig): Promise<RetentionConfig> {
    const result = await this.pool.query<{ value: Partial<RetentionConfig> }>(
      "select value from buho.settings where key = 'retention'",
    );
    const stored = result.rows[0]?.value;
    return stored ? { ...fallback, ...stored } : fallback;
  }

  async saveDiscovered(rows: DiscoveredRow[]): Promise<void> {
    for (const row of rows) {
      await this.pool.query(
        `insert into buho.discovered (host, port, engine, version_text, banner, latency_ms,
                                     first_seen_at, last_seen_at)
              values ($1,$2,$3,$4,$5,$6, now(), now())
         on conflict (host, port) do update
                set engine = excluded.engine,
                    version_text = coalesce(excluded.version_text, buho.discovered.version_text),
                    banner = excluded.banner,
                    latency_ms = excluded.latency_ms,
                    last_seen_at = now()`,
        [row.host, row.port, row.engine, row.versionText, row.banner, row.latencyMs],
      );
    }
  }

  async saveSecurity(instanceId: number, audit: SecurityAudit): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      for (const finding of audit.findings) {
        await client.query(
          `insert into buho.security_findings
                (instance_id, check_id, category, severity, title, detail, remediation, evidence, captured_at)
                values ($1,$2,$3,$4,$5,$6,$7,$8, now())
           on conflict (instance_id, check_id) do update
                  set category = excluded.category, severity = excluded.severity,
                      title = excluded.title, detail = excluded.detail,
                      remediation = excluded.remediation, evidence = excluded.evidence,
                      captured_at = now()`,
          [
            instanceId,
            finding.checkId,
            finding.category,
            finding.severity,
            finding.title,
            finding.detail,
            finding.remediation ?? null,
            JSON.stringify(finding.evidence ?? {}),
          ],
        );
      }

      for (const principal of audit.principals) {
        await client.query(
          `insert into buho.security_principals
                (instance_id, name, host, kind, can_login, is_superuser, disabled,
                 auth_method, password_set_at, expires_at, privileges, detail, captured_at)
                values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
           on conflict (instance_id, name, host) do update
                  set kind = excluded.kind, can_login = excluded.can_login,
                      is_superuser = excluded.is_superuser, disabled = excluded.disabled,
                      auth_method = excluded.auth_method,
                      password_set_at = excluded.password_set_at,
                      expires_at = excluded.expires_at, privileges = excluded.privileges,
                      detail = excluded.detail, captured_at = now()`,
          [
            instanceId,
            principal.name,
            principal.host ?? '',
            principal.kind,
            principal.canLogin,
            principal.isSuperuser,
            principal.disabled,
            principal.authMethod ?? null,
            principal.passwordSetAt ?? null,
            principal.expiresAt ?? null,
            principal.privileges,
            JSON.stringify(principal.detail ?? {}),
          ],
        );
      }

      const count = (severity: string): number =>
        audit.findings.filter((finding) => finding.severity === severity).length;

      await client.query(
        `insert into buho.security_posture
              (instance_id, captured_at, score, critical, high, medium, low, verified, total)
              values ($1, now(), $2, $3, $4, $5, $6, $7, $8)
         on conflict (instance_id, captured_at) do nothing`,
        [
          instanceId,
          audit.score,
          count('critica'),
          count('alta'),
          count('media'),
          count('baja'),
          audit.verified,
          audit.total,
        ],
      );

      // Mismo corte exacto que el inventario: now() es constante en la
      // transacción, así que lo recién escrito no cae en el borrado.
      for (const table of ['security_findings', 'security_principals']) {
        await client.query(
          `delete from buho.${table} where instance_id = $1 and captured_at < now()`,
          [instanceId],
        );
      }

      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async saveCapabilities(instanceId: number, caps: Capabilities): Promise<void> {
    await this.pool.query(
      `insert into buho.instance_capabilities
            (instance_id, version_num, version_text, in_recovery, has_pg_monitor,
             is_superuser, track_io_timing, stat_statements, extensions, server_started_at, probed_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       on conflict (instance_id) do update
              set version_num       = excluded.version_num,
                  version_text      = excluded.version_text,
                  in_recovery       = excluded.in_recovery,
                  has_pg_monitor    = excluded.has_pg_monitor,
                  is_superuser      = excluded.is_superuser,
                  track_io_timing   = excluded.track_io_timing,
                  stat_statements   = excluded.stat_statements,
                  extensions        = excluded.extensions,
                  server_started_at = excluded.server_started_at,
                  probed_at         = now()`,
      [
        instanceId,
        caps.versionNum,
        caps.versionText,
        caps.inRecovery,
        caps.hasPgMonitor,
        caps.isSuperuser,
        caps.trackIoTiming,
        caps.statStatements,
        JSON.stringify(caps.extensions),
        caps.startedAt,
      ],
    );
  }

  /** Inserción por lote con unnest: una sola ida al servidor por ciclo. */
  async insertSamples(instanceId: number, samples: Sample[], ts = new Date()): Promise<number> {
    if (samples.length === 0) return 0;
    const metrics: string[] = [];
    const labels: string[] = [];
    const values: number[] = [];

    for (const sample of samples) {
      if (!Number.isFinite(sample.value)) continue;
      metrics.push(sample.metric);
      labels.push(JSON.stringify(sample.labels ?? {}));
      values.push(sample.value);
    }
    if (metrics.length === 0) return 0;

    // last_seen_at se refresca en el mismo viaje: "último dato" tiene que
    // significar la última muestra, no el arranque del colector. Un CTE que
    // modifica datos se ejecuta aunque nadie lo referencie.
    await this.pool.query(
      `with ins as (
         insert into buho.metric_samples (instance_id, ts, metric, labels, value)
         select $1, $2, m, l::jsonb, v
           from unnest($3::text[], $4::text[], $5::double precision[]) as t(m, l, v)
       )
       update buho.instances
          set last_seen_at = $2
        where instance_id = $1
          and (last_seen_at is null or last_seen_at < $2)`,
      [instanceId, ts, metrics, labels, values],
    );
    return metrics.length;
  }

  /**
   * Un episodio vivo se actualiza en su fila; sólo cuando el pid o el inicio de
   * la query cambian aparece un episodio nuevo. Así la UI muestra "un bloqueo
   * de 4 minutos" en vez de veinticuatro muestras del mismo bloqueo.
   */
  async saveLockEpisodes(instanceId: number, sessions: BlockedSession[], ts = new Date()): Promise<number> {
    for (const session of sessions) {
      await this.pool.query(
        `insert into buho.lock_episodes
              (instance_id, waiter_pid, waiter_query_start, first_seen_at, last_seen_at,
               wait_seconds, waiter_user, waiter_application, waiter_database, waiter_query,
               wait_event_type, wait_event, lock_type, lock_mode, lock_object,
               blocker_pids, blocker_pid, blocker_state, blocker_query, blocker_user,
               blocker_application, blocker_xact_seconds)
              values ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                      $15::integer[], $16, $17, $18, $19, $20, $21)
         on conflict on constraint lock_episodes_identity do update
                set last_seen_at          = excluded.last_seen_at,
                    samples               = buho.lock_episodes.samples + 1,
                    wait_seconds          = greatest(buho.lock_episodes.wait_seconds, excluded.wait_seconds),
                    -- El bloqueador puede cambiar mientras la cadena se resuelve:
                    -- se guarda el último visto.
                    blocker_pids          = excluded.blocker_pids,
                    blocker_pid           = excluded.blocker_pid,
                    blocker_state         = excluded.blocker_state,
                    blocker_query         = excluded.blocker_query,
                    blocker_user          = excluded.blocker_user,
                    blocker_application   = excluded.blocker_application,
                    blocker_xact_seconds  = excluded.blocker_xact_seconds,
                    lock_type             = excluded.lock_type,
                    lock_mode             = excluded.lock_mode,
                    lock_object           = excluded.lock_object`,
        [
          instanceId,
          session.waiterPid,
          session.waiterQueryStart,
          ts,
          session.waitSeconds,
          session.waiterUser,
          session.waiterApplication,
          session.waiterDatabase,
          session.waiterQuery,
          session.waitEventType,
          session.waitEvent,
          session.lockType,
          session.lockMode,
          session.lockObject,
          session.blockerPids,
          session.blockerPid,
          session.blockerState,
          session.blockerQuery,
          session.blockerUser,
          session.blockerApplication,
          session.blockerXactSeconds,
        ],
      );
    }
    return sessions.length;
  }

  /** Dos escrituras por ciclo: los textos (upsert) y los deltas (lote con unnest). */
  async saveStatements(instanceId: number, deltas: StatementDelta[], ts = new Date()): Promise<number> {
    if (deltas.length === 0) return 0;

    // Un mismo queryid puede llegar varias veces en el lote (distinto userid /
    // toplevel). statement_texts tiene PK (instance_id, queryid), así que un
    // unnest con duplicados hace fallar el ON CONFLICT con
    // "cannot affect row a second time" y se pierde todo el ciclo de stats —
    // Flow LIVE y Queries dejan de actualizarse.
    const textsByQueryid = new Map<string, { query: string; truncated: boolean }>();
    for (const delta of deltas) {
      const prev = textsByQueryid.get(delta.queryid);
      if (!prev || delta.query.length >= prev.query.length) {
        textsByQueryid.set(delta.queryid, { query: delta.query, truncated: delta.truncated });
      }
    }
    const textRows = [...textsByQueryid.entries()];

    await this.pool.query(
      `insert into buho.statement_texts
            (instance_id, queryid, query, truncated, first_seen_at, last_seen_at)
       select $1, q::bigint, t, tr, $2, $2
         from unnest($3::text[], $4::text[], $5::boolean[]) as x(q, t, tr)
          on conflict (instance_id, queryid) do update
                 set last_seen_at = excluded.last_seen_at,
                     query        = excluded.query,
                     truncated    = excluded.truncated`,
      [
        instanceId,
        ts,
        textRows.map(([queryid]) => queryid),
        textRows.map(([, row]) => row.query),
        textRows.map(([, row]) => row.truncated),
      ],
    );

    await this.pool.query(
      `insert into buho.statement_stats
            (instance_id, ts, queryid, database, username, toplevel,
             calls, exec_ms, rows, shared_hit, shared_read, temp_read, temp_written, wal_bytes)
       select $1, $2, q::bigint, db, usr, top, c, e, r, sh, sr, tr, tw, wb
         from unnest($3::text[], $4::text[], $5::text[], $6::boolean[],
                     $7::double precision[], $8::double precision[], $9::double precision[],
                     $10::double precision[], $11::double precision[], $12::double precision[],
                     $13::double precision[], $14::double precision[])
              as x(q, db, usr, top, c, e, r, sh, sr, tr, tw, wb)`,
      [
        instanceId,
        ts,
        deltas.map((d) => d.queryid),
        deltas.map((d) => d.database),
        deltas.map((d) => d.username),
        deltas.map((d) => d.toplevel),
        deltas.map((d) => d.calls),
        deltas.map((d) => d.execMs),
        deltas.map((d) => d.rows),
        deltas.map((d) => d.sharedHit),
        deltas.map((d) => d.sharedRead),
        deltas.map((d) => d.tempRead),
        deltas.map((d) => d.tempWritten),
        deltas.map((d) => d.walBytes),
      ],
    );

    return deltas.length;
  }

  async saveProcedureStats(
    instanceId: number,
    deltas: {
      objectId: string;
      database: string;
      schema: string;
      name: string;
      calls: number;
      execMs: number;
      workerMs: number;
      logicalReads: number;
      avgDurationSec: number;
    }[],
    slow: {
      objectId: string;
      database: string;
      schema: string;
      name: string;
      lastElapsedSec: number;
    }[],
    at = new Date(),
  ): Promise<number> {
    if (deltas.length === 0 && slow.length === 0) return 0;

    if (deltas.length > 0) {
      await this.pool.query(
        `insert into buho.procedure_texts
              (instance_id, object_id, database, schema_name, proc_name, first_seen_at, last_seen_at)
         select $1, o::bigint, db, sch, nm, $2, $2
           from unnest($3::text[], $4::text[], $5::text[], $6::text[]) as x(o, db, sch, nm)
            on conflict (instance_id, object_id) do update
                   set last_seen_at = excluded.last_seen_at,
                       database = excluded.database,
                       schema_name = excluded.schema_name,
                       proc_name = excluded.proc_name`,
        [
          instanceId,
          at,
          deltas.map((d) => d.objectId),
          deltas.map((d) => d.database),
          deltas.map((d) => d.schema),
          deltas.map((d) => d.name),
        ],
      );

      await this.pool.query(
        `insert into buho.procedure_stats
              (instance_id, ts, object_id, database, calls, exec_ms, worker_ms, logical_reads, avg_duration_sec)
         select $1, $2, o::bigint, db, c, e, w, lr, avgd
           from unnest($3::text[], $4::text[], $5::double precision[], $6::double precision[],
                       $7::double precision[], $8::double precision[], $9::double precision[])
                as x(o, db, c, e, w, lr, avgd)`,
        [
          instanceId,
          at,
          deltas.map((d) => d.objectId),
          deltas.map((d) => d.database),
          deltas.map((d) => d.calls),
          deltas.map((d) => d.execMs),
          deltas.map((d) => d.workerMs),
          deltas.map((d) => d.logicalReads),
          deltas.map((d) => d.avgDurationSec),
        ],
      );
    }

    if (slow.length > 0) {
      await this.pool.query(
        `insert into buho.procedure_slow_events
              (instance_id, ts, object_id, database, schema_name, proc_name, duration_sec)
         select $1, $2, o::bigint, db, sch, nm, dur
           from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::double precision[])
                as x(o, db, sch, nm, dur)
            on conflict do nothing`,
        [
          instanceId,
          at,
          slow.map((d) => d.objectId),
          slow.map((d) => d.database),
          slow.map((d) => d.schema),
          slow.map((d) => d.name),
          slow.map((d) => d.lastElapsedSec),
        ],
      );
    }

    return deltas.length;
  }

  async saveStatementSlowEvents(
    instanceId: number,
    events: {
      queryid: string;
      database: string | null;
      username: string | null;
      query: string;
      truncated: boolean;
      durationSec: number;
      rowsSent: number;
      rowsExamined: number;
      source: string;
    }[],
    at = new Date(),
  ): Promise<number> {
    if (events.length === 0) return 0;

    await this.pool.query(
      `insert into buho.statement_texts
            (instance_id, queryid, query, truncated, first_seen_at, last_seen_at)
       select $1, q::bigint, txt, trunc, $2, $2
         from unnest($3::text[], $4::text[], $5::boolean[]) as x(q, txt, trunc)
          on conflict (instance_id, queryid) do update
                 set last_seen_at = excluded.last_seen_at,
                     query = case when length(excluded.query) > length(buho.statement_texts.query)
                                  then excluded.query else buho.statement_texts.query end`,
      [
        instanceId,
        at,
        events.map((e) => e.queryid),
        events.map((e) => e.query || '(empty)'),
        events.map((e) => e.truncated),
      ],
    );

    await this.pool.query(
      `insert into buho.statement_slow_events
            (instance_id, ts, queryid, database, username, duration_sec, rows_sent, rows_examined, source)
       select $1, $2, q::bigint, db, usr, dur, rs, re, src
         from unnest(
                $3::text[], $4::text[], $5::text[], $6::double precision[],
                $7::double precision[], $8::double precision[], $9::text[]
              ) as x(q, db, usr, dur, rs, re, src)
          on conflict do nothing`,
      [
        instanceId,
        at,
        events.map((e) => e.queryid),
        events.map((e) => e.database),
        events.map((e) => e.username),
        events.map((e) => e.durationSec),
        events.map((e) => e.rowsSent),
        events.map((e) => e.rowsExamined),
        events.map((e) => e.source),
      ],
    );

    return events.length;
  }

  /** Catálogo de tablas + FKs para ORM en motores sin vacuum_tables. */
  async saveForeignOrmCatalog(
    instanceId: number,
    tables: { schema: string; table: string; liveTuples: number; sizeBytes: number }[],
    fks: { fromSchema: string; fromTable: string; toSchema: string; toTable: string }[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from buho.vacuum_tables where instance_id = $1', [instanceId]);
      if (tables.length > 0) {
        await client.query(
          `insert into buho.vacuum_tables
                (instance_id, schema_name, table_name, live_tuples, dead_tuples, size_bytes, heap_bytes, captured_at)
           select $1, sch, tbl, live, 0, sz, sz, now()
             from unnest($2::text[], $3::text[], $4::bigint[], $5::bigint[]) as x(sch, tbl, live, sz)`,
          [
            instanceId,
            tables.map((t) => t.schema),
            tables.map((t) => t.table),
            tables.map((t) => t.liveTuples),
            tables.map((t) => t.sizeBytes),
          ],
        );
      }
      await client.query('delete from buho.table_fks where instance_id = $1', [instanceId]);
      if (fks.length > 0) {
        await client.query(
          `insert into buho.table_fks
                (instance_id, from_schema, from_table, to_schema, to_table, constraint_name, captured_at)
           select $1, fs, ft, ts, tt, concat(fs, '.', ft, '→', ts, '.', tt), now()
             from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as x(fs, ft, ts, tt)
              on conflict do nothing`,
          [
            instanceId,
            fks.map((f) => f.fromSchema),
            fks.map((f) => f.fromTable),
            fks.map((f) => f.toSchema),
            fks.map((f) => f.toTable),
          ],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Guarda el estado de vacuum.
   *
   *
   * Llega ya agregado por minuto desde el colector, así que aquí sólo se
   * escribe. Se ignoran las combinaciones sin observaciones para no llenar la
   * tabla de ceros.
   */
  async saveQueryActors(
    instanceId: number,
    at: Date,
    observations: {
      application: string;
      username: string;
      database: string;
      queryid: string;
      samples: number;
    }[],
  ): Promise<number> {
    const utiles = observations.filter((observation) => observation.samples > 0);
    if (utiles.length === 0) return 0;

    const values: unknown[] = [];
    const tuples: string[] = [];
    utiles.forEach((observation, index) => {
      const base = index * 7;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`,
      );
      values.push(
        instanceId,
        at,
        observation.queryid,
        observation.application,
        observation.username,
        observation.database,
        observation.samples,
      );
    });

    await this.pool.query(
      `insert into buho.query_actors
              (instance_id, ts, queryid, application, username, database, samples)
       values ${tuples.join(', ')}`,
      values,
    );
    return utiles.length;
  }

  /**
   * Guarda una foto de sesiones: el agregado de esperas y el detalle recortado.
   *
   * Va en una sola transacción porque las dos tablas describen el mismo
   * instante: un agregado sin su detalle, o al revés, haría dudar de si falta un
   * dato o si no había nada.
   */
  async saveSessionSnapshot(
    instanceId: number,
    snapshot: {
      at: Date;
      waits: { waitType: string; waitEvent: string | null; sessions: number }[];
      detail: {
        pid: number;
        state: string;
        waitEventType: string | null;
        waitEvent: string | null;
        application: string;
        username: string;
        database: string;
        queryid: string | null;
        queryMs: number | null;
        xactMs: number | null;
        blockedBy: number | null;
        query: string | null;
      }[];
    },
  ): Promise<number> {
    if (snapshot.waits.length === 0 && snapshot.detail.length === 0) return 0;

    const client = await this.pool.connect();
    try {
      await client.query('begin');

      if (snapshot.waits.length > 0) {
        const values: unknown[] = [];
        const tuples: string[] = [];
        snapshot.waits.forEach((espera, indice) => {
          const base = indice * 5;
          tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
          values.push(instanceId, snapshot.at, espera.waitType, espera.waitEvent, espera.sessions);
        });
        await client.query(
          `insert into buho.wait_samples (instance_id, ts, wait_type, wait_event, sessions)
           values ${tuples.join(', ')}`,
          values,
        );
      }

      if (snapshot.detail.length > 0) {
        const values: unknown[] = [];
        const tuples: string[] = [];
        snapshot.detail.forEach((sesion, indice) => {
          const base = indice * 14;
          tuples.push(
            `(${Array.from({ length: 14 }, (_, offset) => `$${base + offset + 1}`).join(', ')})`,
          );
          values.push(
            instanceId,
            snapshot.at,
            sesion.pid,
            sesion.state,
            sesion.waitEventType,
            sesion.waitEvent,
            sesion.application,
            sesion.username,
            sesion.database,
            sesion.queryid,
            sesion.queryMs,
            sesion.xactMs,
            sesion.blockedBy,
            sesion.query,
          );
        });
        await client.query(
          `insert into buho.session_samples
                  (instance_id, ts, pid, state, wait_type, wait_event, application,
                   username, database, queryid, query_ms, xact_ms, blocked_by, query)
           values ${tuples.join(', ')}`,
          values,
        );
      }

      await client.query('commit');
      return snapshot.waits.length + snapshot.detail.length;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveVacuum(instanceId: number, snapshot: VacuumSnapshot): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      if (snapshot.tables.length > 0) {
        const values: unknown[] = [];
        const tuples: string[] = [];
        snapshot.tables.forEach((table, index) => {
          const base = index * 25;
          tuples.push(
            `(${Array.from({ length: 25 }, (_, offset) => `$${base + offset + 1}`).join(', ')}, now())`,
          );
          values.push(
            instanceId,
            table.schema,
            table.table,
            Math.round(table.liveTuples),
            Math.round(table.deadTuples),
            table.deadPct,
            table.lastAutovacuum,
            table.lastVacuum,
            table.lastAutoanalyze,
            table.lastAnalyze,
            Math.round(table.autovacuumCount),
            Math.round(table.analyzeCount),
            table.threshold,
            table.remaining,
            table.autovacuumEnabled,
            Math.round(table.sizeBytes),
            Math.round(table.heapBytes),
            table.bloatBytes === null ? null : Math.round(table.bloatBytes),
            table.bloatPct,
            table.bloatNote,
            Math.round(table.xidAge),
            Math.round(table.mxidAge),
            Math.round(table.freezeMaxAge),
            table.xidPct,
            table.mxidPct,
          );
        });

        await client.query(
          `insert into buho.vacuum_tables
             (instance_id, schema_name, table_name, live_tuples, dead_tuples, dead_pct,
              last_autovacuum, last_vacuum, last_autoanalyze, last_analyze,
              autovacuum_count, analyze_count, threshold, remaining, autovacuum_enabled,
              size_bytes, heap_bytes, bloat_bytes, bloat_pct, bloat_note,
              xid_age, mxid_age, freeze_max_age, xid_pct, mxid_pct, captured_at)
           values ${tuples.join(', ')}
           on conflict (instance_id, schema_name, table_name) do update
              set live_tuples = excluded.live_tuples,
                  dead_tuples = excluded.dead_tuples,
                  dead_pct = excluded.dead_pct,
                  last_autovacuum = excluded.last_autovacuum,
                  last_vacuum = excluded.last_vacuum,
                  last_autoanalyze = excluded.last_autoanalyze,
                  last_analyze = excluded.last_analyze,
                  autovacuum_count = excluded.autovacuum_count,
                  analyze_count = excluded.analyze_count,
                  threshold = excluded.threshold,
                  remaining = excluded.remaining,
                  autovacuum_enabled = excluded.autovacuum_enabled,
                  size_bytes = excluded.size_bytes,
                  heap_bytes = excluded.heap_bytes,
                  bloat_bytes = excluded.bloat_bytes,
                  bloat_pct = excluded.bloat_pct,
                  bloat_note = excluded.bloat_note,
                  xid_age = excluded.xid_age,
                  mxid_age = excluded.mxid_age,
                  freeze_max_age = excluded.freeze_max_age,
                  xid_pct = excluded.xid_pct,
                  mxid_pct = excluded.mxid_pct,
                  captured_at = excluded.captured_at`,
          values,
        );
      }

      await client.query(
        `delete from buho.vacuum_tables
          where instance_id = $1 and captured_at < now() - interval '1 minute'`,
        [instanceId],
      );

      await client.query('delete from buho.table_fks where instance_id = $1', [instanceId]);
      if (snapshot.foreignKeys.length > 0) {
        const fkValues: unknown[] = [];
        const fkTuples: string[] = [];
        snapshot.foreignKeys.forEach((fk, index) => {
          const base = index * 6;
          fkTuples.push(
            `(${Array.from({ length: 6 }, (_, offset) => `$${base + offset + 1}`).join(', ')}, now())`,
          );
          fkValues.push(
            instanceId,
            fk.fromSchema,
            fk.fromTable,
            fk.toSchema,
            fk.toTable,
            fk.constraintName,
          );
        });
        await client.query(
          `insert into buho.table_fks
             (instance_id, from_schema, from_table, to_schema, to_table, constraint_name, captured_at)
           values ${fkTuples.join(', ')}`,
          fkValues,
        );
      }

      // El progreso es estado vivo: lo que no está corriendo ahora no existe.
      await client.query('delete from buho.vacuum_progress where instance_id = $1', [instanceId]);

      for (const entry of snapshot.progress) {
        await client.query(
          `insert into buho.vacuum_progress
             (instance_id, pid, kind, schema_name, table_name, phase, heap_blks_total,
              heap_blks_scanned, heap_blks_vacuumed, index_vacuum_count, dead_tuple_bytes,
              max_dead_tuple_bytes, progress_pct, started_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           on conflict (instance_id, pid, kind) do nothing`,
          [
            instanceId,
            entry.pid,
            entry.kind,
            entry.schema,
            entry.table,
            entry.phase,
            entry.heapBlksTotal,
            entry.heapBlksScanned,
            entry.heapBlksVacuumed,
            entry.indexVacuumCount,
            entry.deadTupleBytes,
            entry.maxDeadTupleBytes,
            entry.progressPct,
            entry.startedAt,
          ],
        );
      }

      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveCatalog(instanceId: number, snapshot: CatalogSnapshot): Promise<void> {
    if (snapshot.tables.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const CHUNK = 400;
      for (let start = 0; start < snapshot.tables.length; start += CHUNK) {
        const slice = snapshot.tables.slice(start, start + CHUNK);
        const values: unknown[] = [];
        const tuples: string[] = [];
        slice.forEach((table, rowIndex) => {
          const base = rowIndex * 5;
          tuples.push(`(${Array.from({ length: 5 }, (_, offset) => `$${base + offset + 1}`).join(', ')}, now())`);
          values.push(instanceId, table.schema, table.table, Math.round(table.sizeBytes), table.partitions);
        });
        await client.query(
          `insert into buho.catalog_tables
                (instance_id, schema_name, table_name, size_bytes, partitions, captured_at)
           values ${tuples.join(', ')}
           on conflict (instance_id, schema_name, table_name) do update
                  set size_bytes = excluded.size_bytes,
                      partitions = excluded.partitions,
                      captured_at = excluded.captured_at`,
          values,
        );
      }
      await client.query(
        `delete from buho.catalog_tables
          where instance_id = $1 and captured_at < now() - interval '1 minute'`,
        [instanceId],
      );
      const columns = snapshot.columns ?? [];
      for (let start = 0; start < columns.length; start += CHUNK) {
        const slice = columns.slice(start, start + CHUNK);
        const values: unknown[] = [];
        const tuples: string[] = [];
        slice.forEach((column, rowIndex) => {
          const base = rowIndex * 7;
          tuples.push(`(${Array.from({ length: 7 }, (_, offset) => `$${base + offset + 1}`).join(', ')}, now())`);
          values.push(
            instanceId,
            column.schema,
            column.table,
            column.column,
            column.dataType,
            column.notNull,
            column.position,
          );
        });
        await client.query(
          `insert into buho.catalog_columns
                (instance_id, schema_name, table_name, column_name, data_type, not_null, position, captured_at)
           values ${tuples.join(', ')}
           on conflict (instance_id, schema_name, table_name, column_name) do update
                  set data_type = excluded.data_type,
                      not_null = excluded.not_null,
                      position = excluded.position,
                      captured_at = excluded.captured_at`,
          values,
        );
      }
      if (columns.length > 0) {
        await client.query(
          `delete from buho.catalog_columns
            where instance_id = $1 and captured_at < now() - interval '1 minute'`,
          [instanceId],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveIndexes(instanceId: number, snapshot: IndexSnapshot): Promise<void> {
    // Empty collect is a probe miss, not "the instance has no indexes".
    if (snapshot.indexes.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const CHUNK = 300;
      for (let start = 0; start < snapshot.indexes.length; start += CHUNK) {
        const slice = snapshot.indexes.slice(start, start + CHUNK);
        const values: unknown[] = [];
        const tuples: string[] = [];
        slice.forEach((index, rowIndex) => {
          const base = rowIndex * 17;
          tuples.push(
            `(${Array.from({ length: 17 }, (_, offset) => `$${base + offset + 1}`).join(', ')}, now())`,
          );
          values.push(
            instanceId,
            index.schema,
            index.table,
            index.name,
            Math.round(index.sizeBytes),
            Math.round(index.idxScan),
            Math.round(index.idxTupRead),
            Math.round(index.idxTupFetch),
            index.isPrimary,
            index.isUnique,
            index.isValid,
            index.isPartial,
            index.hasExpression,
            index.columns,
            index.definition,
            index.status,
            index.coveredBy,
          );
        });
        await client.query(
          `insert into buho.index_objects
               (instance_id, schema_name, table_name, index_name, size_bytes, idx_scan,
                idx_tup_read, idx_tup_fetch, is_primary, is_unique, is_valid, is_partial,
                has_expression, columns, definition, status, covered_by, captured_at)
             values ${tuples.join(', ')}
             on conflict (instance_id, schema_name, table_name, index_name) do update
                    set size_bytes = excluded.size_bytes,
                        idx_scan = excluded.idx_scan,
                        idx_tup_read = excluded.idx_tup_read,
                        idx_tup_fetch = excluded.idx_tup_fetch,
                        is_primary = excluded.is_primary,
                        is_unique = excluded.is_unique,
                        is_valid = excluded.is_valid,
                        is_partial = excluded.is_partial,
                        has_expression = excluded.has_expression,
                        columns = excluded.columns,
                        definition = excluded.definition,
                        status = excluded.status,
                        covered_by = excluded.covered_by,
                        captured_at = excluded.captured_at`,
          values,
        );
      }

      await client.query(
        `delete from buho.index_objects
          where instance_id = $1 and captured_at < now() - interval '1 minute'`,
        [instanceId],
      );

      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Desde dónde seguir leyendo el log, si ya se leyó antes. */
  async logCursor(instanceId: number): Promise<string | null> {
    const { rows } = await this.pool.query<{ cursor: string | null }>(
      'select cursor from buho.log_cursors where instance_id = $1',
      [instanceId],
    );
    return rows[0]?.cursor ?? null;
  }

  async saveLogCursor(
    instanceId: number,
    source: string,
    cursor: string | null,
    detail: string,
    warnings: string[],
    entries: number,
  ): Promise<void> {
    await this.pool.query(
      `insert into buho.log_cursors (instance_id, source, cursor, detail, warnings, read_at, entries)
            values ($1, $2, $3, $4, $5::jsonb, now(), $6)
       on conflict (instance_id) do update
          set source = excluded.source,
              cursor = excluded.cursor,
              detail = excluded.detail,
              warnings = excluded.warnings,
              read_at = excluded.read_at,
              entries = buho.log_cursors.entries + excluded.entries`,
      [instanceId, source, cursor, detail, JSON.stringify(warnings), entries],
    );
  }

  /**
   * Guarda entradas del log.
   *
   * `on conflict do nothing` y no un upsert: una entrada de log es un hecho que
   * ya ocurrió y no cambia. El conflicto sólo aparece cuando se relee un tramo
   * tras reiniciar el colector, y ahí lo correcto es descartar.
   */
  async saveLogEntries(instanceId: number, entries: LogEntry[]): Promise<number> {
    if (entries.length === 0) return 0;

    const values: unknown[] = [];
    const tuples: string[] = [];

    entries.forEach((entry, index) => {
      const base = index * 15;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6},` +
          ` $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11},` +
          ` $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15})`,
      );
      values.push(
        instanceId,
        entry.at,
        entry.level,
        entry.kind,
        entry.sqlstate,
        entry.message.slice(0, 8_000),
        entry.detail?.slice(0, 8_000) ?? null,
        entry.hint?.slice(0, 4_000) ?? null,
        entry.query?.slice(0, 8_000) ?? null,
        entry.context?.slice(0, 4_000) ?? null,
        entry.pid,
        entry.username,
        entry.database,
        entry.application,
        entry.fingerprint,
      );
    });

    const { rowCount } = await this.pool.query(
      `insert into buho.log_events
         (instance_id, at, level, kind, sqlstate, message, detail, hint, query,
          context, pid, username, database, application, fingerprint)
       values ${tuples.join(', ')}
       on conflict do nothing`,
      values,
    );
    return rowCount ?? 0;
  }

  async saveCheckResults(instanceId: number, results: CheckResult[], score: number): Promise<void> {
    const ts = new Date();
    for (const result of results) {
      await this.pool.query(
        `insert into buho.check_results
              (instance_id, ts, check_id, title, severity, object, message, remediation, value)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          instanceId,
          ts,
          result.checkId,
          result.title,
          result.severity,
          result.object ?? null,
          result.message,
          result.remediation,
          result.value ?? null,
        ],
      );
    }

    await this.pool.query(
      `insert into buho.health_scores (instance_id, ts, score, critical, warning, info)
            values ($1, $2, $3, $4, $5, $6)
       on conflict (instance_id, ts) do nothing`,
      [
        instanceId,
        ts,
        score,
        results.filter((r) => r.severity === 'critical').length,
        results.filter((r) => r.severity === 'warning').length,
        results.filter((r) => r.severity === 'info').length,
      ],
    );
  }

  async logEvent(
    instanceId: number | null,
    level: 'info' | 'warn' | 'error',
    component: string,
    message: string,
    detail?: unknown,
  ): Promise<void> {
    await this.pool.query(
      `insert into buho.collector_events (instance_id, level, component, message, detail)
            values ($1, $2, $3, $4, $5)`,
      [instanceId, level, component, message, detail === undefined ? null : JSON.stringify(detail)],
    );
  }

  async maintenance(
    retention: RetentionConfig,
  ): Promise<{ created: number; dropped: number; rolled: number; baselines: number }> {
    // Dedicated client + timeouts: a long DELETE must not hold the shared pool
    // forever, and must not abort the whole Node process without releasing.
    const client = await this.pool.connect();
    const started = Date.now();
    try {
      await client.query('set local statement_timeout = 180000');
      await client.query('set local lock_timeout = 30000');

      const parents = [
        'metric_samples',
        'metric_rollup_5m',
        'statement_stats',
        'query_actors',
        'wait_samples',
        'session_samples',
        'log_events',
      ] as const;
      let created = 0;
      for (const parent of parents) {
        try {
          const row = await client.query<{ created: number }>(
            `select buho.ensure_partitions($1, $2) as created`,
            [parent, 3],
          );
          created += Number(row.rows[0]?.created ?? 0);
        } catch (error) {
          await this.logEvent(
            null,
            'error',
            'maintenance',
            `ensure_partitions(${parent}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const rolled = await client.query<{ build_rollups: number }>(
        'select buho.build_rollups($1::interval)',
        ['2 hours'],
      );

      const baselines = await client.query<{ build_baselines: number }>(
        `select case
                  when exists (
                    select 1 from buho.metric_baselines
                     where computed_at > now() - interval '1 hour'
                  ) then 0
                  else buho.build_baselines($1)
                end as build_baselines`,
        [4],
      );

      const dropped = await client.query<{ dropped: number }>(
        `select buho.prune_partitions('metric_samples', $1)
              + buho.prune_partitions('metric_rollup_5m', $2)
              + buho.prune_partitions('statement_stats', $3)
              + buho.prune_partitions('procedure_stats', $3)
              + buho.prune_partitions('query_actors', $3)
              + buho.prune_partitions('wait_samples', $3)
              + buho.prune_partitions('session_samples', $1)
              + buho.prune_partitions('log_events', $4) as dropped`,
        [
          retention.rawDays,
          retention.rollup5mDays,
          retention.statementDays,
          retention.logDays ?? 90,
        ],
      );

      // 1h rollups stay flat (cheap); batch delete so one cycle cannot hang.
      await client.query(
        `delete from buho.metric_rollup_1h
          where ctid in (
            select ctid from buho.metric_rollup_1h
             where bucket < now() - ($1 || ' days')::interval
             limit 50000
          )`,
        [retention.rollup1hDays],
      );
      await client.query(
        `delete from buho.lock_episodes where last_seen_at < now() - ($1 || ' days')::interval`,
        [retention.lockEpisodeDays],
      );
      await client.query(
        `delete from buho.topology_edges where week_start < (current_date - ($1 || ' days')::interval)`,
        [Math.max(retention.rollup1hDays, 180)],
      );
      await client.query(
        `delete from buho.security_posture where captured_at < now() - ($1 || ' days')::interval`,
        [retention.rollup1hDays],
      );
      await client.query(
        `delete from buho.plan_requests where requested_at < now() - ($1 || ' days')::interval`,
        [retention.planDays ?? 90],
      );
      await client.query(
        `delete from buho.check_results where ts < now() - ($1 || ' days')::interval`,
        [retention.checkResultDays ?? 90],
      );
      await client.query(
        `delete from buho.collector_events where ts < now() - ($1 || ' days')::interval`,
        [retention.collectorEventDays ?? 90],
      );
      await client.query(
        `delete from buho.health_scores where ts < now() - ($1 || ' days')::interval`,
        [retention.healthScoreDays ?? 90],
      );
      await client.query(
        `delete from buho.statement_texts t
          where not exists (select 1 from buho.statement_stats s
                             where s.instance_id = t.instance_id and s.queryid = t.queryid)`,
      );

      await this.touchHeartbeat(
        client,
        'maintenance',
        {
          created,
          dropped: Number(dropped.rows[0]?.dropped ?? 0),
          rolled: Number(rolled.rows[0]?.build_rollups ?? 0),
          baselines: Number(baselines.rows[0]?.build_baselines ?? 0),
          durationMs: Date.now() - started,
        },
      );

      return {
        created,
        dropped: Number(dropped.rows[0]?.dropped ?? 0),
        rolled: Number(rolled.rows[0]?.build_rollups ?? 0),
        baselines: Number(baselines.rows[0]?.build_baselines ?? 0),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Records that a collector component finished successfully.
   * Watchdog compares last_ok_at against the expected interval.
   */
  async touchHeartbeat(
    client: { query: Pool['query'] } | null,
    component: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const runner = client ?? this.pool;
    await runner.query(
      `insert into buho.collector_heartbeat (component, last_ok_at, detail, updated_at)
            values ($1, now(), $2::jsonb, now())
       on conflict (component) do update
              set last_ok_at = now(),
                  detail = excluded.detail,
                  updated_at = now()`,
      [component, JSON.stringify(detail)],
    );
  }

  async heartbeatAgeSeconds(component: string): Promise<number | null> {
    const result = await this.pool.query<{ age_seconds: number }>(
      `select extract(epoch from (now() - last_ok_at))::float8 as age_seconds
         from buho.collector_heartbeat
        where component = $1`,
      [component],
    );
    const age = result.rows[0]?.age_seconds;
    return age === undefined || age === null ? null : Number(age);
  }

  /**
   * Instances with no fresh samples: resolve zombie check alerts and keep a
   * single `instance_unreachable` alert firing until data returns.
   */
  async reconcileUnreachableInstances(staleAfterMinutes: number): Promise<{
    marked: number;
    cleared: number;
    resolvedZombies: number;
  }> {
    const minutes = Math.max(2, staleAfterMinutes);
    const stale = await this.pool.query<{ instance_id: string; alias: string }>(
      `select instance_id::text, alias
         from buho.instances
        where last_seen_at is null
           or last_seen_at < now() - ($1 || ' minutes')::interval`,
      [minutes],
    );
    const fresh = await this.pool.query<{ instance_id: string }>(
      `select instance_id::text
         from buho.instances
        where last_seen_at is not null
          and last_seen_at >= now() - ($1 || ' minutes')::interval`,
      [minutes],
    );

    let resolvedZombies = 0;
    let marked = 0;
    for (const row of stale.rows) {
      const instanceId = Number(row.instance_id);
      const zombies = await this.pool.query<{ alert_id: string }>(
        `update buho.alerts
            set status = 'resolved',
                resolved_at = now(),
                updated_at = now(),
                pending_count = 0,
                message = message || ' (auto-resolved: instance unreachable)'
          where instance_id = $1
            and status in ('pending', 'firing')
            and check_id <> 'instance_unreachable'
        returning alert_id::text`,
        [instanceId],
      );
      resolvedZombies += zombies.rowCount ?? 0;

      const existing = await this.pool.query<{ alert_id: string; status: string }>(
        `select alert_id::text, status
           from buho.alerts
          where instance_id = $1 and dedupe_key = 'instance_unreachable'`,
        [instanceId],
      );
      const message =
        `No telemetry from ${row.alias} for more than ${minutes} minutes ` +
        `(last_seen stale or missing). Collector cannot reach the instance or is stuck.`;
      if (!existing.rows[0]) {
        const inserted = await this.pool.query<{ alert_id: string }>(
          `insert into buho.alerts
             (instance_id, dedupe_key, check_id, object, severity, title, message, remediation,
              status, pending_count, fired_at, last_seen_at, updated_at)
           values ($1, 'instance_unreachable', 'instance_unreachable', $2, 'critical',
                   'Instance unreachable', $3,
                   'Verify network/DNS, credentials, and collector logs. Silences do not apply until it is back.',
                   'firing', 1, now(), now(), now())
           returning alert_id::text`,
          [instanceId, row.alias, message],
        );
        await this.enqueueAlertDeliveries(Number(inserted.rows[0]!.alert_id), 'fired', null);
        marked += 1;
      } else if (existing.rows[0].status !== 'firing') {
        await this.pool.query(
          `update buho.alerts
              set status = 'firing', pending_count = 1, fired_at = coalesce(fired_at, now()),
                  resolved_at = null, message = $2, last_seen_at = now(), updated_at = now()
            where alert_id = $1`,
          [existing.rows[0].alert_id, message],
        );
        await this.enqueueAlertDeliveries(Number(existing.rows[0].alert_id), 'fired', null);
        marked += 1;
      } else {
        await this.pool.query(
          `update buho.alerts
              set message = $2, last_seen_at = now(), updated_at = now()
            where alert_id = $1`,
          [existing.rows[0].alert_id, message],
        );
      }
    }

    let cleared = 0;
    for (const row of fresh.rows) {
      const open = await this.pool.query<{ alert_id: string; status: string }>(
        `select alert_id::text, status
           from buho.alerts
          where instance_id = $1
            and dedupe_key = 'instance_unreachable'
            and status in ('pending', 'firing')`,
        [row.instance_id],
      );
      for (const alert of open.rows) {
        await this.pool.query(
          `update buho.alerts
              set status = 'resolved', resolved_at = now(), updated_at = now(), pending_count = 0,
                  message = 'Instance is sending telemetry again.'
            where alert_id = $1`,
          [alert.alert_id],
        );
        if (alert.status === 'firing') {
          await this.enqueueAlertDeliveries(Number(alert.alert_id), 'resolved', null);
        }
        cleared += 1;
      }
    }

    return { marked, cleared, resolvedZombies };
  }

  /**
   * Targets added from the console. Merged with config.json by the collector.
   */
  async listMonitorTargets(enabledOnly = false): Promise<MonitorTargetRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `select target_id, tenant, alias, engine, host, port, database, username, password,
              environment, ssl, tags, host_metrics, enabled, created_at, updated_at, created_by
         from buho.monitor_targets
        where ($1::boolean = false or enabled)
        order by alias`,
      [enabledOnly],
    );
    return result.rows.map(mapMonitorTarget);
  }

  async upsertMonitorTarget(input: MonitorTargetInput): Promise<number> {
    const result = await this.pool.query<{ target_id: string }>(
      `insert into buho.monitor_targets
         (tenant, alias, engine, host, port, database, username, password,
          environment, ssl, tags, host_metrics, enabled, created_by, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14, now())
       on conflict (tenant, alias) do update set
         engine = excluded.engine,
         host = excluded.host,
         port = excluded.port,
         database = excluded.database,
         username = excluded.username,
         password = case when excluded.password = '' then buho.monitor_targets.password
                         else excluded.password end,
         environment = excluded.environment,
         ssl = excluded.ssl,
         tags = excluded.tags,
         host_metrics = excluded.host_metrics,
         enabled = excluded.enabled,
         updated_at = now()
       returning target_id`,
      [
        input.tenant ?? 'default',
        input.alias,
        input.engine,
        input.host,
        input.port,
        input.database ?? '',
        input.username,
        input.password ?? '',
        input.environment ?? 'prod',
        input.ssl ?? false,
        JSON.stringify(input.tags ?? {}),
        JSON.stringify(input.hostMetrics ?? {}),
        input.enabled ?? true,
        input.createdBy ?? null,
      ],
    );
    return Number(result.rows[0]?.target_id);
  }

  async setMonitorTargetEnabled(targetId: number, enabled: boolean): Promise<void> {
    await this.pool.query(
      `update buho.monitor_targets set enabled = $2, updated_at = now() where target_id = $1`,
      [targetId, enabled],
    );
  }

  async deleteMonitorTarget(targetId: number): Promise<void> {
    await this.pool.query(`delete from buho.monitor_targets where target_id = $1`, [targetId]);
  }

  async alertSettings(): Promise<AlertSettings> {
    const result = await this.pool.query<{ value: Partial<AlertSettings> }>(
      "select value from buho.settings where key = 'alerts'",
    );
    const stored = result.rows[0]?.value;
    if (!stored) return { ...ALERT_SETTINGS_DEFAULTS, hysteresis: { ...ALERT_SETTINGS_DEFAULTS.hysteresis } };
    return {
      enabled: stored.enabled ?? ALERT_SETTINGS_DEFAULTS.enabled,
      minSeverity: stored.minSeverity ?? ALERT_SETTINGS_DEFAULTS.minSeverity,
      hysteresis: { ...ALERT_SETTINGS_DEFAULTS.hysteresis, ...(stored.hysteresis ?? {}) },
    };
  }

  async saveAlertSettings(settings: AlertSettings, updatedBy?: string): Promise<void> {
    await this.pool.query(
      `insert into buho.settings (key, value, updated_at, updated_by)
            values ('alerts', $1::jsonb, now(), $2)
       on conflict (key) do update
              set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
      [JSON.stringify(settings), updatedBy ?? null],
    );
  }

  /**
   * Turns the latest check findings into pending/firing/resolved alerts and
   * enqueues webhook deliveries. Safe to call every check cycle.
   */
  async reconcileAlerts(
    instanceId: number,
    results: CheckResult[],
  ): Promise<AlertReconcileSummary> {
    const settings = await this.alertSettings();
    const summary: AlertReconcileSummary = {
      opened: 0,
      fired: 0,
      resolved: 0,
      silenced: 0,
      suppressed: 0,
    };
    if (!settings.enabled) return summary;

    const engineRow = await this.pool.query<{ engine: string }>(
      `select engine from buho.instances where instance_id = $1`,
      [instanceId],
    );
    const engine = engineRow.rows[0]?.engine ?? 'postgres';
    const rules = await this.listAlertRules();
    const definitions = await this.listAlertDefinitions();
    const defByCheckId = new Map(
      definitions.map((def) => [customCheckId(def.name), def] as const),
    );

    const findings = actionableFindings(results, settings);
    const now = new Date();
    const seen = new Set<string>();
    const notifyResolvedByKey = new Map<string, boolean>();
    const channelsByKey = new Map<string, number[] | null>();

    const silences = await this.pool.query<{ instance_id: string | null; check_id: string | null }>(
      `select instance_id::text, check_id
         from buho.alert_silences
        where ends_at > now()
          and starts_at <= now()
          and (instance_id is null or instance_id = $1)`,
      [instanceId],
    );

    const isSilenced = (checkId: string): boolean =>
      silences.rows.some(
        (row) =>
          (row.instance_id === null || Number(row.instance_id) === instanceId) &&
          (row.check_id === null || row.check_id === checkId),
      );

    for (const finding of findings) {
      const key = alertDedupeKey(finding.checkId, finding.object);
      seen.add(key);
      if (isSilenced(finding.checkId)) {
        summary.silenced += 1;
        continue;
      }

      const rule = pickAlertRule(rules, finding, instanceId, engine);
      if (rule?.action === 'suppress') {
        summary.suppressed += 1;
        continue;
      }

      const def = defByCheckId.get(finding.checkId);
      const severity = (rule?.severityOverride ?? finding.severity) as AlertSeverity;
      const threshold =
        rule?.hysteresis ??
        def?.hysteresis ??
        settings.hysteresis[severity] ??
        settings.hysteresis.warning;
      notifyResolvedByKey.set(key, rule?.notifyResolved ?? def?.sendRecovery ?? true);
      channelsByKey.set(
        key,
        rule && rule.channelIds.length > 0
          ? rule.channelIds
          : def && def.channelIds.length > 0
            ? def.channelIds
            : null,
      );

      const existing = await this.pool.query<{
        alert_id: string;
        status: AlertStatus;
        pending_count: number;
      }>(
        `select alert_id::text, status, pending_count
           from buho.alerts
          where instance_id = $1 and dedupe_key = $2`,
        [instanceId, key],
      );

      const row = existing.rows[0];
      if (!row) {
        const pendingCount = 1;
        const fireNow = pendingCount >= threshold;
        const inserted = await this.pool.query<{ alert_id: string }>(
          `insert into buho.alerts
             (instance_id, dedupe_key, check_id, object, severity, title, message, remediation,
              status, pending_count, fired_at, last_seen_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now())
           returning alert_id::text`,
          [
            instanceId,
            key,
            finding.checkId,
            finding.object ?? null,
            severity,
            finding.title,
            finding.message,
            finding.remediation,
            fireNow ? 'firing' : 'pending',
            pendingCount,
            fireNow ? now : null,
          ],
        );
        summary.opened += 1;
        if (fireNow) {
          summary.fired += 1;
          await this.enqueueAlertDeliveries(
            Number(inserted.rows[0]!.alert_id),
            'fired',
            channelsByKey.get(key) ?? null,
          );
        }
        continue;
      }

      const alertId = Number(row.alert_id);
      if (row.status === 'firing') {
        await this.pool.query(
          `update buho.alerts
              set severity = $2, title = $3, message = $4, remediation = $5, object = $6,
                  last_seen_at = now(), updated_at = now(), resolved_at = null
            where alert_id = $1`,
          [alertId, severity, finding.title, finding.message, finding.remediation, finding.object ?? null],
        );
        continue;
      }

      if (row.status === 'resolved') {
        const pendingCount = 1;
        const fireNow = pendingCount >= threshold;
        await this.pool.query(
          `update buho.alerts
              set severity = $2, title = $3, message = $4, remediation = $5, object = $6,
                  status = $7, pending_count = $8, fired_at = $9, resolved_at = null,
                  last_seen_at = now(), updated_at = now()
            where alert_id = $1`,
          [
            alertId,
            severity,
            finding.title,
            finding.message,
            finding.remediation,
            finding.object ?? null,
            fireNow ? 'firing' : 'pending',
            pendingCount,
            fireNow ? now : null,
          ],
        );
        summary.opened += 1;
        if (fireNow) {
          summary.fired += 1;
          await this.enqueueAlertDeliveries(alertId, 'fired', channelsByKey.get(key) ?? null);
        }
        continue;
      }

      const pendingCount = row.pending_count + 1;
      const fireNow = pendingCount >= threshold;
      await this.pool.query(
        `update buho.alerts
            set severity = $2, title = $3, message = $4, remediation = $5, object = $6,
                status = $7, pending_count = $8, fired_at = coalesce(fired_at, $9),
                last_seen_at = now(), updated_at = now()
          where alert_id = $1`,
        [
          alertId,
          severity,
          finding.title,
          finding.message,
          finding.remediation,
          finding.object ?? null,
          fireNow ? 'firing' : 'pending',
          pendingCount,
          fireNow ? now : null,
        ],
      );
      if (fireNow) {
        summary.fired += 1;
        await this.enqueueAlertDeliveries(alertId, 'fired', channelsByKey.get(key) ?? null);
      }
    }

    const open = await this.pool.query<{
      alert_id: string;
      dedupe_key: string;
      status: AlertStatus;
      check_id: string;
      object: string | null;
      severity: AlertSeverity;
      title: string;
      message: string;
    }>(
      `select alert_id::text, dedupe_key, status, check_id, object, severity, title, message
         from buho.alerts
        where instance_id = $1 and status in ('pending', 'firing')`,
      [instanceId],
    );
    for (const row of open.rows) {
      if (seen.has(row.dedupe_key)) continue;

      const finding: CheckResult = {
        checkId: row.check_id,
        title: row.title,
        severity: row.severity,
        object: row.object ?? undefined,
        message: row.message,
        remediation: '',
      };
      const rule = pickAlertRule(rules, finding, instanceId, engine);
      const def = defByCheckId.get(row.check_id);
      const notifyResolved =
        notifyResolvedByKey.get(row.dedupe_key) ??
        rule?.notifyResolved ??
        def?.sendRecovery ??
        true;
      const channelIds =
        channelsByKey.get(row.dedupe_key) ??
        (rule && rule.channelIds.length > 0
          ? rule.channelIds
          : def && def.channelIds.length > 0
            ? def.channelIds
            : null);
      const recoveryMessage = def?.recoveryMessage?.trim() || null;

      await this.pool.query(
        `update buho.alerts
            set status = 'resolved', resolved_at = now(), updated_at = now(), pending_count = 0,
                message = coalesce($2, message)
          where alert_id = $1`,
        [row.alert_id, recoveryMessage],
      );
      if (row.status === 'firing' && notifyResolved) {
        summary.resolved += 1;
        await this.enqueueAlertDeliveries(Number(row.alert_id), 'resolved', channelIds);
      }
    }

    return summary;
  }

  private async enqueueAlertDeliveries(
    alertId: number,
    event: 'fired' | 'resolved',
    channelIds: number[] | null = null,
  ): Promise<void> {
    const channels =
      channelIds && channelIds.length > 0
        ? await this.pool.query<{ channel_id: string }>(
            `select channel_id::text from buho.alert_channels
              where enabled
                and kind in (${ALERT_CHANNEL_KINDS_SQL})
                and channel_id = any($1::bigint[])`,
            [channelIds],
          )
        : await this.pool.query<{ channel_id: string }>(
            `select channel_id::text from buho.alert_channels
              where enabled
                and kind in (${ALERT_CHANNEL_KINDS_SQL})`,
          );
    for (const channel of channels.rows) {
      await this.pool.query(
        `insert into buho.alert_deliveries (alert_id, channel_id, event, status, next_attempt_at)
              values ($1, $2, $3, 'pending', now())`,
        [alertId, channel.channel_id, event],
      );
    }
  }

  async listAlertRules(): Promise<AlertRuleRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `select rule_id, name, enabled, match_check_id, match_instance_id, match_engine,
              match_severities, action, hysteresis, severity_override, channel_ids,
              notify_resolved, priority, updated_at, updated_by
         from buho.alert_rules
        order by priority, rule_id`,
    );
    return result.rows.map(mapAlertRule);
  }

  async upsertAlertRule(input: {
    ruleId?: number;
    name: string;
    enabled: boolean;
    matchCheckId?: string | null;
    matchInstanceId?: number | null;
    matchEngine?: string | null;
    matchSeverities: AlertSeverity[];
    action: 'alert' | 'suppress';
    hysteresis?: number | null;
    severityOverride?: AlertSeverity | null;
    channelIds?: number[];
    notifyResolved?: boolean;
    priority?: number;
    updatedBy?: string;
  }): Promise<number> {
    if (input.ruleId) {
      await this.pool.query(
        `update buho.alert_rules
            set name=$2, enabled=$3, match_check_id=$4, match_instance_id=$5, match_engine=$6,
                match_severities=$7::text[], action=$8, hysteresis=$9, severity_override=$10,
                channel_ids=$11::bigint[], notify_resolved=$12, priority=$13,
                updated_at=now(), updated_by=$14
          where rule_id=$1`,
        [
          input.ruleId,
          input.name,
          input.enabled,
          input.matchCheckId ?? null,
          input.matchInstanceId ?? null,
          input.matchEngine ?? null,
          input.matchSeverities,
          input.action,
          input.hysteresis ?? null,
          input.severityOverride ?? null,
          input.channelIds ?? [],
          input.notifyResolved ?? true,
          input.priority ?? 100,
          input.updatedBy ?? null,
        ],
      );
      return input.ruleId;
    }
    const inserted = await this.pool.query<{ rule_id: string }>(
      `insert into buho.alert_rules
         (name, enabled, match_check_id, match_instance_id, match_engine, match_severities,
          action, hysteresis, severity_override, channel_ids, notify_resolved, priority, updated_by)
       values ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10::bigint[],$11,$12,$13)
       returning rule_id::text`,
      [
        input.name,
        input.enabled,
        input.matchCheckId ?? null,
        input.matchInstanceId ?? null,
        input.matchEngine ?? null,
        input.matchSeverities,
        input.action,
        input.hysteresis ?? null,
        input.severityOverride ?? null,
        input.channelIds ?? [],
        input.notifyResolved ?? true,
        input.priority ?? 100,
        input.updatedBy ?? null,
      ],
    );
    return Number(inserted.rows[0]!.rule_id);
  }

  async deleteAlertRule(ruleId: number): Promise<void> {
    await this.pool.query(`delete from buho.alert_rules where rule_id = $1`, [ruleId]);
  }

  async listAlerts(opts: {
    status?: AlertStatus[];
    limit?: number;
  } = {}): Promise<AlertRow[]> {
    const statuses = opts.status ?? ['pending', 'firing'];
    const limit = opts.limit ?? 200;
    const result = await this.pool.query<Record<string, unknown>>(
      `select a.alert_id, a.instance_id, i.alias, i.engine, a.dedupe_key, a.check_id, a.object,
              a.severity, a.title, a.message, a.remediation, a.status, a.pending_count,
              a.fired_at, a.resolved_at, a.last_seen_at, a.updated_at
         from buho.alerts a
         join buho.instances i using (instance_id)
        where a.status = any($1::text[])
        order by case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end,
                 a.last_seen_at desc
        limit $2`,
      [statuses, limit],
    );
    return result.rows.map(mapAlertRow);
  }

  async listAlertChannels(): Promise<AlertChannelRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `select channel_id, name, kind, config, enabled, created_at, updated_at
         from buho.alert_channels
        order by channel_id`,
    );
    return result.rows.map(mapAlertChannel);
  }

  async alertPackSettings(): Promise<AlertPackConfig> {
    const result = await this.pool.query<{ value: Partial<AlertPackConfig> }>(
      "select value from buho.settings where key = 'alert_pack'",
    );
    return mergeAlertPack(result.rows[0]?.value ?? null);
  }

  async saveAlertPackSettings(pack: AlertPackConfig, updatedBy: string): Promise<void> {
    const merged = mergeAlertPack(pack);
    await this.pool.query(
      `insert into buho.settings (key, value, updated_at, updated_by)
            values ('alert_pack', $1::jsonb, now(), $2)
       on conflict (key) do update
              set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
      [JSON.stringify(merged), updatedBy],
    );
  }

  /** Latest value per metric name (any labels — pack uses unlabeled aggregates). */
  async latestMetrics(
    instanceId: number,
    metrics: string[],
  ): Promise<Record<string, number>> {
    if (metrics.length === 0) return {};
    const result = await this.pool.query<{ metric: string; value: number }>(
      `select distinct on (metric) metric, value
         from buho.metric_samples
        where instance_id = $1
          and metric = any($2::text[])
          and ts > now() - interval '15 minutes'
        order by metric, ts desc`,
      [instanceId, metrics],
    );
    const out: Record<string, number> = {};
    for (const row of result.rows) {
      const value = Number(row.value);
      if (Number.isFinite(value)) out[row.metric] = value;
    }
    return out;
  }

  async upsertAlertChannel(input: {
    channelId?: number;
    name: string;
    kind: AlertChannelKind;
    config: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<number> {
    const enabled = input.enabled ?? true;
    if (input.channelId) {
      await this.pool.query(
        `update buho.alert_channels
            set name = $2, kind = $3, config = $4::jsonb, enabled = $5, updated_at = now()
          where channel_id = $1`,
        [input.channelId, input.name, input.kind, JSON.stringify(input.config), enabled],
      );
      return input.channelId;
    }
    const inserted = await this.pool.query<{ channel_id: string }>(
      `insert into buho.alert_channels (name, kind, config, enabled)
            values ($1, $2, $3::jsonb, $4)
       returning channel_id::text`,
      [input.name, input.kind, JSON.stringify(input.config), enabled],
    );
    return Number(inserted.rows[0]!.channel_id);
  }

  async upsertWebhookChannel(name: string, url: string, enabled = true, channelId?: number): Promise<number> {
    return this.upsertAlertChannel({
      channelId,
      name,
      kind: 'webhook',
      config: { url },
      enabled,
    });
  }

  async deleteAlertChannel(channelId: number): Promise<void> {
    await this.pool.query(`delete from buho.alert_channels where channel_id = $1`, [channelId]);
  }

  /**
   * Fire a one-shot test notification on a channel (does not open an alert row).
   * Used by Admin → Alerts and the Get started wizard.
   */
  async sendChannelTest(channelId: number): Promise<void> {
    const result = await this.pool.query<Record<string, unknown>>(
      `select channel_id, name, kind, config, enabled
         from buho.alert_channels
        where channel_id = $1`,
      [channelId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`channel ${channelId} not found`);
    if (!Boolean(row['enabled'])) throw new Error('channel is disabled');

    const kind = String(row['kind']) as AlertChannelKind;
    const config = (row['config'] ?? {}) as AlertChannelRow['config'];
    const alert: AlertNotifyPayload = {
      alertId: 0,
      instanceId: 0,
      alias: 'buho-test',
      engine: 'postgres',
      checkId: 'buho.channel_test',
      title: 'Búho channel test',
      severity: 'info',
      object: String(row['name'] ?? 'channel'),
      message: `Test notification from Búho at ${new Date().toISOString()}. If you see this, the channel works.`,
      remediation: 'No action required — delete this message.',
      firedAt: new Date(),
      resolvedAt: null,
    };

    if (kind === 'smtp') {
      await deliverSmtp(config, 'fired', alert);
      return;
    }

    const delivery = resolveChannelDelivery(kind, config, 'fired', alert);
    const response = await fetch(delivery.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...delivery.headers },
      body: JSON.stringify(delivery.body),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`channel test HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
  }

  async listAlertDefinitions(): Promise<CustomAlertDefinition[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `select definition_id, name, title, enabled, match_instance_id, match_engine, severity,
              sql, threshold_type, threshold, message_template, remediation, recovery_message,
              send_recovery, cooldown_minutes, display_columns, hysteresis, channel_ids
         from buho.alert_definitions
        order by name`,
    );
    return result.rows.map(mapAlertDefinition);
  }

  async listAlertDefinitionsFor(
    instanceId: number,
    engine: string,
  ): Promise<CustomAlertDefinition[]> {
    const all = await this.listAlertDefinitions();
    return all.filter((def) => {
      if (!def.enabled) return false;
      if (def.matchInstanceId != null && def.matchInstanceId !== instanceId) return false;
      if (def.matchEngine && def.matchEngine !== engine) return false;
      if (def.matchInstanceId == null && !def.matchEngine) return false;
      return true;
    });
  }

  async upsertAlertDefinition(input: {
    definitionId?: number;
    name: string;
    title: string;
    enabled: boolean;
    matchInstanceId?: number | null;
    matchEngine?: string | null;
    severity: AlertSeverity;
    sql: string;
    thresholdType: CustomThresholdType;
    threshold?: Record<string, unknown>;
    messageTemplate: string;
    remediation?: string;
    recoveryMessage?: string | null;
    sendRecovery?: boolean;
    cooldownMinutes?: number;
    displayColumns?: string[];
    hysteresis?: number | null;
    channelIds?: number[];
    updatedBy?: string;
  }): Promise<number> {
    const name = input.name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    if (!name) throw new Error('alert definition name required');
    if (!input.matchInstanceId && !input.matchEngine) {
      throw new Error('alert definition needs match_instance_id or match_engine');
    }
    const params = [
      name,
      input.title.trim() || name,
      input.enabled,
      input.matchInstanceId ?? null,
      input.matchEngine ?? null,
      input.severity,
      input.sql,
      input.thresholdType,
      JSON.stringify(input.threshold ?? {}),
      input.messageTemplate,
      input.remediation ?? '',
      input.recoveryMessage ?? null,
      input.sendRecovery ?? true,
      input.cooldownMinutes ?? 0,
      input.displayColumns ?? [],
      input.hysteresis ?? null,
      input.channelIds ?? [],
      input.updatedBy ?? null,
    ];
    if (input.definitionId) {
      await this.pool.query(
        `update buho.alert_definitions
            set name=$2, title=$3, enabled=$4, match_instance_id=$5, match_engine=$6,
                severity=$7, sql=$8, threshold_type=$9, threshold=$10::jsonb,
                message_template=$11, remediation=$12, recovery_message=$13,
                send_recovery=$14, cooldown_minutes=$15, display_columns=$16::text[],
                hysteresis=$17, channel_ids=$18::bigint[], updated_at=now(), updated_by=$19
          where definition_id=$1`,
        [input.definitionId, ...params],
      );
      return input.definitionId;
    }
    const inserted = await this.pool.query<{ definition_id: string }>(
      `insert into buho.alert_definitions
         (name, title, enabled, match_instance_id, match_engine, severity, sql, threshold_type,
          threshold, message_template, remediation, recovery_message, send_recovery,
          cooldown_minutes, display_columns, hysteresis, channel_ids, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::text[],$16,$17::bigint[],$18)
       returning definition_id::text`,
      params,
    );
    return Number(inserted.rows[0]!.definition_id);
  }

  async deleteAlertDefinition(definitionId: number): Promise<void> {
    await this.pool.query(`delete from buho.alert_definitions where definition_id = $1`, [
      definitionId,
    ]);
  }

  async createAlertSilence(input: {
    instanceId?: number | null;
    checkId?: string | null;
    reason: string;
    hours: number;
    createdBy?: string;
  }): Promise<number> {
    const result = await this.pool.query<{ silence_id: string }>(
      `insert into buho.alert_silences (instance_id, check_id, reason, ends_at, created_by)
            values ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)
       returning silence_id::text`,
      [
        input.instanceId ?? null,
        input.checkId ?? null,
        input.reason,
        String(Math.max(1, Math.min(168, input.hours))),
        input.createdBy ?? null,
      ],
    );
    return Number(result.rows[0]!.silence_id);
  }

  async listActiveSilences(): Promise<
    Array<{
      silenceId: number;
      instanceId: number | null;
      alias: string | null;
      checkId: string | null;
      reason: string;
      startsAt: Date;
      endsAt: Date;
      createdBy: string | null;
    }>
  > {
    const result = await this.pool.query<Record<string, unknown>>(
      `select s.silence_id, s.instance_id, i.alias, s.check_id, s.reason,
              s.starts_at, s.ends_at, s.created_by
         from buho.alert_silences s
         left join buho.instances i using (instance_id)
        where s.ends_at > now()
        order by s.ends_at`,
    );
    return result.rows.map((row) => ({
      silenceId: Number(row['silence_id']),
      instanceId: row['instance_id'] == null ? null : Number(row['instance_id']),
      alias: (row['alias'] as string | null) ?? null,
      checkId: (row['check_id'] as string | null) ?? null,
      reason: String(row['reason']),
      startsAt: row['starts_at'] as Date,
      endsAt: row['ends_at'] as Date,
      createdBy: (row['created_by'] as string | null) ?? null,
    }));
  }

  /** Claim and send pending alert deliveries (webhook / Slack / Teams / Telegram / Rocket.Chat). */
  async flushAlertDeliveries(limit = 20): Promise<{ sent: number; failed: number }> {
    const client = await this.pool.connect();
    let sent = 0;
    let failed = 0;
    try {
      await client.query('begin');
      const jobs = await client.query<Record<string, unknown>>(
        `select d.delivery_id, d.alert_id, d.channel_id, d.event, d.attempts,
                c.kind, c.config, a.instance_id, i.alias, i.engine, a.check_id, a.object,
                a.severity, a.title, a.message, a.remediation, a.fired_at, a.resolved_at
           from buho.alert_deliveries d
           join buho.alert_channels c using (channel_id)
           join buho.alerts a using (alert_id)
           join buho.instances i using (instance_id)
          where d.status = 'pending'
            and d.next_attempt_at <= now()
            and c.enabled
            and c.kind in (${ALERT_CHANNEL_KINDS_SQL})
          order by d.delivery_id
          limit $1
          for update of d skip locked`,
        [limit],
      );

      for (const row of jobs.rows) {
        const deliveryId = Number(row['delivery_id']);
        const attempts = Number(row['attempts']) + 1;
        const kind = String(row['kind']) as AlertChannelKind;
        const config = (row['config'] ?? {}) as AlertChannelRow['config'];
        const event = row['event'] as 'fired' | 'resolved';
        const alert = {
          alertId: Number(row['alert_id']),
          instanceId: Number(row['instance_id']),
          alias: String(row['alias']),
          engine: String(row['engine']),
          checkId: String(row['check_id']),
          object: (row['object'] as string | null) ?? null,
          severity: String(row['severity']),
          title: String(row['title']),
          message: String(row['message']),
          remediation: String(row['remediation']),
          firedAt: (row['fired_at'] as Date | null) ?? null,
          resolvedAt: (row['resolved_at'] as Date | null) ?? null,
        };

        try {
          if (kind === 'smtp') {
            await deliverSmtp(config, event, alert);
          } else {
            const delivery = resolveChannelDelivery(kind, config, event, alert);
            const response = await fetch(delivery.url, {
              method: 'POST',
              headers: {
                'user-agent': 'buho-alerts/0.5',
                ...delivery.headers,
              },
              body: JSON.stringify(delivery.body),
              signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
          }
          await client.query(
            `update buho.alert_deliveries
                set status = 'sent', attempts = $2, last_error = null, sent_at = now()
              where delivery_id = $1`,
            [deliveryId, attempts],
          );
          sent += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const backoffMinutes = Math.min(60, 2 ** Math.min(attempts, 5));
          const terminal = attempts >= 8;
          await client.query(
            `update buho.alert_deliveries
                set status = $2, attempts = $3, last_error = $4,
                    next_attempt_at = now() + ($5 || ' minutes')::interval
              where delivery_id = $1`,
            [
              deliveryId,
              terminal ? 'failed' : 'pending',
              attempts,
              message.slice(0, 500),
              String(backoffMinutes),
            ],
          );
          failed += 1;
        }
      }

      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    return { sent, failed };
  }

}

export {
  ALERT_CHANNEL_KINDS,
  ALERT_SETTINGS_DEFAULTS,
  type AlertChannelKind,
  type AlertChannelRow,
  type AlertRuleRow,
  type AlertDeliveryJob,
  type AlertReconcileSummary,
  type AlertRow,
  type AlertSettings,
  type AlertSeverity,
  type AlertStatus,
};

function mapAlertRow(row: Record<string, unknown>): AlertRow {
  return {
    alertId: Number(row['alert_id']),
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    engine: String(row['engine']),
    dedupeKey: String(row['dedupe_key']),
    checkId: String(row['check_id']),
    object: (row['object'] as string | null) ?? null,
    severity: row['severity'] as AlertSeverity,
    title: String(row['title']),
    message: String(row['message']),
    remediation: String(row['remediation']),
    status: row['status'] as AlertStatus,
    pendingCount: Number(row['pending_count']),
    firedAt: (row['fired_at'] as Date | null) ?? null,
    resolvedAt: (row['resolved_at'] as Date | null) ?? null,
    lastSeenAt: row['last_seen_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}


async function deliverSmtp(
  config: AlertChannelRow['config'],
  event: 'fired' | 'resolved',
  alert: Parameters<typeof smtpMailContent>[1],
): Promise<void> {
  const host = (config.host ?? '').trim();
  const from = (config.from ?? '').trim();
  const to = (config.to ?? '').trim();
  if (!host || !from || !to) {
    throw new Error('smtp needs host, from, and to');
  }
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host,
    port: Number(config.port ?? (config.secure ? 465 : 587)),
    secure: Boolean(config.secure),
    auth: config.user
      ? { user: config.user, pass: config.pass ?? '' }
      : undefined,
  });
  const mail = smtpMailContent(event, alert);
  await transporter.sendMail({ from, to, subject: mail.subject, text: mail.text });
}

function mapAlertChannel(row: Record<string, unknown>): AlertChannelRow {
  const rawKind = String(row['kind'] ?? 'webhook');
  const kind = (isAlertChannelKind(rawKind) ? rawKind : 'webhook') as AlertChannelKind;
  return {
    channelId: Number(row['channel_id']),
    name: String(row['name']),
    kind,
    config: (row['config'] as AlertChannelRow['config']) ?? {},
    enabled: Boolean(row['enabled']),
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

function mapAlertDefinition(row: Record<string, unknown>): CustomAlertDefinition {
  return {
    definitionId: Number(row['definition_id']),
    name: String(row['name']),
    title: String(row['title']),
    enabled: Boolean(row['enabled']),
    matchInstanceId:
      row['match_instance_id'] == null ? null : Number(row['match_instance_id']),
    matchEngine: (row['match_engine'] as string | null) ?? null,
    severity: row['severity'] as CustomAlertDefinition['severity'],
    sql: String(row['sql']),
    thresholdType: row['threshold_type'] as CustomThresholdType,
    threshold: (row['threshold'] as Record<string, unknown>) ?? {},
    messageTemplate: String(row['message_template']),
    remediation: String(row['remediation'] ?? ''),
    recoveryMessage: (row['recovery_message'] as string | null) ?? null,
    sendRecovery: Boolean(row['send_recovery']),
    cooldownMinutes: Number(row['cooldown_minutes'] ?? 0),
    displayColumns: (row['display_columns'] as string[]) ?? [],
    hysteresis: row['hysteresis'] == null ? null : Number(row['hysteresis']),
    channelIds: ((row['channel_ids'] as Array<string | number>) ?? []).map(Number),
  };
}


export interface MonitorTargetInput {
  tenant?: string;
  alias: string;
  engine: string;
  host: string;
  port: number;
  database?: string;
  username: string;
  password?: string;
  environment?: string;
  ssl?: boolean;
  tags?: Record<string, string>;
  hostMetrics?: Record<string, unknown>;
  enabled?: boolean;
  createdBy?: string | null;
}

export interface MonitorTargetRow {
  targetId: number;
  tenant: string;
  alias: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  environment: string;
  ssl: boolean;
  tags: Record<string, string>;
  hostMetrics: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

function mapMonitorTarget(row: Record<string, unknown>): MonitorTargetRow {
  const tags = row['tags'];
  const hostMetrics = row['host_metrics'];
  return {
    targetId: Number(row['target_id']),
    tenant: String(row['tenant']),
    alias: String(row['alias']),
    engine: String(row['engine']),
    host: String(row['host']),
    port: Number(row['port']),
    database: String(row['database'] ?? ''),
    username: String(row['username']),
    password: String(row['password'] ?? ''),
    environment: String(row['environment'] ?? 'prod'),
    ssl: Boolean(row['ssl']),
    tags:
      tags && typeof tags === 'object' && !Array.isArray(tags)
        ? (tags as Record<string, string>)
        : {},
    hostMetrics:
      hostMetrics && typeof hostMetrics === 'object' && !Array.isArray(hostMetrics)
        ? (hostMetrics as Record<string, unknown>)
        : {},
    enabled: Boolean(row['enabled']),
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
    createdBy: (row['created_by'] as string | null) ?? null,
  };
}

function mapAlertRule(row: Record<string, unknown>): AlertRuleRow {
  return {
    ruleId: Number(row['rule_id']),
    name: String(row['name']),
    enabled: Boolean(row['enabled']),
    matchCheckId: (row['match_check_id'] as string | null) ?? null,
    matchInstanceId: row['match_instance_id'] == null ? null : Number(row['match_instance_id']),
    matchEngine: (row['match_engine'] as string | null) ?? null,
    matchSeverities: ((row['match_severities'] as string[]) ?? []).map((s) => s as AlertSeverity),
    action: row['action'] as 'alert' | 'suppress',
    hysteresis: row['hysteresis'] == null ? null : Number(row['hysteresis']),
    severityOverride: (row['severity_override'] as AlertSeverity | null) ?? null,
    channelIds: ((row['channel_ids'] as Array<string | number>) ?? []).map(Number),
    notifyResolved: Boolean(row['notify_resolved']),
    priority: Number(row['priority'] ?? 100),
    updatedAt: row['updated_at'] as Date,
    updatedBy: (row['updated_by'] as string | null) ?? null,
  };
}
