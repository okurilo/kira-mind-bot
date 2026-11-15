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
    for (const [width, scoped] of [[1280, false], [390, true]]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
      const accounts = ids.map((id, index) => ({
        id, username: `synthetic_${index}`, accountState: 'active', runtimeMode: 'telegram',
        status: 'ready', bot: { username: `synthetic_${index}_bot`, connected: true }, canConnectBot: false,
      }));
      const errors = [];
      const failures = [];
      let starts = 0, finishes = 0, connectedReads = 0;
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
          const unscoped = url.pathname.replace(/^\/operator/, '');
          const match = /^\/api\/account-scopes\/([^/]+)\/(.+)$/.exec(unscoped);
          const account = match?.[1];
          const local = match ? '/api/' + match[2] : unscoped;
          const json = body => route.fulfill({ json: body, ...(account && { headers: { 'x-kira-account-id': account } }) });
          if (local === '/api/accounts') return await json({
            version: 1, available: scoped, accounts: scoped ? (starts ? [...accounts].reverse() : accounts) : [],
          });
          if (local === '/api/config') return await json({});
          if (local === '/api/personality') return await json({ KiraMindBot: { characterName: 'Учебный бот' } });
          if (local === '/api/auth/context') return await route.fulfill({ json: { csrfEnabled: true, csrfToken: 'synthetic-csrf' } });
          if (local === '/api/mcp/servers') {
            if (account === ids[0] && finishes) {
              connectedReads++;
              return await json({ revision: 'connected', servers: [connected], templates: [] });
            }
            return await json({ revision: 'initial', servers: [], templates: [] });
          }
          if (local === '/api/mcp/plaud/start') {
            starts++;
            assert.equal(account, scoped ? ids[0] : undefined);
            assert.deepEqual(request.postDataJSON(), { revision: 'initial' });
            assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf');
            return await json({ url: 'https://mcp.plaud.ai/authorize' });
          }
          if (local === '/api/mcp/plaud/finish') {
            finishes++;
            assert.equal(account, scoped ? ids[0] : undefined);
            assert.deepEqual(request.postDataJSON(), { state: 'synthetic-state', code: 'synthetic-code' });
            return await json({ revision: 'connected', templates: [], servers: [connected] });
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
        if (scoped) {
          await page.getByRole('combobox', { name: 'Аккаунт', exact: true }).click();
          await page.getByRole('option', { name: 'synthetic_1 · @synthetic_1_bot' }).click();
          await page.getByRole('button', { name: 'Подключить Plaud' }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Войти заново' }).count(), 0);
          await page.getByRole('combobox', { name: 'Аккаунт', exact: true }).click();
          await page.getByRole('option', { name: 'synthetic_0 · @synthetic_0_bot' }).click();
          await page.getByRole('button', { name: 'Войти заново' }).waitFor();
          assert.equal(connectedReads, 1);
          assert.equal(finishes, 1);
        }
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
