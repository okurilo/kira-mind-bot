import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Request } from 'playwright';
import { launchChromium } from '../chromiumLaunch';
import { LivePlaywrightAdapter } from '../liveBrowserPlaywright';
import { liveBrowserInvocation, liveBrowserSessions, type LiveBrowserSession } from '../liveBrowserSession';
import { startCommerceDisplay, type CommerceDisplay } from './display';
import { installCommercePolicy, startCommerceProxy } from './browserPolicy';
import { storefront, type CommerceProvider } from './catalog';
import { CommerceFailure, commerceHash, type CommerceInteraction } from './contracts';
import { commerceInvocation } from './context';
import { CommerceStore } from './store';
import { browserContextScopeKey } from '../../utils/browserRuntimeScope';
import { bindAccountAiOperation } from '../../ai/accountPolicy';
import { withCommerceContext } from './context';

interface MerchantBrowser { browser: Browser; context: BrowserContext; page: Page; session: LiveBrowserSession; close(): Promise<void> }
export interface MerchantRequest { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown; effect: 'read' | 'cart' }

/** Transport for deterministic first-party adapters. No model-supplied URL, headers, cookies or JavaScript. */
export class CommerceBrowserHost {
    private current?: MerchantBrowser;
    private opening?: Promise<MerchantBrowser>;
    private permit?: { url: string; method: string; body: string; until: number; generation: number };
    private contextAtCreation?: ReturnType<typeof commerceInvocation>;
    private merchantContext: Record<string, unknown> = {};
    private lane: Promise<unknown> = Promise.resolve();
    constructor(readonly provider: CommerceProvider, private readonly store: CommerceStore) {}

