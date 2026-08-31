/**
 * Prueba del ciclo de vida del store con el tiempo comprimido.
 *
 * La retención tarda 400 días en demostrarse sola. Esta prueba la demuestra en
 * un minuto: levanta un store aparte, le siembra una historia sintética de más
 * de un año con las fechas ya puestas donde tienen que estar, corre el mismo
 * mantenimiento que corre el colector en producción y comprueba qué sobrevivió
 * y qué se fue.
 *
 * No toca el store real: usa un contenedor propio con un puerto y un volumen
 * temporales, y lo borra al terminar.
 *
 *   node scripts/test-retention.mjs
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import pg from 'pg';

const ejecutar = promisify(execFile);

const CONTENEDOR = 'buho-prueba-retencion';
const PUERTO = 55987;
const URL = `postgres://buho:buho@127.0.0.1:${PUERTO}/buho`;

// La misma retención por omisión del producto, para que la prueba diga algo del
// comportamiento real y no de una configuración inventada.
const RETENCION = {
  rawDays: 7,
  rollup5mDays: 30,
  rollup1hDays: 400,
  lockEpisodeDays: 30,
  statementDays: 14,
  planDays: 60,
  logDays: 30,
};

const fallos = [];

function comprobar(descripcion, condicion, detalle) {
  if (condicion) {
    console.log(`  ✓ ${descripcion}${detalle ? ` — ${detalle}` : ''}`);
  } else {
    console.log(`  ✗ ${descripcion}${detalle ? ` — ${detalle}` : ''}`);
    fallos.push(descripcion);
  }
}

async function docker(...args) {
  try {
    const { stdout } = await ejecutar('docker', args);
    return stdout.trim();
  } catch (error) {
    throw new Error(`docker ${args.join(' ')}: ${error.stderr || error.message}`);
  }
}

async function levantarStore() {
  await docker('rm', '-f', CONTENEDOR).catch(() => {});
  await docker(
    'run', '-d', '--rm',
    '--name', CONTENEDOR,
    '-e', 'POSTGRES_USER=buho',
    '-e', 'POSTGRES_PASSWORD=buho',
    '-e', 'POSTGRES_DB=buho',
    '-p', `127.0.0.1:${PUERTO}:5432`,
    'postgres:18-alpine',
  );

  for (let intento = 0; intento < 60; intento += 1) {
    try {
      const cliente = new pg.Client({ connectionString: URL });
      await cliente.connect();
      await cliente.end();
      return;
    } catch {
      await new Promise((listo) => setTimeout(listo, 1000));
    }
  }
  throw new Error('el store de prueba no aceptó conexiones');
}

const DIA = 86_400_000;

/**
 * Historia sintética con las fechas ya donde tienen que estar.
 *
 * Cada fila se siembra en el punto exacto del pasado que la vuelve interesante:
 * justo dentro de su ventana de retención, o justo afuera. Así el resultado del
 * mantenimiento distingue entre "purga bien" y "purga de más".
 */
