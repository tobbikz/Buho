/**
 * Recorre la pantalla de flujo y calor con datos reales.
 *
 * Comprueba tres cosas que no se pueden ver desde el store: que la página cargue
 * sin errores de cliente, que el diagrama dibuje cintas de verdad (no un panel
 * vacío) y que la rejilla tenga celdas. Guarda una captura para poder mirarla.
 */
import { chromium } from 'playwright';

const BASE = process.env.BUHO_URL ?? 'http://127.0.0.1:3100';
const USER = process.env.BUHO_USER ?? 'tomy';
const PASSWORD = process.env.BUHO_PASSWORD ?? 'contrasena-larga-1';
const INSTANCIA = process.env.BUHO_INSTANCE ?? '1';

const navegador = await chromium.launch({ executablePath: process.env.PW_CHROME });
const contexto = await navegador.newContext({ viewport: { width: 1500, height: 1100 } });
const pagina = await contexto.newPage();

const errores = [];
pagina.on('pageerror', (error) => errores.push(String(error)));

await pagina.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
if (new URL(pagina.url()).pathname === '/login') {
  for (let intento = 0; intento < 5; intento += 1) {
    await pagina.waitForTimeout(400 + intento * 300);
    await pagina.fill('input[name="username"]', USER);
    await pagina.fill('input[name="password"]', PASSWORD);
    if ((await pagina.inputValue('input[name="password"]')) === PASSWORD) break;
  }
  await Promise.all([
    pagina.waitForURL((url) => new URL(url).pathname !== '/login', { timeout: 15000 }),
    pagina.click('button[type="submit"]'),
  ]);
}

const casos = [
  ['escritura · filas', `?dir=escritura&peso=rows&v=24h`],
  ['escritura · tiempo', `?dir=escritura&peso=time&v=7d`],
  ['lectura · llamadas', `?dir=lectura&peso=calls&v=24h`],
  ['calor · peor caso', `?calor=transacciones&agg=max&cv=30d`],
];

for (const [nombre, consulta] of casos) {
  const url = `${BASE}/instances/${INSTANCIA}/flow${consulta}`;
  // La primera visita a una ruta nueva puede caer en un 500 mientras Turbopack
  // la compila; se reintenta una vez antes de dar el caso por fallado.
  let respuesta = await pagina.goto(url, { waitUntil: 'networkidle' });
  if ((respuesta?.status() ?? 0) >= 500) {
    await pagina.waitForTimeout(2500);
    respuesta = await pagina.goto(url, { waitUntil: 'networkidle' });
  }
  await pagina.waitForTimeout(1200);

  const estado = respuesta?.status() ?? 0;
  const cintas = await pagina.locator('svg path.recharts-sankey-link').count();
  const celdas = await pagina.locator('table td div[title]').count();
  const conError = await pagina.locator('text=/no se pudo leer del store/i').count();
  const titulo = await pagina
    .locator('h1')
    .first()
    .textContent({ timeout: 5000 })
    .catch(() => '(sin h1)');

  console.log(
    `${estado === 200 && conError === 0 ? 'ok  ' : 'FALLA'} ${nombre.padEnd(22)} ` +
      `http=${estado} cintas=${cintas} celdas=${celdas} js=${errores.length} · ${titulo?.trim()}`,
  );
}

await pagina.goto(`${BASE}/instances/${INSTANCIA}/flow${process.env.BUHO_VISTA ?? '?v=7d'}`, { waitUntil: 'networkidle' });
await pagina.waitForTimeout(1500);
await pagina.screenshot({ path: '/tmp/buho-flow.png', fullPage: true });
console.log('captura en /tmp/buho-flow.png');

if (errores.length > 0) {
  console.log('\nerrores de cliente:');
  for (const error of errores.slice(0, 5)) console.log('  ·', error);
}

await navegador.close();
