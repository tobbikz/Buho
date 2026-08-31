/**
 * Ejercita los colectores de MariaDB y SQL Server contra los motores de verdad.
 *
 * Es la única forma de saber si el SQL es correcto: los dos motores aceptan
 * sintaxis que no existe en el otro y fallan de formas distintas según la
 * versión y los permisos. Se corre a mano cuando se toca un colector.
 *
 *   npx tsx scripts/probe-parity.ts [mariadb|mssql]
 */
import {
  foreignCollectorsFor,
  loadConfig,
  openEngine,
  probeForeign,
  runForeignCollectors,
  sampleForeignBlocking,
  sampleForeignStatements,
  ForeignStatementTracker,
  readForeignLog,
} from '../packages/core/src/index';
import { runForeignChecks } from '../packages/checks/src/index';

const filtro = process.argv[2];
const config = await loadConfig();

// Permite apuntar a una instancia que no está en config.json, para probar un
// motor con otra configuración sin tocar el archivo:
//   BUHO_PROBE=mariadb://root:x@127.0.0.1:33077/tienda npx tsx scripts/probe-parity.ts
const suelta = process.env['BUHO_PROBE'];
const instancias = suelta
  ? [(() => {
      const url = new URL(suelta);
      return {
        alias: 'suelta',
        engine: url.protocol.replace(':', '') as 'mariadb' | 'mssql',
        host: url.hostname,
        port: Number(url.port),
        database: url.pathname.replace('/', ''),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    })()]
  : config.instances;

for (const instance of instancias) {
  const engine = instance.engine ?? 'postgres';
  if (engine === 'postgres') continue;
  if (filtro && engine !== filtro) continue;

  console.log(`\n=== ${instance.alias} (${engine}) ===`);
  const client = await openEngine(instance, { statementTimeoutMs: 15_000 });

  try {
    const caps = await probeForeign(client);
    console.log(`versión ${caps.versionText} (${caps.versionNum}) · ${caps.flavor}`);
    console.log(`servidor ${caps.serverName} · rol ${caps.role} · arrancó ${caps.startedAt?.toISOString() ?? '?'}`);
    console.log('capacidades:', JSON.stringify(caps.features));
    for (const limite of caps.limitations) console.log(`  ! ${limite}`);

    for (const tier of ['fast', 'normal', 'slow', 'hourly'] as const) {
      const collectors = foreignCollectorsFor(caps, tier);
      if (collectors.length === 0) continue;
      const result = await runForeignCollectors(client, caps, collectors);
      console.log(
        `\n${tier}: ${collectors.length} colector(es), ${result.samples.length} muestras en ${result.latencyMs} ms`,
      );
      for (const error of result.errors) console.log(`  ✗ ${error.collectorId}: ${error.message}`);
      // Una muestra de cada métrica, para ver que los números tengan sentido.
      const vistas = new Set<string>();
      for (const sample of result.samples) {
        if (vistas.has(sample.metric)) continue;
        vistas.add(sample.metric);
        const etiquetas = sample.labels ? ` ${JSON.stringify(sample.labels)}` : '';
        console.log(
          `    ${sample.metric}=${Number(sample.value.toFixed(2))}${sample.counter ? ' (contador)' : ''}${etiquetas}`,
        );
      }
    }

    console.log('\nconsultas:');
    const tracker = new ForeignStatementTracker();
    const primera = await sampleForeignStatements(client, caps);
    tracker.deltas(primera, caps);
    console.log(`  ${primera.length} fila(s) en la primera lectura (sin deltas todavía)`);
    if (primera.length > 0) {
      await new Promise((listo) => setTimeout(listo, 1500));
      const segunda = await sampleForeignStatements(client, caps);
      const { deltas, discarded } = tracker.deltas(segunda, caps);
      console.log(`  ${deltas.length} delta(s), ${discarded} descartada(s)`);
      for (const delta of deltas.slice(0, 3)) {
        console.log(
          `    ${delta.queryid} · ${delta.calls} llamada(s) · ${delta.execMs.toFixed(2)} ms · ` +
            `${delta.query.slice(0, 80).replace(/\s+/g, ' ')}`,
        );
      }
    }

    console.log('\nbloqueos:');
    const bloqueos = await sampleForeignBlocking(client, caps);
    console.log(`  ${bloqueos.length} sesión(es) bloqueada(s)`);
    for (const bloqueo of bloqueos.slice(0, 3)) {
      console.log(`    pid ${bloqueo.waiterPid} espera ${bloqueo.waitSeconds}s por ${bloqueo.blockerPid}`);
    }

    console.log('\nchequeos:');
    const chequeos = await runForeignChecks(client, caps);
    console.log(`  salud ${chequeos.healthScore}/100 · ${chequeos.results.length} hallazgo(s)`);
    for (const error of chequeos.errors) console.log(`  ✗ ${error.checkId}: ${error.message}`);
    for (const hallazgo of chequeos.results) {
      console.log(`    [${hallazgo.severity}] ${hallazgo.checkId} ${hallazgo.object ?? ''}: ${hallazgo.message}`);
    }

    console.log('\nlog:');
    const log = await readForeignLog(client, caps, null);
    console.log(`  ${log.entries.length} entrada(s) de ${log.detail}`);
    for (const aviso of log.warnings) console.log(`  ! ${aviso}`);
    for (const entrada of log.entries.slice(0, 3)) {
      console.log(`    ${entrada.at.toISOString()} ${entrada.level} ${entrada.kind}: ${entrada.message.slice(0, 90)}`);
    }
  } catch (error) {
    console.log(`ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  } finally {
    await client.close().catch(() => {});
  }
}

process.exit(0);