async function sembrar(cliente) {
  await cliente.query(
    `insert into buho.instances (alias, engine, host, port, database, environment)
     values ('prueba', 'postgres', '127.0.0.1', 5432, 'prueba', 'test')`,
  );
  const { rows } = await cliente.query('select instance_id from buho.instances');
  const id = rows[0].instance_id;

  // Particiones para todo el rango que se va a sembrar: en producción las crea
  // ensure_partitions día por día, acá hacen falta de golpe.
  for (const tabla of ['metric_samples', 'statement_stats', 'log_events']) {
    await cliente.query(
      `do $$
       declare d date;
       begin
         for d in select generate_series(current_date - 25, current_date + 1, interval '1 day')::date loop
           execute format('create table if not exists buho.%I partition of buho.%I for values from (%L) to (%L)',
                          '${tabla}_' || to_char(d, 'YYYYMMDD'), '${tabla}', d, d + 1);
         end loop;
       end $$;`,
    );
  }

  const dias = [0, 1, 3, 6, 8, 13, 16];
  for (const dia of dias) {
    const ts = new Date(Date.now() - dia * DIA + 3600_000).toISOString();
    await cliente.query(
      `insert into buho.metric_samples (instance_id, ts, metric, labels, value)
       values ($1, $2, 'connections_total', '{}', $3)`,
      [id, ts, 10 + dia],
    );
    await cliente.query(
      `insert into buho.statement_stats (instance_id, ts, queryid, calls, exec_ms, rows)
       values ($1, $2, $3, 1, 1, 1)`,
      [id, ts, 1000 + dia],
    );
    await cliente.query(
      `insert into buho.log_events (instance_id, at, level, kind, message, fingerprint)
       values ($1, $2, 'ERROR', 'error', 'prueba', 'huella')`,
      [id, ts],
    );
  }

  // Rollups: uno dentro y uno fuera de cada ventana.
  for (const dia of [1, 29, 31, 200, 399, 401]) {
    const bucket = new Date(Date.now() - dia * DIA).toISOString();
    await cliente.query(
      `insert into buho.metric_rollup_5m (instance_id, bucket, metric, labels, samples, avg_value, min_value, max_value)
       values ($1, date_bin('5 minutes', $2::timestamptz, 'epoch'), 'connections_total', '{}', 1, 1, 1, 1)
       on conflict do nothing`,
      [id, bucket],
    );
    await cliente.query(
      `insert into buho.metric_rollup_1h (instance_id, bucket, metric, labels, samples, avg_value, min_value, max_value)
       values ($1, date_bin('1 hour', $2::timestamptz, 'epoch'), 'connections_total', '{}', 1, 1, 1, 1)
       on conflict do nothing`,
      [id, bucket],
    );
  }

  for (const dia of [1, 29, 31]) {
    await cliente.query(
      `insert into buho.lock_episodes
         (instance_id, waiter_pid, first_seen_at, last_seen_at, wait_seconds, waiter_query)
       values ($1, $2, $3, $3, 1, 'select 1')`,
      [id, 100 + dia, new Date(Date.now() - dia * DIA).toISOString()],
    );
  }

  for (const dia of [1, 59, 61]) {
    await cliente.query(
      `insert into buho.plan_requests (instance_id, queryid, sql, mode, state, requested_by, requested_at)
       values ($1, $2, 'select 1', 'generic', 'listo', 'prueba', $3)`,
      [id, 2000 + dia, new Date(Date.now() - dia * DIA).toISOString()],
    );
  }

  // Un texto con deltas y otro huérfano: el huérfano se tiene que ir.
  await cliente.query(
    `insert into buho.statement_texts (instance_id, queryid, query, first_seen_at, last_seen_at)
     values ($1, 1000, 'select con deltas', now(), now()),
            ($1, 9999, 'select huérfano',   now(), now())`,
    [id],
  );

  return id;
}

async function contar(cliente, sql, params = []) {
  const { rows } = await cliente.query(sql, params);
  return Number(rows[0].n);
}

async function particiones(cliente, padre) {
  const { rows } = await cliente.query(
    `select c.relname
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'buho' and c.relname ~ ('^' || $1 || '_[0-9]{8}$')
      order by 1`,
    [padre],
  );
  return rows.map((row) => row.relname);
}

console.log('Levantando un store de prueba aparte (no se toca el real)…');
await levantarStore();

const cliente = new pg.Client({ connectionString: URL });
await cliente.connect();

console.log('Aplicando el esquema…');
await cliente.query(await readFile('packages/store/src/schema.sql', 'utf8'));

console.log('Sembrando una historia de 401 días, con el tiempo comprimido…');
const instancia = await sembrar(cliente);

