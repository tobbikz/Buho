/**
 * Abre la pantalla de índices y comprueba que la sugerencia se vea con su DDL.
 */
import { chromium } from 'playwright';

const BASE = process.env['BUHO_BASE'] ?? 'http://127.0.0.1:3100';
const USER = process.env['BUHO_USER'] ?? 'tomy';
const PASSWORD = process.env['BUHO_PASSWORD'] ?? 'contrasena-larga-1';
const INSTANCIA = process.env['BUHO_INSTANCE'] ?? '102';
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

const respuesta = await pagina.goto(`${BASE}/instances/${INSTANCIA}/indexes`, {
  waitUntil: 'domcontentloaded',
});
await pagina.waitForTimeout(1200);

const texto = (await pagina.textContent('body')) ?? '';
console.log('HTTP', respuesta?.status());
console.log('título:', (await pagina.textContent('h1'))?.trim());

const ddl = texto.match(/create index concurrently [^\s]+/);
console.log('DDL propuesto:', ddl?.[0] ?? '(ninguno)');
const descartadas = texto.match(/descartó el [\d.]+ %/);
console.log('evidencia:', descartadas?.[0] ?? '(ninguna)');

await navegador.close();
process.exit(ddl ? 0 : 1);
