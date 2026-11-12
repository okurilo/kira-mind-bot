import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config';
import { sendMessageToChat } from '../services/telegram';

test('Telegram signature uses the configured name and omits an unknown username', async () => {
    const originalName = config.characterName;
    const originalUsername = config.botUsername;
    const sent: string[] = [];
    const client = { sendMessage: async (_id: number, value: { message: string }) => {
        sent.push(value.message); return { id: sent.length };
    } } as any;
    try {
        config.characterName = 'Салем';
        config.botUsername = '';
        assert.equal((await sendMessageToChat(client, 123, 'Привет')).success, true);
        assert.match(sent[0], /✉️ Салем$/u);
        assert.doesNotMatch(sent[0], /KiraMindBot|@/u);
        config.botUsername = 'synthetic_salem_bot';
        assert.equal((await sendMessageToChat(client, 123, 'Снова')).success, true);
        assert.match(sent[1], /✉️ Салем \| @synthetic_salem_bot$/u);
    } finally {
        config.characterName = originalName;
        config.botUsername = originalUsername;
    }
});
