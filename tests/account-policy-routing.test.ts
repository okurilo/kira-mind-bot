import assert from 'node:assert/strict';
import { test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Bot } from 'grammy';
import { ApiError } from '../api/contracts';
import { BotApiBackend } from '../api/backend';
import { createExternalApiServer } from '../api/server';
import { config } from '../config';
import { processMessage, processImage, processImageGroup } from '../orchestrator';
import { accountPolicyReply } from '../ai/accountPolicy';
import { AiContentSafetyError, AI_CONTENT_SAFETY_REPLY } from '../ai/contentSafety';
import { runKiraRuntime } from '../orchestration/runtime/kernel';
import { ToolRegistry, objectSchema } from '../orchestration/runtime/registry';
import type { KiraRuntimeInput, ToolDefinition } from '../orchestration/runtime/types';
import { performWebSearch } from '../agents/webSearchAgent';
import { imageAgent } from '../agents/imageAgent';
import { createPlan } from '../orchestration/planner';
import { completeClassificationContract } from '../orchestration/intentPrompt';
import * as responses from '../ai/responseCompletion';
import { registerTextMessageHandler } from '../handlers/textMessages';
import { registerDialogueLifecycle } from '../services/dialogueJobs';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import * as sessions from '../services/SessionStorage';
import * as completion from '../ai/chatCompletion';
import * as memory from '../utils/agentMemoryContext';
import * as history from '../utils/history';
import * as communication from '../services/communicationProfileService';
import * as behavior from '../services/behaviorMemoryService';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import { llmCache } from '../utils/llmCache';
import * as shared from '../handlers/shared';
import { factAnalysisManager } from '../utils/factAnalysisTimer';
import type { BotContext, SessionData } from '../types';

const owner = 847102;
const quotaError = () => Object.assign(new Error('Synthetic SDK wrapper'), { cause: new ApiError(429, 'quota_exhausted', 'synthetic-private-provider-payload') });
const value = () => ({ from: { id: owner }, chat: { id: owner, type: 'private' },
    session: { messageHistory: [], reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } }) as any;

function fixture(t: TestContext) {
    const oldOwner = config.allowedUserId; config.allowedUserId = owner;
    const keys = ['KIRA_ORCHESTRATION_MODE', 'KIRA_DECISIONS_ENABLED', 'KIRA_FAST_DIALOGUE_ENABLED'];
    const previous = keys.map(key => process.env[key]);
    process.env.KIRA_ORCHESTRATION_MODE = 'skills'; delete process.env.KIRA_DECISIONS_ENABLED; process.env.KIRA_FAST_DIALOGUE_ENABLED = 'false';
    t.after(() => { config.allowedUserId = oldOwner; keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }); });
    const rows = new Map<string, SessionData>();
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async (key: string) => structuredClone(rows.get(key)));
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (key: string, data: SessionData) => { rows.set(key, structuredClone(data)); });
    t.mock.method(sessions, 'persistAgentRuntime', async () => {});
    t.mock.method(llmCache, 'get', () => undefined);
    t.mock.method(ChatGroupRepository, 'findAll', async () => []);
    t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    t.mock.method(factAnalysisManager, 'scheduleAnalysis', () => {});
    t.mock.method(shared, 'shouldRunProactiveHint', () => false);
    t.mock.method(communication, 'communicationProfileContext', async () => '');
    t.mock.method(behavior, 'getBehaviorMemoryContext', async () => '');
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: any, content: string) => {
        ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() });
    });
    const recall = t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
    const reconsolidate = t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    const clarify = t.mock.method(completion, 'createChatCompletionForTask', async () => { throw quotaError(); });
    const classify = t.mock.method(completion, 'createJsonChatCompletionForTask', async () => { throw quotaError(); });
    return { rows, recall, reconsolidate, clarify, classify };
}

