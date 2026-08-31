/**
 * Marca que llevan todas las consultas que Búho ejecuta contra una instancia
 * monitoreada.
 *
 * Sirve para separar el trabajo del monitor del trabajo de la aplicación en la
 * pantalla de consultas. Sin la marca, el ranking por número de llamadas lo
 * dominan las consultas de catálogo del propio Búho, y filtrarlas por patrones
 * de texto (`pg_stat_%`) esconde también las consultas legítimas del DBA.
 *
 * Va **al final** por una razón medida contra PG 18: `pg_stat_statements`
 * descarta los comentarios que preceden a la sentencia (el texto se guarda
 * desde `stmt_location`) y conserva los que van después. Un prefijo simplemente
 * desaparece. Es la misma razón por la que sqlcommenter añade sus etiquetas al
 * final.
 */
export const QUERY_TAG = '/* buho */';

export function tagged(sql: string): string {
  // El punto y coma cierra la sentencia: un comentario después queda fuera del
  // texto que registra pg_stat_statements.
  const clean = sql.replace(/[\s;]+$/, '');
  return `${clean} ${QUERY_TAG}`;
}
