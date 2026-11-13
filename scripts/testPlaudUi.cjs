'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const origin = 'https://synthetic-admin.example.invalid';
const dist = path.resolve(__dirname, '../admin-panel/dist');
const connected = { id: 'plaud', config: { description: 'Учебные записи', transport: 'http', url: 'https://mcp.plaud.ai/mcp',
  tools: { get_transcript: 'read' }, plaudGrant: null, timeoutMs: 30000 } };

async function main() {
  assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'Run npm run build:admin first');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      const failures = [];
      let starts = 0, finishes = 0;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        try {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin === 'https://mcp.plaud.ai') {
            assert.equal(url.pathname, '/authorize');
            return await route.fulfill({ contentType: 'text/html', body: `<meta http-equiv="refresh" content="0;url=${origin}/operator/?state=synthetic-state&amp;code=synthetic-code">` });
          }
          if (url.origin !== origin) return await route.abort();
          const local = url.pathname.replace(/^\/operator/, '');
          if (local === '/api/config') return await route.fulfill({ json: {} });
          if (local === '/api/personality') return await route.fulfill({ json: { KiraMindBot: { characterName: 'Учебный бот' } } });
          if (local === '/api/auth/context') return await route.fulfill({ json: { csrfEnabled: true, csrfToken: 'synthetic-csrf' } });
          if (local === '/api/mcp/servers') return await route.fulfill({ json: { revision: 'initial', servers: [], templates: [] } });
          if (local === '/api/mcp/plaud/start') {
            starts++;
            assert.deepEqual(request.postDataJSON(), { revision: 'initial' });
            assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf');
            return await route.fulfill({ json: { url: 'https://mcp.plaud.ai/authorize' } });
          }
          if (local === '/api/mcp/plaud/finish') {
            finishes++;
            assert.deepEqual(request.postDataJSON(), { state: 'synthetic-state', code: 'synthetic-code' });
            return await route.fulfill({ json: { revision: 'connected', templates: [], servers: [connected] } });
          }
          if (local.startsWith('/api/')) return await route.fulfill({ status: 503, json: { error: 'Synthetic unavailable' } });
          const file = path.resolve(dist, local === '/' ? 'index.html' : local.slice(1));
          if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return await route.fulfill({ status: 404 });
          return await route.fulfill({ path: file });
        } catch (error) {
          failures.push(error);
          await route.abort();
        }
      });
      try {
        await page.goto(origin + '/operator/');
        await page.getByRole('tab', { name: 'Подключения' }).click({ timeout: 10_000 });
        await page.getByRole('button', { name: 'Подключить Plaud' }).click({ timeout: 10_000 });
        await page.getByRole('button', { name: 'Войти заново' }).waitFor({ timeout: 10_000 });
        assert.equal(new URL(page.url()).search, '');
        assert.equal(starts, 1);
        assert.equal(finishes, 1);
        await page.getByRole('button', { name: 'Настроить', exact: true }).click();
        await page.getByText('Выбери, какие данные бот может читать в Plaud.').waitFor();
        assert.equal(await page.getByLabel('Адрес MCP').count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Отключить' }).count(), 1);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
        console.log(`Plaud browser flow passed at ${width} px`);
      } catch (error) {
        throw new Error(`${error.message}\n${page.url()}\n${errors.join('\n')}\n${(await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')).slice(0, 1200)}`);
      } finally {
        await page.close();
        if (failures.length) throw failures[0];
      }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
