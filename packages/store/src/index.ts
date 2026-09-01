import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type {
  BloatMeasurement,
  LogEntry,
  VacuumSnapshot,
  BlockedSession,
  Capabilities,
  InstanceConfig,
  InventorySnapshot,
  Sample,
  SecurityAudit,
  StatementDelta,
} from '@buho/core';
import type { CheckResult } from '@buho/checks';

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
    this.pool = new Pool({
      connectionString: url,
      application_name: 'buho_store',
      max: 4,
      connectionTimeoutMillis: 10_000,
      options: `-c timezone=${storeTimeZone()}`,
    });
  }

  async migrate(): Promise<void> {
    const schema = await readFile(SCHEMA_PATH, 'utf8');
    await this.pool.query(schema);
    await this.pool.query(
      `select buho.ensure_partitions('metric_samples', $1),
              buho.ensure_partitions('statement_stats', $1),
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
            values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (tenant, alias) do update
              set host         = excluded.host,
                  port         = excluded.port,
                  database     = excluded.database,
                  environment  = excluded.environment,
                  engine       = excluded.engine,
                  last_seen_at = now()
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
                 auth_method, password_set_at, expires_at, privileges, captured_at)
                values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
           on conflict (instance_id, name, host) do update
                  set kind = excluded.kind, can_login = excluded.can_login,
                      is_superuser = excluded.is_superuser, disabled = excluded.disabled,
                      auth_method = excluded.auth_method,
                      password_set_at = excluded.password_set_at,
                      expires_at = excluded.expires_at, privileges = excluded.privileges,
                      captured_at = now()`,
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
        deltas.map((d) => d.queryid),
        deltas.map((d) => d.query),
        deltas.map((d) => d.truncated),
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

  /**
   * Guarda el estado de vacuum.
   *
   * Se borra lo que ya no aparece: una tabla que se dejó de reportar es una
   * tabla que se borró o que salió del top, y dejarla ahí mostraría un
   * "último autovacuum" congelado en el tiempo como si fuera actual.
   */
  /**
   * Guarda las observaciones de qué aplicación ejecutaba qué consulta.
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
    const created = await this.pool.query<{ created: number }>(
      `select buho.ensure_partitions('metric_samples', $1)
            + buho.ensure_partitions('statement_stats', $1)
            + buho.ensure_partitions('query_actors', $1)
            + buho.ensure_partitions('wait_samples', $1)
            + buho.ensure_partitions('session_samples', $1)
            + buho.ensure_partitions('log_events', $1) as created`,
      [3],
    );
    const rolled = await this.pool.query<{ build_rollups: number }>('select buho.build_rollups($1::interval)', [
      '2 hours',
    ]);

    // Las líneas base se recalculan una vez por hora y no en cada vuelta de
    // mantenimiento: describen semanas de historia, así que rehacerlas cada 15
    // minutos gasta lo mismo y no cambia el resultado.
    const baselines = await this.pool.query<{ build_baselines: number }>(
      `select case
                when exists (
                  select 1 from buho.metric_baselines
                   where computed_at > now() - interval '1 hour'
                ) then 0
                else buho.build_baselines($1)
              end as build_baselines`,
      [4],
    );
    const dropped = await this.pool.query<{ dropped: number }>(
      `select buho.prune_partitions('metric_samples', $1)
            + buho.prune_partitions('statement_stats', $2)
            + buho.prune_partitions('query_actors', $2)
            + buho.prune_partitions('wait_samples', $2)
            + buho.prune_partitions('session_samples', $1)
            + buho.prune_partitions('log_events', $3) as dropped`,
      [retention.rawDays, retention.statementDays, retention.logDays],
    );

    await this.pool.query('delete from buho.metric_rollup_5m where bucket < now() - ($1 || \' days\')::interval', [
      retention.rollup5mDays,
    ]);
    await this.pool.query('delete from buho.metric_rollup_1h where bucket < now() - ($1 || \' days\')::interval', [
      retention.rollup1hDays,
    ]);
    await this.pool.query('delete from buho.lock_episodes where last_seen_at < now() - ($1 || \' days\')::interval', [
      retention.lockEpisodeDays,
    ]);
    await this.pool.query(
      `delete from buho.topology_edges where week_start < (current_date - ($1 || ' days')::interval)`,
      [Math.max(retention.rollup1hDays, 180)],
    );
    await this.pool.query(
      `delete from buho.security_posture where captured_at < now() - ($1 || ' days')::interval`,
      [retention.rollup1hDays],
    );
    await this.pool.query(
      `delete from buho.plan_requests where requested_at < now() - ($1 || ' days')::interval`,
      [retention.planDays ?? 60],
    );
    // Un texto sin deltas ya no le sirve a nadie.
    await this.pool.query(
      `delete from buho.statement_texts t
        where not exists (select 1 from buho.statement_stats s
                           where s.instance_id = t.instance_id and s.queryid = t.queryid)`,
    );

    return {
      created: Number(created.rows[0]?.created ?? 0),
      dropped: Number(dropped.rows[0]?.dropped ?? 0),
      rolled: Number(rolled.rows[0]?.build_rollups ?? 0),
      baselines: Number(baselines.rows[0]?.build_baselines ?? 0),
    };
  }
}
