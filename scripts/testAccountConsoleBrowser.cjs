'use strict';
// Real browser regression with synthetic provider frames and API responses only.
// Run after build:server; Chromium may be supplied by the production Docker image.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
Object.assign(process.env, { NODE_ENV: 'test', KIRA_BOT_TOKEN: 'synthetic-test-token', OPENAI_API_KEY: 'synthetic-test-key',
  TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '', TELEGRAM_SESSION_STRING: '' });
const { ACCOUNT_CONSOLE_CSP } = require('../dist/platform/publicAccounts/webHttp');
const origin = 'https://synthetic.example.invalid';
const accountId = '11111111-1111-4111-8111-111111111111';
const flowId = '22222222-2222-4222-8222-222222222222';
const captchaApi = `(() => {
  let current, sequence = 0;
  function close(widget) {
    widget.layer?.remove(); widget.layer = null; widget.options['close-callback']?.();
  }
  window.hcaptcha = {
    render(slot, options) {
      const widget = { id: ++sequence, options }, button = document.createElement('button');
      current = widget; button.type = 'button'; button.textContent = 'Открыть тестовую проверку'; slot.append(button); widget.button = button;
      button.onclick = () => {
        const layer = document.createElement('div'), frame = document.createElement('iframe');
        Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '2147483647', background: '#0008', display: 'grid', placeItems: 'center' });
        frame.title = 'Synthetic challenge'; frame.src = 'https://newassets.hcaptcha.com/synthetic-challenge';
        Object.assign(frame.style, { width: 'min(400px, calc(100vw - 16px))', height: '300px', border: '0', background: 'white' });
        widget.layer = layer; widget.frame = frame; layer.append(frame); document.body.append(layer);
        frame.onload = () => { options['open-callback']?.(); frame.focus(); };
      };
      return widget.id;
    },
    remove(id) { if (current?.id === id) { close(current); current.button.remove(); current = null; } }
  };
  window.addEventListener('message', event => {
    const widget = current;
    if (!widget || event.origin !== 'https://newassets.hcaptcha.com' || event.source !== widget.frame?.contentWindow) return;
    if (event.data === 'synthetic-close' || event.data === 'synthetic-pass') {
      close(widget); if (event.data === 'synthetic-pass') widget.options.callback('synthetic-captcha-token');
    }
  });
  window.__kiraCaptchaReady();
})();`;
const challenge = `<!doctype html><html lang="ru"><meta charset="utf-8"><body><h1>Синтетическое задание</h1>
  <button id="pass">Подтвердить тестовую проверку</button><button id="close">Закрыть тестовое задание</button>
  <script>const send=value=>parent.postMessage(value,'${origin}');
  document.getElementById('pass').onclick=()=>send('synthetic-pass');document.getElementById('close').onclick=()=>send('synthetic-close');
  addEventListener('keydown',e=>{if(e.key==='Escape')send('synthetic-close')});</script></body></html>`;

