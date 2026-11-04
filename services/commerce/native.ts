import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RUNTIME_DATA_DIR } from '../../utils/runtimeData';
import { isValidRuntimeOwnerId, resolveRuntimeIdentity } from '../../utils/runtimeIdentity';
import type { McpServerConfig } from '../mcp/config';
import { CommerceStore } from './store';
import { CommerceService } from './service';
import { CommerceBrowserHost } from './browserHost';
import { createMerchantDriver } from './providers';
import { nativeCommerceProvider } from './config';
import { commerceInvocation } from './context';
import { CommerceFailure, commerceHash } from './contracts';
import { connectCommerceMcp } from './mcp';

const services = new Map<string, Promise<CommerceService>>();

async function storageKey(root: string): Promise<string> {
    const configured = process.env.KIRA_COMMERCE_STORAGE_KEY;
    if (configured !== undefined) {
        if (!/^[a-f0-9]{64}$/i.test(configured)) throw new Error('Invalid private commerce key');
        return configured;
    }
    // Standalone single-owner runtime. Tenant workers always receive an account-derived key.
    if (process.env.KIRA_TENANT_ID) throw new Error('Tenant commerce key missing');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, 'storage.key');
    try { await fs.writeFile(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size !== 64) throw new Error('Invalid private commerce key file');
        const key = await handle.readFile('utf8');
        if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid private commerce key');
        return key;
    } finally { await handle.close(); }
}

export async function connectNativeCommerce(config: McpServerConfig, signal: AbortSignal) {
    const provider = nativeCommerceProvider(config);
    if (!provider) throw new Error('Unknown native merchant');
    return connectCommerceMcp({ provider, load: async () => {
        signal.throwIfAborted();
        const invocation = commerceInvocation(), owner = invocation?.context.ctx.from?.id;
        const expected = resolveRuntimeIdentity(process.env).allowedUserId;
        if (!owner || !isValidRuntimeOwnerId(owner) || owner !== expected || invocation!.context.ctx.chat?.type !== 'private')
            throw new CommerceFailure('blocked', 'Подключение магазина доступно только владельцу в личном диалоге.');
        if (invocation!.context.readOnly) throw new CommerceFailure('blocked', 'Подключение магазина недоступно в фоновом анализе диалога.');
        const scope = process.env.KIRA_TENANT_ID || `owner:${owner}`;
        const root = path.join(RUNTIME_DATA_DIR, 'commerce');
        const id = commerceHash([scope, provider, root]);
        let loaded = services.get(id);
        if (!loaded) {
            loaded = (async () => {
                const store = new CommerceStore(path.join(root, commerceHash(scope)), provider, scope, await storageKey(root));
                return new CommerceService(createMerchantDriver(provider, new CommerceBrowserHost(provider, store)), store);
            })();
            services.set(id, loaded);
            void loaded.catch(() => { if (services.get(id) === loaded) services.delete(id); });
        }
        return loaded;
    } }, () => { const operationId = commerceInvocation()?.approvedOperation; return operationId ? { operationId } : undefined; });
}
