import { AppDataSource } from '../data-source';
import { ApiError } from '../api/contracts';
import { scopedBotKey } from '../utils/botIdentity';
import type { DataSource, EntityManager } from 'typeorm';

export interface UiTransaction {
    /** Canonical dialogue marker, read under the same channel lock. */
    dialogueTurn?(): Promise<string | undefined>;
    get<T>(kind: string, id: string): Promise<T | undefined>;
    put(kind: string, id: string, value: unknown): Promise<void>;
    delete(kind: string, id: string): Promise<void>;
    list<T>(kind: string, limit: number): Promise<Array<{ id: string; value: T }>>;
    trim(kind: string, retain: number): Promise<void>;
}
export interface UiStore { transact<T>(owner: number, work: (tx: UiTransaction) => Promise<T>): Promise<T> }
/** Existing tenant-owned bot_settings storage and grants; no tenant DDL, second auth store or worker registry access. */
export class PgUiStore implements UiStore {
    constructor(private source: DataSource = AppDataSource, private channel: 'api' | 'telegram' = 'api') {}
    transact<T>(owner: number, work: (tx: UiTransaction) => Promise<T>): Promise<T> {
        const prefix = scopedBotKey(this.channel === 'api' ? `ui:${owner}:` : `ui:telegram:${owner}:`);
        const dialogueKey = scopedBotKey(`dialogue:${this.channel === 'api' ? 'api:' : ''}${owner}`);
        return this.source.transaction(async manager => {
            if (this.channel === 'telegram') await manager.query("SET LOCAL lock_timeout = '2500ms'");
            // The canonical API turn marker uses this lock too: late deferred UI cannot overtake a new turn.
            await manager.query('/* ui-private */ SELECT pg_advisory_xact_lock(hashtext($1))', [dialogueKey]);
            await manager.query('/* ui-private */ SELECT pg_advisory_xact_lock(hashtext($1))', [prefix]);
            return work(new PgUiTransaction(manager, prefix, dialogueKey));
        }).catch(error => {
            if (error instanceof ApiError) throw error;
            throw new ApiError(503, 'ui_storage_unavailable', 'Хранилище карточек временно недоступно.');
        });
    }
}
class PgUiTransaction implements UiTransaction {
    constructor(private manager: EntityManager, private prefix: string, private dialogueKey: string) {}
    async dialogueTurn(): Promise<string | undefined> {
        const [row] = await this.manager.query('/* ui-private */ SELECT value FROM bot_settings WHERE key=$1', [this.dialogueKey]);
        return row?.value;
    }
    private key(kind: string, id: string) {
        if (!/^[a-z]+$/.test(kind) || !/^[A-Za-z0-9_:.-]{1,128}$/.test(id)) throw Error('invalid_ui_storage_key');
        return this.prefix + kind + ':' + id;
    }
    async get<T>(kind: string, id: string): Promise<T | undefined> {
        const [row] = await this.manager.query('/* ui-private */ SELECT value FROM bot_settings WHERE key=$1', [this.key(kind, id)]);
        return row ? JSON.parse(row.value) as T : undefined;
    }
    async put(kind: string, id: string, value: unknown) {
        await this.manager.query('/* ui-private */ INSERT INTO bot_settings(key,value,"updatedAt") VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,"updatedAt"=now()', [this.key(kind, id), JSON.stringify(value)]);
    }
    async delete(kind: string, id: string) {
        await this.manager.query('/* ui-private */ DELETE FROM bot_settings WHERE key=$1', [this.key(kind, id)]);
    }
    async list<T>(kind: string, limit: number) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error('invalid_ui_storage_limit');
        const prefix = this.key(kind, 'x').slice(0, -1);
        const rows = await this.manager.query('/* ui-private */ SELECT key,value FROM bot_settings WHERE key >= $1 AND key < $2 ORDER BY "updatedAt" DESC,key DESC LIMIT $3', [prefix, prefix + '\uffff', limit]);
        return rows.map((r: any) => ({ id: r.key.slice(prefix.length), value: JSON.parse(r.value) as T }));
    }
    async trim(kind: string, retain: number) {
        const prefix = this.key(kind, 'x').slice(0, -1);
        await this.manager.query('/* ui-private */ DELETE FROM bot_settings WHERE key IN (SELECT key FROM bot_settings WHERE key >= $1 AND key < $2 ORDER BY "updatedAt" DESC,key DESC OFFSET $3 LIMIT 1000)', [prefix, prefix + '\uffff', retain]);
    }
}
