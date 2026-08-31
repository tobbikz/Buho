/**
 * buho-collector — proceso de recolección.
 *
 * Corre aparte de la UI a propósito: un scheduler de larga vida no sobrevive
 * los reloads ni el ciclo de vida de Next.js.
 *
 * Cada instancia monitoreada tiene su propio pool, sus propios timeouts y su
 * propio manejo de errores: una instancia enferma no puede tumbar el ciclo de
 * las demás.
 */
import { runChecks } from '@buho/checks';
import {
  capabilityWarnings,
  auditSecurity,
  collectInventory,
  collectorsFor,
  createPool,
  engineOf,
  ENGINE_LABEL,
  openEngine,
  postgresClient,
  DeltaEngine,
  instanceKey,
  loadConfig,
  probeCapabilities,
  HostTracker,
  readHostSnapshot,
  inspectLogging,
  readLog,
  sampleVacuum,
  vacuumSamples,
  runCollectors,
  sampleBlocking,
  sampleStatements,
  StatementTracker,
  runExplain,
} from '@buho/core';
import type { Capabilities, InstanceConfig, Tier } from '@buho/core';
import { Store } from '@buho/store';
import type { Pool } from 'pg';

const TIER_INTERVAL_MS: Record<Tier, number> = {
  fast: 10_000,
  normal: 60_000,
  slow: 300_000,
  hourly: 3_600_000,
};

const CHECKS_INTERVAL_MS = 300_000;
// Los bloqueos se muestrean al ritmo del tier rápido: un bloqueo que dura diez
// segundos y no se ve es un incidente que nadie puede explicar después.
const LOCKS_INTERVAL_MS = 10_000;
const STATEMENTS_INTERVAL_MS = 60_000;
// 30 s: la CPU necesita dos lecturas para dar un porcentaje, y con intervalos
// más largos el primer dato tarda demasiado en aparecer.
const HOST_INTERVAL_MS = 30_000;
// El log se lee cada minuto: journald y los archivos guardan lo ocurrido, así
// que leer más seguido no adelanta nada y sí multiplica los procesos de lectura.
const LOG_INTERVAL_MS = 60_000;
// El vacuum es lento por naturaleza: el estado por tabla cambia en minutos. Lo
// que sí es rápido es un vacuum en curso, y por eso el progreso viaja en el
// mismo ciclo en vez de en uno propio: a los dos minutos sigue siendo útil
// saber que hay uno corriendo y en qué fase.
const VACUUM_INTERVAL_MS = 120_000;
const REPROBE_INTERVAL_MS = 3_600_000;
// El inventario del parque cambia de mes en mes, no de minuto en minuto: una
// versión de motor, una edición o un modelo de recuperación no se mueven. Cada
// hora es más que suficiente y mantiene el costo en el servidor monitoreado
// cerca de cero.
const INVENTORY_INTERVAL_MS = 3_600_000;
// La postura de seguridad cambia por una edición manual, no de forma continua.
const SECURITY_INTERVAL_MS = 21_600_000;
const MAINTENANCE_INTERVAL_MS = 900_000;
// La cola de EXPLAIN se revisa cada segundo: es una consulta a un índice parcial
// que sólo contiene los pendientes, y del otro lado hay una persona esperando
// que el plan aparezca en la pantalla.
const PLAN_QUEUE_INTERVAL_MS = 1_000;

const config = await loadConfig();
const store = new Store(config.store.url);
const deltas = new DeltaEngine();

let stopping = false;
const timers = new Set<NodeJS.Timeout>();
const pools: Pool[] = [];

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const stamp = new Date().toISOString();
  console.log(`${stamp} ${level.toUpperCase().padEnd(5)} ${message}`);
}

/** Jitter para que N instancias no golpeen sus servidores en el mismo instante. */
function jitter(intervalMs: number): number {
  return intervalMs * (0.9 + Math.random() * 0.2);
}

