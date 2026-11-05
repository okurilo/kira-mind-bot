import type { DataSource, EntityManager } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { digest } from '../crypto';
import type { PublicAccountConfig } from './config';
import type { ConsentInput, QuotaView } from './contracts';
import * as v from './validation';

export interface OutboundAdmission {
    operationId: string;
    provider: string;
    endpoint: string;
    image: boolean;
    background: boolean;
    reserveOnly?: boolean;
    imageOperationId?: string;
}
type PolicyConfig = Pick<PublicAccountConfig, 'catalog' | 'routes' | 'aiLimit' | 'imageLimit' | 'backgroundAiLimit' | 'maxAiCallsPerOperation'>;
type BudgetPool = 'legacy' | 'dialogue' | 'background';
const prefix = (pool: BudgetPool): string => {
    if (pool === 'legacy') return 'ai';
    if (pool === 'dialogue' || pool === 'background') return pool;
    throw new ApiError(503, 'policy_unavailable', 'Неизвестная квота операции.');
};
const day = (now: Date) => now.toISOString().slice(0, 10);
const catalogError = () => new ApiError(403, 'consent_required', 'Нужно согласие на текущий список получателей AI.');

/** Shared account authority for every worker/channel. The tenant role never receives registry access. */
export class PublicAccountPolicy {
    constructor(private db: DataSource, private config: () => PolicyConfig, private now = () => new Date()) {}

    async consent(accountId: string) {
        const config = this.config();
        const [row] = await this.db.query('SELECT * FROM kira_public_consents WHERE account_id=$1', [accountId]);
        return { version: 1 as const, catalog: config.catalog, acceptedVersion: row?.accepted ? row.catalog_version as string : null,
            aiAllowed: Boolean(row?.accepted && row.catalog_version === config.catalog.version && config.catalog.recipients.length
                && config.catalog.recipients.every(r => row.recipient_ids.includes(r.id))) };
    }

    async setConsent(accountId: string, raw: Record<string, unknown>) {
        v.fields(raw, ['version','consentVersion','accepted','recipientIds'], ['version','consentVersion','accepted','recipientIds']);
        v.version(raw); v.text(raw.consentVersion, 1, 128);
        if (typeof raw.accepted !== 'boolean' || !Array.isArray(raw.recipientIds) || raw.recipientIds.length > 64
            || raw.recipientIds.some(id => typeof id !== 'string')) v.invalid();
        const input = raw as unknown as ConsentInput;
        await this.db.transaction(async tx => {
            await this.account(tx, accountId, false);
            const cfg = this.config();
            const expected = cfg.catalog.recipients.map(r => r.id).sort();
            if (input.accepted && (!expected.length || input.consentVersion !== cfg.catalog.version
                || JSON.stringify([...input.recipientIds].sort()) !== JSON.stringify(expected))) throw catalogError();
            if (!input.accepted && input.recipientIds.length) v.invalid();
            await tx.query(`INSERT INTO kira_public_consents(account_id,catalog_version,recipient_ids,accepted) VALUES($1,$2,$3::jsonb,$4)
                ON CONFLICT(account_id) DO UPDATE SET catalog_version=EXCLUDED.catalog_version,recipient_ids=EXCLUDED.recipient_ids,
                accepted=EXCLUDED.accepted,revision=kira_public_consents.revision+1,updated_at=now()`,
            [accountId, cfg.catalog.version, JSON.stringify(input.accepted ? expected : []), input.accepted]);
        });
        return this.consent(accountId);
    }

    /** Preflight reservation is optional. It never commits a unit before an outbound attempt. */
    async reserve(accountId: string, operationId: string, image = false, background = false): Promise<void> {
        if (!operationId || operationId.length > 512 || typeof background !== 'boolean') throw new ApiError(403, 'policy_unavailable', 'Неизвестная задача.');
        await this.db.transaction(async tx => {
            const account = await this.account(tx, accountId, true);
            if (background && !account.autonomous_ai_enabled) throw new ApiError(403, 'autonomous_ai_disabled', 'Самостоятельные AI-задачи выключены.');
            await this.reservation(tx, accountId, operationId, background, true);
            if(image)await this.imageReservation(tx,accountId,operationId,operationId);
        });
    }

