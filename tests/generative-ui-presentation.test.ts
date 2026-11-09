import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uiAnswerTextRules, UI_ANSWER_TEXT_RULES } from '../generative-ui/presentation';
import { evaluateUiAnswerPresentation } from '../scripts/evalUiAnswerPresentation';

test('presentation guidance is transport-local, keeps plain fallback/speech, and preserves real programming requests', () => {
    const ctx = { chat: { id: 1, type: 'private' as const, first_name: 'Synthetic' },
        session: { isAllowedUser: true, reminders: [], messageHistory: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } };
    assert.equal(uiAnswerTextRules(ctx), UI_ANSWER_TEXT_RULES);
    assert.match(UI_ANSWER_TEXT_RULES, /Настоящий программный код допустим/);
    assert.equal(uiAnswerTextRules({ ...ctx, sessionStorageKey: 'api:synthetic' }), '');
    assert.equal(uiAnswerTextRules({ ...ctx, sessionStorageKey: 'api:synthetic', generativeUiRequest: { enabled: true, catalogId: 'urn:kira:ui:catalog:2' } }), UI_ANSWER_TEXT_RULES);
    assert.equal(uiAnswerTextRules({ ...ctx, chat: { id: -1, type: 'group', title: 'Synthetic' } }), '');
});

test('style evaluation fails on ASCII/Markdown replicas and provider outages instead of treating them as successful abstentions', async () => {
    const raw = await evaluateUiAnswerPresentation(async () => '```text\nПрогноз ─────\n```');
    assert.equal(raw.passed, 0);
    const offline = await evaluateUiAnswerPresentation(async () => { throw Error('synthetic unavailable'); });
    assert.equal(offline.passed, 0); assert.ok(offline.cases.every(c => c.status === 'provider_unavailable'));
});
