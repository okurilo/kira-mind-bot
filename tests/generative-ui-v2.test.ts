import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileUi, validateUiPayload, validateUiChange } from '../generative-ui/validate';
import { composeUi } from '../generative-ui/compose';
import { UI_CATALOG_ID, UI_CATALOG_V2, type UiPayload } from '../generative-ui/contracts';
import { submissionText, validateSubmission, actionValues } from '../generative-ui/forms';
import { UiService, parseFeedback } from '../generative-ui/service';
import { MemoryUiStore } from './helpers/generativeUi';
import { fixtureSnapshot, uiExampleFiles } from '../scripts/generateUiExamples';
import { composeUiNotification } from '../services/uiNotifications';
import { composeDialogueUi } from '../generative-ui/dialogue';
import { ApiActionTokens } from '../api/actionTokens';
import { evaluateGenerativeUi } from '../scripts/evalGenerativeUi';
import { parseUiRequest } from '../generative-ui/request';

const owner = 730001, deviceId = '11111111-1111-4111-8111-111111111111';
const v2 = { enabled: true as const, catalogId: UI_CATALOG_V2 };
const binding = { urls: new Set(['https://example.org/weather']), actions: [], files: new Set([deviceId]),
    evidence: 'Учебный прогноз на 2041-04-12T19:00:00Z. Источник https://example.org/weather', replyToken: () => 'synthetic.signature' };
function snapshot(asOf = '2041-04-12T19:00:00Z'): UiPayload {
    const ui = fixtureSnapshot([{ id: 'root', component: 'Metric', label: 'Учебная температура', value: '18 °C' }], true);
    ui.meta = { title: 'Учебный прогноз', asOf }; return ui;
}

test('eval reports device observations independently of synthetic schema decisions and never infers unreported displays', async () => {
    const stats = { useful: 2, notUseful: 1, shownOnDevice: 3, rejectedOnDevice: 2, rejectionReasons: { invalidGraph: 2 }, unknownUnreported: true };
    const report = await evaluateGenerativeUi(async () => '{"components":null}', { catalogId: UI_CATALOG_V2, deviceFeedback: stats });
    assert.equal(report.total, 16); assert.deepEqual(report.deviceFeedback, stats);
    assert.equal((await evaluateGenerativeUi(async () => '{"components":null}')).deviceFeedback.shownOnDevice, 0);
});

test('JSON identifiers never coerce arrays into strings and empty device bindings cannot become a legacy poll', async () => {
    const surfaceId = snapshot().messages[0].createSurface.surfaceId;
    assert.throws(() => parseUiRequest({ ...v2, target: { surfaceId: [surfaceId], revision: 1 } }));
    assert.throws(() => parseUiRequest({ ...v2, device: { id: [deviceId], bindingId: deviceId } }));
    assert.throws(() => parseFeedback({ surfaceId: [surfaceId], messageId: -1001, verdict: 'useful' }));
    assert.throws(() => parseFeedback({ surfaceId, messageId: -1001, verdict: 'useful', device: { id: [deviceId], bindingId: deviceId } }));
    const service = new UiService(owner, new MemoryUiStore());
    for (const query of [{ deviceId: '', bindingId: '' }, { bindingId: '' }, { deviceId: '' }]) await assert.rejects(service.events(query));
    const actions = new ApiActionTokens('synthetic-unicode-signature-test', owner), token = actions.sign(-1001, 'ui.reply:Привет', 'Ответ');
    const [body, signature] = token.split('.');
    assert.throws(() => actions.inspect(body + '.é' + signature.slice(1)), (e: any) => e.code === 'invalid_action');
});

