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
import { runChecks, runForeignChecks } from '@buho/checks';
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
  measureBloat,
  sampleActors,
  inspectActors,
  ActorAccumulator,
  sampleSessions,
  summarizeSessions,
  readLog,
  sampleVacuum,
  vacuumSamples,
  runCollectors,
  sampleBlocking,
  sampleStatements,
  StatementTracker,
  runExplain,
  probeForeign,
  foreignCollectorsFor,
  runForeignCollectors,
  ForeignStatementTracker,
  sampleForeignStatements,
  sampleForeignBlocking,
  readForeignLog,
} from '@buho/core';
import type { Capabilities, EngineClient, InstanceConfig, Tier } from '@buho/core';
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
// Una medición de bloat puede tardar minutos; no tiene sentido revisar la cola
// cada segundo, y mirar cada dos segundos ya se siente inmediato en la consola.
// Cada cinco segundos se mira quién está activo y cada minuto se escribe lo
// acumulado: la foto tiene que ser frecuente para no perderse las consultas
// cortas, la escritura no.
const ACTOR_SAMPLE_INTERVAL_MS = 5_000;
const SESSION_INTERVAL_MS = 10_000;
const ACTOR_FLUSH_INTERVAL_MS = 60_000;
const BLOAT_QUEUE_INTERVAL_MS = 2_000;
// Media hora es más de lo que cualquiera va a esperar mirando la pantalla, pero
// menos que dejar el escaneo colgado para siempre sobre una tabla de terabytes.
const BLOAT_TIMEOUT_MS = 30 * 60_000;

const config = await loadConfig();
const store = new Store(config.store.url);
const deltas = new DeltaEngine();

let stopping = false;
const timers = new Set<NodeJS.Timeout>();
const pools: Pool[] = [];
const foreignClients: EngineClient[] = [];

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
 * Cola de mediciones de bloat con pgstattuple.
 *
 * De a una y con timeout: cada medición exacta es un escaneo secuencial de la
 * tabla, así que dos en paralelo sobre la misma instancia sería el monitor
 * haciéndole daño al servidor que vigila.
 */
