import { randomUUID } from 'node:crypto';
import { storefront, type CommerceProvider } from './catalog';
import { CommerceFailure, commerceHash, commerceId, cartRevision, type CommerceDriver, type CommerceProduct, type CommerceLine, type CommerceOrder, type CommerceMoney } from './contracts';
import type { CommerceBrowserHost, MerchantRequest } from './browserHost';

export interface MerchantHost extends Pick<CommerceBrowserHost, 'authHint' | 'connect' | 'request' | 'checkout' | 'disconnect' | 'shoppingContext' | 'requirePageStep' | 'readMarketOffers'> {}
const now = () => new Date().toISOString();
const invalid = (): never => { throw new CommerceFailure('unavailable', 'Формат данных магазина изменился. Непроверенные данные не используются.'); };
function object(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value as Record<string, any>; }
function array(value: unknown): any[] { if (!Array.isArray(value) || value.length > 1000) return invalid(); return value; }
function text(value: unknown, limit = 500): string { return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, limit) : ''; }
export function merchantMoney(value: unknown): CommerceMoney | undefined {
    if (value && typeof value === 'object') value = (value as any).value ?? (value as any).amount ?? (value as any).text;
    if (typeof value === 'string') {
        const clean = value.replace(/[\s\u00a0\u202f]/g, '').replace(/(?:₽|руб\.?|RUB)$/i, '').replace(',', '.');
        if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) return undefined;
        value = Number(clean);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000_000) return undefined;
    const minor = Math.round(value * 100); return Number.isSafeInteger(minor) ? { minor, currency: 'RUB' } : undefined;
}
function quantity(value: unknown) { const n = Number(value); if (!Number.isFinite(n) || n <= 0 || n > 100) return invalid(); return n; }
function product(provider: CommerceProvider, row: any): CommerceProduct {
    row = object(row);
    const id = commerceId(String(row.id ?? row.product_id ?? '')), title = text(row.title ?? row.name);
    if (!title) return invalid();
    return { id, title, url: provider === 'kuper' ? `https://kuper.ru/products/${encodeURIComponent(id)}` : `https://lavka.yandex.ru/product/${encodeURIComponent(id)}`,
        price: merchantMoney(row.currentPrice ?? row.price ?? row.pricePerItem), pack: text(row.amount ?? row.human_volume),
        available: typeof row.available === 'boolean' ? row.available : typeof row.inStock === 'boolean' ? row.inStock : typeof row.in_stock === 'boolean' ? row.in_stock
            : typeof row.stock?.available === 'boolean' ? row.stock.available : typeof row.stock === 'boolean' ? row.stock
            : typeof row.stock === 'number' && Number.isFinite(row.stock) && row.stock >= 0 ? row.stock > 0 : undefined };
}

