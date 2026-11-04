import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CommerceProvider } from './catalog';
const id = { type: 'string', minLength: 1, maxLength: 160 };
const schema = (properties: Record<string, object> = {}, required = Object.keys(properties)) => ({ type: 'object' as const, properties, required, additionalProperties: false });
/** Kept in local code: a remote annotation can never turn a purchase into a read. */
export const COMMERCE_MCP_EFFECTS: Record<string, 'read' | 'external'> = {
    session_status: 'read', connect_account: 'read', search_products: 'read', get_product: 'read', get_cart: 'read',
    purchase_history: 'read', get_order: 'read', preview_cart: 'read', get_cart_draft: 'read',
    apply_cart: 'external', checkout_preview: 'read', disconnect_account: 'external', forget_history: 'external',
};
export function commerceMcpToolNames(provider: CommerceProvider): string[] {
    if (provider === 'samokat') return ['session_status', 'connect_account', 'disconnect_account', 'forget_history'];
    if (provider === 'yandex-market') return ['session_status', 'connect_account', 'search_products', 'get_product', 'disconnect_account', 'forget_history'];
    return Object.keys(COMMERCE_MCP_EFFECTS);
}
export const COMMERCE_MCP_TOOLS: Tool[] = [
    { name: 'session_status', description: 'Проверить подключение магазина. При необходимости поставить задачу на паузу для входа в общем браузере; cookies, токены и платёжные данные не возвращаются.', inputSchema: schema() },
    { name: 'connect_account', description: 'Открыть вход в этот магазин в общем браузере iOS. Ввод выполняет владелец; не проси секреты в диалоге.', inputSchema: schema() },
    { name: 'search_products', description: 'Свежие товары магазина и точные ID/цены. Передай query; регион зависит от выбранного в магазине адреса.', inputSchema: schema({ query: { type: 'string', minLength: 1, maxLength: 300 }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, ['query']) },
    { name: 'get_product', description: 'Свежая карточка одного найденного товара. Не подставляй URL вместо ID.', inputSchema: schema({ id }) },
    { name: 'get_cart', description: 'Фактическая корзина магазина, цены и ревизия. Пустая корзина отличается от отказа сайта.', inputSchema: schema() },
    { name: 'purchase_history', description: 'Личная история заказов из магазина или собственный сохранённый кэш. Используй для повтора покупок и предложений разнообразия; черновик не считается покупкой.', inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 50 }, refresh: { type: 'boolean' } }, []) },
    { name: 'get_order', description: 'Товары и фактический статус выбранного заказа из истории.', inputSchema: schema({ id }) },
    { name: 'preview_cart', description: 'Подготовить локальную предлагаемую корзину по ID/количествам без изменений в магазине. merge сохраняет прежние товары, replace явно заменяет состав. Результат — точный draftId/revision для одного последующего подтверждения.', inputSchema: schema({ items: { type: 'array', minItems: 1, maxItems: 100, items: schema({ id, quantity: { type: 'number', exclusiveMinimum: 0, maximum: 100 } }) }, mode: { type: 'string', enum: ['merge', 'replace'] } }) },
    { name: 'get_cart_draft', description: 'Прочитать ранее предложенную корзину по её точному ID; не пересоздавай её при ответе пользователя.', inputSchema: schema({ draftId: id }) },
    { name: 'apply_cart', description: 'Применить только подтверждённый draftId/revision к корзине магазина. Повтор неизвестного исхода запрещён. Заказ и списание не выполняются.', inputSchema: schema({ draftId: id, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' } }) },
    { name: 'checkout_preview', description: 'Показать итог и передать ту же авторизованную страницу владельцу для оформления и оплаты в iOS. Не отправляет заказ автоматически.', inputSchema: schema() },
    { name: 'disconnect_account', description: 'Отключить собственную сессию этого магазина после подтверждения владельца.', inputSchema: schema() },
    { name: 'forget_history', description: 'Удалить сохранённую историю и предложения этого магазина после подтверждения. Это не отменяет заказы магазина.', inputSchema: schema() },
].map(tool => ({ ...tool, annotations: { readOnlyHint: COMMERCE_MCP_EFFECTS[tool.name] === 'read', destructiveHint: false } }));
