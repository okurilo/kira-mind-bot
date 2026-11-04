import { randomUUID } from 'node:crypto';
import { CommerceStore } from './store';
import { CommerceFailure, commerceHash, commerceId, commerceQuantity, type CommerceDriver, type CommerceDraft, type CommerceLine, type CommerceMoney } from './contracts';

/** A proposed basket is local. Only applyDraft touches the merchant and it is one exact confirmed operation. */
export class CommerceService {
    constructor(readonly driver: CommerceDriver, readonly store: CommerceStore, private readonly now: () => number = Date.now) {}
    private async binding() {
        const session = await this.driver.session();
        if (!session.authenticated || !session.accountBinding) throw new CommerceFailure('login_required', 'Для личной корзины и истории нужен вход в магазин.', session.interaction);
        const old = await this.store.snapshot();
        if (old.accountBinding && old.accountBinding !== session.accountBinding) throw new CommerceFailure('account_changed', 'Аккаунт магазина отличается от ранее подключённого. Нужна явная перепривязка.');
        return session.accountBinding;
    }
    async history(limit = 20, refresh = true) {
        if (!refresh) return (await this.store.snapshot()).orders.slice(0, limit);
        const account = await this.binding();
        if (refresh) await this.store.remember(await this.driver.orders(limit), account);
        return (await this.store.snapshot()).orders.slice(0, limit);
    }
    async order(id: string) {
        const account = await this.binding(), order = await this.driver.order(commerceId(id));
        if (order.id !== id) throw new CommerceFailure('unavailable', 'Магазин вернул другой заказ.');
        await this.store.remember([order], account); return order;
    }
    async draft(items: Array<{ id: string; quantity: number }>, mode: 'merge' | 'replace') {
        if (!Array.isArray(items) || !items.length || items.length > 100 || !['merge', 'replace'].includes(mode))
            throw new CommerceFailure('invalid_input', 'Нужны 1–100 товаров и режим merge или replace.');
        const accountBinding = await this.binding(), cart = await this.driver.cart();
        if (new Set(cart.items.map(line => line.product.id)).size !== cart.items.length)
            throw new CommerceFailure('unavailable', 'Корзина содержит одинаковый ID в разных позициях/магазинах. Автоматическая замена неоднозначна; проверь состав на сайте.');
        const quantities = new Map(mode === 'merge' ? cart.items.map(line => [line.product.id, line.quantity] as const) : []);
        const seen = new Set<string>();
        for (const line of items) {
            const id = commerceId(line.id); if (seen.has(id)) throw new CommerceFailure('invalid_input', 'Товар указан несколько раз. Передай итоговое количество.');
            seen.add(id); quantities.set(id, commerceQuantity(line.quantity));
        }
        const lines: CommerceLine[] = [];
        if (quantities.size > 100) throw new CommerceFailure('invalid_input', 'Итоговая корзина содержит больше 100 разных товаров.');
        for (const [id, quantity] of quantities) {
            const product = await this.driver.product(id);
            if (product.id !== id || product.available !== true || !product.price || !Number.isSafeInteger(product.price.minor) || product.price.minor < 0 || product.price.currency !== 'RUB')
                throw new CommerceFailure('unavailable', 'Не подтверждены наличие или цена одного из товаров. Выбери замену.');
            lines.push({ product, quantity });
        }
        const estimatedTotal: CommerceMoney = { currency: 'RUB', minor: lines.reduce((sum, line) => sum + Math.round(line.product.price!.minor * line.quantity), 0), label: 'Товары без неподтверждённой доставки и сборов' };
        const draft: CommerceDraft = { id: randomUUID(), revision: '', provider: this.driver.provider, accountBinding,
            items: lines, estimatedTotal, baseCartRevision: cart.revision, mode, createdAt: new Date(this.now()).toISOString(),
            expiresAt: new Date(this.now() + 30 * 60_000).toISOString(), status: 'proposed' };
        draft.revision = commerceHash(draft);
        await this.store.transaction(state => {
            const retained = state.drafts.filter(old => ['applying', 'unknown'].includes(old.status) || old.expiresAt > draft.createdAt);
            while (retained.length >= 20) {
                const removable = retained.findIndex(old => !['applying', 'unknown'].includes(old.status));
                if (removable < 0) throw new CommerceFailure('operation_uncertain', 'Нужно проверить прежние незавершённые изменения корзины.');
                retained.splice(removable, 1);
            }
            state.accountBinding = accountBinding; state.drafts = [...retained, draft];
        });
        return draft;
    }
    async applyDraft(id: string, revision: string, operationId: string) {
        return this.store.exclusive(() => this.applyExclusive(id, revision, operationId));
    }
    private async applyExclusive(id: string, revision: string, operationId: string) {
        const binding = await this.binding();
        const snapshot = await this.store.snapshot(); const draft = snapshot.drafts.find(item => item.id === id);
        if (!draft || draft.revision !== revision || draft.expiresAt <= new Date(this.now()).toISOString() || draft.accountBinding !== binding)
            throw new CommerceFailure('stale_draft', 'Корзина или аккаунт изменились либо подтверждение истекло. Нужен новый предварительный итог.');
        const receipt = snapshot.receipts[operationId];
        if (receipt) {
            if (receipt.draftId !== id) throw new CommerceFailure('invalid_input', 'Ключ операции уже относится к другой корзине.');
            if (receipt.status !== 'committed') throw new CommerceFailure('operation_uncertain', 'Результат прежнего изменения неизвестен. Автоматический повтор запрещён.');
            return { status: 'applied', cart: await this.driver.cart() };
        }
        if (draft.status !== 'proposed') throw new CommerceFailure('operation_uncertain', 'Эта корзина уже передавалась магазину. Проверь её фактическое состояние.');
        const current = await this.driver.cart();
        if (current.revision !== draft.baseCartRevision) throw new CommerceFailure('stale_draft', 'Корзина магазина изменилась после предварительного итога.');
        for (const line of draft.items) {
            const fresh = await this.driver.product(line.product.id);
            if (fresh.id !== line.product.id || fresh.available !== true || commerceHash(fresh.price) !== commerceHash(line.product.price))
                throw new CommerceFailure('stale_draft', 'Изменились цена или наличие. Подготовь и подтверди обновлённый итог.');
        }
        await this.store.transaction(state => {
            const latest = state.drafts.find(item => item.id === id);
            if (!latest || latest.status !== 'proposed' || state.receipts[operationId] || Object.values(state.receipts).some(receipt => receipt.status === 'running')) throw new CommerceFailure('operation_uncertain', 'Корзина уже исполняется или прежний исход неизвестен.');
            latest.status = 'applying'; state.receipts[operationId] = { draftId: id, status: 'running', createdAt: new Date(this.now()).toISOString() };
        });
        try {
            const quantities = draft.items.map(line => ({ id: line.product.id, quantity: line.quantity }));
            if (draft.mode === 'replace') for (const line of current.items) if (!quantities.some(item => item.id === line.product.id)) quantities.push({ id: line.product.id, quantity: 0 });
            const cart = await this.driver.setCart(quantities);
            if (cart.items.length !== draft.items.length || draft.items.some(line => !cart.items.some(actual => actual.product.id === line.product.id && actual.quantity === line.quantity && commerceHash(actual.product.price) === commerceHash(line.product.price))))
                throw new CommerceFailure('operation_uncertain', 'Магазин изменил корзину частично. Нужна проверка текущего состояния.');
            await this.store.transaction(state => { state.drafts.find(item => item.id === id)!.status = 'applied'; state.receipts[operationId].status = 'committed'; });
            return { status: 'applied', cart };
        } catch {
            await this.store.transaction(state => { state.drafts.find(item => item.id === id)!.status = 'unknown'; state.receipts[operationId].status = 'unknown'; });
            throw new CommerceFailure('operation_uncertain', 'Изменение корзины могло выполниться частично. Не повторяй его автоматически; прочитай текущую корзину.');
        }
    }
}