test('metadata is negotiated, source timestamps are copied from evidence, and optional nulls never enter v1', async () => {
    const draft = { components: [{ id: 'root', component: 'Text', text: 'Учебные данные' }], meta: {
        title: 'Учебный прогноз', asOf: '2041-04-12T19:00:00Z', sources: [{ label: 'Источник', url: 'https://example.org/weather' }],
    } };
    assert.equal(compileUi(draft, binding), undefined);
    const extension = compileUi(draft, binding, { enabled: true, catalogId: UI_CATALOG_ID, metadata: true })!;
    assert.ok(extension); assert.equal(validateUiPayload(extension), false); assert.equal(validateUiPayload(extension, true), true);
    assert.ok(compileUi(draft, binding, v2));
    for (const meta of [{ ...draft.meta, asOf: '2041-04-12T20:00:00Z' }, { ...draft.meta, asOf: null }, { title: 'x'.repeat(81) },
        { sources: [{ label: 'Unknown', url: 'https://unlisted.example.org' }] }]) assert.equal(compileUi({ ...draft, meta }, binding, v2), undefined);
    const result = await composeUi('Покажи прогноз', { id: -1, type: 'text', text: binding.evidence }, binding.replyToken,
        async (prompt, input) => { assert.match(prompt, /время данных, а не генерации/); assert.equal(JSON.parse(input).answer, binding.evidence);
            assert.deepEqual(JSON.parse(input).dataTimes, ['2041-04-12T19:00:00Z']); return JSON.stringify(draft); }, { request: v2 });
    assert.deepEqual(result!.meta, draft.meta);
    const humanTime = 'Учебные цены на 2041-04-12, 10:00 UTC: ALPHA — 110 USD.';
    const resultWithoutInferredTime = await composeUi('Покажи цены', { id: -1, type: 'text', text: humanTime }, binding.replyToken,
        async (prompt, input) => {
            assert.deepEqual(JSON.parse(input).dataTimes, []); assert.match(prompt, /dataTimes пуст/);
            return JSON.stringify({ components: [{ id: 'root', component: 'Metric', label: 'ALPHA', value: '110 USD' }], meta: { title: 'Учебные цены' } });
        }, { request: v2 });
    assert.ok(resultWithoutInferredTime); assert.equal(resultWithoutInferredTime.meta!.asOf, undefined);
    assert.equal(compileUi({ components: draft.components, meta: { asOf: '2041-04-12T10:00:00Z' } }, { ...binding, evidence: humanTime }, v2), undefined);
});

test('v2 forms bind exact visible fields, validate ranges/types and accept no arbitrary JSON/tool arguments', () => {
    const form: any = uiExampleFiles()['v2/valid/form.json'];
    const components = form.messages[0].createSurface.components;
    const fields = components.filter((c: any) => ['Choice', 'Slider', 'Toggle', 'DateTime'].includes(c.component));
    const submission = validateSubmission({ text: 'Подготовь мой план', fields });
    const values = { choice: 'b', slider: 25, toggle: false, when: '2041-04-12T20:00:00Z' };
    const spoken = submissionText(submission, values);
    assert.match(spoken, /Способ: Второй/); assert.match(spoken, /Минуты: 25/); assert.match(spoken, /С разминкой: Нет/);
    for (const wrong of [{ ...values, choice: 'injected' }, { ...values, slider: 26 }, { ...values, slider: 65 },
        { ...values, toggle: 'false' }, { ...values, when: '2041-04-12T23:00:00Z' }, { ...values, code: 'execute' }, { choice: 'b' }, null]) {
        assert.throws(() => submissionText(submission, wrong), (e: any) => e.code === 'invalid_ui_values');
    }
    assert.throws(() => actionValues({ toggle: { tool: 'send' } })); assert.throws(() => actionValues({ slider: Infinity }));
    const raw = structuredClone(components); raw.find((c: any) => c.id === 'submit').action = { type: 'submit', text: submission.text, fields: fields.map((f: any) => f.id) };
    let signed: any;
    const compiled = compileUi({ components: raw }, { ...binding, submitToken: (text, fields) => { signed = { text, fields }; return 'form.signature'; } }, v2);
    assert.ok(compiled); assert.deepEqual(signed, submission);
    raw.find((c: any) => c.id === 'submit').action.fields.push('submitLabel');
    assert.equal(compileUi({ components: raw }, { ...binding, submitToken: () => 'form.signature' }, v2), undefined);
});

test('resource-backed images, literal countdowns, scoped scene placement and passive cards retain trust boundaries', async () => {
    assert.ok(compileUi({ components: [{ id: 'root', component: 'Image', fileId: deviceId, alt: 'Учебное изображение' }] }, binding, v2));
    assert.equal(compileUi({ components: [{ id: 'root', component: 'Image', fileId: deviceId, alt: 'Учебное изображение' }] }, { ...binding, files: new Set() }, v2), undefined);
    assert.equal(compileUi({ components: [{ id: 'root', component: 'Countdown', until: '2041-04-12T20:00:00Z', label: 'Таймер' }] }, binding, v2), undefined);
    const placements: any[] = [];
    const draft = { components: [{ id: 'root', component: 'Text', text: 'План' }], placement: { objectId: deviceId, side: 'wall' } };
    await composeUi('Размести план на стене', { id: -1, type: 'text', text: 'Учебный план' }, binding.replyToken, async () => JSON.stringify(draft),
        { request: v2, sceneObjects: [{ id: deviceId, label: 'Учебная стена' }], onPlacement: p => placements.push(p) });
    assert.equal(placements[0].objectId, deviceId);
    await composeUi('Размести план', { id: -1, type: 'text', text: 'Учебный план' }, binding.replyToken, async () => JSON.stringify(draft),
        { request: v2, sceneObjects: [], onPlacement: p => placements.push(p) });
    assert.equal(placements.length, 1);
    const form = uiExampleFiles()['v2/valid/form.json'] as any;
    assert.equal(await composeUi('', { id: -1, type: 'text', text: 'Учебный план' }, binding.replyToken,
        async () => JSON.stringify({ components: form.messages[0].createSurface.components }), { request: v2, passive: true }), undefined);
});