/** Protocol adapters contain the fixed merchant paths; no code, endpoints or credentials come from the model. */
export function createMerchantDriver(provider: CommerceProvider, host: MerchantHost): CommerceDriver {
    const request = (method: MerchantRequest['method'], path: string, body?: unknown, effect: MerchantRequest['effect'] = 'read') => host.request({ method, path, body, effect });
    const known = new Map<string, CommerceProduct>();
    const remember = (p: CommerceProduct) => { known.set(p.id, p); if (known.size > 500) known.delete(known.keys().next().value!); return p; };
    const session: CommerceDriver['session'] = async () => {
        if (provider === 'kuper') {
            const raw = object(await request('GET', '/api/v2/profile')), id = raw.user?.id;
            if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 || typeof id === 'string' && id.length > 0 && id !== '0') return { authenticated: true, accountBinding: commerceHash([provider, String(id)]) };
        } else {
            const hint = await host.authHint(); if (hint.authenticated) return hint;
        }
        return { authenticated: false, interaction: await host.connect() };
    };
    const requireAuth = async () => { const value = await session(); if (!value.authenticated) throw new CommerceFailure('login_required', 'Войди в магазин в общем браузере.', value.interaction); return value; };
    const base = async () => {
        const context = await host.shoppingContext();
        if (!Array.isArray((context.position as any)?.location) || (context.position as any).location.length !== 2)
            return host.requirePageStep('Выбери адрес доставки на странице Лавки: цены и наличие зависят от него. Затем верни управление Кире.');
        return { depotType: 'regular', currencySign: '₽', ...context };
    };
    const kuperStore = async () => {
        const raw = object(await request('GET', '/api/shopping_session')), value = raw.shopping_session?.store?.id;
        if (!Number.isSafeInteger(value) || value <= 0) return host.requirePageStep('Выбери адрес и магазин в Купере, затем верни управление Кире.');
        return value as number;
    };
    const search: CommerceDriver['search'] = async (query, limit) => {
        if (provider === 'yandex-lavka') {
            const raw = object(await request('POST', '/api/v1/providers/search/v3/lavka', { ...await base(), text: query, productsLimit: limit, subcategoriesLimit: 0, useRetail: true, source: 'manual_input' }));
            return array(raw.cacheProducts).slice(0, limit).map(row => remember(product(provider, row)));
        }
        if (provider === 'kuper') {
            const params = new URLSearchParams({ sid: String(await kuperStore()), q: query, page: '1', per_page: String(limit), sort: 'popularity' });
            const raw = object(await request('GET', `/api/v2/products?${params}`)); return array(raw.products).slice(0, limit).map(row => remember(product(provider, row)));
        }
        if (provider === 'ozon') return ozonSearch(await ozonPage(`/search/?text=${encodeURIComponent(query)}`)).slice(0, limit).map(remember);
        if (provider === 'yandex-market') {
            const rows = await host.readMarketOffers(`/search?text=${encodeURIComponent(query)}`), unique = new Map<string, CommerceProduct>();
            for (const row of rows) {
                const id = commerceId(String(row.wareId)), card = String(row.oskuId);
                if (!/^\d+$/.test(card) || !text(row.title)) continue;
                const discount = Array.isArray(row.additionalPrices) ? row.additionalPrices.find((p: any) => p.priceType === 'withDiscount')?.priceValue : undefined;
                unique.set(id, remember({ id, title: text(row.title), url: `https://market.yandex.ru/card/x/${card}`,
                    price: merchantMoney(discount ?? row.price), available: typeof row.lastStock?.stockItemCount === 'number' ? row.lastStock.stockItemCount > 0 : undefined }));
            }
            return [...unique.values()].slice(0, limit);
        }
        return host.requirePageStep(`Автоматический каталог ${storefront(provider).name} ещё не подтверждён для этой версии сайта. Можно просмотреть страницу в общем браузере.`);
    };
    const ozonPage = (path: string) => request('GET', `/api/composer-api.bx/page/json/v2?${new URLSearchParams({ url: path })}`);
    const getProduct: CommerceDriver['product'] = async id => {
        commerceId(id);
        if (provider === 'yandex-lavka') {
            const raw = object(await request('POST', '/api/v1/providers/v1/product', { ...await base(), productId: id, needCatalogPaths: true, isEcomboReward: false, rewardPriceTemplate: '', enableUnavailable: true }));
            const result = product(provider, raw.product); if (result.id !== id) return invalid(); return remember(result);
        }
        if (provider === 'kuper' || provider === 'yandex-market') {
            const old = known.get(id); if (!old) throw new CommerceFailure('invalid_input', 'Сначала найди товар в текущем магазине: идентификатор предложения зависит от магазина.');
            const fresh = (await search(old.title, 30)).find(p => p.id === id); if (!fresh) return invalid(); return fresh;
        }
        if (provider === 'ozon') {
            if (!/^\d+$/.test(id)) return invalid();
            const raw = await ozonPage(`/product/${id}/`), heading = widget(raw, 'webProductHeading'), price = widget(raw, 'webPrice');
            const title = text(heading?.title); if (!title || !price) return invalid();
            return remember({ id, title, url: `https://www.ozon.ru/product/${id}/`, price: merchantMoney(price.price), available: price.isAvailable });
        }
        return host.requirePageStep('Карточка товара пока требует просмотра в общем браузере.');
    };
    const lavkaCart = async () => {
        const raw = object(await request('POST', '/api/v1/providers/cart/v1/retrieve', await base()));
        const data = object(raw.cart ?? raw); array(data.items); return data;
    };
    const kuperCart = async () => { const raw = object(await request('GET', '/api/multiretailer_order')); const data = object(raw.order); array(data.shipments); return data; };
    const kuperLines = (data: any): CommerceLine[] => array(data.shipments).flatMap(shipment => array(shipment.line_items).map(row => {
        const p = remember(product('kuper', { ...row, id: row.offer_id })); return { product: p, quantity: quantity(row.quantity) };
    }));
    const cart: CommerceDriver['cart'] = async () => {
        await requireAuth(); let items: CommerceLine[], total: CommerceMoney | undefined, source: unknown;
        if (provider === 'yandex-lavka') {
            const data = await lavkaCart(); items = data.items.map((row: any) => ({ product: remember(product(provider, row)), quantity: quantity(row.quantity ?? row.count) }));
            total = merchantMoney(data.totalPriceValue ?? data.totalPrice); source = [data.cartId, data.cartVersion, await base()];
        } else if (provider === 'kuper') {
            const data = await kuperCart(); items = kuperLines(data); total = merchantMoney(data.total); source = [data.number, await kuperStore(), data.shipments.map((shipment: any) => shipment.store_id)];
        } else if (provider === 'ozon') {
            const raw = await ozonPage('/cart'); items = ozonCart(raw); source = undefined;
            // A truncated/paginated cart must never become an authoritative replacement.
            if (walk(widgets(raw)).some(n => typeof n.link === 'string' && /[?&]page=/.test(n.link))) throw new CommerceFailure('unavailable', 'Магазин разбил корзину на страницы. Полнота пока не подтверждена.');
        } else return host.requirePageStep('Чтение личной корзины этого магазина пока требует общего браузера.');
        return { items, total, revision: commerceHash([source, cartRevision(items, total)]), observedAt: now() };
    };
    const order: CommerceDriver['order'] = async id => {
        commerceId(id); await requireAuth();
        if (provider === 'yandex-lavka') {
            const raw = object(await request('GET', `/api/v1/orders/v1/history/${encodeURIComponent(id)}`)); return lavkaOrder(object(raw.data ?? raw));
        }
        if (provider === 'kuper') {
            const raw = object(await request('GET', `/api/v2/orders/${encodeURIComponent(id)}`)); const data = object(raw.order);
            return { id: commerceId(String(data.number)), status: text(data.state), items: kuperLines(data), total: merchantMoney(data.total), observedAt: now() };
        }
        if (provider === 'ozon') {
            if (!/^\d{6,}-\d{3,}$/.test(id)) return invalid();
            const raw = await ozonPage(`/my/orderdetails/?order=${encodeURIComponent(id)}`), shipments = widgets(raw).filter(w => w.name.startsWith('shipmentWidget'));
            if (!shipments.length) return invalid();
            const items: CommerceOrder['items'] = [];
            for (const shipment of shipments) {
                const status = text(walk(shipment.data.header).find(n => (n.testInfo ?? n.common?.testInfo)?.automatizationId === 'shipment-status')?.text);
                for (const row of array(shipment.data.items)) for (const seller of array(row.sellers)) for (const p of array(seller.products)) {
                    const sku = commerceId(String(p.title?.common?.action?.id)), title = text(p.title?.name?.text ?? p.title?.name);
                    if (!/^\d+$/.test(sku) || !title) return invalid();
                    items.push({ product: remember({ id: sku, title, url: `https://www.ozon.ru/product/${sku}/`, price: merchantMoney(p.price?.price?.[0]?.text) }), status });
                }
            }
            return { id, items, observedAt: now(), url: `https://www.ozon.ru/my/orderdetails/?order=${id}` };
        }
        return host.requirePageStep('Детали заказа этого магазина пока требуют просмотра в общем браузере.');
    };
    const orders: CommerceDriver['orders'] = async limit => {
        await requireAuth();
        if (provider === 'yandex-lavka') {
            const raw = object(await request('GET', `/api/v1/orders/v1/history/list?count=${limit}`));
            return array(raw.data?.orders).slice(0, limit).map(lavkaOrder);
        }
        if (provider === 'kuper') {
            const raw = object(await request('GET', '/api/v2/orders/previous'));
            return array(raw.orders).slice(0, limit).map(data => ({ id: commerceId(String(data.number)), status: text(data.state), items: kuperLines(data), total: merchantMoney(data.total), observedAt: now() }));
        }
        if (provider === 'ozon') {
            const raw = await ozonPage('/my/orderlist?selectedTab=archive'), state = widget(raw, 'orderList'), found = new Map<string, CommerceOrder>();
            for (const row of array(state?.ordersV2)) {
                const status = text(walk(row.leftBlock).find(n => (n.testInfo ?? n.common?.testInfo)?.automatizationId === 'tileStatus')?.text);
                for (const n of walk(row)) {
                    const match = typeof n.link === 'string' ? n.link.match(/^\/my\/orderdetails\/\?order=(\d{6,}-\d{3,})(?:&|$)/) : null;
                    if (match) found.set(match[1], { id: match[1], status, items: [], observedAt: now(), url: `https://www.ozon.ru/my/orderdetails/?order=${match[1]}` });
                }
            }
            return [...found.values()].slice(0, limit);
        }
        return host.requirePageStep('История этого магазина ещё не извлекается надёжно: открой её в общем браузере.');
    };
    const setCart: CommerceDriver['setCart'] = async items => {
        await requireAuth();
        if (provider === 'ozon') {
            if (items.some(item => !/^\d+$/.test(item.id) || !Number.isSafeInteger(Number(item.id)) || !Number.isInteger(item.quantity))) throw new CommerceFailure('invalid_input', 'Ozon требует целый SKU и количество.');
            await request('POST', '/api/composer-api.bx/_action/v2/addToCart', items.map(item => ({ id: Number(item.id), quantity: item.quantity })), 'cart');
        } else if (provider === 'yandex-lavka') {
            const data = await lavkaCart(), context = await base();
            if (!data.cartId || data.cartVersion === undefined) return invalid();
            const lines = new Map(array(data.items).map(row => [String(row.id), { ...row }]));
            for (const item of items) {
                const p = item.quantity ? await getProduct(item.id) : known.get(item.id);
                const price = p?.price ?? merchantMoney(lines.get(item.id)?.price); if (!price) return invalid();
                if (!item.quantity) lines.delete(item.id); else lines.set(item.id, { id: item.id, quantity: String(item.quantity), pricePerCount: '1', quantityType: 'unit', price: (price.minor / 100).toFixed(2), title: '', currency: 'RUB' });
            }
            await request('POST', '/api/v1/providers/cart/v1/update', { ...context, items: [...lines.values()], cartId: data.cartId, cartVersion: data.cartVersion, idempotencyToken: randomUUID(), isUserOrderEdit: false }, 'cart');
        } else if (provider === 'kuper') {
            const data = await kuperCart(), storeId = await kuperStore();
            for (const item of items) {
                if (!/^\d+$/.test(item.id) || !Number.isInteger(item.quantity)) return invalid();
                const found = array(data.shipments).flatMap(s => array(s.line_items)).find(line => String(line.offer_id) === item.id);
                if (found) {
                    if (!Number.isSafeInteger(found.id)) return invalid();
                    await request(item.quantity ? 'PUT' : 'DELETE', `/api/v2/line_items/${found.id}`, item.quantity ? { quantity: item.quantity } : undefined, 'cart');
                } else if (item.quantity) await request('POST', '/api/v2/line_items', { order_number: commerceId(String(data.number)), store_id: storeId, product_id: Number(item.id), quantity: item.quantity }, 'cart');
            }
        } else return host.requirePageStep('Изменение корзины этого магазина пока доступно только вручную в общем браузере.');
        return cart();
    };
    function lavkaOrder(data: any): CommerceOrder {
        const info = object(data.deliveryInfo ?? data);
        return { id: commerceId(String(info.orderId ?? info.id)), status: text(info.status), placedAt: text(info.createdAt ?? info.date),
            items: Array.isArray(data.positions) ? data.positions.filter((row: any) => row.id && (row.count ?? row.quantity) > 0).map((row: any) => ({ product: remember(product(provider, row)), quantity: quantity(row.count ?? row.quantity) })) : [],
            total: merchantMoney(data.calculation?.finalCost), observedAt: now() };
    }
    return { provider, session, connect: () => host.connect(), search, product: getProduct, cart, orders, order, setCart, checkout: () => host.checkout(), disconnect: () => host.disconnect() };
}

