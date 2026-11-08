import type { UiStore, UiTransaction } from '../../generative-ui/store';

/** Transactional synthetic store. Owners, restart sharing and rollback are observable in service tests. */
export class MemoryUiStore implements UiStore {
    rows = new Map<number, Map<string, unknown>>();
    private tail: Promise<unknown> = Promise.resolve();
    transact<T>(owner: number, work: (tx: UiTransaction) => Promise<T>): Promise<T> {
        const run = this.tail.then(async () => {
            const rows = structuredClone(this.rows.get(owner) ?? new Map<string, unknown>());
            const tx: UiTransaction = {
                get: async <V>(kind: string, id: string) => structuredClone(rows.get(kind + ':' + id)) as V | undefined,
                put: async (kind, id, value) => { rows.delete(kind + ':' + id); rows.set(kind + ':' + id, structuredClone(value)); },
                list: async <V>(kind: string, limit: number) => [...rows.entries()].filter(([k]) => k.startsWith(kind + ':')).reverse().slice(0, limit)
                    .map(([id, value]) => ({ id: id.slice(kind.length + 1), value: structuredClone(value) as V })),
                trim: async (kind, retain) => {
                    const keys = [...rows.keys()].filter(k => k.startsWith(kind + ':')).reverse().slice(retain);
                    keys.forEach(k => rows.delete(k));
                },
            };
            const result = await work(tx); this.rows.set(owner, rows); return result;
        });
        this.tail = run.catch(() => {}); return run;
    }
}
