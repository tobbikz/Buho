/**
 * Responsive smoke: login → fleet → open drawer (mobile) → screenshot viewports.
 *   npx playwright test scripts/responsive-smoke.mjs  (or node with playwright)
 */
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BUHO_WEB_URL ?? 'http://127.0.0.1:3101';
const USER = process.env.BUHO_AUTH_USER ?? 'smoke';
const PASS = process.env.BUHO_AUTH_PASSWORD ?? 'smoke-test-pass';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../tmp/responsive');

mkdirSync(OUT, { recursive: true });

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  const user = page.locator('input[name="username"]').first();
  const password = page.locator('input[name="password"]').first();
  if (await password.count()) {
    if (await user.count()) await user.fill(USER);
    await password.fill(PASS);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
  }
}

async function shot(page, name) {
  const path = join(OUT, name);
  await page.screenshot({ path, fullPage: true });
  console.log(`ok ${name}`);
}

async function assertNoHorizontalBleed(page, label) {
  const bleed = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      clientWidth: doc.clientWidth,
      scrollWidth: doc.scrollWidth,
      bodyScroll: document.body.scrollWidth,
    };
  });
  const overflow = Math.max(bleed.scrollWidth, bleed.bodyScroll) - bleed.clientWidth;
  if (overflow > 8) {
    throw new Error(`${label}: horizontal overflow ${overflow}px (client=${bleed.clientWidth})`);
  }
  console.log(`ok no-bleed ${label} (Δ${overflow}px)`);
}

async function runViewport(browser, name, size, opts = {}) {
  const context = await browser.newContext({
    viewport: size,
    ...opts,
  });
  const page = await context.newPage();
  await login(page);
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await assertNoHorizontalBleed(page, `${name}/fleet`);
  await shot(page, `${name}-fleet.png`);

  // Burger should exist under 1024
  if (size.width <= 1024) {
    const burger = page.locator('.navbar__burger');
    await burger.waitFor({ state: 'visible', timeout: 5000 });
    await burger.click();
    await page.locator('.app-shell--nav-open .sidebar-col').waitFor({ state: 'visible' });
    await shot(page, `${name}-drawer.png`);
    await page.locator('.nav-backdrop').click({ force: true });
  } else {
    const burger = page.locator('.navbar__burger');
    if (await burger.isVisible().catch(() => false)) {
      throw new Error('desktop should not show burger');
    }
    console.log('ok desktop no-burger');
  }

  await page.goto(`${BASE}/get-started`, { waitUntil: 'networkidle' });
  await assertNoHorizontalBleed(page, `${name}/get-started`);
  await shot(page, `${name}-get-started.png`);

  await context.close();
}

const browser = await chromium.launch({ headless: true });
try {
  await runViewport(browser, 'phone', { width: 390, height: 844 });
  await runViewport(browser, 'tablet', { width: 768, height: 1024 });
  await runViewport(browser, 'desktop', { width: 1440, height: 900 });
  console.log(`screenshots → ${OUT}`);
} finally {
  await browser.close();
}
