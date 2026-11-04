import type { BrowserContext, Request } from 'playwright';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { createBrowserProxy } from '../../platform/browserProxy';
import { commerceHostAllowed, commerceRequestAllowed, type CommerceProvider } from './catalog';

export type CommerceBlockReason = 'request_denied' | 'access_denied' | 'rate_limited';

/** The proxy is installed BEFORE Chromium starts, including startup/background traffic.
 * It reuses the account proxy's DNS pinning, rather than validating DNS then resolving again. */
export async function startCommerceProxy(provider: CommerceProvider): Promise<{ url: string; close(): Promise<void> }> {
    const server: Server = createBrowserProxy(host => commerceHostAllowed(provider, host), false);
    const sockets = new Set<Socket>();
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new Error('Не удалось создать изолированное соединение магазина.'); }
    let closing: Promise<void> | undefined;
    return { url: `http://127.0.0.1:${address.port}`, close: () => closing ??= new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
    }) };
}

/** Use only an ephemeral context: no local Chrome, cookie imports/exports, or shared Yandex profile. */
export async function installCommercePolicy(context: BrowserContext, provider: CommerceProvider, human: () => boolean, onBlockedAction?: (reason: CommerceBlockReason) => void,
    authorizeRequest?: (request: Request) => boolean, options: { notifyMerchantWrites?: boolean } = {}): Promise<void> {
    await context.route('**/*', async route => {
        const request = route.request();
        if (!commerceRequestAllowed(provider, request.url(), request.method(), human()) && !authorizeRequest?.(request)) {
            await route.abort('blockedbyclient');
            // Notify after aborting, without waiting on the browser's action drain in this request handler.
            // No URL, request body, headers or credential values enter the user-facing notice.
            let navigation = request.isNavigationRequest();
            try { if (navigation) navigation = request.frame() === request.frame().page().mainFrame(); }
            catch { /* An early navigation may not have a frame yet; still report its block. */ }
            let merchantMutation = false;
            try { merchantMutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
                commerceHostAllowed(provider, new URL(request.url()).hostname); } catch { /* Invalid URL stays blocked. */ }
            if (!human() && (navigation || merchantMutation && options.notifyMerchantWrites !== false)) onBlockedAction?.('request_denied');
            return;
        }
        await route.continue();
    });
    // WebSockets bypass HTTP route interception; service workers are disabled at context creation.
    await context.routeWebSocket('**/*', socket => socket.close());
    context.on('response', response => {
        if (human() || ![401, 403, 429].includes(response.status())) return;
        const request = response.request();
        if (!request.isNavigationRequest()) return;
        try { if (request.frame() !== request.frame().page().mainFrame()) return; }
        catch { /* The main frame may not be associated yet during an early navigation. */ }
        onBlockedAction?.(response.status() === 429 ? 'rate_limited' : 'access_denied');
    });
}
