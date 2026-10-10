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
/**
 * Lab default when Admin → Users exists: `smoke` / `smoke-test-pass`.
 * Shared BUHO_AUTH_PASSWORD alone fails once users are seeded.
 */
const USER = process.env['BUHO_USER'] ?? 'smoke';
const PASSWORD =
  process.env['BUHO_PASSWORD'] ?? process.env['BUHO_SMOKE_PASSWORD'] ?? 'smoke-test-pass';
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
  await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 60_000 });

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
      await page.waitForLoadState('load');
      console.log('· sesión iniciada');
      return;
    } catch {
      if (new URL(page.url()).searchParams.has('error')) {
        console.error('✗ la consola rechazó la contraseña');
        process.exit(1);
      }
    }
    await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 60_000 });
  }

  console.error('✗ no se pudo entrar: revisar BUHO_USER y BUHO_PASSWORD');
  process.exit(1);
}

async function ver(nombre, ruta, esperado) {
  clientErrors = [];
  // `load` (not networkidle): live charts / polling keep the network busy and
  // make networkidle hang forever on pages like /report.
  const respuesta = await page.goto(`${BASE}${ruta}`, { waitUntil: 'load', timeout: 60_000 });
  const codigo = respuesta?.status() ?? 0;
  const cuerpo = await page.locator('body').innerText();

  const problemas = [];
  if (codigo >= 400) problemas.push(`HTTP ${codigo}`);
  // The store error panel returns 200: match by copy, not status.
  if (/Could not read the store|Store URL is missing|Falta la URL del store|No se pudo leer el store/i.test(cuerpo)) {
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

// Fleet screens — do not require a monitored instance.
await ver('Fleet overview', '/', 'Fleet');
await ver('Fleet checks', '/checks');
await ver('Weekly report', '/report', 'Weekly report');
await ver('Weekly report, prior week', '/report?semana=1');
await ver('Estate: versions', '/estate/versions');
await ver('Estate: configuration', '/estate/configuration');
await ver('Estate: disk', '/estate/disk');
await ver('Estate: replication', '/estate/replication');
await ver('Estate: backups', '/estate');
await ver('Estate: jobs', '/estate/jobs');
await ver('Estate: licensing', '/estate/licensing');
await ver('Security', '/security');
await ver('Security: accounts', '/security/accounts');
await ver('Security: coverage', '/security/coverage');
await ver('Admin: users', '/admin/users');
await ver('Admin: retention', '/admin/retention');
await ver('Admin: discovery', '/admin/discovery');
await ver('Admin: audit', '/admin/audit');
await ver('Admin: targets', '/admin/targets');
await ver('Databases alerts', '/alerts');
await ver('Estate RPO', '/estate/rpo', 'RPO');

// Observability FEAT wave (excl. host inventory)
await ver('Obs: Services', '/observability/services', 'Services');
await ver('Obs: App logs', '/observability/app-logs', 'App logs');
await ver('Obs: DB logs', '/observability/logs', 'DB logs');
await ver('Obs: Probes', '/observability/synthetics', 'Probe');
await ver('Obs: App alerts', '/observability/alerts', 'alert');
await ver('Obs: Probe RPO', '/observability/rpo', 'Probe RPO');
await ver('Obs: APM setup', '/observability/apm/setup', 'APM');
await ver('Obs: Traces', '/observability/apm/traces');
await ver('Obs: Service map', '/observability/map');
await ver('Obs: Security cases', '/observability/security/cases', 'Cases');
await ver('Obs: Security alerts', '/observability/security/alerts');
await ver('Obs: Security findings', '/observability/security/findings');

// Report download: deliverable route, separate from the page.
const exportacion = await context.request.get(`${BASE}/report/export`);
const markdown = await exportacion.text();
if (exportacion.status() !== 200 || !markdown.startsWith('# Weekly database report')) {
  errores.push(`Report download: HTTP ${exportacion.status()}`);
  console.log(`✗ ${'Report download'.padEnd(28)} HTTP ${exportacion.status()}`);
} else {
  console.log(`✓ ${'Report download'.padEnd(28)} ${markdown.length} bytes of Markdown`);
}

// Instance screens — pick the first instance link in the sidebar.
await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60_000 });
const enlaces = await page.locator('.sidebar a[href^="/instances/"]').all();
const ids = [];
for (const enlace of enlaces) {
  const href = await enlace.getAttribute('href');
  const id = href?.match(/\/instances\/(\d+)/)?.[1];
  if (id && !ids.includes(id)) ids.push(id);
}

if (ids.length === 0) {
  console.log('· no instances in the store: skipping instance screens');
} else {
  // Prefer an explicit id when engines are mixed; Postgres has the widest surface.
  const id = process.env['BUHO_INSTANCE'] ?? ids[0];
  console.log(`· using instance ${id} (of ${ids.length} in the sidebar)`);
  await ver('Instance: overview', `/instances/${id}`);
  await ver('Instance: analysis', `/instances/${id}/analysis?m=connections_total`);
  await ver('Instance: queries', `/instances/${id}/queries`);
  await ver('Instance: host', `/instances/${id}/host`);
  await ver('Instance: locks', `/instances/${id}/locks`);
  await ver('Instance: vacuum', `/instances/${id}/vacuum`);
  await ver('Instance: replication', `/instances/${id}/replication`);
  await ver('Instance: logs', `/instances/${id}/logs`);
  await ver('Fleet: flow', '/flow');
  await ver('Instance: sessions', `/instances/${id}/sessions`);
  await ver('Instance: flow', `/instances/${id}/flow`);
  await ver('Instance: capacity', `/instances/${id}/capacity`);
  await ver('Instance: topology', `/instances/${id}/topology`);
  await ver('Instance: analysis vs 24h', `/instances/${id}/analysis?m=connections_total&vs=24h`);
}

await browser.close();

console.log('');
if (errores.length > 0) {
  console.log(`${errores.length} pantalla(s) con problemas:`);
  for (const error of errores) console.log(`  - ${error}`);
  process.exit(1);
}
console.log('Todas las pantallas responden.');