async function fixture(browser, mode, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: viewport.width < 400 ? 'dark' : 'light' });
  let loggedIn = mode === 'reauthenticate', purpose = 'login', authentications = 0, unlinks = 0;
  let identities = [{ id: 'synthetic-password', provider: 'password' }, { id: 'synthetic-google', provider: 'google' }];
  const session = () => ({ account: { id: accountId, username: 'synthetic_account', assistantName: 'Салем', runtimeState: 'ready', consent: { aiAllowed: false } }, operatorAccess: false });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()), endpoint = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.hostname === 'js.hcaptcha.com') return route.fulfill({ contentType: 'application/javascript', body: captchaApi });
    if (url.hostname === 'newassets.hcaptcha.com') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: challenge });
    if (url.origin !== origin) return route.abort();
    const files = { '/account/': ['index.html', 'text/html'], '/account/account.js': ['account.js', 'application/javascript'], '/account/account.css': ['account.css', 'text/css'] };
    if (files[endpoint]) {
      const [name, contentType] = files[endpoint];
      return route.fulfill({ contentType, headers: { 'content-security-policy': ACCOUNT_CONSOLE_CSP }, body: fs.readFileSync(path.join('account-console', name)) });
    }
    if (endpoint === '/api/v1/web/config') return json({ csrfToken: 'synthetic-csrf', hasBrowserSession: false,
      providers: [{ provider: 'google', available: true, clientId: 'synthetic-google-client' }], proof: { hcaptchaSiteKey: 'synthetic-site-key' } });
    if (endpoint === '/api/v1/web/session') return loggedIn ? json(session()) : json({ error: { code: 'unauthorized' } }, 401);
    if (endpoint === '/api/v1/web/auth/refresh') return json({}, 401);
    if (endpoint === '/api/v1/web/auth/pending') return json({ pending: mode === 'resume' && !loggedIn
      ? { flowId, provider: 'telegram', purpose: 'login', callbackReceived: true } : null });
    if (endpoint === '/api/v1/web/auth/challenges') { purpose = route.request().postDataJSON().purpose; return json({ flowId, nonce: 'synthetic-nonce' }); }
    if (['/api/v1/web/auth/password', '/api/v1/web/auth/telegram'].includes(endpoint)) {
      assert.equal(route.request().postDataJSON().captchaToken, 'synthetic-captcha-token'); authentications++;
      if (purpose === 'reauthenticate') return json({ reauthenticationToken: 'synthetic-grant', expiresAt: new Date(Date.now() + 60000).toISOString() });
      loggedIn = true; return json(session());
    }
    if (endpoint === '/api/v1/web/api/account/identities') return json({ identities });
    if (endpoint === '/api/v1/web/api/account/identities/synthetic-google' && route.request().method() === 'DELETE') {
      unlinks++; identities = identities.slice(0, 1); return json({ ok: true });
    }
    throw Error('Unexpected synthetic request: ' + endpoint);
  });
  const page = await context.newPage();
  page.on('pageerror', error => console.error('Synthetic page error:', error.message));
  await page.goto(origin + '/account/');
  if (mode === 'login') {
    await page.getByRole('button', { name: 'Войти по паролю', exact: true }).click();
    await page.getByLabel('Имя пользователя', { exact: true }).fill('synthetic_account');
    await page.getByLabel('Пароль', { exact: true }).fill('synthetic-password-123');
    await page.locator('#password-login').getByRole('button', { name: 'Продолжить', exact: true }).click();
  } else if (mode === 'reauthenticate') {
    await page.getByRole('button', { name: 'Способы входа', exact: true }).click();
    await page.locator('.row').filter({ has: page.getByRole('heading', { name: 'Google', exact: true }) }).getByRole('button', { name: 'Отключить', exact: true }).click();
    await page.locator('#proof-dialog').getByRole('button', { name: 'Пароль', exact: true }).click();
    await page.getByLabel('Текущий пароль', { exact: true }).fill('synthetic-password-123');
    await page.locator('#proof-dialog').getByRole('button', { name: 'Продолжить', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Открыть тестовую проверку', exact: true }).waitFor();
  return { context, page, calls: () => ({ authentications, unlinks }) };
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const [mode, viewport] of [['login', { width: 1280, height: 900 }], ['resume', { width: 1280, height: 900 }],
      ['resume', { width: 360, height: 740 }], ['reauthenticate', { width: 1280, height: 900 }]]) {
      const f = await fixture(browser, mode, viewport);
      try {
        await f.page.getByRole('button', { name: 'Открыть тестовую проверку', exact: true }).click();
        const task = f.page.frameLocator('iframe[title="Synthetic challenge"]');
        // A native modal dialog makes this body-level provider iframe inert, irrespective of its z-index.
        await task.getByRole('button', { name: 'Подтвердить тестовую проверку', exact: true }).click({ timeout: 3000 });
        await f.page.getByRole('status').filter({ hasText: mode === 'reauthenticate' ? 'Способ входа отключён.' : 'Вход выполнен.' }).waitFor();
        if (mode !== 'reauthenticate') {
          await f.page.waitForFunction(() => document.querySelector('#brand-name')?.textContent === 'Салем');
          assert.match(await f.page.title(), /^Салем/);
        }
        assert.deepEqual(f.calls(), { authentications: 1, unlinks: mode === 'reauthenticate' ? 1 : 0 });
        assert.equal(await f.page.locator('#account-app').evaluate(el => el.inert), false);
        assert.equal(await f.page.locator('#proof-backdrop').isVisible(), false);
        console.log(`Account proof browser passed: ${mode} ${viewport.width}px`);
      } catch (error) {
        console.error(await f.page.evaluate(() => ({ modal: document.querySelector('#proof-dialog').matches(':modal'),
          proofInert: document.querySelector('#proof-dialog').inert, appInert: document.querySelector('#account-app')?.inert,
          frames: [...document.querySelectorAll('iframe')].map(frame => ({ src: frame.src, title: frame.title })) })));
        throw error;
      } finally { await f.context.close(); }
    }
    const f = await fixture(browser, 'login', { width: 360, height: 740 });
    try {
      await f.page.getByRole('button', { name: 'Открыть тестовую проверку', exact: true }).click();
      await f.page.frameLocator('iframe[title="Synthetic challenge"]').getByRole('button', { name: 'Закрыть тестовое задание', exact: true }).click();
      assert.equal(await f.page.locator('#proof-dialog').evaluate(el => el.inert), false);
      assert.equal(await f.page.locator('#account-app').evaluate(el => el.inert), true);
      await f.page.locator('#proof-cancel').focus(); await f.page.keyboard.press('Shift+Tab');
      assert.equal(await f.page.getByRole('button', { name: 'Открыть тестовую проверку', exact: true }).evaluate(el => el === document.activeElement), true);
      await f.page.keyboard.press('Tab'); assert.equal(await f.page.locator('#proof-cancel').evaluate(el => el === document.activeElement), true);
      await f.page.keyboard.press('Escape'); await f.page.getByRole('status').filter({ hasText: 'Подтверждение отменено.' }).waitFor();
      assert.equal(await f.page.locator('#account-app').evaluate(el => el.inert), false);
      assert.equal(await f.page.locator('#proof-backdrop').isVisible(), false);
      assert.equal(await f.page.locator('#password-login button').evaluate(el => el === document.activeElement), true);
      assert.deepEqual(f.calls(), { authentications: 0, unlinks: 0 });
      console.log('Account proof browser passed: challenge close, focus, keyboard, cancel');
    } finally { await f.context.close(); }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