test('feedback is owner/surface/message scoped, consented, idempotent, bounded and has no content', async () => {
    let now = Date.parse('2041-04-12T19:00:00Z');
    const store = new MemoryUiStore(), service = new UiService(owner, store, () => now), ui = snapshot(), surfaceId = ui.messages[0].createSurface.surfaceId;
    await service.record(ui, -1001, v2);
    const feedback = { surfaceId, messageId: -1001, verdict: 'useful' };
    await assert.rejects(new UiService(owner + 1, store).feedback(feedback, 'other-owner'), (e: any) => e.status === 404);
    await assert.rejects(service.feedback({ ...feedback, messageId: -1002 }, 'wrong-message'), (e: any) => e.status === 404);
    await service.feedback(feedback, 'same-key'); await new UiService(owner, store, () => now).feedback(feedback, 'same-key');
    assert.equal((await service.metrics()).shownOnDevice, 1);
    assert.throws(() => parseFeedback({ ...feedback, reason: 'raw response' }));
    const rejected = { ...feedback, verdict: 'not_shown', reason: 'unknownField:messages[0].createSurface.theme' };
    await assert.rejects(service.feedback(rejected, 'no-diagnostics'), (e: any) => e.code === 'ui_diagnostics_consent_required');
    const device = (await service.saveDevice(deviceId, { catalogId: UI_CATALOG_V2, proactive: false, diagnostics: true })).device;
    await service.feedback({ ...rejected, device: { id: deviceId, bindingId: device.bindingId } }, 'with-diagnostics');
    assert.equal((await service.metrics()).rejectedOnDevice, 1);
    const rows = [...store.rows.get(owner)!.entries()].filter(([key]) => key.startsWith('feedback:'));
    assert.ok(!JSON.stringify(rows).includes('Учебная температура')); assert.ok(!JSON.stringify(rows).includes('bindingId'));
    for (let i = 0; i < 58; i++) await service.feedback(feedback, 'limit-' + i);
    await assert.rejects(service.feedback(feedback, 'over-limit'), (e: any) => e.status === 429);
    now += 60_000; await service.feedback(feedback, 'next-minute');
});