function startLoop(name: string, intervalMs: number, task: () => Promise<void>): void {
  const schedule = (delay: number) => {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (stopping) return;
      try {
        await task();
      } catch (error) {
        log('error', `${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!stopping) schedule(jitter(intervalMs));
    }, delay);
    timers.add(timer);
  };
  // Arranque escalonado para no abrir todas las conexiones a la vez.
  schedule(Math.random() * Math.min(intervalMs, 5_000));
}

/**
 * Inventario del parque para cualquier motor.
 *
 * Se abre y se cierra una conexión por lectura en vez de mantener un pool vivo
 * una hora: a este ritmo el costo de conectar es irrelevante y evita todo el
 * problema de conexiones que se mueren calladas entre corridas.
 */
function startInventoryLoop(instance: InstanceConfig, instanceId: number, pool?: Pool): void {
  startLoop(`${instance.alias}/inventario`, INVENTORY_INTERVAL_MS, async () => {
    // En PostgreSQL se reutiliza el pool que ya existe; en los otros motores se
    // abre una conexión dedicada y se cierra al terminar.
    const client = pool ? postgresClient(pool) : await openEngine(instance, {
      statementTimeoutMs: config.collector.statementTimeoutMs,
      connectTimeoutMs: config.collector.connectTimeoutMs,
    });

    try {
      const snapshot = await collectInventory(client);
      await store.saveInventory(instanceId, snapshot);

      const problems = snapshot.notes.filter((note) => note.level !== 'info');
      log(
        'info',
        `${instance.alias}/inventario: ${snapshot.settings.length} parámetros, ` +
          `${snapshot.disks.length} objetos de disco, ${snapshot.backups.length} backups, ` +
          `${snapshot.jobs.length} jobs, ${problems.length} hallazgo(s)`,
      );
      for (const note of problems) {
        await store.logEvent(instanceId, note.level, `inventario:${note.domain}`, note.message);
      }
    } finally {
      if (!pool) await client.close().catch(() => {});
    }
  });
}

/**
 * Auditoría de seguridad para cualquier motor.
 *
 * Va cada 6 horas y no cada minuto porque la postura de seguridad cambia cuando
 * alguien edita un archivo de configuración o crea una cuenta, no de forma
 * continua. Además algunas comprobaciones son caras: la de contraseñas de
 * diccionario en SQL Server hace doce comparaciones criptográficas por login.
 */
function startSecurityLoop(instance: InstanceConfig, instanceId: number, pool?: Pool): void {
  startLoop(`${instance.alias}/seguridad`, SECURITY_INTERVAL_MS, async () => {
    const client = pool ? postgresClient(pool) : await openEngine(instance, {
      statementTimeoutMs: config.collector.statementTimeoutMs,
      connectTimeoutMs: config.collector.connectTimeoutMs,
    });

    try {
      const audit = await auditSecurity(client);
      await store.saveSecurity(instanceId, audit);

      const critical = audit.findings.filter((finding) => finding.severity === 'critica');
      const high = audit.findings.filter((finding) => finding.severity === 'alta');
      const blind = audit.findings.filter((finding) => finding.severity === 'no_verificable');

      log(
        'info',
        `${instance.alias}/seguridad: postura ${audit.score}/100, ` +
          `${critical.length} crítica(s), ${high.length} alta(s), ` +
          `${audit.verified}/${audit.total} comprobaciones verificadas`,
      );

      for (const finding of [...critical, ...high]) {
        await store.logEvent(
          instanceId,
          finding.severity === 'critica' ? 'error' : 'warn',
          `seguridad:${finding.category}`,
          finding.title,
        );
      }
      // Los puntos ciegos se registran una sola vez y agrupados: son
      // información para quien administra Búho, no una alarma por instancia.
      if (blind.length > 0) {
        await store.logEvent(
          instanceId,
          'info',
          'seguridad:cobertura',
          `${blind.length} comprobación(es) sin permisos suficientes: ${blind
            .map((finding) => finding.checkId)
            .join(', ')}`,
        );
      }
    } finally {
      if (!pool) await client.close().catch(() => {});
    }
  });
}

/**
 * MariaDB y SQL Server entran sólo por el inventario. El pipeline de métricas de
 * 5 s y los 22 checks son de PostgreSQL, y forzar sus vistas de estadísticas a
 * un molde común terminaría mintiendo sobre lo que mide cada motor.
 */
/**
 * Atiende los encargos de EXPLAIN que deja la consola.
 *
 * Está acá y no en la web porque el colector es el único proceso con
 * credenciales de las instancias monitoreadas. Ver el comentario de
 * `plan_requests` en el schema: la consola no se conecta a la base del cliente,
 * ni para esto.
 *
 * Se atiende un encargo por vuelta a propósito. Un EXPLAIN ANALYZE ejecuta la
 * consulta de verdad, y dejar que se acumulen en paralelo convertiría un botón
 * de la interfaz en una forma de cargar la base del cliente.
 */
function startPlanQueueLoop(instance: InstanceConfig, instanceId: number, pool: Pool): void {
  startLoop(`${instance.alias}/planes`, PLAN_QUEUE_INTERVAL_MS, async () => {
    const job = await store.claimPlanRequest(instanceId);
    if (!job) return;

    const started = Date.now();
    try {
      const report = await runExplain(pool, job.sql, {
        analyze: job.mode === 'analyze',
        genericPlan: job.mode === 'generic',
        timeoutMs: config.collector.statementTimeoutMs * 3,
      });

      await store.finishPlanRequest(job.requestId, {
        plan: report.root,
        planText: report.text,
        findings: report.findings,
        planningMs: report.planningMs,
        executionMs: report.executionMs,
        totalCost: report.totalCost,
      });

      const critical = report.findings.filter((finding) => finding.severity === 'critica').length;
      log(
        'info',
        `${instance.alias}/planes: ${job.mode} para ${job.requestedBy} en ${Date.now() - started} ms, ` +
          `${report.findings.length} hallazgo(s)${critical > 0 ? `, ${critical} crítico(s)` : ''}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.failPlanRequest(job.requestId, message);
      log('warn', `${instance.alias}/planes: ${job.mode} falló: ${message}`);
    }
  });
}

