import type { McpConfig, McpServerConfig } from '../mcp/config';
import { COMMERCE_PROVIDERS, commerceProvider, storefront } from './catalog';
import { COMMERCE_MCP_EFFECTS, commerceMcpToolNames } from './tools';

export function nativeCommerceServers(): McpConfig {
    return Object.fromEntries(COMMERCE_PROVIDERS.map(provider => [`kira_${provider.replace(/-/g, '_')}`, {
        description: `${storefront(provider).name}: собственный покупательский MCP ассистента. ${provider === 'samokat' ? 'Автоматический API ещё не подтверждён; доступен ручной вход/просмотр в общем браузере.' : provider === 'yandex-market' ? 'Поиск и карточки товаров; личная корзина и история пока требуют ручного браузера.' : 'Товары, личная история, повтор покупок, предлагаемая корзина; вход и оплата вручную в общем браузере iOS.'} Доступ зависит от сайта и выбранного адреса; live-приёмка не завершена.`,
        transport: 'builtin-commerce', commerceProvider: provider, tools: Object.fromEntries(commerceMcpToolNames(provider).map(name => [name, COMMERCE_MCP_EFFECTS[name]])), timeoutMs: 120_000,
    }]));
}
export function nativeCommerceProvider(config: McpServerConfig) {
    return config.transport === 'builtin-commerce' ? commerceProvider(config.commerceProvider) : undefined;
}