test('surface changes survive restart, preserve evidence time, serialize revisions and expose ordered atomic events', async () => {
    let now = 1_000_000; const store = new MemoryUiStore(), service = new UiService(owner, store, () => now), ui = snapshot(), sid = ui.messages[0].createSurface.surfaceId;
    await service.record(ui, -1001, v2);
    await assert.rejects(service.update(sid, 1, snapshot()), (e: any) => e.code === 'ui_update_rate_limited');
    now += 60_000;
    const changed = await service.update(sid, 1, snapshot('2041-04-12T20:00:00Z'));
    assert.ok(validateUiChange(changed)); assert.equal(changed.revision, 2);
    const restarted = new UiService(owner, store, () => now);
    assert.equal((await restarted.surface(sid))!.ui.revision, 2);
    await assert.rejects(restarted.update(sid, 1, snapshot()), (e: any) => e.code === 'ui_revision_conflict');
    now += 60_000;
    await assert.rejects(restarted.update(sid, 2, snapshot('2041-04-12T19:00:00Z')), (e: any) => e.code === 'ui_data_stale');
    await assert.rejects(restarted.update(sid, 2, snapshot('2041-04-12T21:00:00Z'), async () => false), (e: any) => e.code === 'ui_turn_superseded');
    const results = await Promise.allSettled([restarted.update(sid, 2, snapshot('2041-04-12T21:00:00Z')), restarted.update(sid, 2, snapshot('2041-04-12T22:00:00Z'))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    await restarted.delete(sid, 3);
    assert.equal((await restarted.surface(sid))!.deleted, true);
    const events = await restarted.events({ after: '0' }); assert.deepEqual(events.uiEvents.map(e => e.seq), [1, 2, 3]);
    assert.ok(events.uiEvents.every(e => validateUiChange(e.messages[0].ui)));
    assert.equal((await restarted.events({ after: events.uiNextCursor })).uiEvents.length, 0);
    assert.equal((await new UiService(owner + 1, store).events()).uiEvents.length, 0);
    await assert.rejects(restarted.update(sid, 4, snapshot()), (e: any) => e.status === 404);
});

test('proactive widgets require device opt-in and budget, coalesce model work, deduplicate and suppress revocation races', async () => {
    const store = new MemoryUiStore(), service = new UiService(owner, store);
    let calls = 0, tasks = 0;
    const complete = async () => { calls++; return JSON.stringify({ components: [{ id: 'root', component: 'Text', text: 'Учебная сводка' }] }); };
    const deps = { service, complete, allowed: async () => true, run: async <T>(work: () => Promise<T>) => { tasks++; return work(); } };
    assert.equal(await composeUiNotification(owner, 'Учебная сводка', 'note-one', deps), 0); assert.equal(calls, 0);
    const a = (await service.saveDevice(deviceId, { catalogId: UI_CATALOG_V2, proactive: true, diagnostics: false })).device;
    const secondId = '22222222-2222-4222-8222-222222222222';
    const b = (await service.saveDevice(secondId, { catalogId: UI_CATALOG_V2, proactive: true, diagnostics: false })).device;
    assert.equal(await composeUiNotification(owner, 'Учебная сводка', 'note-one', { ...deps, allowed: async () => false }), 0); assert.equal(calls, 0);
    assert.equal(await composeUiNotification(owner, 'Учебная сводка', 'note-one', deps), 2); assert.equal(calls, 1); assert.equal(tasks, 1);
    assert.equal(await composeUiNotification(owner, 'Учебная сводка', 'note-one', deps), 0); assert.equal(calls, 1);
    const eventsA = await service.events({ deviceId, bindingId: a.bindingId }), eventsB = await service.events({ deviceId: secondId, bindingId: b.bindingId });
    assert.equal(eventsA.uiEvents.length, 1); assert.equal(eventsB.uiEvents.length, 1);
    assert.notEqual((eventsA.uiEvents[0].messages[0].ui as UiPayload).messages[0].createSurface.surfaceId,
        (eventsB.uiEvents[0].messages[0].ui as UiPayload).messages[0].createSurface.surfaceId);
    assert.equal((await service.events()).uiEvents.length, 0, 'A legacy poll does not receive device-targeted notes');
    const count = await composeUiNotification(owner, 'Учебная сводка', 'note-two', { ...deps, complete: async () => {
        await service.revokeDevice(deviceId); await service.revokeDevice(secondId); return complete();
    } });
    assert.equal(count, 0);
    await assert.rejects(service.events({ deviceId, bindingId: a.bindingId }), (e: any) => e.code === 'ui_device_binding_changed');
});

test('deferred UI uses the originating version and active-turn guard, with durable snapshots and update envelopes', async () => {
    let now = 1_000_000; const service = new UiService(owner, new MemoryUiStore(), () => now);
    const actions = new ApiActionTokens('synthetic-ui-key-long-enough-for-hmac', owner);
    const job = { channel: `api:${owner}`, userId: owner, input: { message: 'Прогноз', ui: { request: v2, version: 'turn-one' } } } as any;
    const complete = async () => JSON.stringify({ components: [{ id: 'root', component: 'Text', text: 'Учебный прогноз' }], meta: { asOf: '2041-04-12T19:00:00Z' } });
    assert.equal(await composeDialogueUi(job, binding.evidence, async () => false, { service, actions, complete }), undefined);
    const result = await composeDialogueUi(job, binding.evidence, async () => true, { service, actions, complete });
    assert.ok(result); assert.ok(validateUiPayload(result.ui));
    const sid = (result.ui as UiPayload).messages[0].createSurface.surfaceId;
    now += 60_000; job.input.ui.request = { ...v2, target: { surfaceId: sid, revision: 1 } };
    const update = await composeDialogueUi(job, binding.evidence, async () => true, { service, actions, complete });
    assert.ok(update); assert.ok(validateUiChange(update.ui)); assert.equal(update.messageId, result.messageId);
    let alive = true;
    assert.equal(await composeDialogueUi(job, binding.evidence, async () => alive, { service, actions, complete: async () => { alive = false; return complete(); } }), undefined);
});