    /** Must be awaited immediately before each actual send, including retry/fallback/background. */
    async authorizeOutbound(accountId: string, admission: OutboundAdmission): Promise<void> {
        if (!admission.operationId || admission.operationId.length > 512 || typeof admission.image !== 'boolean'
            || typeof admission.background !== 'boolean') throw new ApiError(403, 'policy_unavailable', 'Не удалось подтвердить операцию AI.');
        await this.db.transaction(async tx => {
            const account = await this.account(tx, accountId, true);
            if (admission.background && !account.autonomous_ai_enabled) throw new ApiError(403, 'autonomous_ai_disabled', 'Самостоятельные AI-задачи выключены.');
            const config = this.config();
            let url: URL;
            try { url = new URL(admission.endpoint); } catch { throw catalogError(); }
            if (url.username || url.password) throw catalogError();
            const endpoint = `${url.origin}${url.pathname}`.replace(/\/$/, '');
            const routes = config.routes.filter(r => r.provider === admission.provider
                && (endpoint === r.baseUrl || endpoint.startsWith(r.baseUrl + '/'))).sort((a, b) => b.baseUrl.length - a.baseUrl.length);
            const route = routes[0];
            if (!route || !config.catalog.recipients.length) throw catalogError();
            const [consent] = await tx.query('SELECT * FROM kira_public_consents WHERE account_id=$1', [accountId]);
            if (!consent?.accepted || consent.catalog_version !== config.catalog.version
                || route.recipientIds.some(id => !consent.recipient_ids.includes(id))) throw catalogError();
            const op = await this.reservation(tx, accountId, admission.operationId, admission.background);
            const imageOp = admission.image ? await this.imageReservation(tx,accountId,admission.operationId,admission.imageOperationId || admission.operationId) : undefined;
            if(admission.reserveOnly)return;
            if (Number(op.outbound_calls) >= (config.maxAiCallsPerOperation ?? 128)) throw new ApiError(429, 'operation_limit_exceeded', 'Достигнут предел AI-вызовов одной задачи.');
            const counter = prefix(op.budget_pool);
            if (op.ai_state === 'reserved') {
                await tx.query(`UPDATE kira_public_quota SET ${counter}_reserved=${counter}_reserved-1,${counter}_used=${counter}_used+1 WHERE account_id=$1 AND day=$2`,[accountId,op.day]);
                await tx.query("UPDATE kira_public_ai_operations SET ai_state='committed',lease_expires_at=NULL WHERE account_id=$1 AND operation_hash=$2",[accountId,digest(admission.operationId)]);
            }
            await tx.query('UPDATE kira_public_ai_operations SET outbound_calls=outbound_calls+1 WHERE account_id=$1 AND operation_hash=$2',[accountId,digest(admission.operationId)]);
            if(imageOp?.state==='reserved'){
                await tx.query('UPDATE kira_public_quota SET images_reserved=images_reserved-1,images_used=images_used+1 WHERE account_id=$1 AND day=$2',[accountId,imageOp.day]);
                await tx.query("UPDATE kira_public_image_operations SET state='committed',lease_expires_at=NULL WHERE account_id=$1 AND image_hash=$2",[accountId,imageOp.image_hash]);
            }
        });
    }

    async release(accountId: string, operationId: string, imageOperationId?: string | false): Promise<void> {
        await this.db.transaction(async tx => {
            await this.account(tx, accountId, false);
            const [op] = await tx.query('SELECT * FROM kira_public_ai_operations WHERE account_id=$1 AND operation_hash=$2 FOR UPDATE', [accountId, digest(operationId)]);
            if (!op) return;
            if(op.ai_state==='reserved'){
                const counter = prefix(op.budget_pool);
                await tx.query(`UPDATE kira_public_quota SET ${counter}_reserved=${counter}_reserved-1 WHERE account_id=$1 AND day=$2`,[accountId,op.day]);
                await tx.query("UPDATE kira_public_ai_operations SET ai_state='released',lease_expires_at=NULL WHERE account_id=$1 AND operation_hash=$2",[accountId,digest(operationId)]);
            }
            if(imageOperationId===false)return;
            const images=await tx.query(`SELECT * FROM kira_public_image_operations WHERE account_id=$1 AND operation_hash=$2 AND state='reserved'
                AND ($3::text IS NULL OR image_hash=$3) FOR UPDATE`,[accountId,digest(operationId),imageOperationId===undefined?null:digest(imageOperationId)]);
            for(const image of images){
                await tx.query('UPDATE kira_public_quota SET images_reserved=images_reserved-1 WHERE account_id=$1 AND day=$2',[accountId,image.day]);
                await tx.query("UPDATE kira_public_image_operations SET state='released',lease_expires_at=NULL WHERE account_id=$1 AND image_hash=$2",[accountId,image.image_hash]);
            }
        });
    }

