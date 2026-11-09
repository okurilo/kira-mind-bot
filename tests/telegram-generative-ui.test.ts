import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot, session } from 'grammy';
import type { BotContext, SessionData } from '../types';
import { TelegramUiService, registerTelegramWidgetBridge, TELEGRAM_WIDGET_TTL_MS, type WidgetApi } from '../generative-ui/telegram';
import { renderTelegramWidget, TELEGRAM_WIDGET_LIMITS } from '../generative-ui/telegramRender';
import { compileUi } from '../generative-ui/validate';
import { UI_CATALOG_V2 } from '../generative-ui/contracts';
import { MemoryUiStore } from './helpers/generativeUi';
import { deflateSync } from 'node:zlib';

const owner = 730001;
const fileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const binding = { urls: new Set(['https://example.org/weather']), actions: ['w0'], replyToken: () => 'w0', submitToken: () => 'w0', files: new Set([fileId]) };
const request = { enabled: true as const, catalogId: UI_CATALOG_V2 };
const tree = (...nodes: any[]) => ({ components: [{ id: 'root', component: 'Column', children: nodes.map(n => n.id) }, ...nodes] });
export const widgetDraft = (action: unknown = { type: 'reply', text: 'Покажи прогноз на завтра' }) => ({ components: [
    { id: 'root', component: 'Column', children: ['metric', 'button'] },
    { id: 'metric', component: 'Metric', label: 'Температура', value: '18 °C' },
    { id: 'button', component: 'Button', child: 'label', action }, { id: 'label', component: 'Text', text: 'Прогноз на завтра' },
] });
const formDraft = () => ({ components: [
    { id: 'root', component: 'Column', children: ['kind', 'minutes', 'warmup', 'time', 'button'] },
    { id: 'kind', component: 'Choice', label: 'Занятие', options: [{ value: 'read', label: 'Чтение' }, { value: 'walk', label: 'Прогулка' }] },
    { id: 'minutes', component: 'Slider', label: 'Минуты', min: 10, max: 60, step: 5, value: 20 },
    { id: 'warmup', component: 'Toggle', label: 'Разминка', value: true },
    { id: 'time', component: 'DateTime', label: 'Когда', value: '2041-04-12T19:00:00Z', min: '2041-04-12T18:00:00Z', max: '2041-04-12T20:00:00Z' },
    { id: 'button', component: 'Button', child: 'label', action: { type: 'submit', text: 'Составь план', fields: ['kind', 'minutes', 'warmup', 'time'] } },
    { id: 'label', component: 'Text', text: 'Составить план' },
] });
async function fixture(draft: unknown = widgetDraft()) {
    const store = new MemoryUiStore();
    await store.transact(owner, tx => tx.put('canonical', 'turn', 'tg:1'));
    let now = Date.now(), calls = 0;
    const service = new TelegramUiService(store, async () => { calls++; return JSON.stringify(draft); }, () => now);
    const sent: any[] = [];
    const api: WidgetApi = {
        sendWidget: async body => { sent.push(body); return { message_id: 20 + sent.length - 1 } as any; },
        answerWidgetQuery: async () => true, editMessageWidgetData: async () => true,
    };
    const deliver = (keyboard?: any, turn = 'tg:1', text = 'Учебная погода: 18 °C. Время 2041-04-12T19:00:00Z, диапазон 2041-04-12T18:00:00Z — 2041-04-12T20:00:00Z.') =>
        service.deliver(owner, api, 'Покажи наглядно', text, 10, keyboard, turn);
    const query = (data: string, extra: any = {}) => ({ id: 'synthetic-query', from: { id: owner, is_bot: false, first_name: 'Synthetic' },
        chat: { id: owner, type: 'private', first_name: 'Synthetic' }, message_id: 20, chat_instance: 'synthetic-chat', type: { type: 'data' }, data, ...extra } as any);
    return { store, service, api, sent, deliver, query, calls: () => calls, advance: () => { now += TELEGRAM_WIDGET_TTL_MS; } };
}

