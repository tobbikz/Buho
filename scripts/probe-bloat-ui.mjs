/**
 * Aprieta "medir" en la pantalla de vacuum y espera el resultado.
 *
 * Comprueba el camino completo: la consola encola, el colector mide contra la
 * instancia y la celda pasa de "en cola" a un porcentaje real.
 */
import { chromium } from 'playwright';

const BASE = process.env['BUHO_BASE'] ?? 'http://127.0.0.1:3100';
const USER = process.env['BUHO_USER'] ?? 'tomy';
const PASSWORD = process.env['BUHO_PASSWORD'] ?? 'contrasena-larga-1';
const INSTANCIA = process.env['BUHO_INSTANCE'] ?? '82';
const ejecutable = process.env['PW_CHROME'] || undefined;

const navegador = await chromium.launch(ejecutable ? { executablePath: ejecutable } : {});
const pagina = await (await navegador.newContext()).newPage();
pagina.on('pageerror', (error) => console.log('  JS:', error.message));

for (let intento = 0; intento < 5; intento += 1) {
  await pagina.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  if (new URL(pagina.url()).pathname !== '/login') break;
  await pagina.waitForTimeout(400 + intento * 400);
  await pagina.fill('input[name="username"]', USER).catch(() => {});
  await pagina.fill('input[name="password"]', PASSWORD);
  if ((await pagina.inputValue('input[name="password"]')) !== PASSWORD) continue;
  await Promise.all([
    pagina.waitForURL((url) => new URL(url).pathname !== '/login', { timeout: 10_000 }).catch(() => {}),
    pagina.click('button[type="submit"]'),
  ]);
  if (new URL(pagina.url()).pathname !== '/login') break;
}
console.log('sesión iniciada');

await pagina.goto(`${BASE}/instances/${INSTANCIA}/vacuum`, { waitUntil: 'domcontentloaded' });
await pagina.waitForTimeout(1200);

const medir = pagina.locator('text=medir →').first();
if ((await medir.count()) === 0) {
  const cuerpo = (await pagina.textContent('body')) ?? '';
  console.log('no hay botón de medir. ¿aparece la palabra?', cuerpo.includes('medir'));
  console.log('no disponible:', cuerpo.includes('no disponible'));
  const indice = cuerpo.indexOf('Desperdicio estimado');
  console.log(cuerpo.slice(indice, indice + 500));
  await navegador.close();
  process.exit(1);
}

const fila = medir.locator('xpath=ancestor::tr[1]');
console.log('tabla elegida:', ((await fila.textContent()) ?? '').slice(0, 80).trim());

await medir.click();
await pagina.waitForTimeout(300);
await pagina.locator('button:has-text("exacto")').first().click();
await pagina.waitForTimeout(1500);

let resultado = '';
for (let espera = 0; espera < 20; espera += 1) {
  const texto = (await pagina.textContent('body')) ?? '';
  if (/% muerto/.test(texto)) {
    const encontrado = texto.match(/[\d.]+% muerto, [\d.]+% libre/);
    resultado = encontrado?.[0] ?? 'medido';
    break;
  }
  if (/falló/.test(texto)) {
    resultado = 'falló';
    break;
  }
  await pagina.waitForTimeout(1500);
  await pagina.reload({ waitUntil: 'domcontentloaded' });
}

console.log(resultado ? `resultado en pantalla: ${resultado}` : 'la medición no terminó a tiempo');
await navegador.close();
process.exit(resultado && resultado !== 'falló' ? 0 : 1);
