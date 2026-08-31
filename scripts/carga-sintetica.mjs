#!/usr/bin/env node
/**
 * Parque sintético para medir cómo aguanta la consola.
 *
 * Todo lo que hay hasta ahora se probó con seis instancias. Las pantallas de
 * flota consultan cada instancia por separado y el lienzo vivo repite esa
 * consulta cada cinco segundos, así que la pregunta «¿qué pasa con cincuenta
 * servidores?» no es teórica: es la diferencia entre una demo y un cliente.
 *
 * Este script crea instancias falsas con datos creíbles —muestras, consultas,
 * textos, esperas— y mide el tiempo de las consultas que alimentan las pantallas
 * de flota. No inventa datos bonitos: reparte el tráfico de forma desigual, como
 * un parque real, para que los recortes por «top N» tengan algo que recortar.
 *
 * Uso:
 *   node scripts/carga-sintetica.mjs            crea 50, mide y borra
 *   node scripts/carga-sintetica.mjs 120        crea 120
 *   node scripts/carga-sintetica.mjs 50 --dejar deja las instancias creadas
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const CUANTAS = Number(process.argv[2]) || 50;
const DEJAR = process.argv.includes('--dejar');
const PREFIJO = 'sintetica-';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const pool = new pg.Pool({ connectionString: config.store.url, max: 8 });

const TABLAS = ['pedidos', 'clientes', 'facturas', 'movimientos', 'sesiones', 'auditoria'];
const ESQUEMAS = ['public', 'ventas', 'analitica'];
const ROLES = ['app_web', 'app_etl', 'reportes', 'batch_nocturno'];
const ESPERAS = [
  ['CPU', null],
  ['IO', 'DataFileRead'],
  ['Lock', 'transactionid'],
  ['LWLock', 'BufferMapping'],
  ['Client', 'ClientRead'],
];

function reloj() {
  const inicio = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - inicio) / 1e6;
}

async function limpiar() {
  const { rows } = await pool.query(
    `delete from buho.instances where alias like $1 returning instance_id`,
    [`${PREFIJO}%`],
  );
  return rows.length;
}

async function crear() {
  const creadas = [];
  for (let i = 0; i < CUANTAS; i += 1) {
    const alias = `${PREFIJO}${String(i + 1).padStart(3, '0')}`;
    const { rows } = await pool.query(
      `insert into buho.instances (tenant, alias, host, port, database, environment, engine, created_at, last_seen_at)
            values ('default', $1, '10.0.0.' || $2, 5432, 'app', $3, 'postgres', now(), now())
       returning instance_id`,
      [alias, (i % 250) + 1, i % 3 === 0 ? 'produccion' : i % 3 === 1 ? 'staging' : 'lab'],
    );
    creadas.push(Number(rows[0].instance_id));
  }
  return creadas;
}

/**
 * Datos de una instancia.
 *
 * El volumen por instancia imita lo que deja el colector en un día: unas cuantas
 * decenas de consultas distintas, deltas cada minuto y fotos de sesiones cada
 * diez segundos. Con menos, la medición diría que todo es rápido porque no hay
 * nada que leer.
 */