    async quota(accountId: string): Promise<QuotaView> {
        const current = day(this.now());
        const row = await this.db.transaction(async tx=>{
            await this.account(tx,accountId,false);
            return (await tx.query('SELECT * FROM kira_public_quota WHERE account_id=$1 AND day=$2',[accountId,current]))[0];
        });
        const cfg = this.config();
        const budget = (prefix: string, limit: number) => {
            const used = Number(row?.[`${prefix}_used`] || 0), reserved = Number(row?.[`${prefix}_reserved`] || 0);
            return { limit, used, reserved, remaining: Math.max(0, limit - used - reserved) };
        };
        const dialogue = budget('dialogue', cfg.aiLimit);
        return { day: current, resetAt: new Date(Date.parse(current) + 24 * 3600_000).toISOString(), ai: dialogue, dialogue,
            background: budget('background', cfg.backgroundAiLimit ?? 60), images: budget('images', cfg.imageLimit),
            legacyAi: { used: Number(row?.ai_used || 0), reserved: Number(row?.ai_reserved || 0) } };
    }

    async restrict(accountId: string): Promise<void> {
        await this.db.query("UPDATE kira_accounts SET account_state='restricted',autonomous_ai_enabled=false WHERE id=$1 AND account_state NOT IN ('deleting','deleted')", [accountId]);
    }

    private async account(tx: EntityManager, accountId: string, active: boolean): Promise<any> {
        const [account] = await tx.query(`SELECT a.*,EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=a.id) AS deleted
            FROM kira_accounts a WHERE a.id=$1 FOR UPDATE OF a`, [accountId]);
        if (!account || account.deleted || ['deleting','deleted'].includes(account.account_state)) throw new ApiError(403, 'account_deleting', 'Аккаунт удаляется.');
        if (active && account.account_state === 'restricted') throw new ApiError(403, 'account_restricted', 'Доступ к AI ограничен.');
        if (active && account.account_state !== 'active') throw new ApiError(409, 'activation_required', 'Сначала активируй аккаунт.');
        await this.expireReservations(tx,accountId);
        return account;
    }

    private async expireReservations(tx:EntityManager,accountId:string):Promise<void>{
        for (const pool of ['legacy', 'dialogue', 'background'] as BudgetPool[]) {
            const counter = prefix(pool);
            await tx.query(`WITH expired AS (UPDATE kira_public_ai_operations SET ai_state='released',lease_expires_at=NULL
                WHERE account_id=$1 AND budget_pool=$3 AND ai_state='reserved' AND lease_expires_at<=$2 RETURNING day),
                totals AS(SELECT day,count(*)::int AS count FROM expired GROUP BY day)
                UPDATE kira_public_quota q SET ${counter}_reserved=GREATEST(0,q.${counter}_reserved-t.count)
                FROM totals t WHERE q.account_id=$1 AND q.day=t.day`,[accountId,this.now(),pool]);
        }
        for(const [table,state,counter] of [['kira_public_image_operations','state','images_reserved']]){
            await tx.query(`WITH expired AS (UPDATE ${table} SET ${state}='released',lease_expires_at=NULL
                WHERE account_id=$1 AND ${state}='reserved' AND lease_expires_at<=$2 RETURNING day),
                totals AS(SELECT day,count(*)::int AS count FROM expired GROUP BY day)
                UPDATE kira_public_quota q SET ${counter}=GREATEST(0,q.${counter}-t.count)
                FROM totals t WHERE q.account_id=$1 AND q.day=t.day`,[accountId,this.now()]);
        }
    }

