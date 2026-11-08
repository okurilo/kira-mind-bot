import { createHash } from 'node:crypto';
import { config } from '../config';
import { UiService } from '../generative-ui/service';
import { composeUi, type UiCompletion } from '../generative-ui/compose';
import { UI_CATALOG_V2 } from '../generative-ui/contracts';
import { isMaximumSavingsEnabled } from './budgetModeService';
import { withBackgroundAiTask } from '../ai/accountPolicy';
import { runWithChannelPreset } from './aiRuntimeConfigService';
import { apiTurnPreset, BotSettingsApiModelStore } from '../api/modelSettings';
import { nextApiMessageId } from '../api/transport';

const active = new Set<string>();
export async function composeUiNotification(owner: number, text: string, sourceKey: string, dependencies: {
    service?: UiService; complete?: UiCompletion; allowed?: () => Promise<boolean>; run?: <T>(work: () => Promise<T>) => Promise<T>;
} = {}): Promise<number> {
    const service = dependencies.service ?? new UiService(owner);
    if (!text.trim() || text.length > 12_000 || !await (dependencies.allowed ?? (async () => !await isMaximumSavingsEnabled()))()) return 0;
    const devices = (await service.devices()).devices.filter(d => d.enabled && d.proactive && d.catalogId === UI_CATALOG_V2);
    const eligible: typeof devices = [];
    for (const device of devices) if (!await service.hasNote(sourceKey, device.id)) eligible.push(device);
    if (!eligible.length) return 0;
    const run = dependencies.run ?? (<T>(work: () => Promise<T>) => withBackgroundAiTask('ui-note', sourceKey, async () =>
        runWithChannelPreset(await apiTurnPreset(new BotSettingsApiModelStore()), work)));
    return run(async () => {
        const messageId = nextApiMessageId();
        const ui = await composeUi('Представь уже доставленное фоновое сообщение карточкой.', { id: messageId, type: 'text', text, format: 'plain' },
            () => '', dependencies.complete, { request: { enabled: true, catalogId: UI_CATALOG_V2 }, passive: true });
        if (!ui) return 0;
        let sent = 0;
        for (const device of eligible) {
            // Recheck the persisted binding/opt-in after inference. Revocation blocks a late result.
            try { if (await service.publishNote(ui, messageId, text, device, sourceKey)) sent++; } catch { /* revoked/unavailable */ }
        }
        return sent;
    });
}
/** Only explicit successful background deliveries call this; ordinary Telegram chat never enables widgets. */
export function queueUiNotification(chatId: number, text: string, sourceKey: string): void {
    if (chatId !== config.allowedUserId) return;
    const key = createHash('sha256').update(`${chatId}:${sourceKey}`).digest('hex');
    if (active.has(key)) return;
    active.add(key);
    void composeUiNotification(chatId, text, sourceKey).catch(() => {}).finally(() => active.delete(key));
}