async function poblar(instanceId, indice) {
  const consultas = 12 + (indice % 9);
  const horas = 24;

  const textos = [];
  for (let q = 0; q < consultas; q += 1) {
    const esquema = ESQUEMAS[q % ESQUEMAS.length];
    const tabla = TABLAS[q % TABLAS.length];
    const escritura = q % 3 !== 0;
    const texto = escritura
      ? `insert into ${esquema}.${tabla} (a, b, c) values ($1, $2, $3)`
      : `select id, total from ${esquema}.${tabla} where creado_en > $1 order by id limit $2`;
    const queryid = Number(`${instanceId}${String(q).padStart(3, '0')}`) % 9_000_000_000_000_000;
    textos.push({ queryid, texto });
  }

  await pool.query(
    `insert into buho.statement_texts (instance_id, queryid, query, truncated, first_seen_at, last_seen_at)
     select $1, x.queryid, x.query, false, now() - interval '2 days', now()
       from unnest($2::bigint[], $3::text[]) as x(queryid, query)
     on conflict do nothing`,
    [instanceId, textos.map((t) => t.queryid), textos.map((t) => t.texto)],
  );

  // Deltas: una fila por consulta y por minuto de las últimas 24 h sería un
  // millón de filas por instancia. El colector escribe cada minuto pero la
  // pantalla agrega, así que se generan cada cinco minutos: la misma forma con
  // una quinta parte del tiempo de carga del ensayo.
  await pool.query(
    `insert into buho.statement_stats
            (instance_id, ts, queryid, database, username, calls, exec_ms, rows,
             shared_hit, shared_read, temp_written, wal_bytes)
     select $1,
            momento,
            x.queryid,
            'app',
            ($4::text[])[1 + (x.orden % array_length($4::text[], 1))],
            (5 + random() * 400)::bigint,
            (10 + random() * 5000)::numeric,
            (5 + random() * 9000)::bigint,
            (random() * 90000)::bigint,
            (random() * 900)::bigint,
            0,
            (random() * 100000)::bigint
       from generate_series(now() - ($2 || ' hours')::interval, now(), interval '5 minutes') as momento,
            unnest($3::bigint[]) with ordinality as x(queryid, orden)`,
    [instanceId, horas, textos.map((t) => t.queryid), ROLES],
  );

  await pool.query(
    `insert into buho.query_actors (instance_id, ts, queryid, application, username, database, samples)
     select $1, momento, x.queryid,
            ($3::text[])[1 + (x.orden % array_length($3::text[], 1))],
            'app_web', 'app', 1 + (random() * 6)::int
       from generate_series(now() - interval '2 hours', now(), interval '1 minute') as momento,
            unnest($2::bigint[]) with ordinality as x(queryid, orden)
      where random() < 0.4`,
    [instanceId, textos.map((t) => t.queryid), ['portal-web', 'etl-nocturno', 'reportes-bi']],
  );

  await pool.query(
    `insert into buho.wait_samples (instance_id, ts, wait_type, wait_event, sessions)
     select $1, momento, w.tipo, w.evento, 1 + (random() * 8)::int
       from generate_series(now() - interval '6 hours', now(), interval '30 seconds') as momento,
            unnest($2::text[], $3::text[]) as w(tipo, evento)
      where random() < 0.5`,
    [instanceId, ESPERAS.map((e) => e[0]), ESPERAS.map((e) => e[1])],
  );

  // Métricas: sólo unas pocas series, las que usan las pantallas de flota.
  await pool.query(
    `insert into buho.metric_samples (instance_id, ts, metric, labels, value)
     select $1, momento, m.metric, '{}'::jsonb, random() * 100
       from generate_series(now() - interval '6 hours', now(), interval '1 minute') as momento,
            unnest($2::text[]) as m(metric)`,
    [
      instanceId,
      ['connections_total', 'connections_active', 'connections_blocked', 'xact_commit_per_sec'],
    ],
  );
}

async function medir(etiqueta, fn) {
  const t = reloj();
  const resultado = await fn();
  const ms = t();
  console.log(`  ${ms > 2000 ? '⚠' : '·'} ${etiqueta.padEnd(46)} ${ms.toFixed(0).padStart(6)} ms${resultado ?? ''}`);
  return ms;
}

