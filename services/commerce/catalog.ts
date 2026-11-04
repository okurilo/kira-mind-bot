/** First-party consumer workflows. Hosts are code policy, never model/config arguments. */
export const COMMERCE_PROVIDERS = ['ozon', 'yandex-market', 'kuper', 'yandex-lavka', 'samokat'] as const;
export type CommerceProvider = typeof COMMERCE_PROVIDERS[number];

interface Storefront {
    name: string;
    url: string;
    hosts: readonly string[];
    assetHosts: readonly string[];
    readPosts: readonly string[];
}

const YANDEX_AUTH = ['passport.yandex.ru', 'id.yandex.ru', 'sso.passport.yandex.ru', 'smartcaptcha.yandexcloud.net', 'smartcaptcha.cloud.yandex.ru'];
const YANDEX_ASSETS = ['yastatic.net', 'avatars.mds.yandex.net'];
const STOREFRONTS: Record<CommerceProvider, Storefront> = {
    ozon: { name: 'Ozon', url: 'https://www.ozon.ru/',
        hosts: ['www.ozon.ru', 'ozon.ru', 'id.ozon.ru', 'ozonid.ozon.ru'],
        assetHosts: ['ir.ozone.ru', 'cdn1.ozone.ru', 'cdn2.ozone.ru'], readPosts: [] },
    'yandex-market': { name: 'Яндекс Маркет', url: 'https://market.yandex.ru/',
        hosts: ['market.yandex.ru', ...YANDEX_AUTH], assetHosts: YANDEX_ASSETS, readPosts: [] },
    kuper: { name: 'Купер', url: 'https://kuper.ru/', hosts: ['kuper.ru', 'api.kuper.ru'],
        assetHosts: ['img.kuper.ru', 'sbermarket.ru', 'imgproxy.sbermarket.ru'], readPosts: [] },
    'yandex-lavka': { name: 'Яндекс Лавка', url: 'https://lavka.yandex.ru/',
        hosts: ['lavka.yandex.ru', ...YANDEX_AUTH], assetHosts: YANDEX_ASSETS,
        readPosts: ['/api/v1/providers/search/v3/lavka', '/api/v1/providers/v1/product',
            '/api/v1/providers/v1/layout', '/api/v1/providers/v1/category-group', '/api/v1/providers/v2/category',
            '/api/v1/providers/cart/v1/retrieve', '/api/v1/providers/orders/v1/checkout-layout',
            '/api/v1/providers/geo/v1/suggest', '/api/v1/providers/geo/v1/geocode',
            '/api/v1/providers/address/v1/get-favorite-addresses'] },
    samokat: { name: 'Самокат', url: 'https://samokat.ru/', hosts: ['samokat.ru', 'www.samokat.ru', 'web.samokat.ru', 'api.samokat.ru', 'api-web.samokat.ru'],
        assetHosts: ['cdn.samokat.ru', 'cm.samokat.ru'], readPosts: [] },
};

export function commerceProvider(value: unknown): CommerceProvider | undefined {
    return typeof value === 'string' && (COMMERCE_PROVIDERS as readonly string[]).includes(value) ? value as CommerceProvider : undefined;
}

export function storefront(provider: CommerceProvider): Storefront {
    if (!commerceProvider(provider)) throw new Error('Неизвестный магазин.');
    return STOREFRONTS[provider];
}

export function commerceCatalog() {
    return COMMERCE_PROVIDERS.map(id => ({ id, name: STOREFRONTS[id].name, url: STOREFRONTS[id].url,
        mode: 'isolated_browser', maturity: 'experimental', requiresSharedBrowserClient: true,
        capabilities: ['browse', 'compare', 'assisted_cart', 'manual_checkout'],
        nativeMcp: { serverId: `kira_${id.replace(/-/g, '_')}`, automatedCatalog: id !== 'samokat', automatedCartAndHistory: ['ozon', 'kuper', 'yandex-lavka'].includes(id), liveAccepted: false },
        limitations: 'Вход и оформление выполняет пользователь в общем браузере. Автоматическая корзина/история реализованы не для всех сервисов; доступ зависит от сайта, подключения и адреса доставки. Живая приёмка не завершена.' }));
}

export function commerceHostAllowed(provider: CommerceProvider, host: string): boolean {
    const site = storefront(provider);
    // Exact host equality: no substring/suffix parsing, userinfo, ports or trailing dots.
    return [...site.hosts, ...site.assetHosts].includes(host.toLowerCase());
}

export function commerceRequestAllowed(provider: CommerceProvider, raw: string, method: string, human: boolean): boolean {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !commerceHostAllowed(provider, url.hostname)) return false;
        const site = storefront(provider);
        if (site.assetHosts.includes(url.hostname)) return method === 'GET' || method === 'HEAD';
        if (human) return ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method);
        // Paths with side effects are never read operations, even when exposed as GET.
        let pathname = url.pathname;
        for (let i = 0; i < 3 && pathname.includes('%'); i++) pathname = decodeURIComponent(pathname);
        if (pathname.includes('%') || /[\\\x00-\x20]/.test(pathname) || /\/(?:_action|logout|signout|submit|cancel|pay|payment|payments)(?:\/|$)/i.test(pathname)) return false;
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
        return method === 'POST' && url.origin === new URL(site.url).origin && site.readPosts.includes(url.pathname);
    } catch { return false; }
}

export function commerceTask(provider: CommerceProvider, task: string): string {
    const site = storefront(provider);
    return `${task}\n\nМагазин: ${site.name}. Начальная страница: ${site.url}\n` +
        'Работай с наблюдаемыми товарами, ценами, условиями скидок и адресом доставки. Сохраняй ссылки на выбранные варианты. ' +
        'Не считай показанную цену итоговой без проверки доставки и способа оплаты. ' +
        'Вход, коды, изменение корзины, отправка заказа и оплата — ручной шаг владельца в общем браузере. ' +
        'Не проси cookies, пароли или коды в чате. При блокировке сайта сообщи ограничение, не обходи сетевую политику и не повторяй действие автоматически.';
}
