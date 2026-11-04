import assert from 'node:assert/strict';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { reflectionPrescreenMessages, normalizeReminderReview, type ReminderSourceMessage } from '../ai/telegramReminderReview';
import { parseLLMJson } from '../utils';
import { telegramReminderCases, telegramReminderEvalNow } from '../tests/fixtures/telegramReminderCases';

/** Synthetic data only. No Telegram, runtime initialization, history or memory writes. */
async function main() {
    const cases = process.argv[2] ? telegramReminderCases.filter(item => item.id === process.argv[2]) : telegramReminderCases;
    assert.ok(cases.length, 'Unknown synthetic case');
    let passed = 0;
    for (const item of cases) {
        const context: ReminderSourceMessage[] = 'context' in item && item.context ? item.context : [];
        const now = 'now' in item && item.now ? item.now : telegramReminderEvalNow;
        const reply = await createChatCompletionForTask('lightweightText', { messages: reflectionPrescreenMessages({ now, timeZone: 'Europe/Moscow',
            messages: item.messages, context, pending: 'pending' in item && item.pending ? item.pending : [] }, 'Контакт Альфа', 'Владелец'),
            temperature: 0, max_completion_tokens: 1200 });
        const parsed = parseLLMJson<{ reminderReview?: unknown }>(reply.choices[0]?.message?.content || '');
        const review = normalizeReminderReview(parsed?.reminderReview, [...context, ...item.messages], new Set(item.messages.map(m => m.messageId!)), now.getTime());
        try {
            assert.equal(review.candidates.length, item.expected);
            if ('text' in item && item.text) assert.match(review.candidates[0].text, item.text);
            if ('day' in item && item.day) assert.equal(review.candidates[0].remindAt.slice(0, 10), item.day);
            if ('invalidate' in item && item.invalidate) assert.ok(review.invalidated.some(r => r.anchorMessageId === 1));
            // Lead time is a visible suggestion, not a fixed three-hour product rule.
            if (item.id === 'rescheduled') assert.ok(Date.parse(review.candidates[0].remindAt) > Date.parse('2037-04-09T07:30:00Z')
                && Date.parse(review.candidates[0].remindAt) < Date.parse('2037-04-09T13:00:00Z'), 'Replace the former reminder with a proposal before the moved meeting');
            passed++; console.log(`PASS ${item.id}`);
        } catch {
            console.error(`FAIL ${item.id}: ${JSON.stringify({ review, raw: parsed })}`);
        }
    }
    console.log(`Synthetic Telegram reminder semantic evaluation: ${passed}/${cases.length}`);
    if (passed !== cases.length) process.exitCode = 1;
}
main().catch(() => { console.error('Synthetic semantic evaluation failed: provider unavailable'); process.exitCode = 1; });