    private authorize(request: Request) {
        const permit = this.permit, session = this.current?.session;
        if (!permit || !session || session.state !== 'running' || session.generation !== permit.generation || Date.now() > permit.until) return false;
        if (request.url() !== permit.url || request.method() !== permit.method || (request.postData() ?? '') !== permit.body) return false;
        this.permit = undefined; return true;
    }
    private async open(): Promise<MerchantBrowser> {
        if (this.current && !['completed', 'cancelled', 'failed'].includes(this.current.session.state)) return this.current;
        if (this.current) await this.current.close();
        if (this.opening) return this.opening;
        this.opening = this.start();
        try { return await this.opening; } finally { this.opening = undefined; }
    }
    private async start(): Promise<MerchantBrowser> {
        const invocation = commerceInvocation();
        if (!invocation || invocation.context.readOnly || !invocation.context.ctx.liveBrowserRequest)
            throw new CommerceFailure('blocked', 'Для подключения нужен личный iOS-клиент с общим браузером.');
        const ctx = invocation.context.ctx, owner = ctx.from!.id, scope = browserContextScopeKey(ctx);
        const active = liveBrowserSessions.active(owner, scope);
        if (active?.commercePersistentLogin && active.commerceProvider !== this.provider && active.state === 'running' && !active.snapshot().inFlight) {
            active.finish('completed', active.generation); await active.adapter?.close();
        }
        if (active && !['completed', 'cancelled', 'failed'].includes(active.state))
            throw new CommerceFailure('blocked', 'Сначала заверши текущую задачу в общем браузере.', { sessionId: active.id, kind: 'clarification', prompt: 'Общий браузер занят другой задачей.' });
        this.contextAtCreation = invocation;
        const session = liveBrowserSessions.create(owner, scope, ctx.liveBrowserRequest!.operationId);
        session.task = invocation.context.message; session.commerceProvider = this.provider;
        session.commercePersistentLogin = true;
        let proxy: Awaited<ReturnType<typeof startCommerceProxy>> | undefined;
        let display: CommerceDisplay | undefined, browser: Browser | undefined, context: BrowserContext | undefined;
        try {
            proxy = await startCommerceProxy(this.provider);
            const merchantProxy = proxy;
            if (process.platform === 'linux') display = await startCommerceDisplay();
            browser = await launchChromium(env => chromium.launch({
                executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
                headless: process.platform !== 'linux', env: { ...env, HOME: env.TMPDIR, ...display?.env }, proxy: { server: merchantProxy.url },
                args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
                    '--disable-background-networking', '--disable-quic', '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
            }), { PATH: process.env.PATH, LANG: 'ru_RU.UTF-8', TZ: 'Europe/Moscow' });
            const saved = await this.store.snapshot();
            context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport: { width: 1365, height: 900 },
                serviceWorkers: 'block', acceptDownloads: false, storageState: saved.browserState as BrowserContextOptions['storageState'] });
            await installCommercePolicy(context, this.provider, () => session.state === 'user_control', reason => {
                if (['starting', 'running'].includes(session.state)) void session.needsUser(reason === 'rate_limited' ? 'Магазин ограничил запросы. Автоматический повтор остановлен.'
                    : reason === 'access_denied' ? 'Магазин отклонил подключение этого браузера (HTTP 401/403). Повторный вход не гарантирует доступ. Проверь страницу; автоматические повторы остановлены.'
                    : 'Магазину нужен ручной шаг. Открой общий браузер и проверь страницу.', 'blocked').catch(() => {});
            }, request => this.authorize(request), { notifyMerchantWrites: false });
            const page = await context.newPage();
            context.on('request', request => {
                const url = new URL(request.url());
                if (this.provider !== 'yandex-lavka' || url.origin !== new URL(storefront(this.provider).url).origin || request.method() !== 'POST' || !storefront(this.provider).readPosts.includes(url.pathname)) return;
                try {
                    const body = request.postDataJSON();
                    for (const key of ['position', 'depotType', 'deliveryType', 'deliveryTimeInfo', 'additionalData'])
                        if (body?.[key] !== undefined) this.merchantContext[key] = body[key];
                } catch { /* Non-JSON resources are not shopping context. */ }
            });
            let closing: Promise<void> | undefined;
            let savedProfile: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
            let profileSaved = false;
            const ownedContext = context;
            const adapter = new LivePlaywrightAdapter(session, browser, context, page);
            const adapterClose = adapter.close.bind(adapter);
            const close = (): Promise<void> => {
                if (!closing) {
                    const attempt = (async () => {
                        let failure: unknown;
                        try {
                            if (!profileSaved) {
                                savedProfile ??= await ownedContext.storageState({ indexedDB: true });
                                await this.store.transaction(saved => { saved.browserState = savedProfile; }); profileSaved = true;
                            }
                        } catch (error) { failure = error; }
                        try { await adapterClose(); } catch (error) { failure ??= error; }
                        try { await display?.close(); } catch (error) { failure ??= error; }
                        try { await proxy?.close(); } catch (error) { failure ??= error; }
                        if (failure) throw failure;
                        this.current = undefined;
                    })();
                    closing = attempt;
                    void attempt.catch(() => { if (closing === attempt) closing = undefined; });
                }
                return closing;
            };
            adapter.close = close;
            session.attach(adapter);
            let ownerAnswer: string | undefined;
            session.onOwnerText = text => { ownerAnswer = text; };
            session.persistContext = async () => {
                if (this.current?.context === ownedContext && !['cancelled', 'failed', 'completed'].includes(session.state)) {
                    const saved = await ownedContext.storageState({ indexedDB: true });
                    if (this.current?.context === ownedContext && !['cancelled', 'failed', 'completed'].includes(session.state))
                        await this.store.transaction(state => { state.browserState = saved; });
                }
                await import('../SessionStorage').then(module => module.persistAgentRuntime(invocation.context.ctx));
            };
            session.resume = bindAccountAiOperation(async answer => {
                await withCommerceContext(this.contextAtCreation!.context, undefined, () => session.runAgent(async () => {
                    const { continueQuestionRuntime } = await import('../../orchestration/runtime/kernel');
                    const original = this.contextAtCreation!.context;
                    await session.persistContext?.();
                    const currentAnswer = ownerAnswer ?? answer ?? 'Продолжи после ручного шага в магазине.';
                    ownerAnswer = undefined;
                    const result = await continueQuestionRuntime(original.ctx, currentAnswer);
                    if (result?.responseText) {
                        await import('../../utils/history').then(module => module.addToHistory(original.ctx, 'bot', result.responseText!));
                        if (result.operationStatus === 'needs_input') {
                            if (['running', 'starting'].includes(session.state)) await session.needsUser(result.responseText, 'clarification');
                        } else session.publishResult(result.responseText, result.operationStatus ?? 'ok');
                    }
                    await import('../SessionStorage').then(module => module.persistAgentRuntime(original.ctx));
                }));
            });
            this.current = { browser, context, get page() { return adapter.rawPage; }, session, close };
            return this.current;
        } catch (error) {
            session.finish('failed', session.generation);
            await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await display?.close(); await proxy?.close();
            throw error;
        }
    }
    private async run<T>(work: (host: MerchantBrowser) => Promise<T>): Promise<T> {
        const previous = this.lane;
        const task = previous.catch(() => {}).then(() => this.runExclusive(work));
        this.lane = task;
        return task;
    }
    private async runExclusive<T>(work: (host: MerchantBrowser) => Promise<T>): Promise<T> {
        const host = await this.open(), active = liveBrowserInvocation();
        const signal = commerceInvocation()?.context.signal;
        signal?.throwIfAborted();
        if (!['starting', 'running'].includes(host.session.state)) {
            const assistance = host.session.snapshot().assistanceRequest;
            const kind = assistance?.kind === 'login' ? 'login' : assistance?.kind === 'payment' ? 'payment' : 'blocked';
            throw new CommerceFailure(kind === 'login' ? 'login_required' : 'blocked', assistance?.prompt ?? 'Продолжи текущую задачу магазина после ручного шага.',
                this.interaction(host, kind, assistance?.prompt ?? 'Проверь текущую страницу и явно верни управление боту.'));
        }
        const execute = () => host.session.agentCall(host.session.generation, () => work(host));
        const aborted = () => { void host.session.suspend('paused', 'commerce_request_aborted').catch(() => {}); };
        signal?.addEventListener('abort', aborted, { once: true });
        try {
            const result = await (active?.session === host.session ? execute() : host.session.runAgent(execute));
            await this.checkCaptcha(host); return result;
        }
        catch (error) {
            await this.checkCaptcha(host);
            if (error instanceof CommerceFailure) throw error;
            if (['needs_user','paused','pausing','disconnected','user_control'].includes(host.session.state))
                throw new CommerceFailure('blocked', 'Текущий шаг магазина ожидает владельца.', this.interaction(host, 'blocked', host.session.snapshot().assistanceRequest?.prompt ?? 'Продолжи ручной шаг в общем браузере.'));
            throw new CommerceFailure('unavailable', 'Запрос магазина не завершился проверенным результатом.');
        } finally { signal?.removeEventListener('abort', aborted); }
    }
    private async checkCaptcha(host: MerchantBrowser) {
        if (!this.provider.startsWith('yandex-')) return;
        const url = new URL(host.page.url());
        if (url.origin !== new URL(storefront(this.provider).url).origin || !/^\/showcaptcha\/?$/.test(url.pathname)) return;
        const prompt = 'Магазин запросил проверку «Я не робот». Пройди её самостоятельно в общем браузере, затем явно верни управление боту.';
        if (['running', 'starting'].includes(host.session.state)) await host.session.needsUser(prompt, 'captcha');
        throw new CommerceFailure('blocked', prompt, this.interaction(host, 'captcha', prompt));
    }
    private interaction(host: MerchantBrowser, kind: CommerceInteraction['kind'], prompt: string): CommerceInteraction { return { sessionId: host.session.id, kind, prompt }; }
    async connect(): Promise<CommerceInteraction> {
        const host = await this.open();
        if (host.page.url() === 'about:blank') await this.run(host => host.page.goto(storefront(this.provider).url, { waitUntil: 'domcontentloaded', timeout: 25000 }).then(() => undefined));
        await host.session.needsUser('Войди в магазин в общем браузере. Пароль и SMS-код вводи только на сайте, затем верни управление боту.', 'login');
        return this.interaction(host, 'login', 'Нужен вход в магазин в общем браузере.');
    }
    async authHint() {
        const host = await this.open();
        if (host.page.url() === 'about:blank') await this.run(host => host.page.goto(storefront(this.provider).url, { waitUntil: 'domcontentloaded', timeout: 25000 }).then(() => undefined));
        const cookies = await host.context.cookies();
        const value = (name: string) => cookies.find(cookie => cookie.name === name)?.value;
        const stable = this.provider === 'ozon' ? value('__Secure-user-id') : value('yandex_login');
        const authenticated = this.provider === 'ozon' ? Boolean(stable && stable !== '0' && value('__Secure-access-token')) :
            this.provider.startsWith('yandex-') ? Boolean(value('Session_id') && stable) : false;
        return { authenticated, accountBinding: authenticated ? commerceHash([this.provider, stable ?? value('Session_id') ?? value('_Instamart_session')]) : undefined,
            ...(!authenticated ? { interaction: this.interaction(host, 'login', 'Для личных данных нужен вход в магазин.') } : {}) };
    }
    async shoppingContext() {
        await this.authHint();
        return structuredClone(this.merchantContext);
    }
    async readMarketOffers(path: string) {
        if (this.provider !== 'yandex-market' || !/^\/search\?text=/.test(path)) throw new CommerceFailure('invalid_input', 'Неизвестная страница каталога.');
        return this.run(async host => {
            await host.page.goto(new URL(path, storefront(this.provider).url).toString(), { waitUntil: 'domcontentloaded', timeout: 25000 });
            const rows = await host.page.locator('[data-zone-data]').evaluateAll(elements => elements.slice(0, 1000).flatMap(element => {
                try { const value = JSON.parse(element.getAttribute('data-zone-data') ?? 'null'); return value?.type === 'offer' && value.wareId ? [value] : []; } catch { return []; }
            }));
            if (!rows.length) throw new CommerceFailure('unavailable', 'На странице нет подтверждённых структурированных предложений. Это не доказательство отсутствия товара.');
            return rows;
        });
    }
    async requirePageStep(prompt: string): Promise<never> {
        const host = await this.open();
        await host.session.needsUser(prompt, 'clarification');
        throw new CommerceFailure('blocked', prompt, this.interaction(host, 'clarification', prompt));
    }
    async request(request: MerchantRequest): Promise<any> {
        const origin = new URL(storefront(this.provider).url).origin, url = new URL(request.path, origin);
        if (!request.path.startsWith('/') || request.path.startsWith('//') || url.origin !== origin || url.username || url.password || url.hash ||
            /\/(?:submit|completion|payment|payments|cancel)(?:\/|$)/i.test(url.pathname)) throw new CommerceFailure('invalid_input', 'Маршрут магазина не разрешён.');
        if (request.method !== 'GET' && request.effect !== 'cart' && !storefront(this.provider).readPosts.includes(url.pathname))
            throw new CommerceFailure('invalid_input', 'Неизвестный метод чтения магазина.');
        if (request.effect === 'cart' && !cartWriteAllowed(this.provider, request.method, url.pathname)) throw new CommerceFailure('invalid_input', 'Неизвестный маршрут изменения корзины.');
        if (request.effect === 'cart' && !commerceInvocation()?.approvedOperation) throw new CommerceFailure('blocked', 'Отсутствует подтверждение конкретного изменения корзины.');
        return this.run(async host => {
            if (new URL(host.page.url()).origin !== origin) await host.page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 25000 });
            const body = request.body === undefined ? '' : JSON.stringify(request.body);
            this.permit = { url: url.toString(), method: request.method, body, until: Date.now() + 15000, generation: host.session.generation };
            try {
                const reply = await host.page.evaluate(async ({ url, method, body, provider }) => {
                    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ??
                        document.documentElement.innerHTML.match(/"csrfToken"\s*:\s*"([^"\\]+)"/)?.[1];
                    const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
                    if (body) headers['Content-Type'] = 'application/json';
                    if (token) headers['X-CSRF-Token'] = token;
                    if (provider === 'yandex-lavka') Object.assign(headers, { 'X-Lavka-Web-Locale': 'ru-RU', 'X-Captcha-Service': 'lavka', 'X-Captcha-Language': 'ru' });
                    const response = await fetch(url, { method, headers, ...(body ? { body } : {}), credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000) });
                    const text = await response.text();
                    if (text.length > 4_000_000) return { status: 0, json: null };
                    try { return { status: response.status, json: JSON.parse(text) }; } catch { return { status: response.status, json: null }; }
                }, { url: url.toString(), method: request.method, body, provider: this.provider });
                if ([401, 403].includes(reply.status)) {
                    const denied = reply.status === 403, prompt = denied ? 'Магазин отклонил подключение (HTTP 403). Проверь страницу; автоматические повторы остановлены.' : 'Проверь вход в магазин в общем браузере.';
                    void host.session.needsUser(prompt, denied ? 'blocked' : 'login').catch(() => {});
                    throw new CommerceFailure(denied ? 'blocked' : 'login_required', prompt, this.interaction(host, denied ? 'blocked' : 'login', prompt));
                }
                if (reply.status === 429) throw new CommerceFailure('blocked', 'Магазин ограничил запросы. Повтор автоматически не выполняется.');
                if (reply.status < 200 || reply.status >= 300 || reply.json === null) throw new CommerceFailure('unavailable', 'Магазин не вернул ожидаемые данные.');
                return reply.json;
            } finally { this.permit = undefined; }
        });
    }
    async checkout(): Promise<CommerceInteraction> {
        const host = await this.open();
        const route = this.provider === 'ozon' ? '/cart' : this.provider === 'yandex-market' ? '/my/cart' : this.provider === 'kuper' ? '/cart' : '/';
        await this.run(host => host.page.goto(new URL(route, storefront(this.provider).url).toString(), { waitUntil: 'domcontentloaded' }).then(() => undefined));
        await host.session.needsUser('Проверь фактический состав корзины, доставку и окончательный итог на сайте; оформление и оплату выполни самостоятельно.', 'payment');
        return this.interaction(host, 'payment', 'Оформление и оплата в том же общем браузере.');
    }
    async disconnect() {
        const host = this.current;
        if (host) { host.session.stop('commerce_disconnected'); await host.close(); }
        await this.store.transaction(state => { state.browserState = undefined; });
    }
}

function cartWriteAllowed(provider: CommerceProvider, method: string, pathname: string): boolean {
    if (provider === 'ozon') return method === 'POST' && pathname === '/api/composer-api.bx/_action/v2/addToCart';
    if (provider === 'yandex-lavka') return method === 'POST' && pathname === '/api/v1/providers/cart/v1/update';
    if (provider === 'kuper') return method === 'POST' && pathname === '/api/v2/line_items' || ['PUT','DELETE'].includes(method) && /^\/api\/v2\/line_items\/\d+$/.test(pathname);
    return false;
}
