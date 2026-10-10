/**
 * Recorre las pantallas de MariaDB y SQL Server en la consola.
 *
 * Comprueba tres cosas por pantalla: que responda 200, que no tire errores de
 * JavaScript en el cliente, y que no muestre el panel de error del store. Lo que
 * no comprueba es que los números estén bien; para eso está probe-parity.
 *
 *   BUHO_PASSWORD=... node scripts/verify-parity.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env['BUHO_BASE'] ?? 'http://127.0.0.1:3100';
const USER = process.env['BUHO_USER'] ?? 'smoke';
const PASSWORD =
  process.env['BUHO_PASSWORD'] ?? process.env['BUHO_SMOKE_PASSWORD'] ?? 'smoke-test-pass';
/** Lab defaults (2026-10): maria-1 / mssql-lab / brain — override via env. */
const MARIA = process.env['BUHO_MARIADB'] ?? '6323';
const MSSQL = process.env['BUHO_MSSQL'] ?? '6324';
const PG = process.env['BUHO_POSTGRES'] ?? '6311';

const pantallas = [
  ['MariaDB: resumen', `/instances/${MARIA}`],
  ['MariaDB: análisis', `/instances/${MARIA}/analysis`],
  ['MariaDB: consultas', `/instances/${MARIA}/queries`],
  ['MariaDB: bloqueos', `/instances/${MARIA}/locks`],
  ['MariaDB: log', `/instances/${MARIA}/logs`],
  ['MariaDB: flujo y uso', `/instances/${MARIA}/flow`],
  ['MariaDB: sesiones', `/instances/${MARIA}/sessions`],
  ['MariaDB: inventario', `/instances/${MARIA}/inventory`],
  ['SQL Server: resumen', `/instances/${MSSQL}`],
  ['SQL Server: análisis', `/instances/${MSSQL}/analysis`],
  ['SQL Server: consultas', `/instances/${MSSQL}/queries`],
  ['SQL Server: bloqueos', `/instances/${MSSQL}/locks`],
  ['SQL Server: log', `/instances/${MSSQL}/logs`],
  ['SQL Server: flujo y uso', `/instances/${MSSQL}/flow`],
  ['SQL Server: sesiones', `/instances/${MSSQL}/sessions`],
  ['SQL Server: inventario', `/instances/${MSSQL}/inventory`],
  ['PostgreSQL: vacuum y bloat medido', `/instances/${PG}/vacuum`],
  ['PostgreSQL: flujo y uso', `/instances/${PG}/flow`],
  ['PostgreSQL: sesiones', `/instances/${PG}/sessions`],
  ['PostgreSQL: sugeridor de índices', `/instances/${PG}/indexes`],
  ['Chequeos de flota', '/checks'],
  ['Informe semanal', '/report'],
];

// Igual que verify:v1: si Playwright no bajó su propio Chromium, se acepta el
// del sistema por PW_CHROME en vez de fallar.
const ejecutable = process.env['PW_CHROME'] || undefined;
const navegador = await chromium.launch(ejecutable ? { executablePath: ejecutable } : {});
const contexto = await navegador.newContext();
const pagina = await contexto.newPage();

const errores = [];
pagina.on('pageerror', (error) => errores.push(error.message));

async function entrar() {
  for (let intento = 0; intento < 5; intento += 1) {
    await pagina.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    if (new URL(pagina.url()).pathname !== '/login') return;
    await pagina.waitForTimeout(400 + intento * 400);
    await pagina.fill('input[name="username"]', USER).catch(() => {});
    await pagina.fill('input[name="password"]', PASSWORD);
    if ((await pagina.inputValue('input[name="password"]')) !== PASSWORD) continue;
    await Promise.all([
      pagina.waitForURL((url) => new URL(url).pathname !== '/login', { timeout: 10_000 }).catch(() => {}),
      pagina.click('button[type="submit"]'),
    ]);
    if (new URL(pagina.url()).pathname !== '/login') return;
  }
  throw new Error('no se pudo entrar a la consola');
}

await entrar();
console.log('sesión iniciada\n');

let fallos = 0;
for (const [nombre, ruta] of pantallas) {
  errores.length = 0;
  const respuesta = await pagina.goto(`${BASE}${ruta}`, { waitUntil: 'domcontentloaded' });
  await pagina.waitForTimeout(700);

  const estado = respuesta?.status() ?? 0;
  const texto = await pagina.textContent('body').catch(() => '');
  const storeError = /could not read the store|store url is missing|no se pudo leer del store|error de base de datos/i.test(texto ?? '');
  const titulo = (await pagina.textContent('h1').catch(() => null))?.trim() ?? '(sin título)';

  const problemas = [];
  if (estado !== 200) problemas.push(`HTTP ${estado}`);
  if (storeError) problemas.push('error del store en pantalla');
  if (errores.length > 0) problemas.push(`JS: ${errores[0]}`);

  if (problemas.length === 0) {
    console.log(`  ✓ ${nombre} — "${titulo}"`);
  } else {
    console.log(`  ✗ ${nombre} — ${problemas.join(' · ')}`);
    fallos += 1;
  }
}

await navegador.close();
console.log('');
if (fallos > 0) {
  console.log(`${fallos} pantalla(s) con problemas`);
  process.exit(1);
}
console.log('todas las pantallas de los tres motores responden');
