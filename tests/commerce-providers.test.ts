import test from 'node:test';
import assert from 'node:assert/strict';
import { createMerchantDriver, merchantMoney, type MerchantHost } from '../services/commerce/providers';
import type { MerchantRequest } from '../services/commerce/browserHost';
import { CommerceFailure } from '../services/commerce/contracts';

function fixture(reply: (request: MerchantRequest) => unknown) {
    const requests: MerchantRequest[] = [];
    const host: MerchantHost = {
        authHint: async () => ({ authenticated: true, accountBinding: 'synthetic-account' }),
        connect: async () => ({ sessionId: 'synthetic-browser', kind: 'login', prompt: 'Войди на сайте' }),
        checkout: async () => ({ sessionId: 'synthetic-browser', kind: 'payment', prompt: 'Оплата на сайте' }), disconnect: async () => {},
        shoppingContext: async () => ({ position: { location: [37, 55] } }),
        request: async request => { requests.push(request); return reply(request); },
        requirePageStep: async prompt => { throw new CommerceFailure('blocked', prompt, { sessionId: 'synthetic-browser', kind: 'clarification', prompt }); },
        readMarketOffers: async () => [],
    };
    return { requests, host };
}
const lavkaProduct = { id: 'synthetic-milk', title: 'Синтетическое молоко', currentPrice: '100.25', available: true };

test('merchant money never substitutes conditional or malformed values for an ordinary RUB amount', () => {
    assert.deepEqual(merchantMoney('1 234,50 ₽'), { minor: 123450, currency: 'RUB' });
    assert.deepEqual(merchantMoney({ value: 99.95 }), { minor: 9995, currency: 'RUB' });
    for (const value of [-1, NaN, Infinity, 'от 10 ₽', '100 USD', '', true, { min: 50 }, 100000000]) assert.equal(merchantMoney(value), undefined);
});

test('Lavka search/cart/history use source IDs and actual delivery context, omit sensitive source fields', async () => {
    const f = fixture(request => {
        if (request.path.includes('/search/')) return { cacheProducts: [lavkaProduct] };
        if (request.path.includes('/retrieve')) return { cart: { cartId: 'synthetic-cart', cartVersion: 7, items: [{ ...lavkaProduct, quantity: '2' }], totalPriceValue: '200.50' } };
        if (request.path.includes('/history/list')) return { data: { orders: [{ deliveryInfo: { orderId: 'synthetic-order', status: 'delivered', address: 'PRIVATE', phone: 'PRIVATE' }, positions: [{ ...lavkaProduct, count: 2 }], calculation: { finalCost: '200.50' } }] } };
        throw Error('Unexpected source route');
    });
    const driver = createMerchantDriver('yandex-lavka', f.host);
    const search = await driver.search('молоко', 10); assert.equal(search[0].id, 'synthetic-milk');
    assert.equal((await driver.cart()).items[0].quantity, 2);
    const orders = await driver.orders(10); assert.equal(orders[0].id, 'synthetic-order'); assert.equal(orders[0].items[0].quantity, 2);
    assert.doesNotMatch(JSON.stringify(orders), /PRIVATE|address|phone/);
    assert.deepEqual((f.requests[0].body as any).position, { location: [37, 55] });
    assert.ok(f.requests.every(request => request.effect === 'read'));
});

test('Lavka cart update carries optimistic version and one idempotency token; it never calls submit', async () => {
    let changed = false;
    const f = fixture(request => {
        if (request.path.endsWith('/product')) return { product: lavkaProduct };
        if (request.path.endsWith('/update')) { changed = true; return { ok: true }; }
        if (request.path.endsWith('/retrieve')) return { cart: { cartId: 'synthetic-cart', cartVersion: changed ? 8 : 7, items: changed ? [{ ...lavkaProduct, quantity: '2' }] : [] } };
        throw Error('Unexpected route');
    });
    const driver = createMerchantDriver('yandex-lavka', f.host), cart = await driver.setCart([{ id: 'synthetic-milk', quantity: 2 }]);
    const writes = f.requests.filter(request => request.effect === 'cart'); assert.equal(writes.length, 1);
    const body = writes[0].body as any; assert.equal(body.cartVersion, 7); assert.equal(body.cartId, 'synthetic-cart'); assert.match(body.idempotencyToken, /^[\da-f-]{36}$/);
    assert.equal(body.items[0].price, '100.25'); assert.equal(body.items[0].quantity, '2'); assert.equal(cart.items[0].quantity, 2);
    assert.ok(f.requests.every(request => !request.path.includes('submit')));
});

test('source schema failures and missing address never masquerade as empty cart/catalog', async () => {
    const f = fixture(() => ({ error: 'source changed', token: 'PRIVATE' }));
    const driver = createMerchantDriver('yandex-lavka', f.host);
    await assert.rejects(driver.cart(), (error: any) => error.code === 'unavailable');
    await assert.rejects(driver.search('молоко', 10), (error: any) => error.code === 'unavailable');
    f.host.shoppingContext = async () => ({});
    await assert.rejects(driver.search('молоко', 10), (error: any) => error.interaction?.kind === 'clarification');
});

