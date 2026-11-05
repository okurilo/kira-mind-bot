import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from 'grammy';
import { ApiError } from '../api/contracts';
import { BotApiBackend } from '../api/backend';
import { config } from '../config';
import * as policy from '../ai/accountPolicy';
import * as completion from '../ai/chatCompletion';
import * as triage from '../ai/reflectionTriage';
import * as features from '../services/backgroundFeatureService';
import * as settings from '../services/botSettingsService';
import { queueMessage, processBuffers, getBufferStats } from '../services/reflectionModeService';
import { telegramReminderProposals } from '../services/telegramReminderProposals';
import * as history from '../utils/history';
import * as memory from '../utils/agentMemoryContext';
import * as behavior from '../services/behaviorMemoryService';
import * as communication from '../services/communicationProfileService';
import * as conversation from '../agents/conversationAgent';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import * as shared from '../handlers/shared';
import * as gap from '../utils/memoryGapDetector';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import { llmCache } from '../utils/llmCache';
import type { BotContext } from '../types';
import { runKiraRuntime, continueConfirmedRuntime } from '../orchestration/runtime/kernel';
import { ToolRegistry, objectSchema } from '../orchestration/runtime/registry';
import * as session from '../services/SessionStorage';
import { executeRecurringTask } from '../services/recurringTaskScheduler';
import { RecurringTaskRepository } from '../services/RecurringTaskRepository';

test('exhaustion leaves a reflection source batch intact; triage and all later stages keep its logical task ID', async t => {
    const old = config.allowedUserId; config.allowedUserId = 802101; t.after(() => { config.allowedUserId = old; });
    t.mock.method(features, 'isBackgroundFeatureEnabled', async () => true);
    t.mock.method(triage, 'needsPriorityReflection', async () => false);
    t.mock.method(telegramReminderProposals, 'context', async () => []);
    t.mock.method(telegramReminderProposals, 'applyReview', async () => {});
    t.mock.method(settings, 'getSetting', async (_k: string, fallback: string) => fallback);
    const saved = t.mock.method(settings, 'setSetting', async () => {});
    let exhausted = true; const ids: string[] = [];
    const runTask = policy.withAccountAiTask;
    t.mock.method(policy, 'withAccountAiTask', async function<T>(operation: policy.AccountAiOperation, work: () => Promise<T>): Promise<T> {
        ids.push(operation.id); assert.equal(operation.background, true);
        if (exhausted) throw new ApiError(429, 'background_quota_exhausted', 'Synthetic');
        return runTask(operation, work);
    });
    const ai = t.mock.method(completion, 'createChatCompletionForTask', async () => {
        assert.equal(policy.currentAccountAiOperation()?.background, true);
        assert.equal(policy.currentAccountAiOperation()?.id, ids[0]);
        return { choices: [{ message: { content: '{"useful":false,"emotion":"neutral"}' } }] } as any;
    });
    const start = getBufferStats().totalMessages;
    for (let id = 1; id <= 5; id++) await queueMessage('synthetic-budget-thread', 'Контакт Альфа', `Учебная договорённость ${id}`, new Date(Date.now() - 200_000 + id), id % 2 === 0, id);
    await processBuffers({} as any);
    assert.equal(getBufferStats().totalMessages, start + 5); assert.equal(ai.mock.callCount(), 0); assert.equal(saved.mock.callCount(), 0);
    exhausted = false; await processBuffers({} as any);
    assert.equal(getBufferStats().totalMessages, start); assert.equal(ai.mock.callCount(), 1);
    assert.equal(new Set(ids).size, 1); assert.ok(saved.mock.callCount() > 0);
});