function startBloatQueueLoop(instance: InstanceConfig, instanceId: number, pool: Pool): void {
  startLoop(`${instance.alias}/bloat`, BLOAT_QUEUE_INTERVAL_MS, async () => {
    const job = await store.claimBloatRequest(instanceId);
    if (!job) return;

    const objeto = `${job.schema}.${job.table}`;
    const started = Date.now();
    try {
      const medicion = await measureBloat(pool, job.schema, job.table, job.mode, BLOAT_TIMEOUT_MS);
      await store.finishBloatRequest(job.requestId, medicion);
      log(
        'info',
        `${instance.alias}/bloat: ${objeto} ${job.mode} para ${job.requestedBy} en ` +
          `${Math.round((Date.now() - started) / 1000)} s, ${medicion.deadPct.toFixed(1)} % muerto y ` +
          `${medicion.freePct.toFixed(1)} % libre`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.failBloatRequest(job.requestId, message);
      log('warn', `${instance.alias}/bloat: ${objeto} falló: ${message}`);
    }
  });
}

/**
 * Muestreo de quién ejecuta qué, para atribuir el tráfico por aplicación.
 *
 * Dos ritmos distintos a propósito: se mira `pg_stat_activity` seguido, porque
 * es una foto y sólo ve lo que está corriendo en ese instante, y se escribe una
 * vez por minuto con lo acumulado. Muestrear poco perdería las consultas
 * cortas; escribir cada muestra guardaría doce filas por minuto casi idénticas.
 *
 * Si la instancia no puede dar el identificador de consulta, el bucle no
 * arranca y se registra el motivo: la consola lo muestra en vez de enseñar una
 * atribución vacía que parecería "nadie usa esta base".
 */
function startActorLoop(
  instance: InstanceConfig,
  instanceId: number,
  pool: Pool,
  caps: Capabilities,
): void {
  const acumulador = new ActorAccumulator();
  let comprobado = false;
  let disponible = false;
  let ultimaEscritura = Date.now();

  startLoop(`${instance.alias}/actors`, ACTOR_SAMPLE_INTERVAL_MS, async () => {
    if (!comprobado) {
      const soporte = await inspectActors(pool, caps.versionNum);
      comprobado = true;
      disponible = soporte.available;
      if (!soporte.available) {
        log('info', `${instance.alias}/actors: sin atribución por aplicación (${soporte.reason})`);
        await store.logEvent(
          instanceId,
          'info',
          'actors',
          soporte.reason ?? 'sin atribución por aplicación',
        );
        return;
      }
    }
    if (!disponible) return;

    acumulador.add(await sampleActors(pool));

    if (Date.now() - ultimaEscritura < ACTOR_FLUSH_INTERVAL_MS) return;
    ultimaEscritura = Date.now();

    const observaciones = acumulador.drain();
    const escritas = await store.saveQueryActors(instanceId, new Date(), observaciones);
    if (escritas > 0) {
      log('info', `${instance.alias}/actors: ${escritas} combinación(es) de aplicación y consulta`);
    }
  });
}

/**
 * Muestreo de sesiones y esperas.
 *
 * Cada diez segundos, y no cada cinco como el muestreo de aplicaciones, porque
 * esta consulta trae más columnas y llama a `pg_blocking_pids` cuando hay
 * bloqueos. Diez segundos siguen siendo suficientes para lo que esto mide, que
 * son esperas que duran, no las que pasan en un milisegundo.
 */
function startSessionLoop(instance: InstanceConfig, instanceId: number, pool: Pool): void {
  startLoop(`${instance.alias}/sesiones`, SESSION_INTERVAL_MS, async () => {
    const foto = summarizeSessions(await sampleSessions(pool));
    const escritas = await store.saveSessionSnapshot(instanceId, {
      at: foto.at,
      waits: foto.waits,
      detail: foto.detail,
    });
    if (escritas === 0) return;

    // Se registra sólo cuando hay algo raro: una foto con dos sesiones activas
    // en CPU no merece una línea de log cada diez segundos.
    if (foto.blockedSessions > 0 || (foto.longestQueryMs ?? 0) > 30_000) {
      log(
        'info',
        `${instance.alias}/sesiones: ${foto.activeSessions} activa(s), ` +
          `${foto.blockedSessions} bloqueada(s)` +
          (foto.longestQueryMs
            ? `, la más larga ${(foto.longestQueryMs / 1000).toFixed(1)} s`
            : ''),
      );
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

/**
 * Ciclo completo para MariaDB y SQL Server.
 *
 * Mismo trato que PostgreSQL: métricas por tier, consultas, bloqueos, chequeos y
 * log. Lo que cambia es de dónde sale cada cosa, y eso vive en los colectores de
 * cada motor.
 *
 * Una diferencia de fondo con PostgreSQL: acá se mantiene **una** conexión viva
 * para todo el ciclo en vez de un pool. Los dos drivers reconectan solos, el
 * volumen de consultas es el mismo, y una sesión por instancia es más fácil de
 * justificar ante el DBA del cliente que un pool que abre y cierra.
 */
async function monitorForeign(instance: InstanceConfig): Promise<void> {
  const engine = engineOf(instance);
  const instanceId = await store.upsertInstance(instance);
  const key = instanceKey(instance);

  const client = await openEngine(instance, {
    statementTimeoutMs: config.collector.statementTimeoutMs,
    connectTimeoutMs: config.collector.connectTimeoutMs,
  });
  foreignClients.push(client);

  let caps = await probeForeign(client);
  log(
    'info',
    `${instance.alias} (${ENGINE_LABEL[engine]}): ${caps.versionText}, ${caps.role}, ` +
      `consultas=${caps.features.statementDigests ? 'sí' : 'no'}`,
  );
  for (const limite of caps.limitations) {
    log('warn', `${instance.alias}: ${limite}`);
    await store.logEvent(instanceId, 'warn', 'capability_probe', limite);
  }

  for (const tier of Object.keys(TIER_INTERVAL_MS) as Tier[]) {
    startLoop(`${instance.alias}/${tier}`, TIER_INTERVAL_MS[tier], async () => {
      const collectors = foreignCollectorsFor(caps, tier);
      if (collectors.length === 0) return;

      const result = await runForeignCollectors(client, caps, collectors);
      const { rates, discarded } = deltas.rates(key, result.samples);
      const written = await store.insertSamples(instanceId, [...result.samples, ...rates]);

      for (const error of result.errors) {
        log('warn', `${instance.alias}/${tier}: colector ${error.collectorId}: ${error.message}`);
        await store.logEvent(instanceId, 'warn', `collector:${error.collectorId}`, error.message);
      }
      if (discarded > 0) {
        log('info', `${instance.alias}/${tier}: ${discarded} contadores descartados por reset de estadísticas`);
      }
      log('info', `${instance.alias}/${tier}: ${written} muestras (${result.latencyMs.toFixed(1)} ms)`);
    });
  }

  startInventoryLoop(instance, instanceId);
  startSecurityLoop(instance, instanceId);

  startLoop(`${instance.alias}/locks`, LOCKS_INTERVAL_MS, async () => {
    const blocked = await sampleForeignBlocking(client, caps);
    if (blocked.length === 0) return;
    await store.saveLockEpisodes(instanceId, blocked);
    const worst = blocked[0];
    log(
      'info',
      `${instance.alias}/locks: ${blocked.length} sesión(es) bloqueada(s)` +
        `${worst ? `, la peor ${worst.waitSeconds.toFixed(1)} s` : ''}`,
    );
  });

  const statements = new ForeignStatementTracker();
  startLoop(`${instance.alias}/statements`, STATEMENTS_INTERVAL_MS, async () => {
    if (!caps.features.statementDigests) return;

    const rows = await sampleForeignStatements(client, caps);
    const { deltas: activity, discarded } = statements.deltas(rows, caps);
    if (discarded > 0) {
      log('info', `${instance.alias}/statements: ${discarded} consulta(s) descartada(s) por reset de estadísticas`);
    }
    if (activity.length === 0) return;

    const written = await store.saveStatements(instanceId, activity);
    const totalMs = activity.reduce((sum, delta) => sum + delta.execMs, 0);
    log(
      'info',
      `${instance.alias}/statements: ${written} consulta(s) con actividad, ${totalMs.toFixed(0)} ms de ejecución`,
    );
  });

  startLoop(`${instance.alias}/logs`, LOG_INTERVAL_MS, async () => {
    const cursor = await store.logCursor(instanceId);
    const result = await readForeignLog(client, caps, cursor);
    const written = await store.saveLogEntries(instanceId, result.entries);
    await store.saveLogCursor(instanceId, result.source, result.cursor, result.detail, result.warnings, written);

    if (written === 0) return;
    const graves = result.entries.filter(
      (entry) => entry.kind === 'error' || entry.kind === 'fatal' || entry.kind === 'deadlock',
    ).length;
    log(
      'info',
      `${instance.alias}/logs: ${written} entrada(s) de ${result.detail}` +
        (graves > 0 ? `, ${graves} con severidad de error` : ''),
    );
  });

  startLoop(`${instance.alias}/checks`, CHECKS_INTERVAL_MS, async () => {
    const summary = await runForeignChecks(client, caps);
    await store.saveCheckResults(instanceId, summary.results, summary.healthScore);
    for (const error of summary.errors) {
      log('warn', `${instance.alias}/checks: ${error.checkId}: ${error.message}`);
    }
    const critical = summary.results.filter((result) => result.severity === 'critical').length;
    log(
      'info',
      `${instance.alias}/checks: score ${summary.healthScore}/100, ${summary.results.length} hallazgos` +
        `${critical > 0 ? ` (${critical} críticos)` : ''}`,
    );
  });

  // Se vuelve a preguntar qué se puede medir: performance_schema, Query Store o
  // un permiso nuevo aparecen sin reiniciar nada, y el ciclo tiene que
  // aprovecharlos sin que nadie reinicie Búho.
  startLoop(`${instance.alias}/reprobe`, REPROBE_INTERVAL_MS, async () => {
    const fresh = await probeForeign(client);
    if (fresh.versionNum !== caps.versionNum) {
      log('warn', `${instance.alias}: cambió la versión (${caps.versionText} → ${fresh.versionText})`);
      deltas.reset(key);
      statements.reset();
    }
    if (fresh.features.statementDigests && !caps.features.statementDigests) {
      log('info', `${instance.alias}: la analítica de consultas quedó disponible`);
    }
    caps = fresh;
  });
}

async function monitorInstance(instance: InstanceConfig): Promise<void> {
  if (engineOf(instance) !== 'postgres') {
    await monitorForeign(instance);
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
  startBloatQueueLoop(instance, instanceId, pool);
  startActorLoop(instance, instanceId, pool, caps);
  startSessionLoop(instance, instanceId, pool);

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
  await Promise.allSettled(foreignClients.map((client) => client.close()));
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
