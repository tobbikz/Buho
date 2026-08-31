/**
 * Recorrido completo de la consola: entra y abre todas las pantallas.
 *
 * Existe para contestar una sola pregunta antes de publicar: ¿hay alguna
 * pantalla que se cae? Comprueba el código HTTP, que no haya errores de
 * JavaScript en el cliente y que el contenido no sea el panel de error del
 * store, que devuelve 200 y parece una página buena.
 *
 * Sale con código 1 si algo falló, así que sirve en CI.
 *
 *   BUHO_URL=http://127.0.0.1:3100 BUHO_PASSWORD=... node scripts/verify-v1.mjs
 */

import { chromium } from 'playwright';

const BASE = (process.env['BUHO_URL'] ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const USER = process.env['BUHO_USER'] ?? '';
const PASSWORD = process.env['BUHO_PASSWORD'] ?? '';
const executablePath = process.env['PW_CHROME'] || undefined;

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await context.newPage();

const errores = [];
let clientErrors = [];
page.on('pageerror', (error) => clientErrors.push(error.message));
if (process.env['BUHO_DEBUG']) {
  page.on('request', (r) => r.method() === 'POST' && console.log('[POST]', r.url(), (r.postData() ?? '').includes('ACTION_ID') ? 'con action id' : 'SIN action id'));
  page.on('response', (r) => r.request().method() === 'POST' && console.log('[RESP]', r.status(), r.headers()['location'] ?? ''));
}

/**
 * Entra a la consola.
 *
 * El detalle que cuesta descubrir: si se escribe la contraseña antes de que la
 * página hidrate, React monta el input y lo deja vacío, así que el formulario
 * se manda sin contraseña y la respuesta es indistinguible de una credencial
 * mala. De ahí la comprobación de que el valor quedó escrito antes de enviar.
 */
async function login() {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });

  if (new URL(page.url()).pathname !== '/login') {
    console.log('· ya había sesión abierta');
    return;
  }
  if ((await page.locator('input[name="password"]').count()) === 0) {
    console.log('· la consola corre sin autenticación; no hay login que hacer');
    return;
  }

  const campo = page.locator('input[name="password"]');
  for (const intento of [1, 2, 3]) {
    await page.waitForTimeout(1000 * intento);
    if (USER && (await page.locator('input[name="username"]').count())) {
      await page.fill('input[name="username"]', USER);
    }
    await campo.fill(PASSWORD);
    await page.waitForTimeout(400);
    if ((await campo.inputValue()) !== PASSWORD) continue; // hidrató encima; reintentar

    await page.click('button[type="submit"]');

    // La navegación la hace el cliente después de que la acción responde: hay
    // que esperar el cambio de URL, no la carga de la página.
    try {
      await page.waitForURL((url) => new URL(url).pathname !== '/login', { timeout: 15_000 });
      await page.waitForLoadState('networkidle');
      console.log('· sesión iniciada');
      return;
    } catch {
      if (new URL(page.url()).searchParams.has('error')) {
        console.error('✗ la consola rechazó la contraseña');
        process.exit(1);
      }
    }
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  }

  console.error('✗ no se pudo entrar: revisar BUHO_USER y BUHO_PASSWORD');
  process.exit(1);
}

async function ver(nombre, ruta, esperado) {
  clientErrors = [];
  const respuesta = await page.goto(`${BASE}${ruta}`, { waitUntil: 'networkidle' });
  const codigo = respuesta?.status() ?? 0;
  const cuerpo = await page.locator('body').innerText();

  const problemas = [];
  if (codigo >= 400) problemas.push(`HTTP ${codigo}`);
  // El panel de error del store responde 200: hay que buscarlo por texto.
  if (/No se pudo leer el store|Falta la URL del store/i.test(cuerpo)) {
    problemas.push('error del store en pantalla');
  }
  if (clientErrors.length > 0) problemas.push(`error de cliente: ${clientErrors[0]}`);
  if (esperado && !new RegExp(esperado, 'i').test(cuerpo)) {
    problemas.push(`no aparece "${esperado}"`);
  }

  if (problemas.length > 0) {
    errores.push(`${nombre} (${ruta}): ${problemas.join('; ')}`);
    console.log(`✗ ${nombre.padEnd(28)} ${problemas.join('; ')}`);
  } else {
    console.log(`✓ ${nombre.padEnd(28)} ${ruta}`);
  }
}

await login();

// Pantallas de flota, que no dependen de que exista ninguna instancia.
await ver('Resumen de flota', '/', 'Flota');
await ver('Chequeos de la flota', '/checks');
await ver('Informe semanal', '/report', 'Informe');
await ver('Informe, semana anterior', '/report?semana=1');
await ver('Parque: versiones', '/estate/versions');
await ver('Parque: configuración', '/estate/configuration');
await ver('Parque: disco', '/estate/disk');
await ver('Parque: replicación', '/estate/replication');
await ver('Parque: respaldos', '/estate');
await ver('Parque: jobs', '/estate/jobs');
await ver('Parque: licencias', '/estate/licensing');
await ver('Seguridad', '/security');
await ver('Seguridad: cuentas', '/security/accounts');
await ver('Seguridad: cobertura', '/security/coverage');
await ver('Administración: usuarios', '/admin/users');
await ver('Administración: retención', '/admin/retention');
await ver('Administración: descubrimiento', '/admin/discovery');
await ver('Administración: auditoría', '/admin/audit');

// Descarga del informe: es el entregable, y una ruta aparte de la pantalla.
const exportacion = await context.request.get(`${BASE}/report/export`);
const markdown = await exportacion.text();
if (exportacion.status() !== 200 || !markdown.startsWith('# Informe semanal')) {
  errores.push(`Descarga del informe: HTTP ${exportacion.status()}`);
  console.log(`✗ ${'Descarga del informe'.padEnd(28)} HTTP ${exportacion.status()}`);
} else {
  console.log(`✓ ${'Descarga del informe'.padEnd(28)} ${markdown.length} bytes de Markdown`);
}

// Pantallas por instancia, con la primera instancia que aparezca en la barra.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const enlaces = await page.locator('.sidebar a[href^="/instances/"]').all();
const ids = [];
for (const enlace of enlaces) {
  const href = await enlace.getAttribute('href');
  const id = href?.match(/\/instances\/(\d+)/)?.[1];
  if (id && !ids.includes(id)) ids.push(id);
}

if (ids.length === 0) {
  console.log('· no hay instancias en el store: se omiten las pantallas de instancia');
} else {
  // Con motores mezclados conviene fijar la instancia: las pantallas de
  // PostgreSQL son las que más superficie tienen.
  const id = process.env['BUHO_INSTANCE'] ?? ids[0];
  console.log(`· usando la instancia ${id} (de ${ids.length} en la barra)`);
  await ver('Instancia: resumen', `/instances/${id}`);
  await ver('Instancia: análisis', `/instances/${id}/analysis?m=connections_total`);
  await ver('Instancia: consultas', `/instances/${id}/queries`);
  await ver('Instancia: host', `/instances/${id}/host`);
  await ver('Instancia: bloqueos', `/instances/${id}/locks`);
  await ver('Instancia: vacuum', `/instances/${id}/vacuum`);
  await ver('Instancia: replicación', `/instances/${id}/replication`);
  await ver('Instancia: log', `/instances/${id}/logs`);
}

await browser.close();

console.log('');
if (errores.length > 0) {
  console.log(`${errores.length} pantalla(s) con problemas:`);
  for (const error of errores) console.log(`  - ${error}`);
  process.exit(1);
}
console.log('Todas las pantallas responden.');