/**
 * Lectura del log del servidor.
 *
 * Sólo corre si la instancia lo declara: leer journald o archivos del servidor
 * sin que nadie lo haya pedido sería una sorpresa desagradable, igual que con
 * las métricas de host.
 *
 * La inspección se hace en cada vuelta y no una sola vez al arrancar, porque
 * `log_destination` y `log_lock_waits` se recargan con SIGHUP: un DBA puede
 * encender el log de esperas de bloqueo a mediodía y Búho tiene que darse cuenta
 * sin reiniciarse.
 */
function startLogLoop(instance: InstanceConfig, instanceId: number, pool: Pool): void {
  const logConfig = instance.logs;
  if (!logConfig?.source || logConfig.source === 'none') return;

  startLoop(`${instance.alias}/logs`, LOG_INTERVAL_MS, async () => {
    const info = await inspectLogging(pool, logConfig);
    const cursor = await store.logCursor(instanceId);
    const result = await readLog(logConfig, info, cursor);

    const written = await store.saveLogEntries(instanceId, result.entries);
    await store.saveLogCursor(
      instanceId,
      result.source,
      result.cursor,
      result.detail,
      // Las limitaciones de configuración importan tanto como los fallos de
      // lectura: una pantalla sin deadlocks porque log_lock_waits está apagado
      // no es lo mismo que una sin deadlocks.
      [...result.warnings, ...info.limitations],
      written,
    );

    if (result.entries.length === 0) return;

    const errors = result.entries.filter(
      (entry) => entry.kind === 'error' || entry.kind === 'fatal' || entry.kind === 'deadlock',
    ).length;
    log(
      'info',
      `${instance.alias}/logs: ${written} entrada(s) de ${result.detail}` +
        (errors > 0 ? `, ${errors} con severidad de error` : ''),
    );
  });
}

async function monitorInventoryOnly(instance: InstanceConfig): Promise<void> {
  const engine = engineOf(instance);
  const instanceId = await store.upsertInstance(instance);
  log('info', `${instance.alias} (${ENGINE_LABEL[engine]}): inventario y seguridad del parque`);
  startInventoryLoop(instance, instanceId);
  startSecurityLoop(instance, instanceId);
}