test('Telegram renders the same validated catalog with native colors, offline charts and pagination inside hard limits', () => {
    const ui = compileUi(tree(
        { id: 'title', component: 'Text', text: 'Учебная погода', variant: 'title' },
        { id: 'metric', component: 'Metric', label: 'Температура', value: '18 °C' },
        { id: 'table', component: 'Table', columns: ['День', '°C'], rows: Array.from({ length: 24 }, (_, i) => [String(i), String(i)]) },
        { id: 'chart', component: 'Chart', kind: 'line', labels: ['Сегодня', 'Завтра'], series: [{ label: 'Прогноз', values: [18, 20] }] },
        { id: 'progress', component: 'Progress', label: 'Задача', value: .6 },
        { id: 'steps', component: 'Steps', items: [{ label: 'Первый', state: 'done' }] },
        { id: 'map', component: 'Map', pins: [{ lat: 10.2, lon: 20.3, label: 'Учебная точка' }] },
        { id: 'image', component: 'Image', fileId, alt: 'Учебное изображение во вложении' },
        { id: 'checklist', component: 'Checklist', items: [{ id: 'item', label: 'Книга', checked: true }] },
        { id: 'countdown', component: 'Countdown', until: '2041-04-12T19:00:00Z', label: 'Событие' },
        { id: 'divider', component: 'Divider' },
    ), { ...binding, evidence: '2041-04-12T19:00:00Z' }, request)!;
    assert.ok(ui);
    const out = renderTelegramWidget(ui)!; assert.ok(out);
    assert.ok(Buffer.byteLength(out.html) < TELEGRAM_WIDGET_LIMITS.html);
    assert.ok(deflateSync(out.html, { level: 9 }).length <= 3800);
    assert.match(out.html, /--tg-theme-text-color/); assert.match(out.html, /<svg/); assert.match(out.html, /60%/);
    assert.match(out.html, /Открыть карту/); assert.match(out.html, /Страница|id="nav"/);
    assert.doesNotMatch(out.html, /<input|<select|<textarea|<iframe|fetch\(|<script src|<img src="https:/);
    assert.equal((out.html.match(/<table>/g) ?? []).length, 12);
});

test('Telegram escapes adversarial text in markup, attributes and script data; rejects invalid/oversize snapshots and long links', () => {
    const text = '</script><script>fetch("https://evil.example")</script> & "<img onerror=steal()>"';
    const ui = compileUi(tree({ id: 'hostile', component: 'Text', text },
        { id: 'field', component: 'Choice', label: text, options: [{ value: 'one', label: text }] }), binding, request)!;
    const out = renderTelegramWidget(ui)!; assert.ok(out);
    assert.equal((out.html.match(/<script>/g) ?? []).length, 1); assert.equal((out.html.match(/<\/script>/g) ?? []).length, 1);
    assert.match(out.html, /&lt;\/script&gt;/); assert.match(out.html, /\\u003c\/script/);
    assert.equal(renderTelegramWidget({ ...ui, messages: [] }), undefined);
    const random = Array.from({ length: 1600 }, (_, i) => ((i * 2654435761 >>> 0).toString(36))).join('');
    const huge = compileUi(tree(...Array.from({ length: 12 }, (_, i) => ({ id: 'text' + i, component: 'Text', text: random.slice(i * 600, i * 600 + 600) }))), binding, request)!;
    assert.equal(renderTelegramWidget(huge), undefined);
    const url = 'https://example.org/' + 'a'.repeat(300);
    const long = compileUi({ components: [{ id: 'root', component: 'Button', child: 'label', action: { type: 'openUrl', url } },
        { id: 'label', component: 'Text', text: 'Источник' }] }, { ...binding, urls: new Set([url]) }, request)!;
    assert.equal(renderTelegramWidget(long), undefined);
    assert.equal(renderTelegramWidget(compileUi(tree({ id: 'nul', component: 'Text', text: 'a\0b' }), binding, request)!), undefined);
});

test('a reply widget is sent once, bound to the original answer and canonical Telegram turn, with no public data', async () => {
    const f = await fixture(); const sent = await f.deliver(); assert.equal(sent?.message_id, 20); assert.equal(f.calls(), 1);
    assert.equal(f.sent[0].chat_id, owner); assert.equal(f.sent[0].protect_content, true); assert.equal(f.sent[0].allow_queries, true);
    assert.equal(f.sent[0].reply_parameters.message_id, 10); assert.equal(f.sent[0].public_data, undefined);
    assert.ok(Buffer.byteLength(f.sent[0].chat_data) <= 1024);
    const replies = await Promise.all([f.service.query(owner, f.query('a:0:0')), f.service.query(owner, f.query('a:0:0', { id: 'another-query' }))]);
    assert.equal(replies.filter(r => r.dispatch).length, 1);
    assert.deepEqual(replies.find(r => r.dispatch)!.dispatch!.action, { kind: 'reply', text: 'Покажи прогноз на завтра' });
    assert.equal((await new TelegramUiService(f.store).query(owner, f.query('a:0:0'))).dispatch, undefined);
});

test('widgets reject another owner/chat, shared/inline/wallet queries, arbitrary commands, stale turns, expiry and invisible actions', async () => {
    const f = await fixture(); await f.deliver();
    for (const extra of [{ from: { id: owner + 1 } }, { chat: { id: owner + 1, type: 'private' } }, { chat: { id: owner, type: 'group' } },
        { widget_id: 'shared' }, { inline_message_id: 'inline' }, { message_id: 999 }, { type: { type: 'sent_transaction' } }, { from: { id: owner, is_bot: true } }]) {
        assert.equal((await f.service.query(owner, f.query('a:0:0', extra))).dispatch, undefined);
    }
    for (const data of ['a:0:63', 'arbitrary_callback', 'f:0:0', 'a:0:0:1', 'a:0:0\n', 'a'.repeat(65)]) assert.equal((await f.service.query(owner, f.query(data))).dispatch, undefined);
    await f.store.transact(owner, tx => tx.put('canonical', 'turn', 'tg:2'));
    assert.equal((await f.service.query(owner, f.query('a:0:0'))).dispatch, undefined);
    const expired = await fixture(); await expired.deliver(); expired.advance(); assert.equal((await expired.service.query(owner, expired.query('a:0:0'))).dispatch, undefined);
    const hidden = await fixture(); await hidden.deliver({ inline_keyboard: [[{ text: 'Не выбранная моделью кнопка', callback_data: 'original_callback' }]] });
    assert.equal((await hidden.service.query(owner, hidden.query('a:0:0'))).dispatch, undefined);
    assert.equal((await hidden.service.query(owner, hidden.query('a:0:1'))).dispatch?.action.kind, 'reply');
});

test('all form values are validated and persisted with revision CAS before a canonical plain text submission', async () => {
    const f = await fixture(formDraft()); await f.deliver(); assert.equal(f.sent.length, 1);
    assert.equal((await f.service.query(owner, f.query('a:0:0'))).dispatch, undefined); // required Choice missing
    const picked = await f.service.query(owner, f.query('f:0:0:1')); assert.equal(picked.state?.r, 1);
    assert.equal((await f.service.query(owner, f.query('f:0:0:0'))).state?.v[0], 1); // stale query cannot revert
    for (const data of ['f:1:0:6', 'f:1:1:11', 'f:1:2:2', 'f:1:3:0', 'f:1:9:0']) {
        const invalid = await f.service.query(owner, f.query(data)); assert.ok(invalid.error); assert.equal(invalid.state?.r, 1);
    }
    const slider = await f.service.query(owner, f.query('f:1:1:4')); assert.equal(slider.state?.r, 2);
    const submitted = await new TelegramUiService(f.store).query(owner, f.query('a:2:0'));
    assert.deepEqual(submitted.dispatch?.action, { kind: 'reply', text: 'Составь план\n\nВыбранные значения формы:\nЗанятие: Прогулка\nМинуты: 30\nРазминка: Да\nКогда: 2041-04-12T19:00:00.000Z' });
    assert.ok(Buffer.byteLength(JSON.stringify(submitted.state)) <= 1024);
    assert.equal((await f.service.query(owner, f.query('f:3:0:0'))).dispatch, undefined);
});

test('optional UI abstains on null, invalid output, disabled switch, absent/stale turn, model refusal and uncertain send, without retries', async t => {
    for (const draft of [{ components: null }, { components: [] }]) { const f = await fixture(draft); await f.deliver(); assert.equal(f.sent.length, 0); }
    const f = await fixture(); await f.deliver(undefined, 'stale'); assert.equal(f.sent.length, 0);
    const previous = process.env.KIRA_TELEGRAM_WIDGETS_ENABLED; process.env.KIRA_TELEGRAM_WIDGETS_ENABLED = 'false';
    t.after(() => { if (previous === undefined) delete process.env.KIRA_TELEGRAM_WIDGETS_ENABLED; else process.env.KIRA_TELEGRAM_WIDGETS_ENABLED = previous; });
    await f.deliver(); assert.equal(f.calls(), 0);
    delete process.env.KIRA_TELEGRAM_WIDGETS_ENABLED;
    let sends = 0; const unknown = { ...f.api, sendWidget: async () => { sends++; throw Error('timeout'); } };
    await assert.rejects(f.service.deliver(owner, unknown, 'Вопрос', 'Учебная температура 18 °C', 10)); assert.equal(sends, 1);
    const failedModel = new TelegramUiService(f.store, async () => { throw Error('refused'); });
    assert.equal(await failedModel.deliver(owner, f.api, 'Вопрос', 'Ответ', 10), undefined);
});

test('raw Bot API widget updates enter grammY session/text/callback middleware after acknowledgement, preserving canonical callback source', async () => {
    for (const action of [{ type: 'reply', text: 'Прогноз завтра' }, { type: 'existing', index: 0 }]) {
        const f = await fixture(widgetDraft(action)); await f.deliver({ inline_keyboard: [[{ text: 'Подтвердить', callback_data: 'existing_confirmation' }]] });
        const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
        const events: string[] = [];
        bot.api.config.use(async (_prev, method, payload) => { events.push(method); if (String(method) === 'answerWidgetQuery') assert.ok(Buffer.byteLength((payload as any).data) <= 1024); return { ok: true, result: true } as any; });
        registerTelegramWidgetBridge(bot, f.service, owner);
        bot.use(session({ initial: (): SessionData => ({ reminders: [], domains: {}, messageHistory: [], dialogueSummary: '', lastSummarizedIndex: -1 }) }));
        bot.on('message:text', async ctx => { events.push('text'); assert.equal(ctx.from.id, owner); assert.ok(ctx.session); assert.equal(ctx.message.text, 'Прогноз завтра'); assert.equal(ctx.message.reply_to_message?.message_id, 10); });
        bot.on('callback_query:data', async ctx => { events.push('callback'); assert.equal(ctx.callbackQuery.data, 'existing_confirmation'); assert.equal(ctx.callbackQuery.message?.message_id, 10); assert.equal(ctx.from.id, owner); await ctx.answerCallbackQuery({ text: 'Действие выполнено' }); });
        // Existing callback occupies w0; reply occupies w1.
        await bot.handleUpdate({ update_id: 2, widget_query: f.query(action.type === 'reply' ? 'a:0:1' : 'a:0:0') } as any);
        assert.deepEqual(events, action.type === 'reply' ? ['answerWidgetQuery', 'editMessageWidgetData', 'text'] : ['answerWidgetQuery', 'editMessageWidgetData', 'callback', 'editMessageWidgetData']);
        if (action.type === 'existing') assert.equal((await f.service.query(owner, f.query('a:0:0'))).state?.n, 'Действие выполнено');
        await bot.handleUpdate({ update_id: 3, widget_query: f.query('a:0:0') } as any);
        assert.equal(events.filter(e => e === 'text' || e === 'callback').length, 1);
    }
});

test('query acknowledgement failure consumes its receipt and never executes or retries a business action', async () => {
    const f = await fixture(); await f.deliver();
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    bot.api.config.use(async () => { throw Error('uncertain acknowledgement'); });
    registerTelegramWidgetBridge(bot, f.service, owner);
    bot.use(() => { assert.fail('No action after uncertain acknowledgement'); });
    await bot.handleUpdate({ update_id: 2, widget_query: f.query('a:0:0') } as any);
    assert.equal((await f.service.query(owner, f.query('a:0:0'))).dispatch, undefined);
});

test('a composer finishing after a newer turn or revoked deferred job cannot send a widget', async () => {
    const f = await fixture(); let completions = 0;
    const stale = new TelegramUiService(f.store, async () => { completions++; await f.store.transact(owner, tx => tx.put('canonical', 'turn', 'tg:2')); return JSON.stringify(widgetDraft()); });
    await stale.deliver(owner, f.api, 'Вопрос', 'Ответ', 10, undefined, 'tg:1');
    assert.equal(completions, 1); assert.equal(f.sent.length, 0);
    const noMarker = new TelegramUiService(new MemoryUiStore(), async () => { assert.fail('No AI without a canonical turn'); });
    await noMarker.deliver(owner, f.api, 'Вопрос', 'Ответ', 10); assert.equal(f.sent.length, 0);
    let checks = 0;
    await new TelegramUiService(f.store, async () => JSON.stringify(widgetDraft())).deliver(owner, f.api, 'Вопрос', 'Ответ', 10, undefined, 'tg:2', async () => ++checks === 1);
    assert.equal(f.sent.length, 0);
});

test('callback status is durable, bounded, owner-scoped and cannot claim completion before action acceptance', async () => {
    const f = await fixture(); await f.deliver();
    assert.equal(await f.service.notice(owner, 20, 'Результат'), undefined);
    await f.service.query(owner, f.query('a:0:0'));
    assert.equal(await f.service.notice(owner + 1, 20, 'Результат'), undefined);
    const status = await f.service.notice(owner, 20, '\0' + '😀'.repeat(200));
    assert.equal(Array.from(status!.n!).length, 160); assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 1024);
    assert.equal((await new TelegramUiService(f.store).query(owner, f.query('a:0:0'))).state?.n, status?.n);
    await f.store.transact(owner, tx => tx.put('canonical', 'turn', 'tg:2'));
    assert.equal(await f.service.notice(owner, 20, 'Устарело'), undefined);
});
