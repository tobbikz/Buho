/**
 * Verificación de los flujos de la consola que no se pueden comprobar con un
 * curl: los que dependen de sesión, rol y envío de formularios.
 *
 * No es una suite de pruebas —no hay aserciones que hagan fallar el proceso—
 * sino un recorrido que imprime lo que pasó, para leerlo después de tocar
 * autenticación, permisos o administración. Se dejó en el repo porque estos
 * cuatro flujos son fáciles de romper sin darse cuenta: un `requireAdmin`
 * olvidado en una acción nueva no rompe ninguna pantalla.
 *
 *   BUHO_URL=http://127.0.0.1:3100 \
 *   BUHO_ADMIN=usuario:contraseña BUHO_VIEWER=usuario:contraseña \
 *   node scripts/verify-console.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env['BUHO_URL'] ?? 'http://127.0.0.1:3100';
const [adminUser, adminPass] = (process.env['BUHO_ADMIN'] ?? '').split(':');
const [viewerUser, viewerPass] = (process.env['BUHO_VIEWER'] ?? '').split(':');

// El ejecutable se puede fijar cuando Playwright no encuentra su navegador
// (instalaciones donde los binarios viven en otra caché).
const executablePath = process.env['PW_CHROME'] || undefined;

const browser = await chromium.launch(executablePath ? { executablePath } : {});

function path(page) {
  const url = new URL(page.url());
  return url.pathname + url.search;
}

async function login(user, pass) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });

  if (user && (await page.locator('input[name="username"]').count())) {
    await page.fill('input[name="username"]', user);
  }
  await page.fill('input[name="password"]', pass);
  await page.click('button:has-text("Entrar")');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  return { context, page };
}

async function error(page) {
  const text = await page.locator('p.text-error').first().textContent().catch(() => null);
  return text?.trim() ?? null;
}

if (viewerUser) {
  const { context, page } = await login(viewerUser, viewerPass);
  console.log('viewer entra en', path(page));
  console.log('  ve el menú de administración:', (await page.locator('.sidebar__label:has-text("Administración")').count()) > 0);

  for (const route of ['/admin/users', '/admin/retention', '/admin/discovery', '/admin/audit']) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    console.log(`  ${route} →`, path(page));
  }
  for (const route of ['/security', '/estate', '/']) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    console.log(`  ${route} →`, path(page));
  }
  await context.close();
}

if (adminUser) {
  const { context, page } = await login(adminUser, adminPass);
  console.log('\nadmin entra en', path(page));

  await page.goto(`${BASE}/admin/discovery`, { waitUntil: 'networkidle' });
  await page.fill('input[name="ranges"]', '127.0.0.1');
  await page.click('button:has-text("Escanear")');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);
  const ok = await page.locator('p.text-success').first().textContent().catch(() => null);
  console.log('  descubrimiento:', ok?.trim() ?? '(sin mensaje)');

  await page.fill('input[name="ranges"]', '8.8.8.0/30');
  await page.click('button:has-text("Escanear")');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  console.log('  guardia de red pública:', (await error(page))?.slice(0, 90) ?? '(NO BLOQUEÓ)');

  await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"]', 'prueba');
  await page.fill('input[name="password"]', 'corta');
  await page.click('button:has-text("Crear")');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  console.log('  contraseña corta:', (await error(page)) ?? '(NO VALIDÓ)');

  await page.goto(`${BASE}/admin/audit`, { waitUntil: 'networkidle' });
  console.log('  bitácora:', await page.locator('table.data-table tbody tr').count(), 'registros');

  await context.close();
}

{
  // La contraseña compartida sólo debe servir mientras no exista ninguna cuenta.
  const { context, page } = await login('', 'contraseña-que-no-es');
  console.log('\ncredenciales inválidas →', path(page), '·', (await error(page)) ?? '(sin mensaje)');
  await context.close();
}

await browser.close();
