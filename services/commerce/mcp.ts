import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { assertSafeMcpValue } from '../../utils/mcpConfig';
import { CommerceFailure } from './contracts';
import { CommerceService } from './service';

import { COMMERCE_MCP_TOOLS, COMMERCE_MCP_EFFECTS, commerceMcpToolNames } from './tools';
export { COMMERCE_MCP_TOOLS, COMMERCE_MCP_EFFECTS } from './tools';

export interface CommerceWriteAuthority { operationId: string }

type ServiceSource = CommerceService | { provider: import('./catalog').CommerceProvider; load(): Promise<CommerceService> };
export function createCommerceMcpServer(source: ServiceSource, authority: () => CommerceWriteAuthority | undefined) {
    const provider = 'load' in source ? source.provider : source.driver.provider;
    const supported = COMMERCE_MCP_TOOLS.filter(tool => commerceMcpToolNames(provider).includes(tool.name));
    const server = new Server({ name: `kira-${provider}-mcp`, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: supported }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
        const tool = supported.find(item => item.name === request.params.name), args = request.params.arguments ?? {};
        if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Неизвестный инструмент магазина.');
        let valid = false;
        try { assertSafeMcpValue(args); valid = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid; } catch { /* fail closed */ }
        if (!valid) throw new McpError(ErrorCode.InvalidParams, 'Аргументы не соответствуют схеме инструмента.');
        try {
            const permission = COMMERCE_MCP_EFFECTS[tool.name] === 'external' ? authority() : undefined;
            if (COMMERCE_MCP_EFFECTS[tool.name] === 'external' && !permission)
                throw new CommerceFailure('invalid_input', 'Требуется подтверждение конкретной операции владельцем в приложении.');
            const service = 'load' in source ? await source.load() : source;
            let data: unknown;
            switch (tool.name) {
                case 'session_status': data = await service.driver.session(); break;
                case 'connect_account': data = { interaction: await service.driver.connect() }; break;
                case 'search_products': data = { products: await service.driver.search(String(args.query), Number(args.limit ?? 20)) }; break;
                case 'get_product': data = { product: await service.driver.product(String(args.id)) }; break;
                case 'get_cart': data = { cart: await service.driver.cart() }; break;
                case 'purchase_history': data = { orders: await service.history(Number(args.limit ?? 20), args.refresh !== false), source: args.refresh === false ? 'saved_merchant_history' : 'merchant' }; break;
                case 'get_order': data = { order: await service.order(String(args.id)) }; break;
                case 'preview_cart': data = { draft: await service.draft(args.items as Array<{ id: string; quantity: number }>, args.mode as 'merge' | 'replace') }; break;
                case 'get_cart_draft': {
                    const draft = (await service.store.snapshot()).drafts.find(item => item.id === args.draftId);
                    if (!draft) throw new CommerceFailure('invalid_input', 'Предложенная корзина не найдена в этом аккаунте.');
                    data = { draft }; break;
                }
                case 'apply_cart': data = await service.applyDraft(String(args.draftId), String(args.revision), permission!.operationId); break;
                case 'checkout_preview': data = { cart: await service.driver.cart(), interaction: await service.driver.checkout() }; break;
                case 'disconnect_account': await service.driver.disconnect(); data = { disconnected: true }; break;
                case 'forget_history': await service.store.transaction(state => { state.orders = []; state.drafts = state.drafts.filter(draft => draft.status === 'applying' || draft.status === 'unknown'); }); data = { forgotten: true }; break;
            }
            const interaction = (data as { interaction?: unknown })?.interaction;
            const result = { version: 'kira_commerce_v1', provider: service.driver.provider, status: interaction ? 'needs_input' : 'ok', data, ...(interaction ? { interaction } : {}) };
            return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        } catch (error) {
            const known = error instanceof CommerceFailure ? error : new CommerceFailure('unavailable', 'Не удалось получить подтверждённый результат магазина.');
            const result = { version: 'kira_commerce_v1', provider,
                status: known.interaction ? 'needs_input' : known.code === 'operation_uncertain' ? 'unknown' : 'failed',
                code: known.code, message: known.message, interaction: known.interaction };
            return { isError: result.status !== 'needs_input', content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        }
    });
    return server;
}

/** Uses the actual MCP initialize/tools/list/tools/call protocol; credentials never cross the wire. */
export async function connectCommerceMcp(service: ServiceSource, authority: () => CommerceWriteAuthority | undefined) {
    const server = createCommerceMcpServer(service, authority), client = new Client({ name: 'kira-commerce-client', version: '1.0.0' });
    const [caller, callee] = InMemoryTransport.createLinkedPair();
    await server.connect(callee);
    try { await client.connect(caller); }
    catch (error) { await server.close(); throw error; }
    return { client, close: async () => { await client.close(); await server.close(); } };
}
