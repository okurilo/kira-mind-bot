import { createHash } from 'node:crypto';
import type { CommerceProvider } from './catalog';

export interface CommerceMoney { minor: number; currency: 'RUB'; label?: string }
export interface CommerceProduct {
    id: string; title: string; url: string; price?: CommerceMoney; available?: boolean; pack?: string;
}
export interface CommerceLine { product: CommerceProduct; quantity: number }
export interface CommerceCart {
    items: CommerceLine[]; total?: CommerceMoney; revision: string; observedAt: string;
}
export interface CommerceOrder {
    id: string; placedAt?: string; status?: string; items: Array<{ product: CommerceProduct; quantity?: number; status?: string }>; total?: CommerceMoney; url?: string;
    observedAt: string;
    itemsObservedAt?: string;
}
export interface CommerceDraft {
    id: string; revision: string; provider: CommerceProvider; accountBinding: string;
    items: CommerceLine[]; estimatedTotal?: CommerceMoney; baseCartRevision: string; mode: 'merge' | 'replace';
    createdAt: string; expiresAt: string; status: 'proposed' | 'applying' | 'applied' | 'unknown';
}
export interface CommerceInteraction {
    sessionId: string; kind: 'login' | 'captcha' | 'payment' | 'clarification' | 'blocked'; prompt: string;
}
export class CommerceFailure extends Error {
    constructor(readonly code: 'login_required' | 'blocked' | 'unavailable' | 'invalid_input' | 'stale_draft' | 'account_changed' | 'operation_uncertain',
        message: string, readonly interaction?: CommerceInteraction) { super(message); }
}

/** JSON from merchants never supplies permissions, redirects, executable code or account selection. */
export interface CommerceDriver {
    readonly provider: CommerceProvider;
    session(): Promise<{ authenticated: boolean; accountBinding?: string; interaction?: CommerceInteraction }>;
    connect(): Promise<CommerceInteraction>;
    search(query: string, limit: number): Promise<CommerceProduct[]>;
    product(id: string): Promise<CommerceProduct>;
    cart(): Promise<CommerceCart>;
    orders(limit: number): Promise<CommerceOrder[]>;
    order(id: string): Promise<CommerceOrder>;
    /** Absolute quantities, not increments. The coordinator journals before this first effect. */
    setCart(items: Array<{ id: string; quantity: number }>): Promise<CommerceCart>;
    checkout(): Promise<CommerceInteraction>;
    disconnect(): Promise<void>;
}

export function commerceHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function commerceId(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value))
        throw new CommerceFailure('invalid_input', 'Нужен идентификатор из результата магазина.');
    return value;
}
export function commerceQuantity(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100 || Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-7)
        throw new CommerceFailure('invalid_input', 'Количество должно быть больше нуля, не больше 100 и иметь до трёх знаков после запятой.');
    return value;
}
export function cartRevision(items: CommerceLine[], total?: CommerceMoney): string {
    return commerceHash({ items: items.map(line => ({ id: line.product.id, quantity: line.quantity, price: line.product.price,
        available: line.product.available })).sort((a, b) => a.id.localeCompare(b.id)), total });
}
