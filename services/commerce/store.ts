import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PlatformSecrets } from '../../platform/crypto';
import { commerceProvider, type CommerceProvider } from './catalog';
import { CommerceFailure, type CommerceDraft, type CommerceOrder } from './contracts';

export interface CommerceState {
    version: 1; provider: CommerceProvider; accountBinding?: string;
    orders: CommerceOrder[]; drafts: CommerceDraft[];
    receipts: Record<string, { draftId: string; status: 'running' | 'committed' | 'unknown'; createdAt: string }>;
    browserState?: unknown;
}
const lanes = new Map<string, Promise<unknown>>();
const operations = new Map<string, Promise<unknown>>();

/** One account worker owns this directory. All native MCP connections share the same serialized state lane. */
export class CommerceStore {
    private readonly file: string;
    private readonly cipher: PlatformSecrets;
    constructor(root: string, readonly provider: CommerceProvider, private readonly accountScope: string, key: string) {
        if (!commerceProvider(provider) || !accountScope) throw new Error('Invalid commerce storage binding');
        this.file = path.join(root, provider, 'state.enc'); this.cipher = new PlatformSecrets(key);
    }
    async exclusive<T>(work: () => Promise<T>): Promise<T> {
        const previous = operations.get(this.file) ?? Promise.resolve();
        const task = previous.catch(() => {}).then(work); operations.set(this.file, task);
        try { return await task; } finally { if (operations.get(this.file) === task) operations.delete(this.file); }
    }
    private async read(): Promise<CommerceState> {
        let handle: fs.FileHandle | undefined;
        try {
            handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 8_000_000 || stat.mode & 0o077) throw new Error('Invalid private commerce state');
            const state = this.cipher.open<CommerceState>(await handle.readFile('utf8'), `${this.accountScope}:${this.provider}:commerce-state-v1`);
            if (state.version !== 1 || state.provider !== this.provider || !Array.isArray(state.orders) || !Array.isArray(state.drafts) || !state.receipts)
                throw new Error('Invalid commerce state');
            return state;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, provider: this.provider, orders: [], drafts: [], receipts: {} };
            throw new CommerceFailure('unavailable', 'Не удалось прочитать защищённое состояние магазина. Оно не было сброшено.');
        } finally { await handle?.close(); }
    }
    async transaction<T>(work: (state: CommerceState) => T | Promise<T>): Promise<T> {
        const previous = lanes.get(this.file) ?? Promise.resolve();
        const task = previous.catch(() => {}).then(async () => {
            const state = await this.read();
            const result = await work(state);
            if (Buffer.byteLength(JSON.stringify(state), 'utf8') > 5_500_000) throw new CommerceFailure('unavailable', 'Защищённое состояние магазина превысило лимит. Прежние данные сохранены.');
            const directory = path.dirname(this.file);
            await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700);
            const temporary = path.join(directory, `.state-${randomBytes(12).toString('hex')}`);
            let handle: fs.FileHandle | undefined;
            try {
                handle = await fs.open(temporary, 'wx', 0o600);
                await handle.writeFile(this.cipher.seal(state, `${this.accountScope}:${this.provider}:commerce-state-v1`));
                await handle.sync(); await handle.close(); handle = undefined;
                await fs.rename(temporary, this.file);
                const parent = await fs.open(directory, constants.O_RDONLY);
                try { await parent.sync(); } finally { await parent.close(); }
            } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
            return result;
        });
        lanes.set(this.file, task);
        try { return await task; } finally { if (lanes.get(this.file) === task) lanes.delete(this.file); }
    }
    async snapshot(): Promise<CommerceState> {
        await lanes.get(this.file)?.catch(() => {});
        return this.read();
    }
    async remember(orders: CommerceOrder[], accountBinding: string) {
        await this.transaction(state => {
            if (state.accountBinding && state.accountBinding !== accountBinding) throw new CommerceFailure('account_changed', 'Аккаунт магазина изменился. Сначала явно подключи новый аккаунт.');
            state.accountBinding = accountBinding;
            const merged = new Map(state.orders.map(order => [order.id, order]));
            for (const order of orders) {
                const old = merged.get(order.id);
                merged.set(order.id, !order.items.length && old?.items.length ? { ...order, items: old.items, itemsObservedAt: old.itemsObservedAt ?? old.observedAt } : order);
            }
            state.orders = [...merged.values()].sort((a, b) => (b.placedAt ?? b.observedAt).localeCompare(a.placedAt ?? a.observedAt)).slice(0, 200);
        });
    }
}