test('the actual app message handler returns its answer when optional background is exhausted', async t => {
    const old = config.allowedUserId, mode = process.env.KIRA_ORCHESTRATION_MODE; config.allowedUserId = 802102; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
    t.after(() => { config.allowedUserId = old; if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode; });
    t.mock.method(features, 'isBackgroundFeatureEnabled', async () => true);
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async () => undefined);
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async () => {});
    t.mock.method(ChatGroupRepository, 'findAll', async () => []); t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: any, content: string) => { ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() }); });
    t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
    t.mock.method(behavior, 'getBehaviorMemoryContext', async () => ''); t.mock.method(communication, 'communicationProfileContext', async () => '');
    t.mock.method(llmCache, 'get', () => undefined);
    t.mock.method(shared, 'shouldRunProactiveHint', () => true);
    const hint = t.mock.method(gap, 'detectMemoryGapCandidate', async () => { throw Error('No optional AI on an empty background pool'); });
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(policy, 'withBackgroundAiTask', async function<T>(_kind: string, _key: string, _work: () => Promise<T>): Promise<T> {
        throw new ApiError(429, 'background_quota_exhausted', 'Synthetic');
    });
    const classify = t.mock.method(completion, 'createJsonChatCompletionForTask', async () => ({ intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ',
        details: { memoryNeed: 'none', relationshipRole: null, responseComplexity: 'routine' }, fastReply: { mode: 'route' } }) as any);
    t.mock.method(conversation, 'conversationAgent', async () => { assert.equal(policy.currentAccountAiOperation()?.background, false); return { responseText: 'Учебный ответ на понятный вопрос.' }; });
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    bot.api.config.use(async () => { throw Error('No Telegram traffic from the app channel'); });
    const backend = new BotApiBackend(bot, { ownerId: config.allowedUserId, token: 'synthetic-task-budget-token-at-least-thirty-two', host: '127.0.0.1', port: 0 },
        { read: async () => ({ preset: null, revision: 'synthetic' }) } as any);
    const reply = await policy.withAccountAiOperation({ id: 'synthetic-user-goal', background: false }, () => backend.message('Объясни устройство учебного радиоприёмника.'));
    assert.deepEqual(reply.messages.map(m => m.text).filter(Boolean), ['Учебный ответ на понятный вопрос.']);
    assert.equal(classify.mock.callCount(), 1); assert.equal(hint.mock.callCount(), 0);
});

test('a persisted confirmation continues the original foreground operation, not the new callback or background pool', async t => {
    const mode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
    t.after(() => { if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode; });
    t.mock.method(session, 'persistAgentRuntime', async () => {});
    const ctx = { from: { id: 802103 }, chat: { id: 802103, type: 'private' }, session: { messageHistory: [], reminders: [] } } as any;
    const registry = new ToolRegistry([{ name: 'test.read', description: 'Synthetic', skill: 'web-research', effect: 'read', ownerOnly: false,
        inputSchema: objectSchema({}), execute: async () => ({ status: 'needs_input', summary: 'Подтвердить?', confirmationKey: 'synthetic-confirmation' }) }], () => true);
    const deps = { forceLoop: true, registry, persist: async () => {}, decide: async () => ({ calls: [{ id: 'read', tool: 'test.read', args: {} }] }), respond: async () => ({ responseText: 'Выполнено' }) };
    await policy.withAccountAiOperation({ id: 'original-goal', background: false }, () => runKiraRuntime({ ctx, message: 'Подготовь сообщение, затем напомни проверить ответ', isForwarded: false, forwardFrom: '', messageHistory: [],
        classification: { intent: 'ВЕБ_ПОИСК', confidenceLevel: 'ВЫСОКИЙ', details: {} } }, deps));
    ctx.session = JSON.parse(JSON.stringify(ctx.session));
    assert.equal(ctx.session.agentRuntime.accountAiOperation.id, 'original-goal');
    let continued = 0;
    const result = await policy.withAccountAiOperation({ id: 'callback-request', background: false }, () => continueConfirmedRuntime(ctx, ['test.read'], 'Подтверждено', {
        registry, persist: async () => {}, decide: async () => { continued++; assert.deepEqual(policy.currentAccountAiOperation(), { id: 'original-goal', background: false }); return { finish: true }; }, respond: async () => ({ responseText: 'Выполнено' }),
    }, 'synthetic-confirmation'));
    assert.equal(continued, 1); assert.match(result!.responseText, /Выполнено|Подтверждено/);
});

test('a scheduled task with no background budget is unlocked and deferred, without failure or permanent pause', async t => {
    t.mock.method(policy, 'withBackgroundAiTask', async function<T>(): Promise<T> { throw new ApiError(429, 'background_quota_exhausted', 'Synthetic'); });
    let patch: any;
    t.mock.method(RecurringTaskRepository, 'update', async (_id: string, value: any) => { patch = value; return true; });
    t.mock.method(RecurringTaskRepository, 'failRun', async () => { throw Error('Quota is not an execution failure'); });
    const now = new Date(), reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    await executeRecurringTask({ api: { sendMessage: async () => { throw Error('No quota warning spam'); } } } as any,
        { id: 'synthetic-recurring-budget', chatId: 802104, nextRunAt: now, status: 'active', consecutiveFailures: 2, runCount: 3 } as any);
    assert.equal(patch.lockedAt, null); assert.equal(patch.nextRunAt.getTime(), reset);
    assert.equal(patch.status, undefined); assert.equal(patch.consecutiveFailures, undefined); assert.equal(patch.runCount, undefined);
});
