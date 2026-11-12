'use strict';
// Browser regression against the production admin bundle with synthetic API data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const origin = 'https://synthetic-admin.example.invalid';
const dist = path.resolve(__dirname, '../admin-panel/dist');
const profile = {
  characterName: 'Салем', characterGender: 'женский', currentCity: '', persona: '',
  communicationStyle: '', biography: '', ownerName: '', ownerUsername: '',
  userName: '', userBirthDate: '', moodVariants: '', defaultMood: '', proactiveMessageHint: '',
};

async function main() {
  assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'Run npm run build:admin first');
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let current = { ...profile };
  try {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/personality') {
        if (route.request().method() === 'POST') {
          current = route.request().postDataJSON().KiraMindBot;
          return route.fulfill({ json: { success: true } });
        }
        return route.fulfill({ json: { KiraMindBot: current } });
      }
      if (url.pathname === '/api/config') return route.fulfill({ json: {} });
      if (url.pathname === '/api/auth/context') return route.fulfill({ json: { csrfEnabled: false } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'synthetic unavailable' } });
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(dist, relative);
      if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const mime = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css'
        : file.endsWith('.html') ? 'text/html' : file.endsWith('.json') || file.endsWith('.webmanifest') ? 'application/json' : 'image/png';
      return route.fulfill({ path: file, contentType: mime });
    });
    await page.goto(origin + '/');
    await page.getByText('Салем', { exact: true }).first().waitFor({ timeout: 5000 }).catch(async error => {
      throw new Error(`${error.message}\nPage errors: ${pageErrors.join('; ')}\nBody: ${(await page.locator('body').innerText()).slice(0, 1000)}`);
    });
    assert.match(await page.title(), /^Салем/);
    await page.getByRole('button', { name: 'Личность' }).first().click();
    await page.getByText('Салем — Личность и характер').waitFor();
    await page.getByLabel('Имя ассистента').fill('Мира');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.getByText('Мира', { exact: true }).first().waitFor();
    assert.match(await page.title(), /^Мира/);
    await page.getByRole('button', { name: 'Настройки' }).first().click();
    await page.getByRole('tab', { name: 'Система' }).click();
    await page.getByText('Проактивность и переписки').click();
    const unit = page.getByRole('dialog', { name: 'Проактивность и переписки' }).getByRole('combobox').first();
    await unit.waitFor();
    const background = await unit.evaluate(element => getComputedStyle(element).backgroundColor);
    assert.doesNotMatch(background, /rgb\(1[0-9], 1[0-9], 2[0-9]\)/, 'duration unit has a dark background');
    if (process.env.KIRA_UI_SCREENSHOT_PATH) {
      await page.waitForTimeout(250);
      await page.screenshot({ path: process.env.KIRA_UI_SCREENSHOT_PATH });
    }
    assert.deepEqual(pageErrors, []);
    console.log('Admin personalization and duration unit styling passed');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
