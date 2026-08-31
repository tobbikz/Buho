/**
 * Prueba la extracción de objetos contra los textos de consulta reales del store.
 *
 * No es una prueba automatizada con afirmaciones: es una forma de mirar, sobre
 * consultas de verdad, cuántas se pueden atribuir y qué aspecto tiene lo que no
 * se pudo. Ese porcentaje es el que hay que poner en la pantalla al lado del
 * diagrama, porque es el margen de error de la atribución.
 */
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { statementObjects } from '../packages/core/src/sqlobjects';

const config = JSON.parse(await readFile('config.json', 'utf8')) as {
  store: { url: string };
};
const pool = new Pool({ connectionString: config.store.url, max: 2 });

const { rows } = await pool.query<{ instance_id: string; query: string }>(
  `select instance_id, query from buho.statement_texts limit 4000`,
);

const porOperacion = new Map<string, number>();
const sinDestino: string[] = [];
let conDestino = 0;
let conFuentes = 0;

for (const row of rows) {
  const objetos = statementObjects(row.query);
  porOperacion.set(objetos.operation, (porOperacion.get(objetos.operation) ?? 0) + 1);
  if (objetos.target) conDestino += 1;
  else if (objetos.operation !== 'select' && objetos.operation !== 'other') {
    sinDestino.push(row.query.slice(0, 100));
  }
  if (objetos.sources.length > 0) conFuentes += 1;
}

const escrituras = ['insert', 'update', 'delete', 'copy', 'truncate'].reduce(
  (suma, clave) => suma + (porOperacion.get(clave) ?? 0),
  0,
);

console.log(`${rows.length} textos de consulta`);
console.log('por operación:', Object.fromEntries(porOperacion));
console.log(
  `escrituras con destino identificado: ${conDestino} de ${escrituras}` +
    (escrituras > 0 ? ` (${((conDestino / escrituras) * 100).toFixed(1)} %)` : ''),
);
console.log(`consultas con al menos una tabla leída: ${conFuentes}`);

if (sinDestino.length > 0) {
  console.log(`\nescrituras sin destino (${sinDestino.length}), primeras 10:`);
  for (const texto of sinDestino.slice(0, 10)) console.log('  ·', texto);
}

// Una muestra de lo que sí se reconoció, para revisar a ojo que no esté
// atribuyendo cosas raras.
console.log('\nmuestra de atribución:');
for (const row of rows.slice(0, 8)) {
  const objetos = statementObjects(row.query);
  console.log(
    `  ${objetos.operation.padEnd(6)} destino=${(objetos.target ?? '—').padEnd(34)} ` +
      `fuentes=${objetos.sources.slice(0, 3).join(', ') || '—'}`,
  );
}

await pool.end();