const antes = {
  muestras: await contar(cliente, 'select count(*) n from buho.metric_samples'),
  particionesMuestras: (await particiones(cliente, 'metric_samples')).length,
  rollup5m: await contar(cliente, 'select count(*) n from buho.metric_rollup_5m'),
  rollup1h: await contar(cliente, 'select count(*) n from buho.metric_rollup_1h'),
  bloqueos: await contar(cliente, 'select count(*) n from buho.lock_episodes'),
  planes: await contar(cliente, 'select count(*) n from buho.plan_requests'),
  textos: await contar(cliente, 'select count(*) n from buho.statement_texts'),
};
console.log(
  `  sembrado: ${antes.muestras} muestras en ${antes.particionesMuestras} particiones, ` +
    `${antes.rollup5m} rollups de 5 m, ${antes.rollup1h} de 1 h, ${antes.bloqueos} bloqueos, ` +
    `${antes.planes} planes, ${antes.textos} textos`,
);

console.log('\nCorriendo el mismo mantenimiento que corre el colector…');
const { Store } = await import('../packages/store/dist/index.js').catch(() => ({}));
let resultado;
if (Store) {
  const store = new Store(URL);
  resultado = await store.maintenance(RETENCION);
  await store.close();
} else {
  // Sin build previo se llama a las mismas funciones del store, en el mismo
  // orden que `Store.maintenance`. Es la misma prueba sin depender de compilar.
  const creadas = await cliente.query(
    `select buho.ensure_partitions('metric_samples', 3)
          + buho.ensure_partitions('statement_stats', 3)
          + buho.ensure_partitions('log_events', 3) as created`,
  );
  const rodadas = await cliente.query(`select buho.build_rollups(interval '400 days') as rolled`);
  const lineas = await cliente.query('select buho.build_baselines(4) as baselines');
  const purgadas = await cliente.query(
    `select buho.prune_partitions('metric_samples', $1)
          + buho.prune_partitions('statement_stats', $2)
          + buho.prune_partitions('log_events', $3) as dropped`,
    [RETENCION.rawDays, RETENCION.statementDays, RETENCION.logDays],
  );
  await cliente.query(`delete from buho.metric_rollup_5m where bucket < now() - ($1 || ' days')::interval`, [
    RETENCION.rollup5mDays,
  ]);
  await cliente.query(`delete from buho.metric_rollup_1h where bucket < now() - ($1 || ' days')::interval`, [
    RETENCION.rollup1hDays,
  ]);
  await cliente.query(`delete from buho.lock_episodes where last_seen_at < now() - ($1 || ' days')::interval`, [
    RETENCION.lockEpisodeDays,
  ]);
  await cliente.query(`delete from buho.plan_requests where requested_at < now() - ($1 || ' days')::interval`, [
    RETENCION.planDays,
  ]);
  await cliente.query(
    `delete from buho.statement_texts t
      where not exists (select 1 from buho.statement_stats s
                         where s.instance_id = t.instance_id and s.queryid = t.queryid)`,
  );
  resultado = {
    created: Number(creadas.rows[0].created),
    rolled: Number(rodadas.rows[0].rolled),
    baselines: Number(lineas.rows[0].baselines),
    dropped: Number(purgadas.rows[0].dropped),
  };
}
console.log(
  `  +${resultado.created} particiones, -${resultado.dropped} purgadas, ` +
    `${resultado.rolled} filas agregadas, ${resultado.baselines} celdas de línea base`,
);

console.log('\nQué sobrevivió:');

const partesMuestras = await particiones(cliente, 'metric_samples');
const masViejaMuestras = partesMuestras[0]?.slice(-8);
const limiteCrudo = new Date(Date.now() - RETENCION.rawDays * DIA).toISOString().slice(0, 10).replace(/-/g, '');
comprobar(
  'las particiones de muestras más viejas que la retención se borraron',
  masViejaMuestras >= limiteCrudo,
  `la más vieja es ${masViejaMuestras}, el límite ${limiteCrudo}`,
);

const partesLog = await particiones(cliente, 'log_events');
comprobar(
  'el log conserva más historia que las muestras crudas (30 días contra 7)',
  partesLog.length >= partesMuestras.length,
  `${partesLog.length} particiones de log contra ${partesMuestras.length} de muestras`,
);

