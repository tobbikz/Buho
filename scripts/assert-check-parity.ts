/**
 * Fails CI / ensayo if foreign check catalogs are not 1:1 with PostgreSQL CHECKS.
 */
import {
  assertMariadbParity,
  assertMssqlParity,
  CHECKS,
  MARIADB_PARITY_CHECKS,
  MARIADB_PARITY_MAP,
  MSSQL_PARITY_CHECKS,
  MSSQL_PARITY_MAP,
} from '../packages/checks/src/index.ts';

assertMssqlParity();
assertMariadbParity();

const pg = CHECKS.map((c) => c.id);
const mssql = MSSQL_PARITY_CHECKS.map((c) => c.id);
const mariadb = MARIADB_PARITY_CHECKS.map((c) => c.id);

console.log(`PG checks: ${pg.length}`);
console.log(`MSSQL parity checks: ${mssql.length}`);
console.log(`MariaDB parity checks: ${mariadb.length}`);
for (const id of pg) {
  console.log(`  ${id.padEnd(32)} → ${MSSQL_PARITY_MAP[id]} · ${MARIADB_PARITY_MAP[id]}`);
}

if (pg.length !== mssql.length || pg.length !== mariadb.length) {
  console.error('LENGTH MISMATCH');
  process.exit(1);
}

console.log('OK: 23↔23↔23 PostgreSQL ↔ MSSQL ↔ MariaDB check parity');