    private async reservation(tx: EntityManager, accountId: string, operationId: string, background: boolean, reopenUnused = false): Promise<any> {
        const hash = digest(operationId);
        const [existing] = await tx.query('SELECT * FROM kira_public_ai_operations WHERE account_id=$1 AND operation_hash=$2 FOR UPDATE', [accountId, hash]);
        const pool: BudgetPool = background ? 'background' : 'dialogue';
        const renew = existing?.ai_state === 'released' && reopenUnused && existing.budget_pool === pool && Number(existing.outbound_calls) === 0;
        const op = renew ? { ...existing, day: day(this.now()), ai_state: 'none' }
            : existing || { day: day(this.now()), ai_state: 'none', budget_pool: pool, outbound_calls: 0 };
        if (op.ai_state === 'released') throw new ApiError(409, 'operation_closed', 'Операция уже закрыта.');
        if (existing && existing.budget_pool !== 'legacy' && existing.budget_pool !== pool) throw new ApiError(403, 'operation_scope_mismatch', 'Нельзя менять бюджет уже начатой задачи.');
        if(existing && !renew)return op;
        const cfg = this.config();
        await tx.query('INSERT INTO kira_public_quota(account_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING', [accountId, op.day]);
        const [quota] = await tx.query('SELECT * FROM kira_public_quota WHERE account_id=$1 AND day=$2 FOR UPDATE', [accountId, op.day]);
        const counter = prefix(pool), limit = background ? cfg.backgroundAiLimit ?? 60 : cfg.aiLimit;
        if (Number(quota[`${counter}_used`]) + Number(quota[`${counter}_reserved`]) >= limit) {
            throw new ApiError(429, background ? 'background_quota_exhausted' : 'dialogue_quota_exhausted', background ? 'Лимит фонового AI исчерпан.' : 'Лимит общения с AI исчерпан.');
        }
        await tx.query(`UPDATE kira_public_quota SET ${counter}_reserved=${counter}_reserved+1 WHERE account_id=$1 AND day=$2`,[accountId,op.day]);
        if (renew) await tx.query(`UPDATE kira_public_ai_operations SET day=$3,ai_state='reserved',lease_expires_at=$4 WHERE account_id=$1 AND operation_hash=$2`,
            [accountId,hash,op.day,new Date(this.now().getTime()+300_000)]);
        else await tx.query(`INSERT INTO kira_public_ai_operations(account_id,operation_hash,day,ai_state,image_state,lease_expires_at,budget_pool) VALUES($1,$2,$3,'reserved','none',$4,$5)`,
                [accountId,hash,op.day,new Date(this.now().getTime()+300_000),pool]);
        return {...op,ai_state:'reserved'};
    }

    private async imageReservation(tx:EntityManager,accountId:string,operationId:string,imageId:string):Promise<any>{
        if(!imageId || imageId.length>512)throw new ApiError(403,'policy_unavailable','Не удалось подтвердить генерацию.');
        const imageHash=digest(imageId),operationHash=digest(operationId);
        const [old]=await tx.query('SELECT * FROM kira_public_image_operations WHERE account_id=$1 AND image_hash=$2 FOR UPDATE',[accountId,imageHash]);
        if(old){if(old.operation_hash!==operationHash || old.state==='released')throw new ApiError(409,'operation_closed','Генерация уже закрыта.');return old;}
        const current=day(this.now());
        await tx.query('INSERT INTO kira_public_quota(account_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING',[accountId,current]);
        const [quota]=await tx.query('SELECT * FROM kira_public_quota WHERE account_id=$1 AND day=$2 FOR UPDATE',[accountId,current]);
        if(Number(quota.images_used)+Number(quota.images_reserved)>=this.config().imageLimit)throw new ApiError(429,'quota_exhausted','Дневной лимит изображений исчерпан.');
        await tx.query('UPDATE kira_public_quota SET images_reserved=images_reserved+1 WHERE account_id=$1 AND day=$2',[accountId,current]);
        await tx.query("INSERT INTO kira_public_image_operations(account_id,image_hash,operation_hash,day,state,lease_expires_at) VALUES($1,$2,$3,$4,'reserved',$5)",
            [accountId,imageHash,operationHash,current,new Date(this.now().getTime()+300_000)]);
        return {image_hash:imageHash,operation_hash:operationHash,day:current,state:'reserved'};
    }
}