test('Kuper ties products to the selected source store and updates absolute existing line quantities', async () => {
    let count = 1, selectedStore = 301;
    const p = { id: 501, name: 'Синтетический кефир', price: 90, stock: { available: true } };
    const f = fixture(request => {
        if (request.path === '/api/v2/profile') return { user: { id: 701, phone: 'PRIVATE' } };
        if (request.path === '/api/shopping_session') return { shopping_session: { store: { id: selectedStore } } };
        if (request.path.startsWith('/api/v2/products?')) return { products: [p] };
        if (request.path === '/api/multiretailer_order') return { order: { number: 'SYNTHETIC-R1', shipments: [{ store_id: 301, line_items: [{ id: 801, offer_id: 501, name: p.name, quantity: count, price: 90 }] }] } };
        if (request.path === '/api/v2/line_items/801') { count = (request.body as any).quantity; return { ok: true }; }
        throw Error('Unexpected route');
    });
    const driver = createMerchantDriver('kuper', f.host); const products = await driver.search('кефир', 5);
    assert.equal(products[0].price?.minor, 9000); assert.match(f.requests.find(r => r.path.startsWith('/api/v2/products?'))!.path, /sid=301/);
    assert.equal((await driver.product('501')).available, true);
    const result = await driver.setCart([{ id: '501', quantity: 3 }]); assert.equal(result.items[0].quantity, 3);
    assert.equal(f.requests.filter(r => r.effect === 'cart').length, 1); assert.equal(f.requests.find(r => r.effect === 'cart')!.method, 'PUT');
    assert.doesNotMatch(JSON.stringify(await driver.session()), /PRIVATE|phone/);
    p.stock = true as any;
    assert.equal((await driver.product('501')).available, true, 'the source also returns scalar stock availability');
    const revision = result.revision; selectedStore = 302;
    assert.notEqual((await driver.cart()).revision, revision, 'switching the selected store invalidates an otherwise identical cart draft');
});

test('Ozon selects explicit widget fields and ordinary price; absent quantity in an order stays unknown', async () => {
    const f = fixture(request => {
        const path = new URL(request.path, 'https://www.ozon.ru').searchParams.get('url')!;
        if (path.startsWith('/product/')) return { widgetStates: { 'webProductHeading-a': JSON.stringify({ title: 'Синтетический чай' }), 'webPrice-a': JSON.stringify({ price: '200 ₽', cardPrice: '100 ₽', isAvailable: true }) } };
        if (path.startsWith('/my/orderdetails')) return { widgetStates: { 'shipmentWidget-a': JSON.stringify({ header: [{ testInfo: { automatizationId: 'shipment-status' }, text: 'Отменён' }], items: [{ sellers: [{ products: [{ title: { common: { action: { id: '123456' } }, name: { text: 'Синтетический чай' } }, price: { price: [{ text: '190 ₽' }] } }] }] }] }) } };
        throw Error('Unexpected route');
    });
    const driver = createMerchantDriver('ozon', f.host);
    assert.equal((await driver.product('123456')).price?.minor, 20000);
    const order = await driver.order('12345678-1234'); assert.equal(order.items[0].quantity, undefined); assert.equal(order.items[0].status, 'Отменён');
    await assert.rejects(driver.product('../submit'), (error: any) => error.code === 'invalid_input');
    assert.ok(f.requests.every(r => r.effect === 'read'));
});

test('Market uses offer identity, preserves bank-independent price and refreshes exact offer, not another seller', async () => {
    const f = fixture(() => { throw Error('Market must not invent JSON API routes'); });
    f.host.readMarketOffers = async () => [
        { type: 'offer', wareId: 'synthetic-a', oskuId: '100001', title: 'Синтетический товар', price: '1200', additionalPrices: [{ priceType: 'yaBank', priceValue: '900' }, { priceType: 'withDiscount', priceValue: '1100' }], lastStock: { stockItemCount: 3 } },
        { type: 'offer', wareId: 'synthetic-b', oskuId: '100002', title: 'Синтетический товар', price: '800' },
    ];
    const driver = createMerchantDriver('yandex-market', f.host);
    assert.equal((await driver.search('товар', 10))[0].price?.minor, 110000);
    assert.equal((await driver.product('synthetic-a')).url, 'https://market.yandex.ru/card/x/100001');
    assert.equal((await driver.product('synthetic-a')).id, 'synthetic-a');
    await assert.rejects(driver.product('unknown'), (error: any) => error.code === 'invalid_input');
});

test('Samokat missing protocol is explicit and has no guessed mutation/history endpoints', async () => {
    const f = fixture(() => { throw Error('No unverified API calls'); });
    const driver = createMerchantDriver('samokat', f.host);
    await assert.rejects(driver.search('еда', 10), (error: any) => error.code === 'blocked');
    assert.equal(f.requests.length, 0);
});