for (const channel of ['http', 'telegram'] as const) test(`${channel}: exhausted quota is explained once, and the next turn can recover`, async t => {
    const f = fixture(t);
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: {
        id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot',
    } as any });
    const delivered: string[] = []; let id = 8000;
    bot.api.config.use(async (_previous, method, payload: any) => {
        assert.equal(channel, 'telegram', 'HTTP replies must stay in the app transport');
        if (method === 'sendMessage') {
            delivered.push(payload.text);
            return { ok: true, result: { message_id: ++id, date: 0, chat: { id: owner, type: 'private' }, text: payload.text } } as any;
        }
        assert.equal(method, 'sendChatAction'); return { ok: true, result: true } as any;
    });
    let send: (text: string) => Promise<string[]>;
    if (channel === 'http') {
        const token = 'synthetic-policy-token-at-least-thirty-two-characters';
        const backend = new BotApiBackend(bot, { token, ownerId: owner, host: '127.0.0.1', port: 0 },
            { read: async () => ({ preset: 'gpt-lean', revision: 'synthetic' }) } as any);
        const server = createExternalApiServer({ token, ownerId: owner, host: '127.0.0.1', port: 0 }, backend,
            { run: async (_key, _fingerprint, work) => work() });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
        send = async text => {
            const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/messages`, {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `synthetic-${++id}` },
                body: JSON.stringify({ text }),
            });
            assert.equal(response.status, 200);
            return (await response.json() as any).messages.map((m: any) => m.text).filter(Boolean);
        };
    } else {
        bot.use(async (ctx, next) => {
            ctx.sessionStorageKey = String(owner); ctx.session = structuredClone(f.rows.get(String(owner))) ?? value().session;
            await next(); f.rows.set(String(owner), structuredClone(ctx.session));
        });
        registerDialogueLifecycle(bot); registerTextMessageHandler(bot, { immediate: true });
        send = async text => {
            const start = delivered.length;
            await bot.handleUpdate({ update_id: ++id, message: { message_id: id, date: 0,
                from: { id: owner, is_bot: false, first_name: 'Synthetic' }, chat: { id: owner, type: 'private', first_name: 'Synthetic' }, text } });
            return delivered.slice(start);
        };
    }
    const denied = await send('Посмотри, продаются ли настольные лампы в магазине Пример.');
    assert.equal(denied.length, 1);
    assert.match(denied[0], /дневной лимит.*исчерпан/iu);
    assert.doesNotMatch(denied[0], /уточни|что именно|сформулируй|synthetic-private/iu);
    assert.equal(f.classify.mock.callCount(), 1);
    assert.equal(f.clarify.mock.callCount(), 0, 'A denied classifier must not invoke the clarification model');
    assert.equal(f.recall.mock.callCount(), 0);
    assert.equal(f.reconsolidate.mock.callCount(), 0, 'A failed turn must not launch optional AI after delivery');

    f.classify.mock.mockImplementation(async () => ({ intent: 'НЕОПРЕДЕЛЕНО', confidenceLevel: 'НИЗКИЙ', details: { memoryNeed: 'none' } }) as any);
    f.clarify.mock.mockImplementation(async () => ({ choices: [{ message: { content: 'Что именно нужно сделать с учебным проектом?' } }] }) as any);
    const recovered = await send('Давай займёмся учебным проектом.');
    assert.match(recovered.join('\n'), /Что именно нужно сделать с учебным проектом/);
    assert.doesNotMatch(recovered.join('\n'), /лимит/iu);
    assert.equal(f.clarify.mock.callCount(), 1, 'Genuine ambiguity still asks a question after recovery');
});

test('classifier transport errors are failed turns, not low-confidence intent decisions', async t => {
    const f = fixture(t);
    f.classify.mock.mockImplementation(async () => { throw new Error('synthetic-private-transport-payload'); });
    const result = await processMessage(value(), 'Сравни характеристики двух учебных телескопов.');
    assert.equal(result.operationStatus, 'failed'); assert.equal(result.skipOptionalFollowups, true);
    assert.match(result.responseText, /технической ошибки/iu);
    assert.doesNotMatch(result.responseText, /уточни|что именно|сформулируй|synthetic-private/iu);
    assert.equal(f.clarify.mock.callCount(), 0);
});

test('account denials retain safe actionable reasons through SDK causes', async t => {
    const f = fixture(t);
    const cases = [
        ['quota_exhausted', /дневной лимит.*исчерпан/iu], ['consent_required', /согласие/iu],
        ['activation_required', /активировать/iu], ['account_restricted', /ограничены/iu],
        ['account_deleting', /удаляется/iu], ['autonomous_ai_disabled', /самостоятельные.*выключены/iu],
        ['policy_unavailable', /проверить доступность/iu], ['operation_closed', /уже завершена/iu],
        ['moderation_unavailable', /проверки.*временно недоступен/iu], ['content_policy_violation', /безопасности/iu],
    ] as const;
    for (const [code, expected] of cases) {
        f.classify.mock.mockImplementation(async () => { throw Object.assign(new Error('SDK'), { cause: new ApiError(403, code, 'synthetic-private-policy-detail') }); });
        const result = await processMessage(value(), 'Объясни устройство учебного радиоприёмника.');
        assert.match(result.responseText, expected, code);
        assert.doesNotMatch(result.responseText, /synthetic-private|уточни|что именно/iu);
        assert.equal(result.operationStatus, 'failed'); assert.equal(result.skipOptionalFollowups, true);
    }
    assert.equal(accountPolicyReply(Object.assign(new Error('SDK'), { code: 'quota_exhausted' })), undefined, 'A provider error cannot impersonate account authority');
    assert.equal(f.clarify.mock.callCount(), 0);
});

test('a failure while generating a genuine clarification never becomes a canned clarification', async t => {
    const f = fixture(t);
    f.classify.mock.mockImplementation(async () => ({ intent: 'НЕОПРЕДЕЛЕНО', confidenceLevel: 'НИЗКИЙ',
        intentScores: [{ intent: 'РАЗГОВОР', score: .5 }, { intent: 'НАПОМИНАНИЕ', score: .5 }], details: { memoryNeed: 'none', relationshipRole: null } }) as any);
    for (const mode of ['skills', 'legacy']) {
        process.env.KIRA_ORCHESTRATION_MODE = mode;
        const before = f.clarify.mock.callCount();
        f.clarify.mock.mockImplementation(async () => { throw quotaError(); });
        const denied = await processMessage(value(), 'Давай займёмся учебным проектом.');
        assert.match(denied.responseText, /дневной лимит.*исчерпан/iu);
        assert.equal(denied.operationStatus, 'failed'); assert.equal(denied.skipOptionalFollowups, true);
        assert.equal(f.clarify.mock.callCount(), before + 1, 'A policy refusal is never retried by the legacy executor');
        f.clarify.mock.mockImplementation(async () => { throw new Error('synthetic-private-model-payload'); });
        const unavailable = await processMessage(value(), 'Давай займёмся учебным проектом.');
        assert.match(unavailable.responseText, /технической ошибки/iu);
        assert.doesNotMatch(unavailable.responseText, /уточни|что именно|synthetic-private/iu);
        assert.equal(unavailable.operationStatus, 'failed'); assert.equal(unavailable.skipOptionalFollowups, true);
        assert.equal(unavailable.keyboard, undefined, 'A failed clarification must not offer intent-choice buttons');
    }
});

test('policy refusal during context-format repair is terminal and leaves server-bound continuation intact', async () => {
    for (const binding of ['profile', 'workspace']) {
        let calls = 0;
        await assert.rejects(completeClassificationContract(async () => {
            if (++calls === 1) return { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: {} };
            throw quotaError();
        }, binding === 'profile' ? { candidates: [] } : undefined, binding === 'workspace' ? { id: 'synthetic-bound-workspace' } : undefined),
        error => !!accountPolicyReply(error));
        assert.equal(calls, 2);
    }
});

test('runtime stops on planning or tool policy failures, retaining completed actions without retry', async t => {
    fixture(t);
    const input: KiraRuntimeInput = { ctx: value(), message: 'Синтетическая задача', isForwarded: false, forwardFrom: '', messageHistory: [],
        classification: { intent: 'НАПОМИНАНИЕ', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none' } } };
    let answers = 0, writes = 0, reads = 0;
    const respond = async () => { answers++; return { responseText: 'Не должно генерироваться' }; };
    const planned = await runKiraRuntime(input, { forceLoop: true, decide: async () => { throw quotaError(); }, persist: async () => {}, respond });
    assert.match(planned.responseText, /дневной лимит.*исчерпан/iu); assert.equal(planned.operationStatus, 'failed');
    const tool = (name: string, effect: ToolDefinition['effect'], execute: ToolDefinition['execute']): ToolDefinition => ({
        name, effect, execute, description: 'Synthetic operation', skill: 'reminders', ownerOnly: false, inputSchema: objectSchema({}),
    });
    const registry = new ToolRegistry([
        tool('test.write', 'state', async () => { writes++; return { status: 'ok', summary: 'Синтетическая запись сохранена.', result: { responseText: 'Синтетическая запись сохранена.' } }; }),
        tool('test.read', 'read', async () => { reads++; throw quotaError(); }),
    ], () => true);
    let round = 0;
    const result = await runKiraRuntime({ ...input, ctx: value() }, { forceLoop: true, registry, persist: async () => {}, respond,
        decide: async () => ({ calls: [{ id: String(++round), tool: round === 1 ? 'test.write' : 'test.read', args: {} }] }) });
    assert.match(result.responseText, /Синтетическая запись сохранена/);
    assert.match(result.responseText, /дневной лимит.*исчерпан/iu);
    assert.equal(result.operationStatus, 'failed'); assert.equal(result.skipOptionalFollowups, true);
    assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(answers, 0);
    const uncertain = await runKiraRuntime({ ...input, ctx: value() }, { forceLoop: true,
        registry: new ToolRegistry([tool('test.write', 'state', async () => { throw quotaError(); })], () => true),
        persist: async () => {}, respond, decide: async () => ({ calls: [{ id: 'write', tool: 'test.write', args: {} }] }) });
    assert.equal(uncertain.operationStatus, 'unknown');
    assert.match(uncertain.responseText, /дневной лимит.*исчерпан/iu);
    assert.match(uncertain.responseText, /не повторяла/iu);
});

test('legacy compound planner also preserves policy refusal instead of constructing another AI plan', async t => {
    const f = fixture(t);
    await assert.rejects(createPlan({ message: 'Объясни учебную теорему и создай напоминание о занятии.',
        classification: { intent: 'РАЗГОВОР', subIntents: [{ intent: 'НАПОМИНАНИЕ' }] } }), error => !!accountPolicyReply(error));
    assert.equal(f.clarify.mock.callCount(), 1);
});

test('search and its verification preserve terminal policy failures without reporting an empty search', async t => {
    const f = fixture(t); let calls = 0;
    const search = t.mock.method(responses, 'createResponseForTask', async () => { calls++; throw quotaError(); });
    await assert.rejects(performWebSearch('Синтетические настольные лампы'), error => !!accountPolicyReply(error));
    assert.equal(calls, 1);
    calls = 0;
    search.mock.mockImplementation(async () => { if (++calls === 1) return { output_text: 'Непроверенный синтетический каталог' } as any; throw quotaError(); });
    await assert.rejects(performWebSearch('Синтетический товар в наличии', { verifyAvailability: true }), error => !!accountPolicyReply(error));
    assert.equal(calls, 2); assert.equal(f.clarify.mock.callCount(), 0);
    calls = 0;
    await assert.rejects(performWebSearch('Новости учебной обсерватории'), error => !!accountPolicyReply(error));
    assert.equal(calls, 2, 'A denied news review cannot return the insufficient draft as success');
});

test('photo and album policy failures use the same clear reply, including image-only model failures', async t => {
    fixture(t);
    for (const mode of ['skills', 'legacy']) {
        process.env.KIRA_ORCHESTRATION_MODE = mode;
        for (const process of [() => processImage(value(), Buffer.from('synthetic'), 'Объясни учебную схему.'),
            () => processImageGroup(value(), [Buffer.from('synthetic')], 'Объясни учебные схемы.')]) {
            const result = await process();
            assert.match(result.responseText, /дневной лимит.*исчерпан/iu);
            assert.equal(result.operationStatus, 'failed'); assert.equal(result.skipOptionalFollowups, true);
        }
    }
    await assert.rejects(imageAgent(Buffer.from('synthetic'), '', []), error => !!accountPolicyReply(error));
});

test('content safety remains terminal at classification and is not mistaken for ambiguity', async t => {
    const f = fixture(t);
    f.classify.mock.mockImplementation(async () => { throw new AiContentSafetyError(); });
    const result = await processMessage(value(), 'Объясни синтетическую задачу.');
    assert.equal(result.responseText, AI_CONTENT_SAFETY_REPLY); assert.equal(result.operationStatus, 'failed');
    assert.equal(f.clarify.mock.callCount(), 0);
});