const partesStmt = await particiones(cliente, 'statement_stats');
comprobar(
  'las consultas conservan 14 días',
  partesStmt.length > partesMuestras.length,
  `${partesStmt.length} particiones`,
);

comprobar(
  'quedan particiones por delante para que el colector nunca escriba sin destino',
  partesMuestras.some((nombre) => nombre.slice(-8) > new Date().toISOString().slice(0, 10).replace(/-/g, '')),
  `hasta ${partesMuestras.at(-1)?.slice(-8)}`,
);

const muestrasVivas = await contar(cliente, 'select count(*) n from buho.metric_samples');
comprobar(
  'no se perdió ninguna muestra dentro de la ventana',
  muestrasVivas === 4,
  `${muestrasVivas} muestras de los últimos ${RETENCION.rawDays} días (se sembraron 4)`,
);

const defecto = await contar(cliente, 'select count(*) n from buho.metric_samples_default');
comprobar('la partición por defecto quedó vacía', defecto === 0, `${defecto} filas`);

const rollup5m = await contar(cliente, 'select count(*) n from buho.metric_rollup_5m where bucket < now() - interval \'30 days\'');
comprobar('los rollups de 5 minutos más viejos que 30 días se fueron', rollup5m === 0, `${rollup5m} filas viejas`);

const rollup1hViejo = await contar(
  cliente,
  "select count(*) n from buho.metric_rollup_1h where bucket < now() - interval '400 days'",
);
comprobar('los rollups de 1 hora más viejos que 400 días se fueron', rollup1hViejo === 0, `${rollup1hViejo} filas viejas`);

const rollup1hVivo = await contar(
  cliente,
  "select count(*) n from buho.metric_rollup_1h where bucket > now() - interval '400 days'",
);
comprobar(
  'el año de historia agregada sigue ahí',
  rollup1hVivo > 0,
  `${rollup1hVivo} filas, la más vieja de hace ${
    (
      await cliente.query(
        "select round(extract(epoch from now() - min(bucket)) / 86400) d from buho.metric_rollup_1h",
      )
    ).rows[0].d
  } días`,
);

const rollupDerivado = await contar(
  cliente,
  `select count(*) n from buho.metric_rollup_5m
    where bucket >= date_bin('5 minutes', now() - interval '1 day', 'epoch') - interval '1 day'`,
);
comprobar(
  'el rollup se construyó a partir de las muestras crudas',
  rollupDerivado > 0,
  `${rollupDerivado} tramos de 5 minutos con datos recientes`,
);

const bloqueos = await contar(cliente, 'select count(*) n from buho.lock_episodes');
comprobar('los episodios de bloqueo respetan sus 30 días', bloqueos === 2, `quedaron ${bloqueos} de 3`);

const planes = await contar(cliente, 'select count(*) n from buho.plan_requests');
comprobar('los planes respetan sus 60 días', planes === 2, `quedaron ${planes} de 3`);

const textos = await contar(cliente, 'select count(*) n from buho.statement_texts');
comprobar('el texto huérfano se borró y el que tiene deltas se quedó', textos === 1, `quedó ${textos} de 2`);

const tamano = await cliente.query(
  `select pg_size_pretty(sum(pg_total_relation_size(c.oid))) as total
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'buho'`,
);
console.log(`\nTamaño del store después de la purga: ${tamano.rows[0].total}`);

await cliente.end();
console.log('Borrando el store de prueba…');
await docker('rm', '-f', CONTENEDOR).catch(() => {});

console.log('');
if (fallos.length > 0) {
  console.log(`${fallos.length} comprobación(es) fallaron:`);
  for (const fallo of fallos) console.log(`  - ${fallo}`);
  process.exit(1);
}
console.log(`Retención verificada sobre la instancia ${instancia}: el ciclo de un año entero funciona.`);