function widgets(raw: any): any[] {
    const states = object(raw).widgetStates; object(states);
    return Object.entries(states).map(([name, value]) => { try { return { name, data: typeof value === 'string' ? JSON.parse(value) : value }; } catch { return invalid(); } });
}
function widget(raw: any, prefix: string): any { return widgets(raw).find(entry => entry.name === prefix || entry.name.startsWith(`${prefix}-`))?.data; }
function walk(value: any): any[] {
    const pending = [value], result = []; let budget = 20000;
    while (pending.length && budget-- > 0) { const node = pending.pop(); if (Array.isArray(node)) pending.push(...node); else if (node && typeof node === 'object') { result.push(node); pending.push(...Object.values(node)); } }
    if (pending.length) return invalid(); return result;
}
function ozonSearch(raw: any): CommerceProduct[] {
    const grid = widget(raw, 'tileGridDesktop') ?? widget(raw, 'searchResultsV2');
    return array(grid?.items).map(item => {
        const nodes = walk(item), id = commerceId(String(item.sku ?? item.skuId ?? item.id));
        const title = text(nodes.find(n => n.id === 'name' || n.testInfo?.automatizationId === 'tile-name')?.text);
        if (!/^\d+$/.test(id) || !title) return invalid();
        const prices = nodes.flatMap(n => Array.isArray(n.price) ? n.price : []);
        return { id, title, url: `https://www.ozon.ru/product/${id}/`, price: merchantMoney(prices.find(p => p.textStyle === 'PRICE')?.text) };
    });
}
function ozonCart(raw: any): CommerceLine[] {
    const splits = widgets(raw).filter(entry => entry.name.startsWith('cartSplit'));
    if (!splits.length) return invalid();
    return splits.flatMap(entry => array(entry.data.cartItems).map(row => {
        const p = object(row.product), nodes = walk(p.titleColumn), title = text(nodes.find(n => n.id === 'name')?.text ?? nodes.find(n => typeof n.text === 'string')?.text);
        const id = commerceId(String(p.id)); if (!title || !/^\d+$/.test(id)) return invalid();
        const prices = walk(p.priceColumn).flatMap(n => Array.isArray(n.price) ? n.price : []);
        return { product: { id, title, url: `https://www.ozon.ru/product/${id}/`, price: merchantMoney(prices.find(n => n.textStyle === 'PRICE')?.text) }, quantity: quantity(row.controls?.quantity?.current) };
    }));
}