async function main() {
  console.log(`\nParque sintético de ${CUANTAS} instancias\n`);

  const borradas = await limpiar();
  if (borradas > 0) console.log(`  (se borraron ${borradas} instancias sintéticas de una corrida anterior)`);

  const t = reloj();
  const ids = await crear();
  console.log(`  ${ids.length} instancias creadas en ${t().toFixed(0)} ms`);

  const carga = reloj();
  // En lotes: cincuenta inserciones masivas en paralelo saturarían el store y la
  // medición diría más del generador que del producto.
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map((id, n) => poblar(id, i + n)));
  }
  console.log(`  datos generados en ${(carga() / 1000).toFixed(1)} s\n`);

  await pool.query('analyze buho.statement_stats, buho.statement_texts, buho.wait_samples, buho.query_actors');

  console.log('Consultas que alimentan las pantallas de flota:');
  const tiempos = {};

  tiempos.instancias = await medir('lista de instancias con salud', async () => {
    const { rows } = await pool.query(
      `select i.instance_id, i.alias from buho.instances i order by i.alias`,
    );
    return ` (${rows.length} filas)`;
  });

  tiempos.flujoUna = await medir('flujo de UNA instancia (24 h)', async () => {
    const { rows } = await pool.query(
      `select s.queryid, sum(s.calls) c, sum(s.rows) r, max(t.query) q
         from buho.statement_stats s
         left join buho.statement_texts t
                on t.instance_id = s.instance_id and t.queryid = s.queryid
        where s.instance_id = $1 and s.ts > now() - interval '24 hours'
        group by s.queryid`,
      [ids[0]],
    );
    return ` (${rows.length} consultas)`;
  });

  tiempos.flujoParque = await medir('flujo del parque completo, en paralelo', async () => {
    const resultados = await Promise.all(
      ids.map((id) =>
        pool.query(
          `select s.queryid, sum(s.calls) c, sum(s.rows) r, max(t.query) q
             from buho.statement_stats s
             left join buho.statement_texts t
                    on t.instance_id = s.instance_id and t.queryid = s.queryid
            where s.instance_id = $1 and s.ts > now() - interval '24 hours'
            group by s.queryid`,
          [id],
        ),
      ),
    );
    return ` (${resultados.reduce((suma, r) => suma + r.rows.length, 0)} filas en total)`;
  });

  tiempos.vivo = await medir('lienzo vivo del parque (ventana 5 min)', async () => {
    const resultados = await Promise.all(
      ids.map((id) =>
        pool.query(
          `select s.queryid, sum(s.calls) c, sum(s.rows) r, max(t.query) q
             from buho.statement_stats s
             left join buho.statement_texts t
                    on t.instance_id = s.instance_id and t.queryid = s.queryid
            where s.instance_id = $1 and s.ts > now() - interval '5 minutes'
            group by s.queryid`,
          [id],
        ),
      ),
    );
    return ` (${resultados.reduce((suma, r) => suma + r.rows.length, 0)} filas)`;
  });

  tiempos.esperas = await medir('esperas de una instancia (6 h)', async () => {
    const { rows } = await pool.query(
      `select wait_type, sum(sessions) from buho.wait_samples
        where instance_id = $1 and ts > now() - interval '6 hours' group by 1`,
      [ids[0]],
    );
    return ` (${rows.length} tipos)`;
  });

  const { rows: tamano } = await pool.query(
    `select pg_size_pretty(pg_database_size(current_database())) as tamano`,
  );
  console.log(`\n  store: ${tamano[0].tamano}`);

  const veredicto =
    tiempos.vivo > 3000
      ? 'El lienzo del parque no aguanta este tamaño sin caché.'
      : tiempos.vivo > 1200
        ? 'El lienzo del parque va justo: conviene caché si el parque crece más.'
        : 'El lienzo del parque aguanta este tamaño sin caché.';
  console.log(`\n  ${veredicto}\n`);

  if (!DEJAR) {
    const t2 = reloj();
    const n = await limpiar();
    console.log(`  ${n} instancias sintéticas borradas en ${(t2() / 1000).toFixed(1)} s\n`);
  } else {
    console.log(`  se dejaron ${ids.length} instancias sintéticas (borrar con: node scripts/carga-sintetica.mjs 0)\n`);
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
