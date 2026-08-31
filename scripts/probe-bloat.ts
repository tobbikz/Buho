/**
 * Comprueba la medición de bloat con pgstattuple contra una base real.
 *
 * Mide la misma tabla en los dos modos y la compara con la estimación por ancho
 * de tupla que usa la pantalla de vacuum: es la única forma de saber cuánto se
 * equivoca la estimación, que es justamente lo que el cliente va a preguntar.
 *
 *   BUHO_PROBE=postgres://usuario:clave@host:puerto/base \
 *   BUHO_TABLE=esquema.tabla npx tsx scripts/probe-bloat.ts
 */
import { Pool } from 'pg';
import { inspectPgstattuple, measureBloat } from '../packages/core/src/bloat';
import { probeCapabilities } from '../packages/core/src/capabilities';
import { sampleVacuum } from '../packages/core/src/vacuum';

const url = process.env['BUHO_PROBE'];
if (!url) throw new Error('falta BUHO_PROBE con la URL de la base a medir');

const objetivo = process.env['BUHO_TABLE'] ?? '';
const pool = new Pool({ connectionString: url, max: 2 });

const estado = await inspectPgstattuple(pool);
console.log('pgstattuple:', estado);

if (!estado.installed) {
  console.log('\ninstalando la extensión para la prueba…');
  await pool.query('create extension if not exists pgstattuple');
  console.log('ahora:', await inspectPgstattuple(pool));
}

// Si no dicen qué tabla, se mide la más grande: es donde el error de la
// estimación cuesta dinero.
let schema: string;
let table: string;
if (objetivo.includes('.')) {
  [schema = '', table = ''] = objetivo.split('.');
} else {
  const { rows } = await pool.query<{ schemaname: string; relname: string }>(
    `select schemaname, relname from pg_stat_user_tables
      order by pg_total_relation_size(relid) desc limit 1`,
  );
  schema = rows[0]?.schemaname ?? 'public';
  table = rows[0]?.relname ?? '';
}
if (!table) throw new Error('no hay tablas de usuario que medir');

console.log(`\nmidiendo ${schema}.${table}`);

// La estimación tal como la calcula la pantalla de vacuum. Se llama al mismo
// código en vez de reimplementar la fórmula: comparar contra una copia distinta
// de la aritmética no diría nada sobre lo que el cliente ve en pantalla.
const caps = await probeCapabilities(pool);
const foto = await sampleVacuum(pool, caps);
const estimada = foto.tables.find((fila) => fila.schema === schema && fila.table === table);
const estimadoPct = estimada?.bloatPct ?? null;

for (const modo of ['aproximado', 'exacto'] as const) {
  const inicio = Date.now();
  const medicion = await measureBloat(pool, schema, table, modo, 5 * 60_000);
  const ms = Date.now() - inicio;
  console.log(
    `  ${modo.padEnd(11)} ${ms.toString().padStart(6)} ms · ` +
      `tabla ${(medicion.tableBytes / 1024 / 1024).toFixed(1)} MB · ` +
      `muerto ${medicion.deadPct.toFixed(2)} % · libre ${medicion.freePct.toFixed(2)} % · ` +
      `${medicion.tupleCount} tuplas`,
  );
}

console.log(
  `  estimación  ${' '.repeat(6)}    · desperdicio ` +
    (estimadoPct === null
      ? `no estimable (${estimada?.bloatNote ?? 'la tabla no aparece en la foto'})`
      : `${estimadoPct.toFixed(2)} % del heap`),
);

await pool.end();
