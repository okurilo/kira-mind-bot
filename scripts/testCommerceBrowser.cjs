'use strict';
// Native Chromium boundary regression. Run in an isolated --network none container.
// The only credentials are synthetic. TLS fixtures are generated for this test by the runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns/promises');
const { chromium } = require('playwright');
const { startCommerceProxy, installCommercePolicy } = require('../dist/services/commerce/browserPolicy');
const { startCommerceDisplay } = require('../dist/services/commerce/display');
const tlsRoot = process.argv[2];
if (!tlsRoot) throw Error('Provide a disposable directory with test-key.pem and test-cert.pem');

async function main() {
    const received = [];
    const upstream = https.createServer({ key: fs.readFileSync(path.join(tlsRoot, 'test-key.pem')),
        cert: fs.readFileSync(path.join(tlsRoot, 'test-cert.pem')) }, (req, res) => {
        received.push({ host: req.headers.host, path: req.url, method: req.method, cookie: req.headers.cookie });
        if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://outside.invalid/collect' }); res.end(); return; }
        if (req.url === '/forbidden') { res.writeHead(403); res.end('Synthetic access denial'); return; }
        if (req.url === '/throttled') { res.writeHead(429); res.end('Synthetic throttle'); return; }
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>Synthetic store</title><main><h1>Synthetic product</h1><p>100 RUB</p></main>');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    // Route a globally routable synthetic DNS answer back into our local TLS fixture.
    // URL checks and real browser/proxy traffic remain intact. No internet DNS/traffic is used.
    const originalLookup = dns.lookup, originalConnect = net.createConnection;
    const lookedUp = [];
    const syntheticPublicAddress = [93, 184, 216, 34].join('.');
    dns.lookup = async host => { lookedUp.push(host); return [{ address: syntheticPublicAddress, family: 4 }]; };
    net.createConnection = function (options, ...args) {
        if (options && options.host === syntheticPublicAddress) options = { ...options, host: '127.0.0.1', port: upstream.address().port };
        return originalConnect.call(this, options, ...args);
    };
    let browser, proxy, display;
    try {
        proxy = await startCommerceProxy('ozon');
        display = await startCommerceDisplay();
        browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: false, env: { PATH: process.env.PATH, ...display.env },
            proxy: { server: proxy.url }, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-quic',
                '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
        const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', acceptDownloads: false });
        let human = false;
        const notices = [];
        await installCommercePolicy(context, 'ozon', () => human, reason => notices.push(reason));
        await context.addCookies([{ name: 'synthetic-session', value: 'synthetic-user-a', domain: 'www.ozon.ru', path: '/', secure: true, httpOnly: true }]);
        const page = await context.newPage();
        await page.goto('https://www.ozon.ru/');
        assert.equal(await page.locator('h1').innerText(), 'Synthetic product');
        const request = (url, method = 'GET') => page.evaluate(async ({ url, method }) => {
            try { await fetch(url, { method }); return true; } catch { return false; }
        }, { url, method });
        assert.equal(await request('https://www.ozon.ru/search?text=synthetic'), true);
        assert.equal(await request('https://outside.invalid/collect?secret=synthetic-user-a'), false);
        assert.equal(await request('https://www.ozon.ru/api/create-order', 'POST'), false);
        assert.equal(received.some(row => row.method === 'POST'), false);
        human = true;
        assert.equal(await request('https://www.ozon.ru/api/create-order', 'POST'), true);
        human = false;
        assert.equal(await request('https://www.ozon.ru/api/create-order', 'POST'), false);
        assert.equal(received.filter(row => row.method === 'POST').length, 1);
        await page.goto('https://www.ozon.ru/forbidden');
        await page.goto('https://www.ozon.ru/throttled');
        assert.ok(notices.includes('access_denied')); assert.ok(notices.includes('rate_limited'));
        assert.equal(received.filter(row => row.path === '/throttled').length, 1);
        assert.equal(await page.evaluate(() => new Promise(resolve => {
            const ws = new WebSocket('wss://www.ozon.ru/events');
            ws.onopen = () => { ws.close(); resolve('opened'); };
            ws.onclose = () => resolve('closed'); ws.onerror = () => resolve('closed');
            setTimeout(() => { ws.close(); resolve('timeout'); }, 3000);
        })), 'closed');
        await assert.rejects(page.goto('https://www.ozon.ru/redirect'));
        assert.equal(lookedUp.includes('outside.invalid'), false);
        assert.ok(received.every(row => row.host === 'www.ozon.ru'));
        assert.ok(received.some(row => row.cookie === 'synthetic-session=synthetic-user-a'));
        const second = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        await installCommercePolicy(second, 'ozon', () => false);
        const pageB = await second.newPage(); await pageB.goto('https://www.ozon.ru/');
        assert.equal(received.at(-1).cookie, undefined, 'another context must not inherit the first account session');
        await context.close(); await second.close();
        process.stdout.write('Commerce native checks passed: Chromium, cookie isolation, redirect/egress, mutation boundary, WebSocket.\n');
    } finally {
        await browser?.close(); await display?.close(); await proxy?.close();
        dns.lookup = originalLookup; net.createConnection = originalConnect;
        await new Promise(resolve => upstream.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