async function monitorInstance(instance: InstanceConfig): Promise<void> {
  if (engineOf(instance) !== 'postgres') {
    await monitorInventoryOnly(instance);
    return;
  }

  const key = instanceKey(instance);
  const pool = createPool(instance, {
    statementTimeoutMs: config.collector.statementTimeoutMs,
    connectTimeoutMs: config.collector.connectTimeoutMs,
  });
  pools.push(pool);

  pool.on('error', (error) => log('warn', `${instance.alias}: error de pool: ${error.message}`));

  const instanceId = await store.upsertInstance(instance);
  let caps: Capabilities;

  try {
    caps = await probeCapabilities(pool);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', `${instance.alias}: no se pudo hacer el probe inicial: ${message}`);
    await store.logEvent(instanceId, 'error', 'capability_probe', message);
    // Se reintenta el probe en el próximo ciclo en vez de abandonar la instancia.
    startLoop(`${instance.alias}/reprobe`, 60_000, async () => {
      caps = await probeCapabilities(pool);
      await store.saveCapabilities(instanceId, caps);
      log('info', `${instance.alias}: probe recuperado`);
    });
    return;
  }

  await store.saveCapabilities(instanceId, caps);
  log(
    'info',
    `${instance.alias} (${key}): PostgreSQL ${caps.versionNum}, ${caps.inRecovery ? 'standby' : 'primary'}, ` +
      `pg_stat_statements=${caps.statStatements}`,
  );
  for (const warning of capabilityWarnings(caps)) {
    log('warn', `${instance.alias}: ${warning}`);
    await store.logEvent(instanceId, 'warn', 'capability_probe', warning);
  }

  for (const tier of Object.keys(TIER_INTERVAL_MS) as Tier[]) {
    startLoop(`${instance.alias}/${tier}`, TIER_INTERVAL_MS[tier], async () => {
      const collectors = collectorsFor(caps, tier);
      if (collectors.length === 0) return;

      const result = await runCollectors(pool, caps, collectors);
      const { rates, discarded } = deltas.rates(key, result.samples);
      const written = await store.insertSamples(instanceId, [...result.samples, ...rates]);

      if (result.errors.length > 0) {
        for (const error of result.errors) {
          log('warn', `${instance.alias}/${tier}: colector ${error.collectorId}: ${error.message}`);
          await store.logEvent(instanceId, 'warn', `collector:${error.collectorId}`, error.message);
        }
      }
      if (discarded > 0) {
        log('info', `${instance.alias}/${tier}: ${discarded} contadores descartados por reset de estadísticas`);
      }
      log('info', `${instance.alias}/${tier}: ${written} muestras (${result.latencyMs.toFixed(1)} ms)`);
    });
  }

  startInventoryLoop(instance, instanceId, pool);
  startSecurityLoop(instance, instanceId, pool);
  startPlanQueueLoop(instance, instanceId, pool);

  startLoop(`${instance.alias}/locks`, LOCKS_INTERVAL_MS, async () => {
    const blocked = await sampleBlocking(pool);
    if (blocked.length === 0) return;
    await store.saveLockEpisodes(instanceId, blocked);
    const worst = blocked[0];
    log(
      'info',
      `${instance.alias}/locks: ${blocked.length} sesión(es) bloqueada(s)` +
        `${worst ? `, la peor ${worst.waitSeconds.toFixed(1)} s en ${worst.lockObject ?? 'objeto desconocido'}` : ''}`,
    );
  });

  // CPU, memoria y disco del host. Sólo si la instancia lo declara: leer /proc
  // por SSH sin que nadie lo haya pedido sería una sorpresa desagradable.
  const hostConfig = instance.hostMetrics;
  if (hostConfig && hostConfig.source && hostConfig.source !== 'none') {
    const host = new HostTracker();
    startLoop(`${instance.alias}/host`, HOST_INTERVAL_MS, async () => {
      const snapshot = await readHostSnapshot(hostConfig);
      const samples = host.samples(snapshot);
      if (samples.length === 0) return;
      await store.insertSamples(instanceId, samples);
      log('info', `${instance.alias}/host: ${samples.length} muestras (${hostConfig.source})`);
    });
  }

  startLogLoop(instance, instanceId, pool);

  startLoop(`${instance.alias}/vacuum`, VACUUM_INTERVAL_MS, async () => {
    const snapshot = await sampleVacuum(pool, caps);
    await store.saveVacuum(instanceId, snapshot);
    await store.insertSamples(instanceId, vacuumSamples(snapshot));

    const running = snapshot.progress.length;
    const worst = snapshot.tables[0];
    log(
      'info',
      `${instance.alias}/vacuum: ${snapshot.tables.length} tabla(s)` +
        (running > 0 ? `, ${running} en curso` : '') +
        (worst ? `, peor ${worst.schema}.${worst.table} con ${Math.round(worst.deadTuples)} muertas` : ''),
    );
  });

  // El loop se registra siempre: si el DBA hace CREATE EXTENSION más tarde, el
  // reprobe actualiza las capabilities y esto arranca solo, sin reiniciar Búho.
  const statements = new StatementTracker();
  startLoop(`${instance.alias}/statements`, STATEMENTS_INTERVAL_MS, async () => {
    if (caps.statStatements !== 'active') return;

    const rows = await sampleStatements(pool, caps);
    const { deltas, discarded } = statements.deltas(rows);
    if (discarded > 0) {
      log('info', `${instance.alias}/statements: ${discarded} consulta(s) descartada(s) por reset de estadísticas`);
    }
    if (deltas.length === 0) return;

    const written = await store.saveStatements(instanceId, deltas);
    const totalMs = deltas.reduce((sum, delta) => sum + delta.execMs, 0);
    log(
      'info',
      `${instance.alias}/statements: ${written} consulta(s) con actividad, ${totalMs.toFixed(0)} ms de ejecución`,
    );
  });

  startLoop(`${instance.alias}/checks`, CHECKS_INTERVAL_MS, async () => {
    const summary = await runChecks(pool, caps);
    await store.saveCheckResults(instanceId, summary.results, summary.healthScore);
    const critical = summary.results.filter((r) => r.severity === 'critical').length;
    log(
      'info',
      `${instance.alias}/checks: score ${summary.healthScore}/100, ${summary.results.length} hallazgos` +
        `${critical > 0 ? ` (${critical} críticos)` : ''}`,
    );
  });

  startLoop(`${instance.alias}/reprobe`, REPROBE_INTERVAL_MS, async () => {
    const fresh = await probeCapabilities(pool);
    if (fresh.versionNum !== caps.versionNum) {
      log('warn', `${instance.alias}: cambió la versión (${caps.versionNum} → ${fresh.versionNum})`);
      deltas.reset(key);
    }
    caps = fresh;
    await store.saveCapabilities(instanceId, fresh);
  });
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', `${signal} recibido, cerrando`);
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  await Promise.allSettled(pools.map((pool) => pool.end()));
  await store.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await store.migrate();
log('info', `store listo, ${config.instances.length} instancia(s) configurada(s)`);

// Un encargo que quedó a medio ejecutar cuando el proceso murió se marca como
// error al arrancar: la consola no puede quedarse mostrando "ejecutando" para
// siempre sin que nadie lo esté ejecutando.
const released = await store.releaseStalePlanRequests(0);
if (released > 0) log('warn', `${released} plan(es) quedaron a medias en la corrida anterior`);

startLoop('mantenimiento', MAINTENANCE_INTERVAL_MS, async () => {
  // La retención se consulta en cada ciclo, no al arrancar: así un cambio hecho
  // desde la consola surte efecto en el siguiente cuarto de hora sin reiniciar
  // el colector. El config.json queda como valor inicial.
  const retention = await store.effectiveRetention(config.collector.retention);
  const result = await store.maintenance(retention);
  log(
    'info',
    `mantenimiento: +${result.created} particiones, -${result.dropped} purgadas, ${result.rolled} filas agregadas` +
      (result.baselines > 0 ? `, ${result.baselines} celdas de línea base` : '') +
      ` (crudo ${retention.rawDays}d, 5m ${retention.rollup5mDays}d, 1h ${retention.rollup1hDays}d)`,
  );
});

for (const instance of config.instances) {
  await monitorInstance(instance).catch((error) => {
    log('error', `${instance.alias}: no se pudo iniciar: ${error instanceof Error ? error.message : error}`);
  });
}
