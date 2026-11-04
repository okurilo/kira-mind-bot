import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { CommerceBrowserHost } from '../services/commerce/browserHost';
import { CommerceStore } from '../services/commerce/store';
import { withCommerceContext } from '../services/commerce/context';
import { liveBrowserSessions } from '../services/liveBrowserSession';
import * as storage from '../services/SessionStorage';
import * as kernel from '../orchestration/runtime/kernel';
import type { ToolContext } from '../orchestration/runtime/types';

test('native browser restores only its encrypted profile, checkpoints private state, and resumes the actual voice answer in the same task', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-commerce-host-synthetic-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new CommerceStore(root, 'yandex-lavka', 'synthetic-owner', 'cd'.repeat(32));
    const profile = { cookies: [{ name: 'Session_id', value: 'synthetic-private-session', domain: '.yandex.ru', path: '/' }], origins: [] };
    await store.transaction(state => { state.browserState = profile; });
    let options: any, launch: any, contextClosed = 0, browserClosed = 0, route: any, currentUrl = 'about:blank';
    const pageHandlers = new Map(), contextHandlers = new Map();
    const mainFrame = {};
    const page: any = { on: (name: string, handler: any) => { pageHandlers.set(name, handler); }, url: () => currentUrl, mainFrame: () => mainFrame,
        goto: async (url: string) => { currentUrl = url; }, title: async () => 'Synthetic storefront',
        evaluate: async (_fn: any, args: any) => {
            if (!args?.url) return { width: 1365, height: 900, deviceScaleFactor: 1 };
            let allowed = false;
            await route({ request: () => ({ url: () => args.url, method: () => args.method, postData: () => args.body, isNavigationRequest: () => false }),
                continue: async () => { allowed = true; }, abort: async () => {} });
            return allowed ? { status: 200, json: { cart: { items: [] } } } : { status: 0, json: null };
        }, frames: () => [], isClosed: () => false };
    const context: any = { route: async (_pattern: string, callback: any) => { route = callback; }, routeWebSocket: async () => {},
        on: (name: string, handler: any) => { contextHandlers.set(name, handler); }, newPage: async () => page, pages: () => [page],
        cookies: async () => [{ name: 'Session_id', value: 'synthetic-private-session' }, { name: 'yandex_login', value: 'synthetic-merchant-owner' }],
        storageState: async () => profile, clearCookies: async () => {}, close: async () => { contextClosed++; contextHandlers.get('close')?.(); } };
    t.mock.method(chromium, 'launch', async (opts: any) => { launch = opts; return { newContext: async (value: any) => { options = value; return context; }, close: async () => { browserClosed++; } } as any; });
    t.mock.method(storage, 'persistAgentRuntime', async () => {});
    let answer = '', resumedContext: any, nextCaptcha = false;
    t.mock.method(kernel, 'continueQuestionRuntime', async (ctx: any, text: string) => {
        resumedContext = ctx; answer = text;
        if (nextCaptcha) { await liveBrowserSessions.active(ctx.from.id, ctx.agentRuntimeStorageKey)!.needsUser('Синтетическая CAPTCHA', 'captcha'); return { responseText: 'Проверка на сайте', operationStatus: 'needs_input' }; }
        return { responseText: 'Синтетический итог', operationStatus: 'ok' };
    });
    const scope = `api:synthetic-${randomUUID()}`, owner = 96011;
    const invocation = { ctx: { from: { id: owner }, chat: { id: owner, type: 'private' }, agentRuntimeStorageKey: scope,
        liveBrowserRequest: { operationId: 'synthetic-operation' }, session: { messageHistory: [] } }, message: 'Повтори прошлую корзину', signal: new AbortController().signal } as unknown as ToolContext;
    const host = new CommerceBrowserHost('yandex-lavka', store);
    await withCommerceContext(invocation, undefined, () => host.authHint());
    const session = liveBrowserSessions.active(owner, scope)!; t.after(() => session.dispose());
    assert.equal(session.commercePersistentLogin, true); assert.deepEqual(options.storageState, profile);
    assert.equal(options.serviceWorkers, 'block'); assert.equal(options.acceptDownloads, false);
    assert.equal(launch.env.OPENAI_API_KEY, undefined); assert.equal(launch.env.DB_PASSWORD, undefined); assert.equal(launch.env.KIRA_COMMERCE_STORAGE_KEY, undefined);
    assert.equal(launch.env.HOME, launch.env.TMPDIR); assert.ok(launch.proxy.server.startsWith('http://127.0.0.1:'));
    const observer = randomUUID(); session.registerObserver(observer, 'background'); session.subscribe(observer, () => true, () => {});
    await session.needsUser('Сколько упаковок?', 'clarification');
    profile.cookies.push({ name: 'synthetic-new-login', value: 'synthetic-connected-after-manual', domain: '.yandex.ru', path: '/' });
    const snapshot = session.snapshot();
    await session.answerAssistance(randomUUID(), { observerId: observer, expectedRevision: snapshot.revision, assistanceRequestId: snapshot.assistanceRequest!.requestId }, 'Две упаковки');
    for (let step = 0; step < 30 && !answer; step++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(answer, 'Две упаковки'); assert.equal(resumedContext, invocation.ctx); assert.equal(session.id, snapshot.sessionId);
    assert.equal(session.snapshot().result?.text, 'Синтетический итог');
    assert.ok((await store.snapshot()).browserState && JSON.stringify((await store.snapshot()).browserState).includes('synthetic-connected-after-manual'), 'manual login state is checkpointed before continuation');
    let popupRequests = 0;
    const popup = { ...page, url: () => 'https://lavka.yandex.ru/', evaluate: async (fn: any, args: any) => { if (args?.url) popupRequests++; return page.evaluate(fn, args); } };
    contextHandlers.get('page')!(popup);
    await withCommerceContext(invocation, 'synthetic-approved-operation', () => host.request({ method: 'POST', path: '/api/v1/providers/cart/v1/update', body: { items: [] }, effect: 'cart' }));
    assert.equal(popupRequests, 1, 'manual authentication tab and deterministic MCP must use the same adopted page');
    assert.equal(session.state, 'running');
    await assert.rejects(withCommerceContext(invocation, undefined, () => host.request({ method: 'POST', path: '/api/v1/providers/cart/v1/update', body: {}, effect: 'cart' })), /подтверждение/);
    await assert.rejects(withCommerceContext(invocation, 'synthetic-approved-operation', () => host.request({ method: 'POST', path: '/api/v1/orders/submit', effect: 'cart' })), /не разрешён/);
    currentUrl = 'https://lavka.yandex.ru/showcaptcha'; popup.url = () => currentUrl;
    await assert.rejects(withCommerceContext(invocation, undefined, () => host.request({ method: 'GET', path: '/api/source-read', effect: 'read' })), (error: any) => error.interaction?.kind === 'captcha');
    assert.equal(session.snapshot().assistanceRequest?.kind, 'captcha');
    assert.equal(session.snapshot().assistanceRequest?.responseActions.includes('answer'), false);
    pageHandlers.get('framenavigated')!({});
    assert.equal(session.snapshot().assistanceRequest?.kind, 'captcha', 'loading the CAPTCHA iframe does not erase the pending manual step');
    nextCaptcha = true; answer = ''; currentUrl = 'https://lavka.yandex.ru/';
    await session.command(randomUUID(), { type: 'resume', observerId: observer, expectedRevision: session.snapshot().revision });
    for (let step = 0; step < 30 && !answer; step++) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(session.snapshot().assistanceRequest?.kind, 'captcha', 'runtime result must preserve the secret/manual step instead of downgrading it to a chat clarification');
    assert.equal(session.snapshot().assistanceRequest?.responseActions.includes('answer'), false);
    await session.persistContext!();
    assert.deepEqual((await store.snapshot()).browserState, profile);
    const originalClose = context.close;
    let firstClose = true;
    context.close = async () => { await originalClose(); if (firstClose) { firstClose = false; throw Error('Synthetic close acknowledgement lost'); } };
    await assert.rejects(host.disconnect(), /Synthetic close/);
    await host.disconnect();
    assert.equal((await store.snapshot()).browserState, undefined); assert.equal(contextClosed, 2);
    assert.equal(browserClosed, 1, 'a successful browser close remains idempotent when only the context acknowledgement is retried');
    const cipher = await fs.readFile(path.join(root, 'yandex-lavka', 'state.enc'), 'utf8'); assert.doesNotMatch(cipher, /synthetic-private-session/);
});
